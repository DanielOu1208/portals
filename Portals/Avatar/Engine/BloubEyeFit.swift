// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/eyefit.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation
import Synchronization

/// Where to put the face on a customiser shape.
///
/// The eyes live on a sphere and `radiusAtAngle` re-anchors them to the real outline
/// pro rata. That places their CENTRE, but an eye has a size: a shape that is narrow in
/// the eye's direction pushes it against the edge until the mask opens it outwards.
///
/// So a COMMON offset (a translation, hence an isometry) is added to both eyes, and it is
/// solved once per (shape, base-body state, expression), never per frame: seven per-frame
/// solvers all trembled, because everything they read moves at 60 fps. The engine only
/// interpolates between two table entries along a morph's own curve.
///
/// bloub builds the whole table at import. This port fills the same table lazily, one
/// entry the first time it is asked for, so the app pays only for the shape it uses. The
/// entries are a pure function of their key, so `Engine.sample` stays a pure function of
/// time.
nonisolated extension Bloub {
    struct Offset: Equatable, Sendable {
        var x: Double
        var y: Double

        static let zero = Offset(x: 0, y: 0)
    }

    enum EyeFit {
        /// The solver's reference radius. The offset it returns is in ball radii.
        private static let R = 100.0

        /// Largest amplitudes of the resting life, read off `liveliness`: `loopNoise` is
        /// bounded by 1, so these sums are exact bounds, not estimates.
        private static let deriveYaw = 5.5 + 1.6
        private static let derivePitch = 4.2 + 1.3
        /// Floating of the centre, in ball radii.
        private static let deriveX = 0.006
        private static let deriveY = 0.007

        /// The face of a pose: what the solver needs to place its capsules.
        private struct Face {
            var gaze: HeadGaze
            var split: Double
            var eyes: EyePair
        }

        /// A capsule ready to measure: its axis segment, and what it takes to compute the
        /// clearance needed in a given direction (the support function of its ellipse).
        private struct Footprint {
            /// centre, in viewBox units
            var x: Double
            var y: Double
            /// half axis vector
            var ax: Double
            var ay: Double
            /// local disc radius, before the transform
            var r: Double
            /// columns of the tangent matrix
            var m: (Double, Double, Double, Double)
        }

        /// Footprints of a face's two eyes on a profile. The blink is left out: a closed
        /// eye needs no room.
        private static func footprints(_ face: Face, sil: Silhouette, radii: [Double]) -> [Footprint] {
            var out: [Footprint] = []
            let poses = eyePoses(face.gaze, scale: R, split: face.split)
            for i in 0..<2 {
                let e = poses[i]
                if e.depth <= 0.02 { continue }
                let cfg = face.eyes[i]
                let phi = (cfg.tilt * .pi) / 180
                let cp = cos(phi)
                let sp = sin(phi)
                let ax = e.a * cp + e.c * sp
                let ay = e.b * cp + e.d * sp
                let cx = -e.a * sp + e.c * cp
                let cy = -e.b * sp + e.d * cp

                let hw = max(cfg.w * R, 0.01) / 2
                let hh = max(cfg.h * R, 0.01) / 2
                let r = min(hw, hh)
                // the axis runs along the larger dimension
                let long = hh > hw
                let half = long ? hh - r : hw - r
                // the local radius pro rata, exactly as the engine does
                let fit = radiusAtAngle(radii, atan2(e.y, e.x) - sil.rot)
                out.append(Footprint(
                    x: e.x * fit,
                    y: e.y * fit,
                    ax: (long ? cx : ax) * half,
                    ay: (long ? cy : ay) * half,
                    r: r,
                    m: (ax, ay, cx, cy)
                ))
            }
            return out
        }

        /// Closest approach between an outline and a segment: the distance, and the unit
        /// vector from the outline to the segment (the direction that clears it).
        private static func approach(_ pts: [Point], _ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double)
            -> (d: Double, ux: Double, uy: Double)
        {
            let sx = x1 - x0
            let sy = y1 - y0
            let len2 = sx * sx + sy * sy
            var best = Double.infinity
            var vx = 0.0
            var vy = 0.0
            for p in pts {
                var t = len2 > 0 ? ((p.x - x0) * sx + (p.y - y0) * sy) / len2 : 0
                t = t < 0 ? 0 : t > 1 ? 1 : t
                let ex = x0 + t * sx - p.x
                let ey = y0 + t * sy - p.y
                let d2 = ex * ex + ey * ey
                if d2 < best {
                    best = d2
                    vx = ex
                    vy = ey
                }
            }
            let d = best.squareRoot()
            return (d, d > 1e-9 ? vx / d : 0, d > 1e-9 ? vy / d : 0)
        }

        /// A trial: capsules to fit in an outline, and the reference outline.
        private struct Trial {
            var footprints: [Footprint]
            var reference: [Footprint]
            var outline: [Point]
            var referenceOutline: [Point]
        }

        /// Resting float of the centre, in viewBox units, added to the capsule's radius.
        private static let floatMargin = hypot(deriveX, deriveY) * R

        /// Margin of the tightest capsule, and the direction that clears it.
        private static func worst(_ pts: [Point], _ footprints: [Footprint], _ tx: Double, _ ty: Double)
            -> (margin: Double, ux: Double, uy: Double)
        {
            var margin = Double.infinity
            var ux = 0.0
            var uy = 0.0
            for e in footprints {
                let x = e.x + tx
                let y = e.y + ty
                let a = approach(pts, x - e.ax, y - e.ay, x + e.ax, y + e.ay)
                // support function of the ellipse in the approach direction
                let (m0, m1, m2, m3) = e.m
                let radius = e.r * hypot(m0 * a.ux + m1 * a.uy, m2 * a.ux + m3 * a.uy) + floatMargin
                if a.d - radius < margin {
                    margin = a.d - radius
                    ux = a.ux
                    uy = a.uy
                }
            }
            return (margin, ux, uy)
        }

        /// Directions probed and bisection steps.
        private static let directions = 12
        private static let bisection = 8

        /// The smallest common translation that fits, by a directional search: probe a
        /// ring of directions and bisect the distance along each.
        private static func solve(_ trials: [Trial]) -> Offset {
            guard let first = trials.first else { return .zero }

            /// The tightest margin over every trial, for a given translation.
            func margin(_ tx: Double, _ ty: Double) -> Double {
                var m = Double.infinity
                for trial in trials { m = min(m, worst(trial.outline, trial.footprints, tx, ty).margin) }
                return m
            }

            // Required margin: the tightest the original profile tolerates, capped by the
            // most the shape can offer the pair, at its centre.
            var required = Double.infinity
            for trial in trials {
                required = min(required, worst(trial.referenceOutline, trial.reference, 0, 0).margin)
            }
            // The search must be able to reach the body's centre.
            var mx = 0.0
            var my = 0.0
            let fps = first.footprints
            for e in fps {
                mx -= e.x / Double(fps.count)
                my -= e.y / Double(fps.count)
            }
            let reach = max(0.35 * R, hypot(mx, my) * 1.25)

            required = min(required, margin(mx, my))

            // Already fine: the circle, and any wide enough shape. The capsule must also
            // FIT; otherwise a shape where nothing fits passes degenerately.
            let start = margin(0, 0)
            if start >= required && start >= 0 { return .zero }
            let target = max(required, 0)

            var bestX = 0.0
            var bestY = 0.0
            var bestNorm = Double.infinity
            // fallback when nothing fits: the translation that clears the most
            var fallbackX = 0.0
            var fallbackY = 0.0
            var fallback = start

            for d in 0..<directions {
                let a = (Double(d) / Double(directions)) * .pi * 2
                let ux = cos(a)
                let uy = sin(a)
                if margin(ux * reach, uy * reach) < target {
                    // no solution this way, but maybe a better clearance
                    for k in [0.3, 0.6, 1] {
                        let m = margin(ux * reach * k, uy * reach * k)
                        if m > fallback {
                            fallback = m
                            fallbackX = ux * reach * k
                            fallbackY = uy * reach * k
                        }
                    }
                    continue
                }
                // the shortest distance that fits, along this direction
                var low = 0.0
                var high = reach
                for _ in 0..<bisection {
                    let mid = (low + high) / 2
                    if margin(ux * mid, uy * mid) >= target { high = mid } else { low = mid }
                }
                if high < bestNorm {
                    bestNorm = high
                    bestX = ux * high
                    bestY = uy * high
                }
            }

            let x = bestNorm == .infinity ? fallbackX : bestX
            let y = bestNorm == .infinity ? fallbackY : bestY
            // in BALL RADII; the engine scales it back
            return Offset(x: toFixed6(x / R), y: toFixed6(y / R))
        }

        /// JavaScript's `+(v).toFixed(6)`.
        private static func toFixed6(_ v: Double) -> Double {
            Double(String(format: "%.6f", v)) ?? v
        }

        /// The face to cover: the expression's if the state takes it, its own otherwise.
        private static func face(_ def: StateDef, _ pose: Pose, _ expr: Expression?) -> Face {
            if def.baseFace, let expr { return Face(gaze: expr.gaze, split: expr.split, eyes: expr.eyes) }
            return Face(gaze: pose.gaze, split: pose.split, eyes: pose.eyes)
        }

        /// The times to sample in a state: one if its pose doesn't move.
        private static func dates(_ def: StateDef) -> [Double] {
            func same(_ a: Pose, _ b: Pose) -> Bool {
                a.gaze == b.gaze && a.split == b.split && a.eyes == b.eyes && a.sil.rot == b.sil.rot
                    && a.sil.cx == b.sil.cx && a.sil.cy == b.sil.cy && a.sil.sx == b.sil.sx && a.sil.sy == b.sil.sy
            }
            if same(def.pose(0), def.pose(def.duration)) { return [0] }
            let n = 3
            return (0..<n).map { (Double($0) / Double(n - 1)) * def.duration }
        }

        /// A shape's offset on a state and an expression, drift included.
        private static func compute(_ def: StateDef, radii: [Double], expr: Expression?) -> Offset {
            var trials: [Trial] = []
            for t in dates(def) {
                let pose = def.pose(t)
                var shaped = pose.sil
                shaped.radii = radii
                let outline = toPoints(shaped, scale: R)
                let referenceOutline = toPoints(pose.sil, scale: R)
                let v = face(def, pose, expr)
                // The four corners of the drift bound the nominal pose, their centre.
                var corners: [Face] = []
                for dy in [-deriveYaw, deriveYaw] {
                    for dp in [-derivePitch, derivePitch] {
                        var c = v
                        c.gaze = HeadGaze(yaw: v.gaze.yaw + dy, pitch: v.gaze.pitch + dp, roll: v.gaze.roll)
                        corners.append(c)
                    }
                }
                for c in corners {
                    trials.append(Trial(
                        footprints: footprints(c, sil: pose.sil, radii: radii),
                        reference: footprints(c, sil: pose.sil, radii: pose.sil.radii),
                        outline: outline,
                        referenceOutline: referenceOutline
                    ))
                }
            }
            return solve(trials)
        }

        private struct Key: Hashable {
            var shape: ShapeID
            var state: StateID
            var expression: ExpressionID?
        }

        private static let table = Mutex<[Key: Offset]>([:])

        /// The offset to put on both eyes for this shape on this state, in ball radii.
        ///
        /// Zero for anything outside the catalogue (`nil`, a hand-made profile) and for
        /// states whose body is not replaceable. The circle solves to zero by
        /// construction, so the measured body does not move.
        static func offset(shape: BodyShape?, state: StateID, expression: ExpressionID?) -> Offset {
            guard let shape, shape.id.shape == shape else { return .zero }
            let def = state.def
            guard def.baseBody else { return .zero }
            // a state without the resting face has one entry, whatever the expression
            let key = Key(shape: shape.id, state: state, expression: def.baseFace ? expression : nil)
            if let hit = table.withLock({ $0[key] }) { return hit }
            let value = compute(def, radii: shape.radii, expr: key.expression?.expression)
            table.withLock { $0[key] = value }
            return value
        }
    }
}
