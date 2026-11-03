import AgentCore
import SwiftUI

/// The start of a new thread, in the middle of the empty chat: the agent's avatar, the
/// question, the project it works in, and on a Mac's first thread, where the rest is.
/// The header leaves its avatar out meanwhile (`ChatHeader.showsAgent`), and takes it back
/// as the first message goes and this gives way. 2026-10-22: "when we open a new
/// session we should style the what should … do better so that its like centered and show
/// the project name. and at that time the avatar shouldnt be floating by itself at the top".
/// Before 2026-10-23, a line at the top of the chat (`PORTALS_DEBUG_NEW_THREAD=before`).
/// Then, having seen it: "dont have the avatar in a bubble and make a lot larger so the text
/// overlaps with the bottom a bit": a maker's logo is drawn bare, not on its glass circle,
/// the avatar about twice the header's, and the question comes up over its foot, which
/// fades so the words read.
struct NewThreadStart: View {
    let agent: Agent
    /// The project's name, for a coding agent in a folder that is not General.
    let project: String?
    let mood: AgentMood
    var style: AgentAvatarStyle = .standard
    var hint: String?
    /// Its Mac, agent and folder to change, under the question (`NewThreadPickers`).
    var pickers: NewThreadPickers?
    var onEditLook: () -> Void = {}

    @Environment(\.swipeGuard) private var swipeGuard
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    /// The question's size: the reader's text size on a phone and an iPad, a Mac's own.
    @ScaledMetric(relativeTo: .title3) private var scaledQuestionSize: CGFloat = 20

    /// The avatar's side: about three times the header's, a little smaller in a Mac's window
    /// (2026-10-23: "make the logo even bigger", then "like 20% larger", then
    /// "reduce size of the logo by 10%", then 15% in all, "another 5% smaller").
    private static let baseAvatarSize: CGFloat = Platform.isMac ? 143 : 163
    /// The whole start a fifth larger where there is room for it: a Mac's window, an iPad
    /// not split narrow ("on desktop and ipad if the screen size allows this whole thing
    /// should be about 20% larger").
    private var scale: CGFloat {
        Platform.isMac || (horizontalSizeClass == .regular && verticalSizeClass == .regular) ? 1.2 : 1
    }
    private var avatarSize: CGFloat { Self.baseAvatarSize * scale }
    /// A maker's logo drawn bare: as wide as the glass circle it sat on in the header.
    private var logoSide: CGFloat { avatarSize * AgentLogoArt.tileShare }
    private var questionSize: CGFloat { (AppTextStyles.fixedSize(of: .title3) ?? scaledQuestionSize) * scale }

    private var showsBareLogo: Bool { style.logo != nil && style.showsLogo }
    /// What is drawn of the avatar: a logo its square, an avatar's body less (room under it).
    private var faceHeight: CGFloat { showsBareLogo ? logoSide : avatarSize }
    /// How far the question comes up over the avatar's foot: a tenth of a logo (an avatar's
    /// body leaves room under it in its square, so more of that), little enough that the
    /// logo hardly shows under the words (2026-10-23: "make sure the logos dont
    /// overlap with the text so much that it shows underneath"; a fifth before).
    private var overlap: CGFloat { showsBareLogo ? logoSide * 0.1 : avatarSize * 0.18 }

    var body: some View {
        VStack(spacing: 0) {
            avatar
            // The project in the question itself, not on a line under it (2026-10-23: "it should say like what should claude code work on in Portals").
            Text(question)
                .font(.system(size: questionSize, weight: .semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .padding(.top, -overlap)
            if let pickers {
                pickers
                    .padding(.top, Theme.grid * 2)
            }
            if let hint {
                Text(hint)
                    .font(.app.footnote)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.top, Theme.grid * 2)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, ChatFeature.margin * 2)
        .frame(maxWidth: 480 * scale)
        // Its middle, where it is centred, is the logo's centre, not the block's (2026-10-23: "make sure its centered to the whole app based on the center of the
        // logo"); the question and the hint hang under it.
        .alignmentGuide(VerticalAlignment.center) { _ in faceHeight / 2 }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("new-thread-start")
    }

    private var question: String {
        if let project { return "What should \(agent.displayName) work on in \(project)?" }
        return "What should \(agent.displayName) work on?"
    }

    /// A maker's logo bare, or the avatar, its foot fading under the question.
    @ViewBuilder
    private var face: some View {
        if let logo = style.logo, style.showsLogo {
            logo.image
                .resizable()
                .scaledToFit()
                .frame(width: logoSide, height: logoSide)
        } else {
            AgentAvatarView(mood: mood, size: avatarSize, style: style)
                .environment(\.agentLogoBadgeCentre, CGPoint(x: 0.87, y: 0.56))
        }
    }

    @ViewBuilder
    private var avatar: some View {
        // The fade over a shorter stretch, lower down, as strong as it was where the question
        // comes over it (2026-10-23: "move the area of the gradient down a bit so
        // that the area of the gradient is a bit smaller but like keep the strength of the
        // gradient at the part where the text overlaps").
        // Faint where the words are, so it hardly shows under them.
        let under = max(0.5, 1 - overlap / faceHeight)
        // Short of whole: "slightly too stark" (2026-10-23, "like 90%"; 80% tried,
        // then "go back to 90% opacity").
        let view = face
            .opacity(0.9)
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .black, location: under - 0.17),
                        .init(color: .black.opacity(0.25), location: under),
                        .init(color: .black.opacity(0.05), location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom
                )
            }
        if Platform.isMac {
            // Only looked at, as the window bar's is.
            view.accessibilityHidden(true)
        } else {
            // Tapped, it opens the look for changing, as the header's does.
            Button { swipeGuard(onEditLook) } label: { view }
                .buttonStyle(.plain)
                .accessibilityLabel("Change \(agent.displayName)'s look")
                .accessibilityIdentifier("new-thread-avatar")
        }
    }
}
