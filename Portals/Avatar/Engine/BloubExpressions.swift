// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/expressions.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

/// The bot's resting expression.
///
/// The face is two capsules, so everything rests on four levers: head orientation, eye
/// spacing, eye proportions, and each eye's own tilt. The last one gives anger and
/// sadness, which need MIRRORED tilts that head roll alone cannot give.
///
/// Only the resting state (`idle`, and `swirl`) wears this expression. The video's
/// expressive states (wink, wide eyes, notification) keep their measured faces.
nonisolated extension Bloub {
    /// bloub's ids, kept in French so they match its catalogue one to one.
    enum ExpressionID: String, Sendable, CaseIterable, Codable {
        /// neutral: the pose measured frame by frame on the video
        case neutre
        /// attentive
        case attentif
        /// surprised
        case surpris
        /// excited
        case excite
        /// happy: eyes squinted into arcs, tops converging slightly
        case heureux
        /// laughing
        case hilare
        /// angry
        case colere
        /// sad
        case triste
        /// frightened
        case effraye
        /// suspicious
        case mefiant
        /// confused
        case confus
        /// curious: the head roll carries it
        case curieux
        /// proud
        case fier
        /// shy
        case timide
        /// bored
        case blase
        /// sleepy
        case somnolent

        var expression: Expression { expressionByID[self]! }
    }

    struct Expression: Equatable, Sendable {
        var id: ExpressionID
        var gaze: HeadGaze
        var split: Double
        var eyes: EyePair
    }

    /// `tilt` in degrees, positive = the top of the capsule leans right.
    private static func eye(_ w: Double, _ h: Double, _ tilt: Double = 0, _ open: Double = 1) -> EyeConfig {
        EyeConfig(w: w, h: h, open: open, tilt: tilt)
    }

    /// Both eyes the same, tilts mirrored when `tilt` is given.
    private static func pair(_ w: Double, _ h: Double, _ tilt: Double = 0, _ open: Double = 1) -> EyePair {
        EyePair(inner: eye(w, h, tilt, open), outer: eye(w, h, -tilt, open))
    }

    static let expressions: [Expression] = [
        Expression(id: .neutre, gaze: restGaze, split: eyeSplit,
                   eyes: EyePair(inner: eye(eyeWidth, eyeHeight), outer: eye(eyeWidth, eyeHeight))),
        Expression(id: .attentif, gaze: HeadGaze(yaw: 4, pitch: 5, roll: -4), split: 16, eyes: pair(0.21, 0.44)),
        Expression(id: .surpris, gaze: HeadGaze(yaw: 3, pitch: -3, roll: 0), split: 19, eyes: pair(0.45, 0.47)),
        Expression(id: .excite, gaze: HeadGaze(yaw: 6, pitch: -14, roll: 0), split: 19.5, eyes: pair(0.4, 0.56, -10)),
        Expression(id: .heureux, gaze: HeadGaze(yaw: 5, pitch: 9, roll: 0), split: 17, eyes: pair(0.27, 0.17, 14)),
        Expression(id: .hilare, gaze: HeadGaze(yaw: 4, pitch: 14, roll: 0), split: 18, eyes: pair(0.34, 0.13, 20)),
        // tops converging hard towards the centre, narrowed eyes
        Expression(id: .colere, gaze: HeadGaze(yaw: 3, pitch: 7, roll: 0), split: 17, eyes: pair(0.34, 0.15, 30)),
        // the reverse: tops diverge and the gaze drops
        Expression(id: .triste, gaze: HeadGaze(yaw: 3, pitch: -13, roll: 0), split: 16, eyes: pair(0.22, 0.4, -28)),
        Expression(id: .effraye, gaze: HeadGaze(yaw: 2, pitch: -20, roll: 0), split: 20.5, eyes: pair(0.4, 0.6)),
        // one eye clearly more closed than the other
        Expression(id: .mefiant, gaze: HeadGaze(yaw: 12, pitch: 6, roll: -6), split: 16,
                   eyes: EyePair(inner: eye(0.21, 0.4), outer: eye(0.22, 0.15))),
        // asymmetric on both axes; the squinted eye is flat (ratio 1.6) so its tilt shows
        Expression(id: .confus, gaze: HeadGaze(yaw: -14, pitch: 3, roll: 8), split: 16.5,
                   eyes: EyePair(inner: eye(0.2, 0.44, -18), outer: eye(0.28, 0.17, 14))),
        // the head leans: the roll carries the curiosity
        Expression(id: .curieux, gaze: HeadGaze(yaw: 16, pitch: -9, roll: -15), split: 16.5,
                   eyes: EyePair(inner: eye(0.24, 0.46, -8), outer: eye(0.2, 0.38, -8))),
        Expression(id: .fier, gaze: HeadGaze(yaw: 5, pitch: 17, roll: 0), split: 17, eyes: pair(0.3, 0.15, 18)),
        Expression(id: .timide, gaze: HeadGaze(yaw: -19, pitch: -14, roll: -7), split: 14, eyes: pair(0.17, 0.3)),
        // horizontal slits, gaze off to the side
        Expression(id: .blase, gaze: HeadGaze(yaw: -22, pitch: 2, roll: 0), split: 16, eyes: pair(0.3, 0.12)),
        // half-dropped lids, through `open`: the same vertical squash as a blink
        Expression(id: .somnolent, gaze: HeadGaze(yaw: 6, pitch: -9, roll: -3), split: 16, eyes: pair(0.2, 0.42, 0, 0.42)),
    ]

    private static let expressionByID: [ExpressionID: Expression] =
        Dictionary(uniqueKeysWithValues: expressions.map { ($0.id, $0) })

    static let defaultExpression = ExpressionID.neutre

    private static func lerpEyeConfig(_ a: EyeConfig, _ b: EyeConfig, _ t: Double) -> EyeConfig {
        EyeConfig(w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), open: lerp(a.open, b.open, t), tilt: lerp(a.tilt, b.tilt, t))
    }

    /// Interpolates two expressions: a change glides instead of jumping.
    static func blendExpression(_ a: Expression, _ b: Expression, _ t: Double) -> Expression {
        Expression(
            id: b.id,
            gaze: HeadGaze(
                yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
                pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
                roll: lerp(a.gaze.roll, b.gaze.roll, t)
            ),
            split: lerp(a.split, b.split, t),
            eyes: EyePair(inner: lerpEyeConfig(a.eyes.inner, b.eyes.inner, t), outer: lerpEyeConfig(a.eyes.outer, b.eyes.outer, t))
        )
    }
}
