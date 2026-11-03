import AgentCore
import SwiftUI

/// A thread the thread on screen's agent started (with `portals start`), as the line at
/// the foot of its chat and its latest turn's footer list it.
struct StartedThread: Identifiable, Hashable {
    var record: ThreadRecord
    /// Its agent's name: "Codex".
    var agentName: String
    var activity: HostModel.Activity
    /// Listed under the thread that started it, unless taken over into the sidebar too:
    /// false under a thread of an agent the sidebar does not list, whose threads are in the
    /// sidebar whatever their mark. Take over thread is offered only when true.
    var nests = true
    /// Its agent's look, for its icon on the line while it is at work or waits for you.
    var style: AgentAvatarStyle?

    var id: ThreadKey { record.key }
    /// At work, or waiting for you.
    var isActive: Bool { activity != .idle }
    /// What it is doing, as the line at the foot of the chat counts it (`FootLine`): nil at rest.
    var footActivity: ThreadActivity? {
        switch activity {
        case .working: .running
        case .waiting: .waiting
        case .idle: nil
        }
    }
}

/// The threads the thread's agent started, under the chat where its subagents are: the
/// icons of those at work or waiting for you, and how many; opened, each with its agent
/// and what it is doing. A tap opens one. On a host that nests them (`AgentThreadNesting`)
/// they are not in the sidebar, but in Needs you while one waits on you, unless Take over
/// thread put one there too, on every device. The line as it was before it became a part
/// of the one line at the foot of the chat (`ChatFootLine`), shown with
/// `PORTALS_DEBUG_FOOT_LINE=before`.
struct StartedThreadsLine: View {
    let threads: [StartedThread]
    /// As `FootDisclosure.onToggle`.
    var onToggle: () -> Void = {}
    var onOpen: (ThreadRecord) -> Void
    /// Take over thread (true) or Hide from sidebar (false) pressed on one.
    var onShare: (ThreadRecord, Bool) -> Void

    var body: some View {
        FootDisclosure(hints: (open: "Hides the threads", closed: "Shows the threads this agent started"), identifier: "started-threads-line", onToggle: onToggle) {
            HStack(spacing: Theme.grid) {
                let active = threads.filter(\.isActive)
                Group {
                    if active.isEmpty {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.app.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                    } else {
                        StartedThreadIcons(threads: active)
                    }
                }
                .frame(minWidth: 20, alignment: .leading)
                FootTitle(text: FootLine.title(of: [], threads: threads.map(\.footActivity)))
                if threads.contains(where: { $0.activity == .working }) {
                    ProgressView()
                        .controlSize(.mini)
                        .transition(.opacity)
                }
            }
        } rows: {
            ForEach(threads) { thread in
                StartedThreadRow(thread: thread, onOpen: onOpen, onShare: onShare)
            }
        }
        .animation(.smooth(duration: 0.25), value: threads)
    }
}

/// The icons of the threads at work or waiting for you, side by side, after a small one
/// for each kind of the thread's own agents at work (`kinds`, `FootLine.icons`): four in
/// all at most (`FootLine.mostIcons`), then how many more threads, so that the line at the
/// foot of the chat stays as wide as with the threads alone. Each comes and goes with a
/// little scale as a thread or a kind starts or ends.
struct StartedThreadIcons: View {
    let threads: [StartedThread]
    var kinds: [FootLine.Part] = []

    var body: some View {
        let most = max(FootLine.mostIcons - kinds.count, 0)
        HStack(spacing: 4) {
            ForEach(kinds, id: \.self) { kind in
                FootKindIcon(kind: kind)
                    .transition(.scale(scale: 0.5).combined(with: .opacity))
            }
            ForEach(threads.prefix(most)) { thread in
                StartedThreadIcon(thread: thread)
                    .transition(.scale(scale: 0.5).combined(with: .opacity))
            }
            if threads.count > most {
                Text("+\(threads.count - most)")
                    .font(.app.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .accessibilityHidden(true)
            }
        }
        .animation(.smooth(duration: 0.3), value: kinds)
        .animation(.smooth(duration: 0.3), value: threads.map(\.id))
        .animation(.smooth(duration: 0.3), value: threads.map(\.activity))
    }
}

/// The small icon of a kind at work on the closed line, the subagents' or the workflows':
/// one however many there are, in the symbol of their rows, as wide as a thread's icon.
/// It says to VoiceOver what the title, which only counts them, does not.
private struct FootKindIcon: View {
    let kind: FootLine.Part

    var body: some View {
        Image(systemName: SubagentLook.symbol(for: kind))
            .font(.app.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(width: 18, height: 18)
            .accessibilityLabel(kind.title)
    }
}

/// A started thread's agent, as the sidebar draws it (a maker's logo, or the avatar at
/// rest): an amber dot while it waits for you, faded once it is done. A spinner beside
/// the words says it works (2026-10-19: a breathing icon was too subtle).
struct StartedThreadIcon: View {
    let thread: StartedThread
    var side: CGFloat = 18

    var body: some View {
        glyph
            .frame(width: side, height: side)
        .opacity(thread.activity == .idle ? 0.5 : 1)
        .overlay(alignment: .topTrailing) {
            if thread.activity == .waiting {
                Circle()
                    .fill(.orange)
                    .frame(width: side * 0.4, height: side * 0.4)
                    .offset(x: side * 0.12, y: -side * 0.12)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var glyph: some View {
        if let style = thread.style {
            RowAvatar(style: style, side: side)
        } else {
            Image(systemName: "bubble.left")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: side, height: side)
        }
    }
}

/// One started thread in a list: what it is doing, its title, its agent; a tap opens it,
/// and Take over thread where it nests.
struct StartedThreadRow: View {
    let thread: StartedThread
    var onOpen: (ThreadRecord) -> Void
    var onShare: (ThreadRecord, Bool) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Button {
                swipeGuard { onOpen(thread.record) }
            } label: {
                content
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens the thread")
            .accessibilityIdentifier("started-thread-\(thread.record.id.rawValue)")
            .contextMenu {
                Button("Open", systemImage: "arrow.up.right") { onOpen(thread.record) }
                if thread.nests { shareButton }
            }
            if thread.nests { ShareButton(thread: thread, onShare: onShare) }
        }
    }

    private var content: some View {
        HStack(alignment: .top, spacing: Theme.grid) {
            // Whose thread, and whether it waits for you (a dot; the spinner by the words
            // says it works): not a mark that reads as a box to tick.
            StartedThreadIcon(thread: thread, side: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 1) {
                // The chevron says a tap goes to the thread.
                // Kept to the last word (a no-break space and a word joiner), never on a
                // line of its own.
                (Text(thread.record.displayTitle + "\u{00A0}\u{2060}")
                    + Text(Image(systemName: "chevron.right")).font(.app.caption2.weight(.semibold)).foregroundStyle(.tertiary))
                    .font(.app.footnote)
                    .foregroundStyle(thread.activity == .idle ? .secondary : .primary)
                    .lineLimit(2)
                HStack(spacing: 5) {
                    // On two lines where it must: a thread on another Mac ("Fake agent on
                    // mini · Working") beside Take over thread, in the footer's list, was cut
                    // before what it is doing.
                    Text(Self.detail(of: thread))
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    if thread.activity == .working {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }
            }
            Spacer(minLength: Theme.grid)
        }
        .contentShape(.rect)
    }

    private var shareButton: some View {
        let shared = thread.record.isShared
        return Button(shared ? TakeOver.undoInMenu : TakeOver.nameInMenu, systemImage: TakeOver.symbol) {
            onShare(thread.record, !shared)
        }
    }

    /// Its agent, and what it is doing, or that it is in the sidebar too.
    static func detail(of thread: StartedThread) -> String {
        let doing: String? = switch thread.activity {
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .idle: thread.nests && thread.record.isShared ? "In the sidebar" : nil
        }
        return [thread.agentName, doing].compactMap(\.self).joined(separator: " · ")
    }
}

/// What the latest ended turn's footer needs to list the threads the agent started.
struct StartedThreadsLink {
    let threads: () -> [StartedThread]
    let onOpen: (ThreadRecord) -> Void
    let onShare: (ThreadRecord, Bool) -> Void
}

/// "· 3 threads ›" after a turn's time and tokens: every thread the agent started here,
/// in a popover, the finished ones too, which the line at the foot of the chat no longer
/// shows (`ChatFoot`). Kept as it was when the threads became a part of that one line
/// (2026-10-26): it is still the one place the finished ones are.
struct StartedThreadsFooterLink: View {
    let link: StartedThreadsLink
    /// After the turn's time and tokens, past a dot.
    var follows = true

    @State private var isShown = false
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        let threads = link.threads()
        if !threads.isEmpty {
            let count = threads.count == 1 ? "1 thread" : "\(threads.count) threads"
            Button {
                swipeGuard { isShown = true }
            } label: {
                HStack(spacing: 3) {
                    Text((follows ? " · " : "") + count)
                    Image(systemName: "chevron.right")
                        .font(.app.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .font(.app.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(count) started here")
            .accessibilityHint("Lists the threads this agent started")
            .accessibilityIdentifier("turn-footer-threads")
            .popover(isPresented: $isShown) {
                StartedThreadsList(threads: link.threads, onOpen: { record in
                    isShown = false
                    link.onOpen(record)
                }, onShare: link.onShare)
                .presentationCompactAdaptation(.popover)
            }
        }
    }
}

/// The footer's popover: every thread started here, current as they change.
private struct StartedThreadsList: View {
    let threads: () -> [StartedThread]
    let onOpen: (ThreadRecord) -> Void
    let onShare: (ThreadRecord, Bool) -> Void

    var body: some View {
        let started = threads()
        let list = VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
            Text(started.count == 1 ? "Started 1 thread" : "Started \(started.count) threads")
                .font(.app.subheadline.weight(.semibold))
            ForEach(started) { thread in
                StartedThreadRow(thread: thread, onOpen: onOpen, onShare: onShare)
            }
        }
        .padding(Theme.grid * 2)
        .frame(width: 360, alignment: .leading)
        // As tall as the list, scrolling past what fits.
        ViewThatFits(in: .vertical) {
            list
            ScrollView { list }
        }
        .frame(maxHeight: 440)
    }
}

/// The name of the action that puts a thread an agent started, listed under the thread
/// that started it, in the sidebar too, on every device (`ThreadRecord.shared`), and of its
/// undo: one name wherever it is offered, the row of the line at the foot of the chat, its
/// menu, a tab's menu and a sidebar row's (2026-10-27, of what was Show in sidebar:
/// "maybe we should change to 'takeover thread' or smt"). Its undo says what it does.
enum TakeOver {
    /// As a button says it, and as a menu, in its title case.
    static let name = "Take over thread"
    static let nameInMenu = "Take Over Thread"
    static let undo = "Hide from sidebar"
    static let undoInMenu = "Hide from Sidebar"
    static let symbol = "sidebar.left"
}

/// Take over thread, by a thread's row, in words (2026-10-19: the bare sidebar
/// icon did not say what it did), and "In sidebar" with a check once it is taken over,
/// which Hide from sidebar takes out again.
private struct ShareButton: View {
    let thread: StartedThread
    let onShare: (ThreadRecord, Bool) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    private var label: String {
        thread.record.isShared ? TakeOver.undo : TakeOver.name
    }

    var body: some View {
        let shared = thread.record.isShared
        Button {
            swipeGuard { onShare(thread.record, !shared) }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: shared ? "checkmark" : TakeOver.symbol)
                    .font(.app.caption2.weight(.semibold))
                Text(shared ? "In sidebar" : TakeOver.name)
                    .font(.app.caption.weight(.medium))
            }
            .foregroundStyle(shared ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .padding(.horizontal, Theme.grid)
            .padding(.vertical, 4)
            .background(Capsule().fill(.quaternary.opacity(shared ? 0.9 : 0.5)))
            .fixedSize()
            .contentShape(.capsule)
            .animation(.smooth(duration: 0.2), value: shared)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityIdentifier("started-thread-share-\(thread.record.id.rawValue)")
    }
}
