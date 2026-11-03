import AgentCore
import SwiftUI

/// A Mac's bots, the agents that are talked with rather than set to work in a folder (a
/// Hermes profile), as a strip of avatars on top of its space, spread evenly across the
/// row while they fit and scrolling once they do not (2026-10-23). A tap opens
/// the bot's thread that last ran, or a new thread with it where it has none; its menu
/// starts a new one, opens one of its recent ones, or changes its look. A bot that keeps
/// one ongoing conversation (a Hermes profile's bot chat) has only that: a tap opens it,
/// and its menu offers no other.
struct BotStrip: View {
    let bots: [SidebarAgent]
    let sidebar: AgentSidebar

    /// The room each bot needs: with more bots than the row has room for, it scrolls.
    private static let slot: CGFloat = Platform.isMac ? 56 : 64

    /// The strip's id in its space's list, which Show in Sidebar scrolls to for a bot's
    /// thread in no folder (`AgentSidebar.reveal`).
    static let rowID = "bots"

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                ForEach(bots) { bot in
                    button(for: bot)
                        .frame(minWidth: Self.slot, maxWidth: .infinity)
                }
            }
            ScrollView(.horizontal) {
                HStack(spacing: 0) {
                    ForEach(bots) { bot in
                        button(for: bot)
                            .frame(width: Self.slot)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollEdgeEffectHidden(true, for: .all)
        }
        .padding(.vertical, Theme.grid / 2)
    }

    private func button(for bot: SidebarAgent) -> some View {
        let fleet = sidebar.fleet
        let agent = bot.agent
        return BotButton(
            agent: agent,
            style: fleet.style(for: agent.id),
            activity: fleet.activity(of: agent.id),
            isUnseen: bot.threads.contains(where: \.isUnseen),
            isCurrent: fleet.chat?.agent.id == agent.id,
            recent: Array(bot.threads.prefix(BotButton.recentCount)),
            keepsOneThread: bot.threads.contains { $0.ref.isOngoing },
            asksFolder: fleet.offersFolders(for: agent.id) && !fleet.choosesFolder(for: agent.id),
            hostName: fleet.hosts.count > 1 ? fleet.model(for: agent.id.host)?.host.name : nil,
            onOpen: sidebar.onOpen,
            onNewThread: sidebar.onNewThread,
            onNewThreadChoosingFolder: sidebar.onNewThreadChoosingFolder,
            onEditLook: sidebar.onEditLook
        )
        .equatable()
    }
}

/// One bot's avatar and name, with what its threads are doing at the avatar's corner
/// (`ActivityMark`), and a ring while one of its threads is on screen. Compared by what
/// it shows and its menu offers, not by the actions it is handed: a bot whose threads did
/// not change is not drawn again as another's do.
private struct BotButton: View, Equatable {
    let agent: Agent
    let style: AgentAvatarStyle
    let activity: HostModel.Activity
    /// One of its threads ended out of sight and is not opened yet.
    let isUnseen: Bool
    let isCurrent: Bool
    /// Its threads that last ran, the first of them what a tap opens.
    let recent: [ThreadRecord]
    /// It keeps one ongoing conversation (`ThreadRef.ongoing`): a new thread with it is
    /// that one, and its menu lists no threads.
    let keepsOneThread: Bool
    /// Its menu offers a new thread in a folder of choice: its Mac has folders, and it is
    /// not asked for one.
    let asksFolder: Bool
    /// Its Mac's name, for what the pointer shows, with more than one Mac.
    let hostName: String?
    let onOpen: (ThreadRecord) -> Void
    let onNewThread: (Agent) -> Void
    let onNewThreadChoosingFolder: (Agent) -> Void
    let onEditLook: (Agent) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    /// How many of its threads its menu lists.
    static let recentCount = 6

    private static let avatar: CGFloat = Platform.isMac ? 34 : 40

    static func == (one: BotButton, other: BotButton) -> Bool {
        one.agent == other.agent && one.style == other.style && one.activity == other.activity && one.isUnseen == other.isUnseen
            && one.isCurrent == other.isCurrent && one.recent == other.recent && one.keepsOneThread == other.keepsOneThread
            && one.asksFolder == other.asksFolder
            && one.hostName == other.hostName
    }

    var body: some View {
        // A tap opens it; held, or a secondary click, its menu: a pull-down one on a Mac,
        // which has no "Ask Siri" field as a context menu there has (`ThreadRow`).
        Menu {
            menu
        } label: {
            label
        } primaryAction: {
            swipeGuard { open() }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .tip(hostName.map { "\(agent.displayName) on \($0)" } ?? agent.displayName)
        .accessibilityLabel(agent.displayName)
        .accessibilityValue(Self.spoken(activity, isUnseen: isUnseen))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityHint("Opens its last thread. Hold for more")
        .accessibilityIdentifier("bot-\(agent.id.name)")
    }

    private var label: some View {
        VStack(spacing: 4) {
            RowAvatar(style: style, side: Self.avatar)
                .overlay(alignment: .topTrailing) {
                    if activity != .idle || isUnseen {
                        ActivityMark(activity: activity, unseen: isUnseen)
                            .frame(width: 14, height: 14)
                            .background(AgentSidebar.background, in: .circle)
                            .offset(x: 4, y: -2)
                    }
                }
                .padding(3)
                .overlay {
                    if isCurrent {
                        Circle().strokeBorder(Color.primary.opacity(0.35), lineWidth: 1.5)
                    }
                }
            Text(agent.displayName)
                .font(.app.caption2)
                .foregroundStyle(isCurrent ? .primary : .secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
        .contentShape(.rect)
    }

    @ViewBuilder
    private var menu: some View {
        if !keepsOneThread {
            Button("New thread", systemImage: "square.and.pencil") { onNewThread(agent) }
            if asksFolder {
                Button("New thread in a folder…", systemImage: "folder") { onNewThreadChoosingFolder(agent) }
                    .accessibilityIdentifier("new-thread-in-folder-\(agent.id.name)")
            }
        }
        if !recent.isEmpty, !keepsOneThread {
            Section("Recent") {
                ForEach(recent, id: \.key) { record in
                    Button(record.displayTitle) { onOpen(record) }
                }
            }
        }
        if !keepsOneThread { Divider() }
        Button("Change look", systemImage: "paintpalette") { onEditLook(agent) }
    }

    /// Its ongoing conversation, or its thread that last ran, or else a new thread with it.
    private func open() {
        if let ongoing = recent.first(where: \.ref.isOngoing) {
            onOpen(ongoing)
        } else if let last = recent.first {
            onOpen(last)
        } else {
            onNewThread(agent)
        }
    }

    private static func spoken(_ activity: HostModel.Activity, isUnseen: Bool) -> String {
        AgentSidebar.statusLine(activity) ?? (isUnseen ? "Not opened yet" : "")
    }
}
