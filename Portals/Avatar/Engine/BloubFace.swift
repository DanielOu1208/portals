// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/face.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

/// The eyes are painted on a sphere, not laid flat.
///
/// Measured on the video: the eye nearer the edge is 0.69 times the width of the other
/// and 0.663 times its area, exactly the depth factor of a point on a sphere at that
/// distance from the centre. So each eye takes the sphere's tangent frame, projected
/// orthographically: compression and tilt follow on their own.
///
/// The constants come from fitting that model to the positions and sizes measured frame
/// by frame (residual error about 1 px on a 190 px radius).
nonisolated extension Bloub {
    /// Half the angle between the eyes on the sphere, degrees (about 31 degrees in all).
    static let eyeSplit = 15.46
    /// Resting eye size, in ball radii.
    static let eyeWidth = 0.186
    static let eyeHeight = 0.412

    /// Resting head orientation, fitted on the reference frames.
    static let restGaze = HeadGaze(yaw: 28.49, pitch: 28.62, roll: -13)

    struct HeadGaze: Equatable, Sendable {
        /// Yaw, degrees, positive looks right.
        var yaw: Double
        /// Pitch, degrees, positive looks up.
        var pitch: Double
        /// Roll, degrees, head tilt.
        var roll: Double
    }

    struct EyePose: Equatable, Sendable {
        var x: Double
        var y: Double
        /// Tangent 2x2 matrix [a b c d], as in SVG matrix(a,b,c,d,e,f).
        var a: Double
        var b: Double
        var c: Double
        var d: Double
        /// z of the normal: > 0 means the face is visible.
        var depth: Double
    }

    private typealias Vec3 = (Double, Double, Double)

    private static func deg(_ d: Double) -> Double { (d * .pi) / 180 }

    /// Turns two vectors of an orthonormal frame within their common plane.
    private static func spin(_ u: Vec3, _ v: Vec3, _ angle: Double) -> (Vec3, Vec3) {
        let c = cos(angle)
        let s = sin(angle)
        return (
            (u.0 * c + v.0 * s, u.1 * c + v.1 * s, u.2 * c + v.2 * s),
            (v.0 * c - u.0 * s, v.1 * c - u.1 * s, v.2 * c - u.2 * s)
        )
    }

    /// Head frame, then both eyes. Screen frame: x right, y down, z towards the viewer.
    /// Index 0 is the inner eye, index 1 the outer eye.
    static func eyePoses(_ gaze: HeadGaze, scale: Double, split: Double = eyeSplit) -> [EyePose] {
        var f: Vec3 = (0, 0, 1)
        var right: Vec3 = (1, 0, 0)
        var down: Vec3 = (0, 1, 0)

        // yaw: forward tips towards right
        (f, right) = spin(f, right, deg(gaze.yaw))
        // pitch: forward tips up (away from down)
        (down, f) = spin(down, f, deg(gaze.pitch))
        // roll: the head leans in its own plane
        (right, down) = spin(right, down, deg(gaze.roll))

        func build(_ side: Double) -> EyePose {
            let (ef, er) = spin(f, right, deg(split * side))
            return EyePose(
                x: ef.0 * scale,
                y: ef.1 * scale,
                a: er.0,
                b: er.1,
                c: down.0,
                d: down.1,
                depth: ef.2
            )
        }
        return [build(-1), build(1)]
    }

    /// Resting life: slow gaze drift, blinks, the body's float and breath. Offsets to add
    /// to the current state's pose.
    struct Liveliness: Equatable, Sendable {
        var dYaw: Double
        var dPitch: Double
        var dRoll: Double
        /// 1 = open, 0 = closed (vertical squash in screen space).
        var lid: Double
        var driftX: Double
        var driftY: Double
        var breath: Double
    }

    /// Pre-drawn blink schedule: deterministic and stateless. Like bloub, it stops at
    /// 900 s; `AgentAvatarDirector` re-anchors its clock long before that.
    static let blinkSchedule: [Double] = {
        var rng = Rng(seed: 0x5eed)
        var out: [Double] = []
        var t = 1.4
        while t < 900 {
            out.append(t)
            // 1.9 to 4.6 s between blinks, plus the odd double blink
            t += 1.9 + rng.next() * 2.7
            if rng.next() < 0.18 {
                out.append(t)
                t += 0.24
            }
        }
        return out
    }()

    /// Measured: 1 to 2 frames at 10 fps.
    static let blinkDuration = 0.18

    private static func blinkLid(_ t: Double) -> Double {
        for start in blinkSchedule {
            if t < start { break }
            let k = (t - start) / blinkDuration
            if k >= 0 && k <= 1 {
                // fast close, slightly slower reopening
                return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55
            }
        }
        return 1
    }

    /// `wander` scales the drift of the gaze and `float` the body's float and breath:
    /// 1 is bloub's own, 0 none.
    static func liveliness(_ t: Double, wander: Double = 1, blink: Bool = true, float: Double = 1) -> Liveliness {
        // Periods are coprime: the drift never visibly repeats.
        Liveliness(
            dYaw: (loopNoise(t, period: 11.3, seed: 0.4) * 5.5 + loopNoise(t, period: 3.7, seed: 2.1) * 1.6) * wander,
            dPitch: (loopNoise(t, period: 9.1, seed: 1.3) * 4.2 + loopNoise(t, period: 4.3, seed: 0.7) * 1.3) * wander,
            dRoll: loopNoise(t, period: 13.7, seed: 3.2) * 2.2 * wander,
            lid: blink ? blinkLid(t) : 1,
            // At rest the video is almost still (centre stable to +-0.003): the life is
            // in the gaze and the blinks. Just enough here not to freeze the image.
            driftX: loopNoise(t, period: 7.9, seed: 1.9) * 0.006 * float,
            driftY: loopNoise(t, period: 5.3, seed: 0.3) * 0.007 * float,
            // Width is constant; only the height breathes, very slightly.
            breath: 1 + sin((t / 3.4) * .pi * 2) * 0.005 * float
        )
    }

    /// A blink is a VERTICAL squash in screen space around the eye's centre (measured:
    /// bbox width kept, height down to ~0.35), not a shrink along the capsule's axis.
    static func blinkScale(_ lid: Double) -> Double {
        0.06 + 0.94 * clamp(lid)
    }
}
