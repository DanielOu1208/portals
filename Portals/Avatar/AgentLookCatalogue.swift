import AgentCore
import SwiftUI

/// What an `AgentLook`'s indices stand for: the body shapes, resting faces and colours
/// an agent's avatar can have.
///
/// The lists only ever grow at the end. A stored look is three indices, so reordering
/// or removing an entry would re-dress every agent.
nonisolated enum AgentLookCatalogue {
    /// Every body shape bloub has.
    static let shapes: [Bloub.ShapeID] = [.galet, .cercle, .squircle, .capsule, .triangle, .hexagone, .nuage, .goutte]

    /// The faces that read as a calm resting face. bloub has more (angry, scared,
    /// sleepy…), which would be odd on an agent at rest.
    static let faces: [Bloub.ExpressionID] = [.attentif, .neutre, .curieux, .heureux, .fier, .timide]

    /// The colours. The first is the label colour: black in light mode, white in dark.
    static let tints: [Tint] = [
        Tint(name: "Ink", color: nil),
        Tint(name: "Blue", color: .blue),
        Tint(name: "Indigo", color: .indigo),
        Tint(name: "Purple", color: .purple),
        Tint(name: "Pink", color: .pink),
        Tint(name: "Red", color: .red),
        Tint(name: "Orange", color: .orange),
        Tint(name: "Green", color: .green),
        Tint(name: "Mint", color: .mint),
        Tint(name: "Teal", color: .teal),
        Tint(name: "Cyan", color: .cyan),
        Tint(name: "Brown", color: .brown),
    ]

    struct Tint: Hashable, Sendable {
        var name: String
        /// nil is the label colour.
        var color: Color?
    }

    static let size = AgentLook.Catalogue(shapes: shapes.count, faces: faces.count, tints: tints.count)

    /// The default colour for a coding agent wearing its maker's logo: orange for Claude,
    /// blue for the others.
    static func defaultTint(for logo: CodingAgentLogo) -> Int {
        switch logo {
        case .claude: 6
        case .codex, .pi, .cursor, .droid, .opencode: 1
        }
    }

    /// The look as something to draw, with `logo` for a coding agent (shown in place of
    /// the avatar when the look says so). An index from a newer version of the app that
    /// this one does not know falls back to the first entry.
    static func style(for look: AgentLook, logo: CodingAgentLogo? = nil) -> AgentAvatarStyle {
        let rest = faces.indices.contains(look.face) ? faces[look.face] : faces[0]
        return AgentAvatarStyle(
            shape: shapes.indices.contains(look.shape) ? shapes[look.shape] : shapes[0],
            rest: rest,
            // The listening face has to differ from the resting one to be seen.
            listening: rest == .curieux ? .attentif : .curieux,
            happy: rest == .heureux ? .fier : .heureux,
            ringTone: .secondary,
            ringGap: 0.03,
            tint: tints.indices.contains(look.tint) ? tints[look.tint].color : nil,
            logo: logo,
            showsLogo: look.shows(logo)
        )
    }

    /// Looks for every host's agents, the hosts in the sidebar's order: looks chosen by
    /// hand are kept as they are; others are kept unless an agent earlier in the sidebar
    /// is drawn the same; new agents get a shape and a colour no other agent on their
    /// host has, and a pairing of the two no agent anywhere has (`AgentLook.assign`). New
    /// agents are given a colour, never ink, so agents differ at a glance; ink can still
    /// be chosen by hand.
    static func assign(to agents: [Agent.ID], keeping saved: [Agent.ID: AgentLook], origins: [Agent.ID: LookOrigin]) -> [Agent.ID: AgentLook] {
        AgentLook.assign(to: agents, keeping: saved, origins: origins, in: size, firstTint: 1)
    }
}
