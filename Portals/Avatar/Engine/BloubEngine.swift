// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/engine.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

nonisolated extension Bloub {
    /// Where the bot looks when something outside drives it.
    ///
    /// `yaw` and `pitch` are ABSOLUTE and replace the pose's own as `mix` rises; the
    /// engine does the mixing because only it knows the pose at this instant. `wander`
    /// is what remains of the automatic drift of the gaze, separately: a turned head with
    /// nothing driving it must stay turned AND keep living. `float` is what remains of
    /// the body's own: its slow float and breath. Both 0 hold the avatar still between
    /// blinks. `spin` is a turn taken on the way, in degrees; -360 is the same angle as
    /// 0, so it never changes where the eyes land.
    struct Look: Equatable, Sendable {
        var yaw: Double
        var pitch: Double
        var mix: Double
        var spin: Double
        var wander: Double
        var float: Double = 1

        /// The state's own gaze, with bloub's drift of the gaze and the body.
        static let none = Look(yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1)
        /// The state's own gaze, held: nothing moves but the blinks.
        static let still = Look(yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 0, float: 0)

        fileprivate var isFinite: Bool { (yaw + pitch + mix + spin + wander + float).isFinite }

        fileprivate static func lerp(_ a: Look, _ b: Look, _ t: Double) -> Look {
            Look(
                yaw: Bloub.lerp(a.yaw, b.yaw, t),
                pitch: Bloub.lerp(a.pitch, b.pitch, t),
                mix: Bloub.lerp(a.mix, b.mix, t),
                spin: Bloub.lerp(a.spin, b.spin, t),
                wander: Bloub.lerp(a.wander, b.wander, t),
                float: Bloub.lerp(a.float, b.float, t)
            )
        }
    }

    /// A 2D affine transform, as SVG's matrix(a,b,c,d,e,f) and CGAffineTransform:
    /// x' = a x + c y + tx, y' = b x + d y + ty.
    struct Affine: Equatable, Sendable {
        var a: Double
        var b: Double
        var c: Double
        var d: Double
        var tx: Double
        var ty: Double

        func apply(_ p: Point) -> Point {
            Point(x: a * p.x + c * p.y + tx, y: b * p.x + d * p.y + ty)
        }
    }

    struct RenderedEye: Equatable, Sendable {
        /// 0 = inner eye, 1 = outer eye. An eye past the sphere's limb is left out.
        var index: Int
        /// The stadium, in output units, centred on the origin.
        var capsule: Capsule
        /// Places the capsule: tangent frame, own tilt, blink, position.
        var transform: Affine
        var alpha: Double

        /// The eye's outline as a point list, in output units.
        func outline(samplesPerCorner n: Int = 8) -> [Point] {
            let hw = capsule.halfWidth
            let hh = capsule.halfHeight
            let r = capsule.cornerRadius
            // corner centres, clockwise from top-left (y down), with their start angles
            let corners: [(Double, Double, Double)] = [
                (-hw + r, -hh + r, .pi), (hw - r, -hh + r, -.pi / 2), (hw - r, hh - r, 0), (-hw + r, hh - r, .pi / 2),
            ]
            var pts: [Point] = []
            for (cx, cy, start) in corners {
                for k in 0...n {
                    let a = start + (Double(k) / Double(n)) * (.pi / 2)
                    pts.append(transform.apply(Point(x: cx + cos(a) * r, y: cy + sin(a) * r)))
                }
            }
            return pts
        }
    }

    struct Disc: Equatable, Sendable {
        var x: Double
        var y: Double
        var r: Double
    }

    /// One image of the bot. Coordinates are in output units: the engine's `scale` is the
    /// resting ball's radius, and the origin is the centre of the viewBox.
    struct Frame: Equatable, Sendable {
        /// The body outline: 64 points, closed. `bodyCurve` smooths them.
        var body: [Point]
        var bodyAlpha: Double
        var eyes: [RenderedEye]
        var dots: [Dot]
        /// true = the dots pass behind the body (the burst's particles).
        var dotsBehind: Bool
        var arcs: [ArcRender]
        var notif: Disc?
        var notch: Disc?

        /// The body as closed Catmull-Rom cubics, exactly as bloub draws it.
        var bodyCurve: [CubicSegment] { closedCurve(body) }
    }

    /// Clockless engine: `sample(_:)` is a pure function of time.
    ///
    /// The setters are timestamped and are the only way state gets in. Pausing,
    /// resuming, slowing down or jumping to any date give exactly the same image, and
    /// re-reading a past date (even mid-transition) gives the frame it gave before.
    struct Engine: Sendable {
        /// The resting ball's radius, in output units.
        let scale: Double

        private(set) var state: StateID
        private var prev: StateID?
        /// FROZEN starting pose, set only when a state change lands during a fade.
        private var frozenOrigin: Pose?
        private var tCur = 0.0
        private var tPrev = 0.0
        private var blinkAt = -10.0
        private var shape: BodyShape?
        private var shapePrev: BodyShape?
        private var shapeAt = -10.0
        private var expr: Expression?
        private var exprPrev: Expression?
        private var exprAt = -10.0
        private var look = Look.none
        private var lookPrev = Look.none
        private var lookAt = -10.0
        /// current catch-up duration; see `lookMorph`, its default
        private var currentLookMorph = 0.24

        /// Morph duration when the body shape changes.
        static let shapeMorph = 0.45

        /// Catch-up duration of the gaze towards its target. Shorter than `shapeMorph`: a
        /// gaze that follows should look attentive, not viscous.
        static let lookMorph = 0.24

        init(scale: Double = 100, initial: StateID = .idle, shape: BodyShape? = nil, expression: Expression? = nil) {
            self.scale = scale
            state = initial
            self.shape = shape
            expr = expression
        }

        var currentShape: BodyShape? { shape }
        var currentExpression: Expression? { expr }
        var currentLook: Look { look }

        // MARK: Setters

        /// The resting expression. Like the shape, it glides to the new value.
        mutating func setExpression(_ expression: Expression?, now: Double = 0) {
            if expression == expr { return }
            exprPrev = expr
            expr = expression
            exprAt = now
        }

        /// The chosen body shape. It only replaces the body on `baseBody` states.
        mutating func setShape(_ newShape: BodyShape?, now: Double = 0) {
            if newShape == shape { return }
            shapePrev = shape
            shape = newShape
            shapeAt = now
        }

        /// A new gaze target, nil to go back to the state's own. It starts from the
        /// CURRENT value, not the previous target, so frequent updates glide. A non-finite
        /// target is refused and the last one is kept.
        mutating func setLook(_ newLook: Look?, now: Double, morph: Double = Engine.lookMorph) {
            if let newLook, !newLook.isFinite { return }
            lookPrev = lookAtTime(now)
            look = newLook ?? .none
            lookAt = now
            currentLookMorph = morph
        }

        /// Starts over on `id` with NO previous state, like a new engine on that state.
        mutating func reset(_ id: StateID, now: Double) {
            state = id
            prev = nil
            frozenOrigin = nil
            tCur = now
            tPrev = now
            blinkAt = -10
        }

        /// Timestamped state change. A change that lands during a fade blends from the
        /// frozen composite pose, so chained changes stay continuous; outside a fade
        /// nothing is frozen, so the state being left keeps animating while it fades.
        mutating func setState(_ id: StateID, now: Double) {
            if id == state { return }
            let morph = state.def.morph
            let midFade = prev != nil && now - tCur < morph
            frozenOrigin = midFade ? composedPose(now) : nil
            prev = state
            tPrev = tCur
            state = id
            tCur = now
            // In the video every shape change is hidden by a blink.
            if id.def.blinkIn { blinkAt = now }
        }

        // MARK: Time-resolved inputs

        private func exprAtTime(_ now: Double) -> Expression? {
            guard let to = expr, let from = exprPrev else { return expr }
            let k = (now - exprAt) / Engine.shapeMorph
            if k >= 1 { return to }
            return blendExpression(from, to, Easing.easeOutQuint(clamp(k)))
        }

        /// The effective radii at `now`, morph included. `shapePrev` is never cleared:
        /// re-reading a past date must give the intermediate image again.
        private func shapeAtTime(_ now: Double) -> [Double]? {
            guard let to = shape?.radii, let from = shapePrev?.radii else { return shape?.radii }
            let k = (now - shapeAt) / Engine.shapeMorph
            if k >= 1 { return to }
            let t = Easing.easeOutQuint(clamp(k))
            return to.enumerated().map { i, r in lerp(from.bloubElement(at: i) ?? r, r, t) }
        }

        private func lookAtTime(_ now: Double) -> Look {
            let k = (now - lookAt) / currentLookMorph
            if k >= 1 { return look }
            return Look.lerp(lookPrev, look, Easing.easeOutQuint(clamp(k)))
        }

        private func posed(_ def: StateDef, _ t: Double, _ radii: [Double]?, _ expr: Expression?) -> Pose {
            var pose = def.pose(t)
            if def.baseBody, let radii {
                // keep the pose (rotation, offset, squash) and swap only the profile
                pose.sil.radii = radii
            }
            if def.baseFace, let expr {
                pose.gaze = expr.gaze
                pose.split = expr.split
                pose.eyes = expr.eyes
            }
            return pose
        }

        /// The eye offset at `now` for a state, in ball radii: READ from the table on the
        /// bounds of each morph and interpolated with that morph's curve, never solved on
        /// an interpolated value.
        private func offsetAtTime(_ now: Double, _ state: StateID) -> Offset {
            func onAxis(_ start: Double, _ duration: Double, _ a: Offset, _ b: Offset) -> Offset {
                if a == b { return b }
                let k = (now - start) / duration
                if k >= 1 { return b }
                let t = Easing.easeOutQuint(clamp(k))
                return Offset(x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t))
            }
            // expression axis, for each of the two shapes involved
            func perShape(_ s: BodyShape?) -> Offset {
                onAxis(
                    exprAt, Engine.shapeMorph,
                    EyeFit.offset(shape: s, state: state, expression: exprPrev?.id),
                    EyeFit.offset(shape: s, state: state, expression: expr?.id)
                )
            }
            // then the shape axis
            return onAxis(shapeAt, Engine.shapeMorph, perShape(shapePrev), perShape(shape))
        }

        /// Origin of the current fade: the frozen pose if there is one, otherwise the
        /// state being left at its own elapsed time (so still animating, on purpose).
        private func origin(_ now: Double, _ radii: [Double]?, _ expr: Expression?) -> Pose? {
            if let frozenOrigin { return frozenOrigin }
            guard let prev else { return nil }
            return posed(prev.def, max(0, now - tPrev), radii, expr)
        }

        /// The composite pose at `now`, fade included: what `sample` blends, before the
        /// resting life and the gaze.
        private func composedPose(_ now: Double) -> Pose {
            let def = state.def
            let radii = shapeAtTime(now)
            let expr = exprAtTime(now)
            let pose = posed(def, max(0, now - tCur), radii, expr)
            let since = now - tCur
            if since >= def.morph { return pose }
            guard let origin = origin(now, radii, expr) else { return pose }
            return Engine.blendPose(origin, pose, Easing.easeOutQuint(clamp(since / def.morph)))
        }

        private static func lerpEye(_ a: EyeConfig, _ b: EyeConfig, _ t: Double) -> EyeConfig {
            EyeConfig(w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), open: lerp(a.open, b.open, t), tilt: lerp(a.tilt, b.tilt, t))
        }

        /// Blends two poses. The decor crossfades in opacity, not in geometry.
        private static func blendPose(_ a: Pose, _ b: Pose, _ t: Double) -> Pose {
            let out = 1 - t
            var pose = Pose()
            pose.sil = blend(a.sil, b.sil, t)
            pose.offX = lerp(a.offX, b.offX, t)
            pose.offY = lerp(a.offY, b.offY, t)
            pose.gaze = HeadGaze(
                yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
                pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
                roll: lerp(a.gaze.roll, b.gaze.roll, t)
            )
            pose.split = lerp(a.split, b.split, t)
            pose.eyes = EyePair(inner: lerpEye(a.eyes.inner, b.eyes.inner, t), outer: lerpEye(a.eyes.outer, b.eyes.outer, t))
            pose.eyeAlpha = lerp(a.eyeAlpha, b.eyeAlpha, t)
            pose.bodyAlpha = lerp(a.bodyAlpha, b.bodyAlpha, t)
            pose.dots = a.dots.map { var d = $0; d.opacity *= out; return d }
                + b.dots.map { var d = $0; d.opacity *= t; return d }
            pose.arcs = a.arcs.map { var r = $0; r.id = "a\(r.id)"; r.opacity *= out; return r }
                + b.arcs.map { var r = $0; r.id = "b\(r.id)"; r.opacity *= t; return r }
            // the notification dot belongs to one of the two states; it does not blend
            pose.notif = t < 0.5 ? a.notif : b.notif
            pose.dotsBehind = t < 0.5 ? a.dotsBehind : b.dotsBehind
            return pose
        }

        // MARK: Sampling

        func sample(_ now: Double) -> Frame {
            let R = scale
            let def = state.def
            let radii = shapeAtTime(now)
            let expr = exprAtTime(now)
            var pose = posed(def, max(0, now - tCur), radii, expr)
            var offset = offsetAtTime(now, state)

            // --- transition ---
            // The previous state is never purged: `since < def.morph` is enough to ignore
            // it once the fade is over, and forgetting it would make re-reads impossible.
            let since = now - tCur
            if since < def.morph, let origin = origin(now, radii, expr) {
                // Exponential ease-out: the curve measured on the video. The ratio is
                // clamped: a date BEFORE the change would extrapolate thirty times too far.
                let ratio = Easing.easeOutQuint(clamp(since / def.morph))
                pose = Engine.blendPose(origin, pose, ratio)
                // The eye offset follows the SAME curve as the silhouette that causes it.
                if let left = prev {
                    let before = offsetAtTime(now, left)
                    offset = Offset(x: lerp(before.x, offset.x, ratio), y: lerp(before.y, offset.y, ratio))
                }
            }

            // --- resting life ---
            let alive = pose.eyeAlpha > 0.01
            let look = lookAtTime(now)
            let life = liveliness(now, wander: alive ? look.wander : 0, blink: alive, float: look.float)

            // Both aims REPLACE the pose's instead of adding to it, and the spin is taken
            // off on the way. The drift is added AFTER the mix, or the target would cancel
            // it along with the pose. The roll follows nothing: the bot's head leans -13deg.
            let gaze = HeadGaze(
                yaw: lerp(pose.gaze.yaw, look.yaw, look.mix) + life.dYaw - look.spin,
                pitch: lerp(pose.gaze.pitch, look.pitch, look.mix) + life.dPitch,
                roll: pose.gaze.roll + life.dRoll
            )

            // blink triggered by the state change, on top of the schedule
            let forced = clamp((now - blinkAt) / 0.2)
            let forcedLid = forced < 1 ? abs(forced * 2 - 1) : 1
            let lid = min(life.lid, forcedLid)

            let offX = pose.offX + life.driftX
            let offY = pose.offY + life.driftY

            // --- body ---
            var sil = pose.sil
            sil.cx = pose.sil.cx + offX
            sil.cy = pose.sil.cy + offY
            sil.sy = pose.sil.sy * life.breath
            let body = toPoints(sil, scale: R)

            // --- eyes ---
            // The eyes live on a sphere of radius 1; on a non-circular silhouette they
            // are brought back pro rata to the real radius in their direction.
            func bodyRadius(_ x: Double, _ y: Double) -> Double {
                radiusAtAngle(pose.sil.radii, atan2(y, x) - pose.sil.rot)
            }

            var eyes: [RenderedEye] = []
            if pose.eyeAlpha > 0.01 {
                let poses = eyePoses(gaze, scale: R, split: pose.split)
                for i in 0..<2 {
                    let e = poses[i]
                    if e.depth <= 0.02 { continue }
                    let cfg = pose.eyes[i]
                    let fit = bodyRadius(e.x, e.y)
                    // The eye's own tilt composes the tangent frame with a rotation in
                    // the eye's plane (Basis x Rot): mirrored tilts become possible.
                    let phi = (cfg.tilt * .pi) / 180
                    let cp = cos(phi)
                    let sp = sin(phi)
                    let ax = e.a * cp + e.c * sp
                    let ay = e.b * cp + e.d * sp
                    let cx2 = -e.a * sp + e.c * cp
                    let cy2 = -e.b * sp + e.d * cp
                    // The blink comes AFTER all that: a vertical squash on screen, not
                    // along the capsule's axis.
                    let k = blinkScale(min(lid, cfg.open))
                    eyes.append(RenderedEye(
                        index: i,
                        capsule: Capsule(width: cfg.w * R, height: cfg.h * R),
                        transform: Affine(
                            a: ax,
                            b: ay * k,
                            c: cx2,
                            d: cy2 * k,
                            tx: e.x * fit + (offX + offset.x) * R,
                            ty: e.y * fit + (offY + offset.y) * R
                        ),
                        alpha: pose.eyeAlpha * clamp(e.depth / 0.12)
                    ))
                }
            }

            // --- decor ---
            let dots = pose.dots
                .filter { $0.opacity > 0.01 && $0.r > 0.0005 }
                .map { p -> Dot in
                    var d = p
                    d.x = (p.x + offX) * R
                    d.y = (p.y + offY) * R
                    d.r = p.r * R
                    return d
                }

            // the notification dot sits on the outline, so it follows the shape too
            var notif: Disc?
            var notch: Disc?
            if let n = pose.notif {
                let nFit = bodyRadius(n.x, n.y)
                let nx = (n.x * nFit + offX) * R
                let ny = (n.y * nFit + offY) * R
                notif = Disc(x: nx, y: ny, r: n.r * R)
                notch = Disc(x: nx, y: ny, r: n.notch * R)
            }

            return Frame(
                body: body,
                bodyAlpha: pose.bodyAlpha,
                eyes: eyes,
                dots: dots,
                dotsBehind: pose.dotsBehind,
                // States declare arcs in ball radii; the engine, the only one that knows
                // the output scale, rasterises them.
                arcs: pose.arcs
                    .filter { $0.opacity > 0.01 }
                    .map { arcRender($0.seed, t: $0.t, scale: R, id: $0.id, opacity: $0.opacity) },
                notif: notif,
                notch: notch
            )
        }
    }
}
