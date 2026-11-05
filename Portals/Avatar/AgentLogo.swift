import AgentCore
import SwiftUI

/// How a coding agent's logo (`AgentAvatarStyle.logo`) is drawn with its avatar: in a
/// small round badge just off the avatar's lower-right corner, or, when its look says so,
/// on a glass circle in place of the avatar.
///
/// Sizes are shares of the avatar's side, so the badge sits in the same place at every
/// size. The badge sits in a gap cut out of the avatar, as bloub cuts its notification
/// dot out of the body, so it reads on any colour and over any background.
nonisolated enum AgentLogoArt {
    /// The badge's diameter: small, like a status dot. Larger on a Mac, where it is read
    /// from farther away and would otherwise be a speck.
    static let badgeShare = Platform.isMac ? 0.3 : 0.22
    /// The badge's centre, across and down from the avatar's top-left corner: just past
    /// the body's lower-right edge, so only a sliver of it covers the body. A view can
    /// move it (`agentLogoBadgeCentre`).
    static let badgeCentre = CGPoint(x: 0.85, y: 0.84)
    /// The gap cut around the badge, and around the circle's waiting dot.
    static let gapShare = 0.025
    /// How much of the badge's diameter the logo takes.
    static let logoInBadge = 0.64

    /// The glass circle in place of the avatar, a little wider than the avatar's body,
    /// and on a Mac a little larger again, with more of it the logo.
    static let tileShare = Platform.isMac ? 0.8 : 0.72
    static let logoInTile = Platform.isMac ? 0.58 : 0.52
    /// The dot on the tile's corner while the agent waits for you, a little larger than
    /// bloub's notification dot, which is 0.095 of the avatar's side.
    static let dotShare = 0.11

    /// What the badge's logo sits on: white in light mode, a dark grey in dark, where
    /// the Blossom, Cursor's cube, Factory's mark and OpenCode's turn light.
    static let background = Theme.raisedBackground
    /// A hairline round the badge, for a white one on a white page.
    static let edge = Color.primary.opacity(0.12)
}

extension CodingAgentLogo {
    /// The maker's mark, vector, with the dark-mode version where one is published.
    var image: Image {
        switch self {
        case .claude: Image(.claudeLogo)
        case .codex: Image(.openAILogo)
        case .pi: Image(.piLogo)
        case .cursor: Image(.cursorLogo)
        case .droid: Image(.factoryLogo)
        case .opencode: Image(.openCodeLogo)
        }
    }
}

/// The logo in its round badge.
struct AgentLogoBadge: View {
    var logo: CodingAgentLogo
    var diameter: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(AgentLogoArt.background)
            Circle().strokeBorder(AgentLogoArt.edge, lineWidth: max(diameter * 0.03, 0.5))
            logo.image
                .resizable()
                .scaledToFit()
                .frame(width: diameter * AgentLogoArt.logoInBadge, height: diameter * AgentLogoArt.logoInBadge)
        }
        .frame(width: diameter, height: diameter)
    }
}

extension EnvironmentValues {
    /// Where avatars put their logo badge, as shares of their side across and down.
    @Entry var agentLogoBadgeCentre = AgentLogoArt.badgeCentre
}

/// Puts the badge on an avatar of side `size`, in a gap cut out of it. No logo, no
/// change.
struct AgentLogoBadgeModifier: ViewModifier {
    var logo: CodingAgentLogo?
    var size: CGFloat

    @Environment(\.agentLogoBadgeCentre) private var share

    func body(content: Content) -> some View {
        if let logo {
            let diameter = size * AgentLogoArt.badgeShare
            let gap = size * AgentLogoArt.gapShare
            let centre = CGPoint(x: size * share.x, y: size * share.y)
            content
                .mask {
                    Rectangle()
                        .overlay {
                            Circle()
                                .frame(width: diameter + 2 * gap, height: diameter + 2 * gap)
                                .position(centre)
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                }
                .overlay {
                    AgentLogoBadge(logo: logo, diameter: diameter)
                        .position(centre)
                }
        } else {
            content
        }
    }
}

/// The logo in place of the avatar, on a glass circle like the app's round buttons,
/// giving the one cue the avatar gives that the chat does not say elsewhere: a dot cut
/// into its edge while the agent waits for you (bloub's notification pose). It holds
/// still while the agent works (2026-10-22: "for coding harnesses avatars dont
/// make them pulse"); the orb in the chat, the wash behind it and the sidebar's spinner
/// say that it works. Nothing runs per tile.
struct AgentLogoTile: View {
    enum Cue {
        case none, waiting
    }

    var logo: CodingAgentLogo
    /// The avatar's side.
    var size: CGFloat
    var cue: Cue

    var body: some View {
        tile
            .frame(width: size, height: size)
    }

    private var tile: some View {
        let side = size * AgentLogoArt.tileShare
        return logo.image
            .resizable()
            .scaledToFit()
            .frame(width: side * AgentLogoArt.logoInTile, height: side * AgentLogoArt.logoInTile)
            .frame(width: side, height: side)
            .glassEffect(.regular, in: .circle)
            .modifier(WaitingDot(isOn: cue == .waiting, side: side, size: size))
    }
}

/// An agent's icon at rest, `size` across, for Settings' Agents: its maker's logo or its avatar,
/// by itself, with nothing round it (2026-11-05: "there should be nothing around the
/// icons/avatars just leave the raw image").
struct AgentIcon: View {
    var style: AgentAvatarStyle
    var size: CGFloat

    /// How much of its room a maker's logo takes: nearly all of it, with a little air
    /// round it, about the size an avatar's body comes out at.
    private static let logoShare = 0.84

    /// A program with no agent here: its maker's logo, as its agent would wear it.
    static func style(ofProgram id: String) -> AgentAvatarStyle {
        var style = AgentAvatarStyle.standard
        if let logo = CodingAgentLogo(rawValue: id) {
            style.logo = logo
            style.showsLogo = true
        }
        return style
    }

    var body: some View {
        if let logo = style.logo, style.showsLogo {
            logo.image
                .resizable()
                .scaledToFit()
                .frame(width: size * Self.logoShare, height: size * Self.logoShare)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            // An avatar's square keeps room round its body, so it is drawn larger than its room (`RowAvatar`).
            AgentAvatarView(state: .idle, frozenAt: 1, size: size * 1.36, style: style)
                .frame(width: size, height: size)
        }
    }
}

/// A program's icon: Hermes's own logo, which none of its bots wear, or that of its agent.
struct ProgramIcon: View {
    var programID: String
    var style: AgentAvatarStyle
    var size: CGFloat

    /// How much of its room her drawing takes. It fills its square to the edges, so a
    /// little less than a maker's mark reads as the same size.
    private static let hermesShare = 0.8

    var body: some View {
        if programID == "hermes" {
            Image(.hermesLogo)
                .resizable()
                .scaledToFit()
                .frame(width: size * Self.hermesShare, height: size * Self.hermesShare)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            AgentIcon(style: style, size: size)
        }
    }
}

/// The waiting dot, on the circle's upper-right edge, in a gap of its own.
private struct WaitingDot: ViewModifier {
    var isOn: Bool
    /// The circle's diameter, and the avatar's side.
    var side: CGFloat
    var size: CGFloat

    func body(content: Content) -> some View {
        if isOn {
            let dot = size * AgentLogoArt.dotShare
            let gap = size * AgentLogoArt.gapShare
            // Where the circle crosses its upper-right diagonal.
            let inset = side / 2 * (1 - 1 / 2.squareRoot())
            let centre = CGPoint(x: side - inset, y: inset)
            content
                .mask {
                    Rectangle()
                        .overlay {
                            Circle()
                                .frame(width: dot + 2 * gap, height: dot + 2 * gap)
                                .position(centre)
                                .blendMode(.destinationOut)
                        }
                        .compositingGroup()
                }
                .overlay {
                    Circle()
                        .fill(.primary)
                        .frame(width: dot, height: dot)
                        .position(centre)
                }
        } else {
            content
        }
    }
}

#Preview("Logos") {
    VStack(spacing: 24) {
        ForEach(CodingAgentLogo.allCases, id: \.self) { logo in
            HStack(spacing: 16) {
                AgentAvatarView(state: .idle, frozenAt: 1, size: 40,
                                style: AgentLookCatalogue.style(for: AgentLook(shape: 1, face: 0, tint: 3), logo: logo))
                AgentAvatarView(mood: .thinking, size: 64,
                                style: AgentLookCatalogue.style(for: AgentLook(shape: 1, face: 0, tint: 3), logo: logo))
                AgentAvatarView(state: .notify, frozenAt: 0.9, size: 40,
                                style: AgentLookCatalogue.style(for: AgentLook(shape: 1, face: 0, tint: 3, showsLogo: true), logo: logo))
                AgentAvatarView(mood: .thinking, size: 64,
                                style: AgentLookCatalogue.style(for: AgentLook(shape: 1, face: 0, tint: 3, showsLogo: true), logo: logo))
            }
        }
    }
    .padding(20)
}
