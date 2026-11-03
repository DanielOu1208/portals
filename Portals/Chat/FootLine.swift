import AgentCore
import SwiftUI

/// What sits at the foot of a chat, after its turns: the one line (`ChatFootLine`), or,
/// with `PORTALS_DEBUG_FOOT_LINE=before`, the two it was, the subagents line with the
/// started threads' under it. Outside the lazy stack of turns, which would let go of it,
/// and of whether it was open, while the chat is scrolled far up. The threads are asked
/// for here (`threads`), so that their news draws this again and not the whole chat. Once
/// a turn's footer lists them all (`listedInFooter`, the ask of 2026-10-19), only
/// those at work or waiting for you are on it, and none once none is. A background command
/// that ended leaves the one line by itself a moment after, done, failed or stopped until
/// then, and fades out (`FootLine.shown`, 2026-10-27.
struct ChatFoot: View {
    let subagents: [Subagent]
    let threads: () -> [StartedThread]
    /// The latest ended turn's footer lists every thread started here.
    var listedInFooter = false
    var isRunning = false
    /// The subagent or workflow whose detail is open (`SubagentsLine.detail`).
    @Binding var opened: Subagent.ID?
    let onStop: (Subagent.ID) -> Void
    let onOpen: (ThreadRecord) -> Void
    let onShare: (ThreadRecord, Bool) -> Void
    /// As `FootDisclosure.onToggle`.
    let onToggle: () -> Void

    /// The moment the line last went by, for the finished commands it shows
    /// (`FootLine.shown`): brought up to date as the next of them is to leave it.
    @State private var now = Date.now
    @AppStorage(FootLine.showsCommandsKey) private var showsCommands = true

    var body: some View {
        let started = threads()
        let shown = listedInFooter ? started.filter(\.isActive) : started
        let onLine = FootLine.shown(subagents, at: now, showsCommands: showsCommands)
        VStack(spacing: 0) {
            if DebugLaunch.footLineBefore {
                if !subagents.isEmpty {
                    SubagentsLine(subagents: subagents, opened: $opened, onToggle: onToggle, onStop: onStop)
                        .padding(.top, Theme.grid * (isRunning ? 1 : 3))
                        .padding(.horizontal, ChatFeature.margin)
                        .chatColumn()
                        .transition(.opacity)
                }
                if !shown.isEmpty {
                    StartedThreadsLine(threads: shown, onToggle: onToggle, onOpen: onOpen, onShare: onShare)
                        .padding(.top, Theme.grid * (isRunning ? 1 : 3))
                        .padding(.horizontal, ChatFeature.margin)
                        .chatColumn()
                        .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
                }
            } else if !onLine.isEmpty || !shown.isEmpty {
                ChatFootLine(
                    subagents: onLine, threads: shown, opened: $opened,
                    onToggle: onToggle, onStop: onStop, onOpen: onOpen, onShare: onShare
                )
                .padding(.top, Theme.grid * (isRunning ? 1 : 3))
                .padding(.horizontal, ChatFeature.margin)
                .chatColumn()
                .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.35), value: shown.isEmpty)
        // A finished command, done for a moment, then fading out of the rows, the title and
        // the icons, and the line with it once nothing else is on it.
        .task(id: FootLine.nextClearing(of: subagents, after: now)) {
            guard let next = FootLine.nextClearing(of: subagents, after: now) else { return }
            try? await Task.sleep(for: .seconds(max(next.timeIntervalSinceNow, 0)))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth(duration: 0.35)) { now = .now }
        }
    }
}

/// The agents the thread's agent set to work, its workflows, the threads it started here
/// and the commands it left running in the background, as one line at the foot of the
/// chat (2026-10-26: "We can try making it stay in one line first"): a mark that
/// spins while any of it works, one title for all of it (`FootLine.title`), a small icon
/// for the subagents and one for the workflows while any of each works (`FootLine.icons`),
/// then the icons of the threads at work or waiting for you, as the started threads' line
/// had them. Opened in
/// place, its rows in the chosen order of parts, each row as it was on its own line ("Subagents
/// and stuff should just show as they do right now"): a subagent's or workflow's opens its
/// detail and has its Stop, a thread's opens the thread, with its menu and Take over thread.
struct ChatFootLine: View {
    let subagents: [Subagent]
    let threads: [StartedThread]
    @Binding var opened: Subagent.ID?
    var onToggle: () -> Void = {}
    var onStop: (Subagent.ID) -> Void = { _ in }
    var onOpen: (ThreadRecord) -> Void
    var onShare: (ThreadRecord, Bool) -> Void

    var body: some View {
        let activities = threads.map(\.footActivity)
        FootDisclosure(
            hints: FootLine.hints(of: subagents, threads: !threads.isEmpty),
            identifier: "foot-line", onToggle: onToggle
        ) {
            HStack(spacing: Theme.grid) {
                FootMark(mark: FootLine.mark(of: subagents, threads: activities))
                FootTitle(text: FootLine.title(of: subagents, threads: activities))
                let kinds = FootLine.icons(of: subagents)
                let active = threads.filter(\.isActive)
                if !kinds.isEmpty || !active.isEmpty {
                    StartedThreadIcons(threads: active, kinds: kinds)
                        .transition(.opacity)
                }
            }
        } rows: {
            rows
        }
        .animation(.smooth(duration: 0.25), value: subagents)
        .animation(.smooth(duration: 0.25), value: threads)
    }

    private var rows: some View {
        let rows = FootLine.rows(of: subagents, threads: threads.count)
        return VStack(alignment: .leading, spacing: Theme.grid * 2) {
            ForEach(rows.parts, id: \.self) { part in
                VStack(alignment: .leading, spacing: Theme.grid * 0.75) {
                    if rows.headed { FootPartHeading(part: part) }
                    VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
                        if part == .threads {
                            ForEach(threads) { thread in
                                StartedThreadRow(thread: thread, onOpen: onOpen, onShare: onShare)
                            }
                        } else {
                            // A subagent's own subagent under the one that started it, set in.
                            ForEach(rows.agents[part] ?? [], id: \.agent.id) { entry in
                                SubagentRow(agent: entry.agent, depth: entry.depth, opened: $opened, onStop: onStop)
                            }
                        }
                    }
                }
                .transition(.opacity)
            }
        }
    }
}

/// A part's small heading on the opened line, when more than one part has rows
/// (`FootLine.Rows.headed`).
private struct FootPartHeading: View {
    let part: FootLine.Part

    var body: some View {
        Text(part.title)
            .font(.app.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The mark at the start of a line at the foot of the chat (`FootLine.Mark`).
struct FootMark: View {
    let mark: FootLine.Mark

    var body: some View {
        Group {
            switch mark {
            case .working:
                ProgressView()
                    .controlSize(.small)
            case .waiting:
                // The sidebar's mark for a thread waiting for you (`ActivityMark`).
                Circle()
                    .fill(.orange)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Waiting for you")
            case .failed:
                // As a row that did not finish has it (`SubagentLook`).
                Image(systemName: SubagentLook.symbol(for: Subagent.State.failed))
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(SubagentLook.tint(for: .failed))
                    .accessibilityLabel("One did not finish")
            case .ended:
                Image(systemName: "checkmark.circle")
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            case .started:
                Image(systemName: "arrow.turn.down.right")
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 20)
    }
}

/// The words of a line at the foot of the chat, one line of them, a new one fading in
/// for the old.
struct FootTitle: View {
    let text: String

    var body: some View {
        ZStack(alignment: .leading) {
            Text(text)
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .id(text)
                .transition(.opacity)
        }
        .animation(.smooth(duration: 0.25), value: text)
    }
}

/// The collapse code of what sits at the foot of a chat, one for the one line and for the
/// two lines it was: a line that says what goes on, with a chevron, which a tap opens in
/// place to the rows under it, past its mark, and closes again.
struct FootDisclosure<Label: View, Rows: View>: View {
    /// What a tap does, for VoiceOver: while open, and while closed.
    let hints: (open: String, closed: String)
    let identifier: String
    /// The list has opened or closed, which moved the end of the chat it sits at.
    /// Called once the change is laid out, since a scroll asked for while the chat is
    /// still growing is cut to the old size: at once for an opening, which is not
    /// animated, and after the animation for a closing.
    let onToggle: () -> Void
    @ViewBuilder let label: () -> Label
    @ViewBuilder let rows: () -> Rows

    @State private var isOpen = DebugLaunch.expandsWork
    /// The rows fade and settle into place after the list has opened, since opening it
    /// is not animated.
    @State private var rowsShown = DebugLaunch.expandsWork
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
            Button {
                swipeGuard(toggle)
            } label: {
                HStack(spacing: Theme.grid) {
                    label()
                    Image(systemName: "chevron.right")
                        .font(.app.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .animation(.smooth(duration: 0.25), value: isOpen)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(isOpen ? hints.open : hints.closed)
            .accessibilityIdentifier(identifier)

            if isOpen {
                VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
                    rows()
                }
                // Under the words, past the mark.
                .padding(.leading, 20 + Theme.grid)
                .opacity(rowsShown ? 1 : 0)
                .offset(y: rowsShown ? 0 : -Theme.grid)
                .transition(.opacity)
            }
        }
    }

    private func toggle() {
        if isOpen {
            withAnimation(.smooth(duration: 0.25)) {
                isOpen = false
                rowsShown = false
            } completion: { onToggle() }
        } else {
            // Opened in one step, so the scroll that brings the list into view can
            // start with it instead of after it; the rows then fade in as it goes.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { isOpen = true }
            onToggle()
            withAnimation(.smooth(duration: 0.35)) { rowsShown = true }
        }
    }
}
