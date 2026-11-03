import AgentCore
import SwiftUI

/// An agent's look, picked from bloub's own catalogue (shapes, expressions) so the
/// motion stays bloub's, measured off the reference video.
///
/// A look changes the two things that carry identity: the body shape on the resting
/// states, and the face the avatar rests on. bloub's default is the x.ai bot, a perfect
/// circle (`cercle`) whose eyes glance up and to the right (`neutre`); `.standard` is a
/// pebble (`galet`) with upright eyes that look at you (`attentif`), so it is its own
/// character.
///
/// Without a tint the avatar draws in the label colours: the body, the dots and the
/// notification dot in the primary label colour (black in light mode, white in dark),
/// the orbit rings and the comet's ribbons in the secondary one. With a tint, the body
/// takes it and the rings a lighter version. A ring that passes in front of the body is
/// separated from it by a thin cut, so it reads over the body either way.
///
/// The animated states (thinking dots, orbit, burst...) keep their measured silhouettes;
/// a chosen shape only replaces the body on bloub's `baseBody` states (idle, wink, wide,
/// notify, swirl), and bloub's eye-fit table re-seats the face on the shape.
nonisolated struct AgentAvatarStyle: Hashable, Sendable {
    /// Body shape on the resting states.
    var shape: Bloub.ShapeID
    /// The rest face: idle and talking.
    var rest: Bloub.ExpressionID
    /// The face while the user is typing or speaking.
    var listening: Bloub.ExpressionID
    /// The face after a reply lands.
    var happy: Bloub.ExpressionID
    /// The label colour of the rings and ribbons.
    var ringTone: Tone
    /// The cut around a ring passing in front of the body, in ball radii.
    var ringGap: Double
    /// The body's colour; nil draws in the label colour.
    var tint: Color?
    /// A coding agent's logo, worn as a badge on the avatar's lower-right corner; nil for
    /// every other agent (`CodingAgentLogo`).
    var logo: CodingAgentLogo?
    /// The logo is drawn in place of the avatar, on a plain tile.
    var showsLogo = false

    enum Tone: Hashable, Sendable {
        case primary
        case secondary
    }

    static let standard = AgentAvatarStyle(shape: .galet, rest: .attentif, listening: .curieux, happy: .heureux,
                                           ringTone: .secondary, ringGap: 0.03)

    var bodyShape: Bloub.BodyShape { shape.shape }
}
