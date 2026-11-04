import AgentCore
import SwiftUI
import UIKit

// The panel over a chat, as the Codex app has one (2026-10-31): how much of the
// plan the thread's agent has used, what its repository holds uncommitted (one line, which
// opens it all as one diff), the thread's folder opened in an app on the host, and how the
// host is reached. A small card, compact (2026-11-01: "it should just be an overlay
// card on the mac app", "make everything more compact"), opened by a glass button: on a
// phone the header's right one, on a Mac and beside an iPad's sidebar one under the tabs,
// in the right corner. A tap beside it closes it. What runs in the background stays at the
// foot of the chat (2026-11-01: "keep subagents and managed threads in the actual
// thread").

enum ThreadPanel {
    /// The card's width.
    static let width: CGFloat = Platform.isMac ? 280 : 300
    /// The room between the card's edges and what is in it, the same on every side.
    static let inset: CGFloat = 14
    static let corner: CGFloat = 20
    /// Whether a thread's folder can be opened in an app on the host: from a Mac alone (2026-11-01: "there should not be any open in for phone or ipad"), and so its apps, some
    /// 40 KB, are asked for only there.
    static let opensInApps = Platform.isMac
    /// Where VoiceOver goes as the panel is opened or closed.
    enum Focus: Hashable {
        case card, button
    }

    /// The app Open in shows, the one last opened.
    static let openInKey = "threadPanel.openIn"
    /// Open where the tabs are, kept from one launch to the next.
    static let openKey = "threadPanel.open"

    /// Where the tabs are, the card's top and its button's: as far under the tabs as from
    /// the window's edge (2026-11-01: "too much empty space above it"), from the
    /// tabs' foot, not the bar's, which on a Mac reaches lower. From the bar's foot.
    static let top: CGFloat = TabBar.top + TabBar.tabHeight + TabBar.inset - TabBar.height
    /// What the card takes of a chat `width` wide at its right, its room to the edge too.
    private static let room: CGFloat = width + TabBar.inset

    /// Whether the card fits beside the chat's column in a chat `width` wide, the column
    /// moved as far left as it goes (2026-11-01: "decrease the empty space on the
    /// left of the chat until theres enough to fit the panel").
    static func fits(chatWidth: CGFloat) -> Bool {
        chatWidth >= WindowLayout.chatColumnWidth + room
    }

    /// How far left of the middle the column goes to clear the card: none while it is
    /// clear already.
    static func columnShift(chatWidth: CGFloat) -> CGFloat {
        let column = min(WindowLayout.chatColumnWidth, chatWidth)
        let middle = (chatWidth - column) / 2
        return min(max(0, middle + column - (chatWidth - room)), middle)
    }
}

// MARK: The host

/// The host a thread runs on, as the panel's last line says it.
struct ThreadPanelHost: Equatable {
    var name: String
    /// What kind of computer it is, as its tab shows it (`HostConfig.macSymbol`).
    var symbol = "laptopcomputer"
    /// Its General folder, which a thread working there is in no project of.
    var generalFolder: String?
    var isConnected: Bool
    var problem: String?
    var route: ConnectionRoute = .direct
    /// The host's address: its name or IP.
    var address: String?
    /// The version of portals-host it runs, when it said.
    var version: String?
    /// A later version that is out.
    var latest: String?

    /// How it is reached, in a word or two.
    var reach: String {
        guard isConnected else { return "Not connected" }
        if route == .relay { return "Relay" }
        if let address, Self.isTailscale(address) { return "Tailscale" }
        if let address, URL.isLoopback(host: address) { return "This Mac" }
        return "Direct"
    }

    /// A Tailscale name (`*.ts.net`) or address (100.64.0.0/10).
    static func isTailscale(_ address: String) -> Bool {
        if address.hasSuffix(".ts.net") { return true }
        let parts = address.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64 ... 127).contains(parts[1])
    }
}

// MARK: What the host says

/// What one chat's panel has heard, asked again as it opens, as a turn ends, and each minute
/// it stays open.
@MainActor
@Observable
final class ThreadPanelState {
    enum Load<Value: Hashable>: Hashable {
        case loading
        case loaded(Value)
        case failed(String)
    }

    /// While nothing is known of its repository: being asked, or why it could not be.
    /// nil from a host that does not say.
    private var gitAsked: Load<GitState>?
    /// Why the last Open in, or opening the changes, did not work.
    private(set) var notice: String?
    /// The app being opened, while the host is at it.
    private(set) var opening: HostApp.ID?
    /// The changes being fetched, to be opened as they come.
    private var fetchingChanges: Task<Void, Never>?

    var fetchingDiff: Bool { fetchingChanges != nil }

    /// What is known of the plan of the chat's agent, from any chat that asked.
    func usage(for chat: ThreadController) -> UsageLimits? {
        ThreadPanelMemory.shared.usage[chat.agent.id] ?? nil
    }

    /// What is known of the thread's repository.
    func git(for chat: ThreadController) -> Load<GitState>? {
        if let key = chat.thread?.key, let known = ThreadPanelMemory.shared.git[key] { return .loaded(known) }
        return gitAsked
    }

    func refresh(_ chat: ThreadController) async {
        guard let host = chat.panelHost, let thread = chat.thread?.id else {
            gitAsked = nil
            return
        }
        let memory = ThreadPanelMemory.shared
        let agent = chat.agent.id
        let readsUsage = await host.readsUsage ?? false
        let readsGit = await host.readsGitStatus ?? false
        let opens = ThreadPanel.opensInApps ? await host.opensFolders ?? false : false
        if !readsUsage {
            memory.forgetUsage(of: agent)
        }
        if !readsGit {
            gitAsked = nil
            if let key = chat.thread?.key { memory.forgetGit(of: key) }
        } else if gitAsked == nil {
            gitAsked = .loading
        }
        if !opens { memory.forgetApps(on: agent.host) }
        // Each shown as it comes, not all at the slowest's time, and kept whatever comes on
        // screen meanwhile.
        let usageAnswer = Task {
            guard readsUsage else { return }
            // A failure stays beside known windows in the shared memory.
            try? await memory.askUsage(of: agent, thread: thread, from: host)
        }
        let gitAnswer = Task {
            if readsGit { await refreshGit(chat) }
        }
        let appsAnswer = Task {
            if opens { await memory.askApps(on: agent.host, from: host) }
        }
        _ = await (usageAnswer.value, gitAnswer.value, appsAnswer.value)
    }

    /// Ahead of the panel's opening, as the chat comes on screen.
    func preload(_ chat: ThreadController) async {
        guard let host = chat.panelHost, let thread = chat.thread?.id else { return }
        await ThreadPanelMemory.shared.preload(from: host, host: chat.agent.id.host, threads: [chat.agent.id: thread], asksApps: ThreadPanel.opensInApps)
    }

    func refreshGit(_ chat: ThreadController) async {
        guard let host = chat.panelHost, let key = chat.thread?.key, await host.readsGitStatus == true else { return }
        do {
            try await ThreadPanelMemory.shared.askGit(of: key, from: host)
        } catch {
            // A failure to ask again keeps what was heard before.
            gitAsked = .failed(error.localizedDescription)
        }
    }

    func open(_ app: HostApp, for chat: ThreadController) async {
        guard let host = chat.panelHost, let thread = chat.thread?.id else { return }
        opening = app.id
        defer { opening = nil }
        do {
            try await host.openFolder(of: thread, in: app.id)
        } catch {
            await say(error.localizedDescription)
        }
    }

    /// Fetches everything not committed and hands it to `show`, unless the chat has left the
    /// screen or the card has closed by then (`stopFetchingChanges`): it would open over
    /// whatever is on screen now.
    func showChanges(for chat: ThreadController, in show: @escaping (TurnDiff, TurnDiff.Origin) -> Void) {
        fetchingChanges?.cancel()
        fetchingChanges = Task {
            let changes = await changes(for: chat)
            guard !Task.isCancelled else { return }
            fetchingChanges = nil
            if let changes { show(changes.diff, changes.origin) }
        }
    }

    func stopFetchingChanges() {
        fetchingChanges?.cancel()
        fetchingChanges = nil
    }

    /// Everything not committed, as one diff for the turn diff's panel, its files named as
    /// a turn's are: from the thread's folder when that is the repository's top, else in
    /// full, which "Open File" reads either way. How many files differ in all comes with it,
    /// from the same look at the repository, as the diff is only of those the host lists.
    private func changes(for chat: ThreadController) async -> (diff: TurnDiff, origin: TurnDiff.Origin)? {
        guard let host = chat.panelHost, let key = chat.thread?.key else { return nil }
        do {
            let answer = try await host.gitDiff(of: key.id)
            var diff = answer.diff
            // A thread opened from the list has its folder from the host, none chosen for it.
            if (chat.thread?.workingDirectory ?? chat.folder?.path) != answer.root {
                for index in diff.files.indices {
                    diff.files[index].path = (answer.root as NSString).appendingPathComponent(diff.files[index].path)
                }
            }
            return (diff, .uncommitted(total: answer.total))
        } catch {
            if !Task.isCancelled { Task { await say(error.localizedDescription) } }
            return nil
        }
    }

    private func say(_ text: String) async {
        notice = text
        try? await Task.sleep(for: .seconds(4))
        if notice == text { notice = nil }
    }
}

/// Asks the host what the panel shows, as it opens and each minute it stays open, or ahead of
/// its opening: while the chat is on screen, its host is connected, and a window can be seen.
/// Nobody is reading it otherwise, and each round can start a Claude Code only to ask, or call
/// Factory's or Cursor's service. It goes on as soon as one can be seen, and ahead of its
/// opening only the once: uncovering a window nobody has opened the panel in asks nothing. Here
/// rather than in the chat, whose body does not need working out again for any of this.
struct PanelAsking: ViewModifier {
    let chat: ThreadController
    let state: ThreadPanelState
    let isShown: Bool
    let isOpen: Bool
    let isConnected: Bool

    @Environment(\.scenePhase) private var scenePhase
    /// What the preload was last made for, until the chat leaves the screen or the host goes.
    @State private var preloaded: Load?

    /// What asking again follows: on screen, open, the thread, the connection, in sight.
    private struct Load: Hashable {
        let isShown: Bool
        let isOpen: Bool
        let thread: ThreadRef.ID?
        let connected: Bool
        let isSeen: Bool
    }

    private func load(isOpen: Bool, isSeen: Bool) -> Load {
        Load(isShown: isShown, isOpen: isOpen, thread: chat.thread?.id, connected: isConnected, isSeen: isSeen)
    }

    func body(content: Content) -> some View {
        let isSeen = scenePhase != .background && !WindowVisibility.shared.isHidden
        let closed = load(isOpen: false, isSeen: true)
        content
            // Being seen again matters only to an open panel, or to a preload still to be made.
            .task(id: !isOpen && preloaded == closed ? closed : load(isOpen: isOpen, isSeen: isSeen)) {
                guard isShown, isConnected else {
                    preloaded = nil
                    return
                }
                guard isSeen else { return }
                guard isOpen else {
                    // Closing it asks nothing: what it shows was asked for as it stood open.
                    guard preloaded != closed else { return }
                    preloaded = closed
                    return await state.preload(chat)
                }
                preloaded = closed
                // Asked again each minute it stays open (the host asks an agent at most so often).
                while !Task.isCancelled {
                    await state.refresh(chat)
                    try? await Task.sleep(for: .seconds(60))
                }
            }
            // What a turn changed is in the repository once it ends.
            .onChange(of: chat.isRunning) { _, running in
                guard !running, isOpen, isShown, isSeen else { return }
                Task { await state.refreshGit(chat) }
            }
    }
}

// MARK: The button

/// The glass button that opens the panel, gone while it is open: the panel's own ✕ is where
/// it was.
struct ThreadPanelButton: View {
    var side: CGFloat = 44
    let focus: AccessibilityFocusState<ThreadPanel.Focus?>.Binding
    let action: () -> Void

    var body: some View {
        HeaderButton(title: "Show Panel", systemImage: "sidebar.trailing", side: side, action: action)
            .tip("Show Panel")
            .accessibilityIdentifier("thread-panel-button")
            .accessibilityFocused(focus, equals: .button)
    }
}

// MARK: The card

/// The panel as a card over the chat.
struct ThreadPanelCard<Content: View>: View {
    /// Over the chat, not beside it: VoiceOver keeps to the card until it closes.
    let isModal: Bool
    /// The escape gesture, which closes it as a tap beside it does.
    let onEscape: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(width: ThreadPanel.width, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: ThreadPanel.corner))
            // A container, so that its rows keep their own identifiers.
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(isModal ? .isModal : [])
            .accessibilityAction(.escape, onEscape)
            .accessibilityIdentifier("thread-panel")
    }
}

/// What the panel holds, laid out as the Codex app's panel is (2026-11-01: "the
/// name of the project at the top and then the diffs, then the open in, then the rate
/// limits, then the device info"): the project's name, quiet, at the top; rows of a symbol,
/// a title and what goes at the end; parts between thin rules, each headed as the Codex
/// app heads them.
struct ThreadPanelContent: View {
    let chat: ThreadController
    let state: ThreadPanelState
    let host: ThreadPanelHost
    /// Its close button, at the end of the project's line, just where the button that opened
    /// it was, on every device (2026-11-01: "a button in the panel that is aligned
    /// with the open button").
    let onClose: () -> Void
    /// How wide and tall that button was: the ✕ takes the same room, in the card's corner.
    let closeSide: CGFloat
    /// The agent's colour, its avatar's and its chat's wash: the usage bars' (2026-11-01). The app's accent where it has none.
    var tint: Color?
    /// Where VoiceOver goes as it opens: to its first line.
    let focus: AccessibilityFocusState<ThreadPanel.Focus?>.Binding

    @Environment(\.swipeGuard) private var swipeGuard

    /// The project the thread works in, never the agent (2026-11-01: "it should
    /// show the project name not the agent name"): its folder's name as the host reported
    /// it, or the one chosen for a new thread, else no project.
    private var project: String {
        if let name = chat.thread?.folderName(general: host.generalFolder) { return name }
        if let folder = chat.folder { return folder.isGeneral ? Folder.generalName : folder.name }
        return Folder.generalName
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heading
                .padding(.horizontal, ThreadPanel.inset)
            // As tall as they are, up to the room there is; then they scroll under the
            // heading, its ✕ always in reach (a short window, the largest text, the keyboard).
            ViewThatFits(in: .vertical) {
                rows
                ScrollView { rows }
                    .scrollBounceBehavior(.basedOnSize)
                    // A scroll view draws on past its frame, into the safe area under the card.
                    .clipShape(.rect(cornerRadii: .init(bottomLeading: ThreadPanel.corner, bottomTrailing: ThreadPanel.corner)))
            }
        }
        .font(.app.subheadline)
        .animation(.smooth(duration: 0.25), value: state.notice)
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let git = state.git(for: chat) {
                ChangesLine(chat: chat, state: state, load: git)
            }
            if ThreadPanel.opensInApps, let apps = ThreadPanelMemory.shared.apps[chat.agent.id.host], !apps.isEmpty, chat.thread != nil {
                OpenInLine(chat: chat, state: state, apps: apps)
            }
            if let usage, !usage.windows.isEmpty {
                PartRule()
                UsagePart(
                    agent: chat.agent.displayName, limits: usage,
                    failure: ThreadPanelMemory.shared.usageFailures[chat.agent.id],
                    asOf: ThreadPanelMemory.shared.usageAsOf(of: chat.agent.id, isConnected: host.isConnected),
                    tint: tint
                )
                .transition(.opacity)
            } else if let note = usage?.blockingNote {
                Text(note)
                    .font(.app.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.grid)
            }
            PartRule()
            DeviceRow(host: host)
            if let notice = state.notice {
                Text(notice)
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Theme.grid)
                    .transition(.opacity)
            }
        }
        // The same room at the sides and the foot; at the top, the project's line, as tall as
        // the ✕ in the corner.
        .padding(.horizontal, ThreadPanel.inset)
        .padding(.bottom, ThreadPanel.inset)
        // Preloaded limits draw at once. A first answer arriving while open eases the
        // rows into place; no room is held for an agent that may have no limits.
        .animation(.smooth(duration: 0.25), value: usage?.windows.isEmpty == false)
    }

    private var usage: UsageLimits? { state.usage(for: chat) }

    private var heading: some View {
        HStack(spacing: 0) {
            Text(project)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityLabel("Panel, \(project)")
                .accessibilityFocused(focus, equals: .card)
            Spacer(minLength: Theme.grid)
            Button {
                swipeGuard(onClose)
            } label: {
                // An ✕, as what closes it (2026-11-01).
                Image(systemName: "xmark")
                    .foregroundStyle(.secondary)
                    .frame(width: closeSide, height: closeSide)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .tip("Hide Panel")
            .accessibilityLabel("Hide Panel")
            .accessibilityIdentifier("thread-panel-close")
            // Out to the card's edge, past the room the rest keeps.
            .padding(.trailing, -ThreadPanel.inset)
        }
        .frame(height: closeSide)
    }
}

/// A thin rule between parts, with the room the Codex app's panel leaves round one.
private struct PartRule: View {
    var body: some View {
        Divider().padding(.vertical, Theme.grid * 1.25)
    }
}

// MARK: Usage

/// How much of the plan is left, as CodexBar shows it (2026-11-01): the plan as
/// people name it ("Claude Max"), then for each window how much is left and when it
/// resets, a bar of what is left with a mark where an even pace would be, and the pace:
/// how much is in reserve or over, and whether it lasts until the reset.
private struct UsagePart: View {
    let agent: String
    let limits: UsageLimits
    /// Why they could not be asked again: what is known stays, not the whole truth by itself.
    let failure: String?
    /// When what is known was true, where that is not just now.
    let asOf: Date?
    let tint: Color?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                // Headed as the Codex app heads its parts ("Subagents"): the plan as people
                // name it (2026-11-01: "it should just say claude max").
                Text(limits.title ?? agent)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let asOf {
                    Text(Self.asOf(asOf))
                        .font(.app.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        // Numbers from the last launch or connection are asked again at once:
                        // said only if the answer is late.
                        .modifier(LateReveal(isWaiting: true))
                }
            }
            // Asked each minute while open: the times and the pace follow it.
            TimelineView(.periodic(from: .now, by: 60)) { context in
                VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
                    ForEach(limits.windows) { window in
                        UsageWindowView(window: window, now: context.date, asOf: asOf, tint: tint)
                    }
                }
            }
            if let note = limits.note {
                Text(note).font(.app.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let failure {
                Text(failure).font(.app.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-panel-usage")
    }

    /// "As of 3:05 PM", with the day when it was not today.
    static func asOf(_ date: Date) -> String {
        "As of \(date.formatted(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened))"
    }
}

/// What says an answer is on its way shows only once it is late: most come within a blink,
/// which a spinner only made flash (2026-11-01: "it does take less than second but
/// still shows loading"). These labels keep their room; usage without windows has none.
private struct LateReveal: ViewModifier {
    let isWaiting: Bool

    @State private var isLate = false

    func body(content: Content) -> some View {
        content
            .opacity(!isWaiting || isLate ? 1 : 0)
            .task(id: isWaiting) {
                isLate = false
                guard isWaiting else { return }
                try? await Task.sleep(for: .milliseconds(400))
                if !Task.isCancelled { isLate = true }
            }
    }
}

private struct UsageWindowView: View {
    let window: UsageLimits.Window
    let now: Date
    /// When what is known of the plan was true, where that is not just now.
    let asOf: Date?
    let tint: Color?

    /// When this window's numbers were true, where that is not just now: its own time, as a
    /// window kept from an earlier answer has one, or the plan's.
    private var heard: Date? { window.heardAt ?? asOf }

    var body: some View {
        // Past its reset, what was said of it is over, used up or not, whether the answer
        // that would say so has come or not.
        let hasReset = window.hasReset(at: now)
        let left = hasReset ? nil : window.left
        let pace = hasReset ? nil : window.pace(at: heard ?? now)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                // The size of the plan's name over it (2026-11-01).
                Text(heading(left: left, hasReset: hasReset))
                    .lineLimit(1)
                    // How much is left is what it is for ("Weekly Fable 100…"): when it
                    // resets gives way first, to its time alone.
                    .layoutPriority(1)
                Spacer(minLength: Theme.grid)
                if let resets = window.resetsAt, resets > now {
                    let time = Self.duration(resets.timeIntervalSince(now))
                    ViewThatFits(in: .horizontal) {
                        Text("Resets in \(time)")
                        Text(time)
                    }
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    // What is left after the heading, before the space between them.
                    .layoutPriority(0.5)
                }
            }
            if !hasReset {
                // None where the agent has not said how much is used: an empty bar says none is left.
                if let left {
                    UsageBar(left: left, paceMark: pace.map(\.expectedLeft), onPace: (pace?.reserve ?? 0) >= 0, tint: tint)
                }
                if let line = paceLine(pace) {
                    Text(line)
                        .font(.app.caption)
                        .foregroundStyle(heard == nil && pace?.runsOutAt != nil ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility(left: left, pace: pace, hasReset: hasReset))
    }

    private func heading(left: Double?, hasReset: Bool) -> String {
        let name = window.name.prefix(1).uppercased() + window.name.dropFirst()
        if hasReset { return "\(name) has reset" }
        if window.isUsedUp { return "\(name) used up" }
        return left.map { "\(name) \(Int($0.rounded()))% left" } ?? name
    }

    /// The line under the bar. For numbers from a while ago, how they stood when heard, and
    /// not whether they last from now on; a window kept from an earlier answer says when
    /// that was here, the plan's own time being over all of them.
    private func paceLine(_ pace: UsagePace?) -> String? {
        let own = window.heardAt.map(UsagePart.asOf)
        guard let pace else { return own }
        guard heard != nil else { return Self.paceLine(pace, now: now) }
        return [Self.reserve(pace), own].compactMap(\.self).joined(separator: " · ")
    }

    /// "19% in reserve", "8% over pace".
    private static func reserve(_ pace: UsagePace) -> String {
        let points = Int(abs(pace.reserve).rounded())
        return pace.reserve >= 0 ? "\(points)% in reserve" : "\(points)% over pace"
    }

    /// "19% in reserve · Lasts until reset", "8% over pace · Runs out in 1d 4h".
    static func paceLine(_ pace: UsagePace, now: Date) -> String {
        let lasts = pace.runsOutAt.map { "Runs out in \(duration($0.timeIntervalSince(now)))" } ?? "Lasts until reset"
        return "\(reserve(pace)) · \(lasts)"
    }

    /// "5d 13h", "2h 17m", "35m": the two largest units.
    static func duration(_ seconds: TimeInterval) -> String {
        let minutes = max(Int(seconds / 60), 1)
        let days = minutes / 1440, hours = minutes % 1440 / 60, rest = minutes % 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return rest > 0 ? "\(hours)h \(rest)m" : "\(hours)h" }
        return "\(rest)m"
    }

    private func accessibility(left: Double?, pace: UsagePace?, hasReset: Bool) -> String {
        var parts = [heading(left: left, hasReset: hasReset)]
        if let resets = window.resetsAt, resets > now { parts.append("resets in \(Self.duration(resets.timeIntervalSince(now)))") }
        if !hasReset, let line = paceLine(pace) { parts.append(line) }
        return parts.joined(separator: ", ")
    }
}

/// What is left of a window as a bar in the agent's colour (red once nearly none is), with
/// a mark where an even pace would be: green while there is more left than that, red once
/// there is less.
private struct UsageBar: View {
    let left: Double
    let paceMark: Double?
    let onPace: Bool
    let tint: Color?

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            // The bar, and over it what is left and the mark, as overlays: the mark, taller
            // than the bar, would make it as tall in a stack.
            Capsule().fill(.primary.opacity(0.1))
                // A little quieter than the agent's colour, so the mark reads over it
                // (2026-11-01: "the colors are slightly too bright").
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill((left <= 10 ? Color.red : tint ?? .accentColor).opacity(0.62))
                        .frame(width: width * min(max(left, 0), 100) / 100)
                }
                .overlay(alignment: .leading) {
                    if let paceMark {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(onPace ? Color.green : .red)
                            .overlay { RoundedRectangle(cornerRadius: 1.5).stroke(.black.opacity(0.45), lineWidth: 0.75) }
                            .frame(width: 3, height: 9)
                            .offset(x: min(max(width * paceMark / 100 - 1.5, 0), width - 3))
                    }
                }
        }
        // 4 points (2026-11-01: "a bit thinner", "still too thick"), the mark
        // standing out over it into the room left above and below.
        .frame(height: 4)
        .padding(.vertical, 2.5)
    }
}

// MARK: Changes

/// The branch and what is not committed, on one line (2026-11-01: "the changes and
/// main thing should just be on one line"), which opens all of it as one diff.
private struct ChangesLine: View {
    let chat: ThreadController
    let state: ThreadPanelState
    let load: ThreadPanelState.Load<GitState>

    @Environment(\.turnDiffPresenter) private var presenter
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        switch load {
        case .loading:
            line(Text("Changes").foregroundStyle(.secondary)) { ProgressView().controlSize(.small) }
                .modifier(LateReveal(isWaiting: true))
        case let .failed(message):
            // Under its name, all of it: the host's sentence on why, for the person to read.
            VStack(alignment: .leading, spacing: 0) {
                line(Text("Changes").foregroundStyle(.secondary)) { EmptyView() }
                Text(message).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        case .loaded(.noRepository):
            line(Text("Changes").foregroundStyle(.secondary)) { Text("No git repository").foregroundStyle(.tertiary) }
        case let .loaded(.branchOnly(branch, commit)):
            line(Branch(name: branch ?? commit ?? "–", ahead: 0, behind: 0)) { Text("git not installed").foregroundStyle(.tertiary).fixedSize() }
        case let .loaded(.status(status)):
            Button {
                swipeGuard { state.showChanges(for: chat) { presenter?.show($0, origin: $1) } }
            } label: {
                line(Branch(
                    name: status.branch ?? status.commit ?? "–",
                    ahead: status.upstream == nil ? 0 : status.ahead, behind: status.upstream == nil ? 0 : status.behind
                )) {
                    // Whole, the branch's name giving way to it (`Branch`): squeezed by a long
                    // name, these went down the card a letter at a time.
                    HStack(spacing: Theme.grid) {
                        if status.total == 0 {
                            Text("No changes").foregroundStyle(.tertiary)
                        } else {
                            Text(status.total == 1 ? "1 file" : "\(status.total) files").foregroundStyle(.secondary)
                            if status.hasCounts { ChangeCounts(added: status.added, removed: status.removed) }
                            Group {
                                if state.fetchingDiff {
                                    ProgressView().controlSize(.mini)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .font(.app.caption2.weight(.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(width: 10)
                        }
                    }
                    .fixedSize()
                }
            }
            .buttonStyle(.plain)
            .disabled(status.total == 0 || state.fetchingDiff)
            .accessibilityLabel(accessibility(status))
            .accessibilityHint("Shows the changes")
            .accessibilityIdentifier("thread-panel-changes")
        }
    }

    /// What the line says, the branch too: "On main, 2 ahead, 1 behind. 3 files uncommitted: 8
    /// lines added, 2 removed".
    private func accessibility(_ status: GitStatus) -> String {
        var branch = ["On \(status.branch ?? status.commit ?? "no branch")"]
        if status.upstream != nil {
            if status.ahead > 0 { branch.append("\(status.ahead) ahead") }
            if status.behind > 0 { branch.append("\(status.behind) behind") }
        }
        let files = status.total == 1 ? "1 file" : "\(status.total) files"
        let changes = status.total == 0 ? "No uncommitted changes"
            : status.hasCounts ? "\(files) uncommitted: \(status.added) lines added, \(status.removed) removed" : "\(files) uncommitted"
        return "\(branch.joined(separator: ", ")). \(changes)"
    }

    private func line<Leading: View, Trailing: View>(_ leading: Leading, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: Theme.grid) {
            leading
            Spacer(minLength: Theme.grid)
            trailing()
        }
        .frame(minHeight: 30)
        .contentShape(.rect)
    }
}

/// The branch's symbol and name, and how far it is ahead of and behind the one it follows.
private struct Branch: View {
    let name: String
    let ahead: Int
    let behind: Int

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
                .foregroundStyle(.secondary)
            Text(name)
                .lineLimit(1)
                .truncationMode(.middle)
            if ahead > 0 { Text("↑\(ahead)").foregroundStyle(.secondary).monospacedDigit().fixedSize() }
            if behind > 0 { Text("↓\(behind)").foregroundStyle(.secondary).monospacedDigit().fixedSize() }
        }
        .layoutPriority(1)
    }
}

// MARK: Open in

/// The apps on the host the thread's folder opens in, as a menu with their icons at the
/// end of the line, showing the one last opened (2026-11-01: "a dropdown with the
/// actual app icons", "what it looked like before with the drop down").
private struct OpenInLine: View {
    let chat: ThreadController
    let state: ThreadPanelState
    let apps: [HostApp]

    @AppStorage(ThreadPanel.openInKey) private var lastOpened = ""
    @Environment(\.swipeGuard) private var swipeGuard

    private var shown: HostApp {
        apps.first { $0.id == lastOpened } ?? apps.first { $0.kind == .editor } ?? apps[0]
    }

    /// The app to open in, from its dropdown, and beside it the button that opens it
    /// (2026-11-01: "theres nothing to actually click to open").
    var body: some View {
        let shown = shown
        HStack(spacing: Theme.grid * 0.75) {
            Text("Open in")
                .foregroundStyle(.secondary)
                .fixedSize()
            Spacer(minLength: 0)
            Menu {
                ForEach(apps) { app in
                    Button {
                        lastOpened = app.id
                    } label: {
                        Label {
                            Text(app.name)
                        } icon: {
                            app.menuIcon
                        }
                        // On a Mac a menu's items are titles alone otherwise.
                        .labelStyle(.titleAndIcon)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    AppIcon(app: shown, side: 16)
                    Text(shown.name)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.app.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, Theme.grid)
                .frame(height: Self.height)
                .background(.primary.opacity(0.07), in: .capsule)
                .contentShape(.capsule)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("Choose the app to open the folder in, now \(shown.name)")
            .accessibilityIdentifier("thread-panel-open-in")
            Button {
                swipeGuard { Task { await state.open(shown, for: chat) } }
            } label: {
                Group {
                    if state.opening != nil {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up.forward")
                            .font(.app.caption.weight(.semibold))
                    }
                }
                .frame(width: Self.height, height: Self.height)
                .background(.primary.opacity(0.07), in: .circle)
                .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .disabled(state.opening != nil)
            .tip("Open in \(shown.name)")
            .accessibilityLabel("Open in \(shown.name)")
            .accessibilityIdentifier("thread-panel-open")
        }
        .frame(minHeight: 30)
    }

    /// The dropdown's height, and the button's beside it.
    private static let height: CGFloat = 26
}

/// An app's icon as the host drew it, or a symbol for its kind where it could not.
private struct AppIcon: View {
    let app: HostApp
    let side: CGFloat

    var body: some View {
        if let image = app.iconImage {
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .frame(width: side, height: side)
        } else {
            Image(systemName: app.symbol)
                .frame(width: side, height: side)
        }
    }
}

/// Apps' icons once made: the same few, each time their row and its menu are drawn.
@MainActor
private enum AppIconImages {
    static var decoded: [Data: UIImage] = [:]
    static var forMenus: [Data: Image] = [:]
}

@MainActor
private extension HostApp {
    var symbol: String {
        kind == .files ? "folder" : kind == .terminal ? "apple.terminal" : "chevron.left.forwardslash.chevron.right"
    }

    var iconImage: UIImage? {
        guard let icon else { return nil }
        if let made = AppIconImages.decoded[icon] { return made }
        let made = UIImage(data: icon, scale: 3)?.withRenderingMode(.alwaysOriginal)
        AppIconImages.decoded[icon] = made
        return made
    }

    /// Its icon for a menu's item: a menu shows a plain image alone, not one sized or framed
    /// as a view (`AppIcon` drew none there), so it is drawn at its size here.
    var menuIcon: Image {
        guard let icon, let image = iconImage else { return Image(systemName: symbol) }
        if let made = AppIconImages.forMenus[icon] { return made }
        let size = CGSize(width: 18, height: 18)
        let drawn = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        let made = Image(uiImage: drawn.withRenderingMode(.alwaysOriginal))
        AppIconImages.forMenus[icon] = made
        return made
    }
}

// MARK: The device

/// The host: whether it is reached (a dot), what kind of computer it is, its name, how it
/// is reached and its portals-host version, on one line (2026-11-01: "return to
/// the dot", "show the icon of the computer beside it").
private struct DeviceRow: View {
    let host: ThreadPanelHost

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(host.isConnected ? Color.green : .orange)
                .frame(width: 6, height: 6)
            Image(systemName: host.symbol)
                .foregroundStyle(.secondary)
            Text(host.name).lineLimit(1)
            Text("·").foregroundStyle(.tertiary)
            Text(host.reach).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: Theme.grid)
            if let version = host.version {
                Text(host.latest.map { "\(version), \($0) out" } ?? version)
                    .font(.app.caption)
                    .foregroundStyle(host.latest == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.orange))
                    .monospacedDigit()
                    .lineLimit(1)
            }
        }
        .frame(minHeight: 22)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-panel-device")
        .help(host.problem ?? host.address ?? "")
    }
}
