import AgentCore
import SwiftUI

/// The agent centred at the top, as a contact in Messages: the animated avatar with the
/// agent's name, and the thread's title once it has one, in a pill under it. Tapping
/// the avatar opens its look for changing. The sidebar button sits on the left, level with
/// the avatar; the right is kept empty as wide (New thread was there until 2026-10-20).
struct ChatHeader: View {
    let agent: Agent
    let title: String?
    let mood: AgentMood
    var style: AgentAvatarStyle = .standard
    let canStartNewThread: Bool
    /// The avatar and the name, left out while a new thread's start has them
    /// (`NewThreadStart`), with the header's height kept so that nothing moves.
    var showsAgent = true
    var onOpenSidebar: () -> Void
    var onNewThread: () -> Void
    var onEditLook: () -> Void = {}
    /// The panel's button, on the right (`ThreadPanel`).
    var panelButton: ThreadPanelButton?
    /// How far down the screen that button's place is: the panel opens there, over it.
    var onPanelButtonTop: (CGFloat) -> Void = { _ in }

    @Environment(\.swipeGuard) private var swipeGuard

    /// How far the pill reaches up behind the avatar: past the room the avatar's canvas
    /// leaves around its body, so the body itself stands a little over the pill.
    private static let overlap = Theme.grid * 2

    var body: some View {
        HStack(alignment: .avatarMiddle) {
            HeaderButton(title: "Agents and threads", systemImage: "sidebar.leading") { swipeGuard(onOpenSidebar) }
                .keyboardShortcut("s", modifiers: [.control, .command])
                .accessibilityIdentifier("open-sidebar")
            Spacer(minLength: Theme.grid)
            VStack(spacing: -Self.overlap) {
                Group {
                    if showsAgent {
                        Button { swipeGuard(onEditLook) } label: {
                            AgentAvatarView(mood: mood, size: 64, style: style)
                                // A coding agent's logo badge sits higher here, clear of the
                                // name the avatar stands over.
                                .environment(\.agentLogoBadgeCentre, CGPoint(x: 0.87, y: 0.56))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Change \(agent.displayName)'s look")
                    } else {
                        // Its room only, while a new thread's start has the avatar: the
                        // header keeps its height, and there is nothing to find or tap.
                        Color.clear
                            .frame(width: 64, height: 64)
                            .accessibilityHidden(true)
                    }
                }
                .alignmentGuide(.avatarMiddle) { $0[VerticalAlignment.center] }
                .zIndex(1)
                // In a glass pill, like a contact's name in Messages, so it stays
                // readable over the chat scrolling under it. The title is as bright as
                // the name: a dimmer one is lost against text behind the glass. A long
                // title gives way before the name does.
                if style.logo == nil || title != nil {
                    HStack(spacing: 0) {
                        if style.logo == nil {
                            Text(agent.displayName)
                                .lineLimit(1)
                                .fixedSize()
                        }
                        if let title {
                            Text(style.logo == nil ? " · \(title)" : title)
                                .lineLimit(1)
                        }
                    }
                    .font(.app.subheadline.weight(.medium))
                    // Like a navigation bar's title, it stops growing at the accessibility sizes.
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .padding(.horizontal, Theme.grid * 1.75)
                    .padding(.vertical, Theme.grid / 2)
                    .glassEffect(.regular, in: .capsule)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel([agent.displayName, title].compactMap(\.self).joined(separator: ", "))
                    .accessibilityAddTraits(.isHeader)
                }
            }
            .opacity(showsAgent ? 1 : 0)
            .allowsHitTesting(showsAgent)
            .accessibilityHidden(!showsAgent)
            .animation(.smooth(duration: 0.35), value: showsAgent)
            .accessibilityIdentifier("chat-header")
            Spacer(minLength: Theme.grid)
            // Where New thread was until 2026-10-20, the panel's button since 2026-10-31
            // (`ThreadPanel`), as wide as the sidebar's button, so the avatar stays in the
            // middle. A thread is started from the sidebar; ⌘N on a keyboard still starts
            // one, with nothing drawn for it.
            Group {
                if let panelButton {
                    panelButton
                } else {
                    Color.clear.accessibilityHidden(true)
                }
            }
            .frame(width: 44, height: 44)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { onPanelButtonTop($0) }
            .background {
                Button("New thread") { swipeGuard(onNewThread) }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(!canStartNewThread)
                    .opacity(0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .pageMargins()
        // A little into the status bar's band, to leave the chat more room, with clear
        // space between the avatar and the Dynamic Island.
        .padding(.top, -Theme.grid)
    }
}

private extension VerticalAlignment {
    /// The middle of the header's avatar, which the header buttons line up with.
    nonisolated enum AvatarMiddle: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat {
            context[VerticalAlignment.center]
        }
    }

    static let avatarMiddle = VerticalAlignment(AvatarMiddle.self)
}

/// A round glass button in the header, the size of a navigation bar button; smaller up in
/// a Mac window's bar, beside the tabs (`TabBar`).
struct HeaderButton: View {
    let title: String
    let systemImage: String
    /// The circle's side.
    var side: CGFloat = 44
    var action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        // The label fills the circle, so a click anywhere on it is the button's: with the
        // circle round a label of the symbol alone, a click near its edge lit the glass up
        // and did nothing (2026-11-01).
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .labelStyle(.iconOnly)
                .font(.app.body.weight(.medium))
                // A bar button's symbol stops growing at the accessibility sizes, so it
                // stays inside its circle.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(width: side, height: side)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isEnabled ? .primary : .tertiary)
        .glassEffect(.regular.interactive(isEnabled), in: .circle)
    }
}

/// Back to the thread that started the one on screen, over a managed thread's chat
/// (2026-10-27: "i think we should add a back button so can go back to the main
/// thread quickly"): a glass pill at the chat's leading edge, as the header's title is in
/// one, with a chevron and the title of the thread it opens. Under the header on a phone,
/// and at the top of the chat under the tabs on a Mac and beside an iPad's sidebar, where
/// there is no header. ⌘[ on a keyboard, as Back is in a Mac's apps. Only over a tab opened
/// from the foot of that thread's chat, which going back closes, and not once the thread is
/// taken over into the sidebar; nothing for a thread no agent started, nor once the one that
/// started it is gone (`Fleet.parent`, `Fleet.back`).
struct ParentThreadButton: View {
    /// The thread that started the one on screen: asked for as this is drawn, so that only
    /// this follows the list.
    let parent: () -> ThreadRecord?
    /// ⌘[ goes back: only for the chat on screen, with nothing over it.
    var answersKeys = true
    let onOpen: (ThreadRecord) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        if let parent = parent() {
            let title = parent.displayTitle
            Button {
                swipeGuard { onOpen(parent) }
            } label: {
                HStack(spacing: Theme.grid * 0.75) {
                    Image(systemName: "chevron.left")
                        .font(.app.footnote.weight(.semibold))
                    Text(title)
                        .lineLimit(1)
                }
                .font(.app.subheadline.weight(.medium))
                // Like the header's title, it stops growing at the accessibility sizes.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .padding(.horizontal, Theme.grid * 1.5)
                .padding(.vertical, Theme.grid * 0.875)
                .glassEffect(.regular.interactive(), in: .capsule)
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(answersKeys ? KeyboardShortcut("[", modifiers: .command) : nil)
            .tip("Back to \(title) (⌘[)")
            .accessibilityLabel("Back to \(title)")
            .accessibilityHint("Opens the thread that started this one")
            .accessibilityIdentifier("parent-thread")
            .frame(maxWidth: .infinity, alignment: .leading)
            .pageMargins()
        }
    }
}
