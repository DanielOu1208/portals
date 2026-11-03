// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/states.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

nonisolated extension Bloub {
    struct EyeConfig: Equatable, Sendable {
        /// Local width (short axis of the capsule), in ball radii.
        var w: Double
        /// Local height (long axis).
        var h: Double
        /// 1 = open, 0 = closed.
        var open: Double
        /// The capsule's own tilt, degrees, positive = top leans right. Applied AFTER the
        /// sphere's tangent frame, so the two eyes can lean in mirror (anger, sadness).
        var tilt: Double = 0
    }

    /// [inner eye, outer eye].
    struct EyePair: Equatable, Sendable {
        var inner: EyeConfig
        var outer: EyeConfig

        subscript(_ i: Int) -> EyeConfig { i == 0 ? inner : outer }

        static func same(_ w: Double, _ h: Double) -> EyePair {
            EyePair(inner: EyeConfig(w: w, h: h, open: 1), outer: EyeConfig(w: w, h: h, open: 1))
        }
    }

    struct Notif: Equatable, Sendable {
        var x: Double
        var y: Double
        var r: Double
        var notch: Double
    }

    struct Pose: Equatable, Sendable {
        /// Body silhouette, in ball radii.
        var sil: Silhouette = circle(1)
        /// Global offset of the body AND the eyes.
        var offX = 0.0
        var offY = 0.0
        var gaze: HeadGaze = restGaze
        /// Half the angle between the eyes on the sphere, degrees.
        var split: Double = eyeSplit
        var eyes: EyePair = .same(eyeWidth, eyeHeight)
        /// Eye opacity: for the states without a face.
        var eyeAlpha = 1.0
        var bodyAlpha = 1.0
        var dots: [Dot] = []
        var arcs: [ArcSpec] = []
        var notif: Notif?
        /// true = the decor passes behind the body (the burst's particles).
        var dotsBehind = false
    }

    // MARK: Non-radial shapes

    /// Bar of the upright "!": convex hull of two circles. Measured: top circle
    /// (0, -0.505) r 0.132, bottom circle (0, +0.130) r 0.075, straight sides. Tapered,
    /// top/bottom ratio 1.76.
    private static let barUprightCY = -0.1875
    private static let barUpright = profileFromPolygon(
        hullOfCircles(0, -0.505, 0.132, 0, 0.13, 0.075), cx: 0, cy: barUprightCY
    )

    /// Bar of the leaning "!": a pure capsule (constant width 0.269, length 0.776).
    private static let barItalic = profileFromPolygon(
        hullOfCircles(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), cx: 0, cy: 0
    )

    /// The leaning "!"'s dot is not a disc: a teardrop, round end (r 0.118) towards the
    /// bar, tapered point away, length 0.300 along the glyph. bloub stores it as a path
    /// rounded to 0.01 ball radii (`polyPath`), and that rounding is kept: it is the
    /// shape bloub draws.
    static let teardrop: [Point] = hullOfCircles(0, 0, 0.118, 0, 0.172, 0.012).map {
        Point(x: r2($0.x), y: r2($0.y))
    }

    /// The triangle does not spin in place: its centre describes a circle of radius
    /// 0.213 around the origin (measured), which makes it tumble rather than pivot.
    private static let triOrbit = 0.213

    private static func spinningTriangle(_ rot: Double) -> Silhouette {
        silhouette(.triangle, rot: rot, cx: -triOrbit * sin(rot), cy: triOrbit * cos(rot))
    }

    /// Pulse wave running through the three dots from left to right.
    private static func dotPulse(_ t: Double, _ index: Double) -> Double {
        let p = ((((t - index * 0.5) / 1.5).truncatingRemainder(dividingBy: 1)) + 1).truncatingRemainder(dividingBy: 1)
        let k = p < 0.5 ? 0.5 - 0.5 * cos(p * tau) : 0
        return clamp(k * 2)
    }

    // MARK: States

    enum StateID: String, Sendable, CaseIterable, Codable {
        case idle, thinking, wink, wide, alert, notify, exclaim, sleep, egg, hexagon, play, orbit
        /// An interface transition, not a catalogue animation: outside `sequence`.
        case swirl
        case burst, comet

        var def: StateDef { stateDefs[self]! }
    }

    struct StateDef: Sendable {
        var id: StateID
        /// Hold time when the whole sequence plays.
        var duration: Double
        /// Below this the animation is cut before it resolves. Read off `pose`'s
        /// constants. nil = the state ignores time or loops.
        var minDuration: Double?
        /// Entry morph duration.
        var morph: Double
        /// true = the entry is hidden by a blink, as in the video.
        var blinkIn: Bool
        /// true = the body is the "resting" silhouette, replaceable by a chosen shape.
        var baseBody: Bool
        /// true = the state wears the resting face, replaceable by a chosen expression.
        var baseFace: Bool
        var pose: @Sendable (Double) -> Pose
    }

    static let states: [StateDef] = [
        StateDef(id: .idle, duration: 2.4, morph: 0.45, blinkIn: false, baseBody: true, baseFace: true) { _ in
            Pose()
        },

        StateDef(id: .thinking, duration: 2.6, morph: 0.4, blinkIn: true, baseBody: false, baseFace: false) { t in
            let mid = dotPulse(t, 1)
            // The side dots come out of the ball's flanks: in the video they stay merged
            // with it for 1-2 frames before detaching.
            let emerge = 0.3 + 0.7 * Easing.easeOutCubic(clamp(t / 0.3))
            var pose = Pose()
            // the ball BECOMES the middle dot: the morph stays continuous
            pose.sil = circle(dotR * (1 + (dotPeak - 1) * mid), cx: dotX[1])
            pose.eyeAlpha = 0
            pose.dots = [0, 2].map { i in
                let k = dotPulse(t, Double(i))
                return Dot(x: dotX[i] * emerge, y: 0, r: dotR * (1 + (dotPeak - 1) * k), opacity: 0.55 + 0.45 * k)
            }
            return pose
        },

        StateDef(id: .wink, duration: 1.6, morph: 0.3, blinkIn: true, baseBody: true, baseFace: false) { _ in
            var pose = Pose()
            pose.gaze = HeadGaze(yaw: -5.37, pitch: 4.55, roll: 6.7)
            pose.split = 16.25
            // The closed eye is not the open eye squashed: a horizontal dash WIDER than
            // the open eye (0.447 against 0.236).
            pose.eyes = EyePair(inner: EyeConfig(w: 0.236, h: 0.464, open: 1), outer: EyeConfig(w: 0.447, h: 0.089, open: 1))
            return pose
        },

        StateDef(id: .wide, duration: 1.8, morph: 0.55, blinkIn: true, baseBody: true, baseFace: false) { _ in
            var pose = Pose()
            pose.gaze = HeadGaze(yaw: 6.92, pitch: -21.96, roll: 11.6)
            pose.split = 18.43
            pose.eyes = .same(0.356, 0.875)
            return pose
        },

        // the "!" is back in place at 1.6 + 0.4
        StateDef(id: .alert, duration: 2.4, minDuration: 2, morph: 0.45, blinkIn: false, baseBody: false, baseFace: false) { t in
            // Measured travel: -0.087 -> +0.732 in 1.5 s, ease-in-out, micro-overshoot.
            let p = clamp(t / 1.5)
            let travel = Easing.easeInOutCubic(p) * 0.82 - 0.087
            let back = t > 1.6 ? clamp((t - 1.6) / 0.4) : 0
            let x = travel * (1 - back) + 0.1 * back
            // Secondary buzz at 2.5 Hz, bar and dot in opposite phase.
            let buzz = sin(t * 2.5 * tau) * 0.005
            let tilt = (17.7 * .pi) / 180
            var pose = Pose()
            pose.sil = Silhouette(radii: barItalic, rot: tilt, cx: x, cy: -0.325 - buzz)
            pose.eyeAlpha = 0
            pose.dots = [
                // the dot follows the glyph's axis, 0.580 from the bar's centre
                Dot(x: x - sin(tilt) * 0.58, y: -0.325 + cos(tilt) * 0.58 + buzz * 2.8, r: 0.118, opacity: 1,
                    shape: teardrop, rot: (tilt * 180) / .pi),
            ]
            return pose
        },

        StateDef(id: .notify, duration: 2.2, morph: 0.5, blinkIn: true, baseBody: true, baseFace: false) { t in
            // Pop of the blue dot: peaks +14 % around 0.3 s, then settles.
            let p = clamp(t / 0.45)
            let pop = 1 + (notifPop - 1) * sin(p * .pi) * (1 - p * 0.35)
            let r = notifRadius * (p < 1 ? pop : 1)
            let a = (notifAngle * .pi) / 180
            var pose = Pose()
            // the gaze goes away from the dot
            pose.gaze = HeadGaze(yaw: -21.94, pitch: -5.82, roll: -12.2)
            pose.split = 18.89
            pose.eyes = .same(0.505, 0.498)
            pose.notif = Notif(x: cos(a) * notifDistance, y: sin(a) * notifDistance, r: r, notch: r + notifMargin)
            return pose
        },

        StateDef(id: .exclaim, duration: 2, morph: 0.45, blinkIn: false, baseBody: false, baseFace: false) { _ in
            var pose = Pose()
            pose.sil = Silhouette(radii: barUpright, cy: barUprightCY)
            pose.eyeAlpha = 0
            pose.dots = [Dot(x: -0.012, y: 0.526, r: 0.113, opacity: 1)]
            return pose
        },

        StateDef(id: .sleep, duration: 2.4, morph: 0.5, blinkIn: false, baseBody: false, baseFace: false) { t in
            var pose = Pose()
            // Measured vertical bounce: +-0.19 around +0.11, period 0.6 s.
            pose.sil = circle(0.1585, cy: 0.11 + sin(t * (tau / 0.6)) * 0.19)
            pose.eyeAlpha = 0
            return pose
        },

        StateDef(id: .egg, duration: 1.8, morph: 0.4, blinkIn: true, baseBody: false, baseFace: false) { _ in
            var pose = Pose()
            pose.sil = silhouette(.egg)
            pose.gaze = HeadGaze(yaw: 19.97, pitch: 26.01, roll: -17.1)
            // the eyes close in like the body
            pose.split = 11.07
            pose.eyes = .same(0.164, 0.385)
            return pose
        },

        StateDef(id: .hexagon, duration: 1.6, morph: 0.4, blinkIn: true, baseBody: false, baseFace: false) { _ in
            var pose = Pose()
            pose.sil = silhouette(.hexagon)
            pose.gaze = HeadGaze(yaw: 23.11, pitch: 24.42, roll: -13.3)
            pose.split = 13.37
            pose.eyes = .same(0.177, 0.411)
            return pose
        },

        StateDef(id: .play, duration: 2, morph: 0.5, blinkIn: true, baseBody: false, baseFace: false) { t in
            // The triangle stays almost still while the bundle crosses it.
            let fade = clamp(t / 0.35) * clamp((2.2 - t) / 0.5)
            var pose = Pose()
            pose.sil = spinningTriangle(0)
            pose.gaze = HeadGaze(yaw: 12, pitch: -8, roll: -6)
            pose.split = 15
            pose.eyes = .same(0.18, 0.34)
            // the bundle sweeps right to left over the triangle
            pose.arcs = swoosh.enumerated().map { i, s in
                var seed = s
                seed.cx = 0.45 - t * 0.42
                return ArcSpec(id: "sw\(i)", seed: seed, t: t, opacity: fade)
            }
            return pose
        },

        // the body has relaxed from the triangle to the ball at 1.6 + 0.9
        StateDef(id: .orbit, duration: 3.4, minDuration: 2.5, morph: 0.6, blinkIn: false, baseBody: false, baseFace: false) { t in
            // Measured rotation: ramp over 0.35 s, then 1.25 turns/s (anticlockwise).
            let ramp = Easing.easeInOutCubic(clamp(t / 0.35))
            let rot = -tau * 1.25 * t * ramp
            // The body relaxes from the triangle back to the ball during the orbit.
            let back = Easing.easeInOutCubic(clamp((t - 1.6) / 0.9))
            let tri = spinningTriangle(rot)
            let ball = circle(1, rot: rot)
            let sil = Silhouette(
                radii: tri.radii.enumerated().map { i, r in r + (ball.radii[i] - r) * back },
                rot: rot,
                cx: tri.cx * (1 - back),
                cy: tri.cy * (1 - back),
                sx: 1,
                sy: 1
            )
            let fade = clamp(t / 0.8) * clamp((3.6 - t) / 0.9)
            var pose = Pose()
            pose.sil = sil
            // the eyes race round the sphere ~3x faster than the silhouette
            pose.gaze = HeadGaze(
                yaw: restGaze.yaw + sin(t * 6.5) * 65 * (1 - back),
                pitch: -4 + back * 32,
                roll: -13
            )
            pose.eyes = .same(0.18, 0.34 + back * 0.07)
            // the rings come in one by one over 0.8 s
            pose.arcs = rings.enumerated().map { i, s in
                ArcSpec(id: "rg\(i)", seed: s, t: t, opacity: fade * clamp((t - Double(i) * 0.13) / 0.3))
            }
            return pose
        },

        // Entry into bloub's settings view. The ONE state not measured off the video:
        // orbit's vocabulary (same rings, measured parameters), cut short. Both flags
        // true so a chosen shape morphs into it and gaze tracking applies from frame one.
        StateDef(id: .swirl, duration: 1.3, minDuration: 1.3, morph: 0.3, blinkIn: true, baseBody: true, baseFace: true) { t in
            var pose = Pose()
            // three of orbit's six rings: half the bundle is enough to recognise it
            pose.arcs = rings.prefix(3).enumerated().map { i, s in
                // they come in one after another, then fade before the block ends
                ArcSpec(id: "sw\(i)", seed: s, t: t,
                        opacity: clamp((t - Double(i) * 0.06) / 0.14) * clamp((1.22 - t) / 0.34))
            }
            return pose
        },

        // the body is whole again at 1.7 + 0.7
        StateDef(id: .burst, duration: 2.6, minDuration: 2.4, morph: 0.4, blinkIn: false, baseBody: false, baseFace: false) { t in
            // Measured collapse: 1.0 -> 0.166 in 0.7 s, ease-out, no bounce.
            let collapse = 1 - 0.834 * Easing.easeOutQuint(clamp(t / 0.7))
            let regrow = Easing.easeOutQuint(clamp((t - 1.7) / 0.7))
            var pose = Pose()
            pose.sil = circle(collapse + (1 - collapse) * regrow)
            pose.eyeAlpha = clamp((t - 1.85) / 0.4)
            pose.dots = particles(t, scale: 1)
            pose.dotsBehind = true
            return pose
        },

        // the dot recomposes at 1.85 + 0.6 = 2.45, 0.05 s after the video's cut: the
        // remainder ends during the next fade, as in the reference.
        StateDef(id: .comet, duration: 2.4, minDuration: 2.4, morph: 0.45, blinkIn: false, baseBody: false, baseFace: false) { t in
            let collapse = 1 - (1 - cometDot) * Easing.easeOutQuint(clamp(t / 0.55))
            let regrow = Easing.easeOutQuint(clamp((t - 1.85) / 0.6))
            let fade = clamp((t - 0.15) / 0.25) * clamp((1.95 - t) / 0.3)
            var pose = Pose()
            // The dot drifts 0.035 down then back up (measured wobble).
            pose.sil = circle(collapse + (1 - collapse) * regrow, cy: sin(clamp(t / 1.7) * .pi) * 0.035)
            pose.eyeAlpha = clamp((t - 2) / 0.35)
            pose.arcs = cometRibbons.enumerated().map { i, s in
                ArcSpec(id: "cm\(i)", seed: s, t: t, opacity: fade)
            }
            return pose
        },
    ]

    private static let stateDefs: [StateID: StateDef] = Dictionary(uniqueKeysWithValues: states.map { ($0.id, $0) })

    /// Local time at which each state reads best: the pose the thumbnails show.
    static let poseTimes: [StateID: Double] = [
        .idle: 1, .thinking: 1.1, .wink: 0.8, .wide: 0.8, .alert: 0.75, .notify: 0.9, .exclaim: 0.8,
        .sleep: 0.45, .egg: 0.8, .hexagon: 0.8, .play: 0.9, .orbit: 1.2, .swirl: 0.5, .burst: 0.45,
        .comet: 1.15,
    ]

    /// The order of the full sequence, as in the reference video: the 14-state catalogue.
    static let sequence: [StateID] = [
        .idle, .thinking, .wink, .wide, .alert, .notify, .exclaim, .sleep, .egg, .hexagon, .play,
        .orbit, .burst, .comet,
    ]
}
