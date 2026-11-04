import AgentCore
import SwiftUI

/// One turn: what started it, then everything the agent did, in order, and how it ended.
/// While it runs, a line at its end says what the agent is doing right now. A slash
/// command's turn ends with what came of it: its answer, a compaction's mark, "Done"
/// when there is nothing more to say, or why it failed. Once it has ended, finished,
/// stopped or failed, a quiet line under it says how long it took and how many tokens it
/// spent, where the agent says (`Turn.footer`), and what it changed (`Turn.diff`).
struct TurnView: View {
    let turn: Turn
    /// What the agent is doing, when this is the turn it is on.
    var status: RunStatus?
    /// The current checklist belongs only to the running turn's status line.
    var plan: TodoPlan?
    /// Whether "Try again" can be offered now.
    let canRetry: Bool
    var onRetry: () -> Void
    var offersMessageFork = false
    var canForkMessage = false
    var onForkMessage: (UserMessage, MessageCheckpoint, Bool) -> Void = { _, _, _ in }
    /// On the latest ended turn: its footer lists the threads the agent started.
    var startedThreads: StartedThreadsLink?

    /// How many visuals the reply's views have laid out (`ShownVisualsKey`).
    @State private var shownVisuals = 0
    /// A tool call kept on the status line a minimum time (`StatusHold`). Kept here, not
    /// by the line, so it outlasts the line going while the agent's words are written.
    @State private var hold = StatusHold(minimum: DebugLaunch.statusHold ?? StatusHold.standard)

    var body: some View {
        let layout = TurnLayout.layout(for: turn)
        VStack(alignment: .leading, spacing: Theme.grid * 2) {
            ForEach(Self.blocks(layout.pieces)) { block in
                switch block {
                case let .item(item, segment):
                    view(for: item, segment: segment)
                        .transition(.opacity)
                case let .steps(steps):
                    StepsFoldView(steps: steps)
                        .transition(.opacity)
                }
            }
            // Where the visual the agent is about to show will go, held from the moment
            // it starts on one until the reply lays the visual out there; it goes at
            // once, as the visual takes its place.
            if turn.awaitsWidget(shown: shownVisuals) {
                VisualPlanningView()
                    .transition(.asymmetric(insertion: .opacity, removal: .identity))
            }
            // What the agent is doing, with the work since it last said something
            // folded into the same line; a call held there stays its time. Directly under
            // it, the turn's to-do list, opened apart from it (`TodoPlanSection`).
            if lineShown(layout) != nil || sectionPlan != nil {
                VStack(alignment: .leading, spacing: Theme.grid) {
                    if let status = lineShown(layout) {
                        RunStatusLine(status: status, underWay: layout.underWay, plan: TodoPlanSection.inStatusLine ? plan : nil, isHolding: hold.isHolding)
                            .transition(.opacity)
                    }
                    if let sectionPlan {
                        TodoPlanSection(plan: sectionPlan, turn: turn.id)
                            .transition(.opacity)
                    }
                }
                .transition(.opacity)
            }
            ending
            if turn.footer != nil || startedThreads != nil || changes != nil {
                HStack(spacing: 0) {
                    if let footer = turn.footer { TurnFooter(text: footer, isRunning: turn.isRunning) }
                    // What the turn changed, which opens its files' diffs (feature turn_diff).
                    if let changes { TurnDiffFooterLink(diff: changes, follows: turn.footer != nil) }
                    if let startedThreads { StartedThreadsFooterLink(link: startedThreads, follows: turn.footer != nil || changes != nil) }
                }
                .transition(.opacity)
            }
        }
        .onPreferenceChange(ShownVisualsKey.self) { shownVisuals = $0 }
        .animation(.smooth(duration: 0.35), value: turn.items.count)
        .animation(.smooth(duration: 0.35), value: turn.isRunning)
        .animation(.smooth(duration: 0.25), value: lineShown(layout) != nil)
        .onChange(of: HoldInput(status: lineStatus(layout), scope: layout.underWay?.id), initial: true) { _, input in
            hold.update(input.status, scope: input.scope, at: .now)
        }
        // Only while a call is held with something newer waiting: one wait, then the line
        // moves on. Nothing runs otherwise.
        .task(id: hold.due) {
            guard let due = hold.due else { return }
            try? await Task.sleep(for: .seconds(max(0, due.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            hold.tick(at: max(.now, due))
        }
    }

    /// The to-do list under the status line, while the turn runs.
    private var sectionPlan: TodoPlan? {
        guard turn.isRunning, !TodoPlanSection.inStatusLine, let plan, plan.summary != nil else { return nil }
        return plan
    }

    /// What the status line would say now: nil when the turn has ended, and while the
    /// reply is being written with no work under way.
    private func lineStatus(_ layout: TurnLayout.Layout) -> RunStatus? {
        guard turn.isRunning else { return nil }
        return status ?? (layout.underWay != nil || plan != nil ? .thinking : nil)
    }

    /// What it says: a call still held, else what it would say now (at once, not a frame
    /// late through the hold).
    private func lineShown(_ layout: TurnLayout.Layout) -> RunStatus? {
        guard turn.isRunning else { return nil }
        return hold.isHolding ? hold.shown : lineStatus(layout)
    }

    /// What the hold is told: the status and the stretch of work it is in.
    private struct HoldInput: Equatable {
        var status: RunStatus?
        var scope: UUID?
    }

    /// What the turn changed, once it has ended and where the host said (`Turn.diff`).
    private var changes: TurnDiff? {
        guard !turn.isRunning, let diff = turn.diff, !diff.files.isEmpty else { return nil }
        return diff
    }

    /// The turn's pieces, each piece of text with its place among the turn's.
    private enum Block: Identifiable {
        /// `segment`: for a piece of text, which of the turn's it is (its visuals' keys).
        case item(TurnItem, segment: Int)
        case steps(TurnLayout.Steps)

        var id: UUID {
            switch self {
            case let .item(item, _): item.id
            case let .steps(steps): steps.id
            }
        }
    }

    private static func blocks(_ pieces: [TurnLayout.Piece]) -> [Block] {
        var blocks: [Block] = []
        var texts = 0
        for piece in pieces {
            switch piece {
            case let .steps(steps):
                blocks.append(.steps(steps))
            case let .item(item):
                blocks.append(.item(item, segment: texts))
                if case .text = item.content { texts += 1 }
            }
        }
        return blocks
    }

    /// An item outside the work list. It is drawn like any other, except the reply
    /// text still being written, which eases in.
    @ViewBuilder
    private func view(for item: TurnItem, segment: Int) -> some View {
        if case let .text(text) = item.content {
            let isLast = item.id == turn.items.last?.id
            ReplyTextView(
                text: text,
                revealsGradually: turn.isRunning && isLast,
                // A reply that came whole as its turn ended (Claude Code holds a reply back
                // until it has thought, then sends it at once) still plays in.
                justEnded: !turn.isRunning && isLast && turn.endedAt.map { Date.now.timeIntervalSince($0) < 2 } == true,
                turn: turn.id,
                segment: segment
            )
        } else {
            VStack(alignment: .trailing, spacing: Theme.grid / 2) {
                WorkItemView(item: item)
                if offersMessageFork, !turn.isRunning,
                   item.id == turn.items.first(where: \.isUserMessage)?.id,
                   case let .user(message) = item.content,
                   let checkpoint = message.checkpoint, checkpoint.canFork || checkpoint.canEdit {
                    Menu {
                        if checkpoint.canFork {
                            Button("Fork from here", systemImage: "arrow.triangle.branch") {
                                onForkMessage(message, checkpoint, false)
                            }
                        }
                        if checkpoint.canEdit {
                            Button("Edit and send again", systemImage: "square.and.pencil") {
                                onForkMessage(message, checkpoint, true)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.app.footnote)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 44, minHeight: 32)
                            .contentShape(.rect)
                    }
                    .disabled(!canForkMessage)
                    .accessibilityLabel("Message actions")
                    .accessibilityHint(canForkMessage ? "Creates a new thread from this message" : "Available when this thread is idle and connected")
                    .accessibilityIdentifier("message-fork-actions")
                }
            }
        }
    }

    @ViewBuilder
    private var ending: some View {
        switch turn.outcome {
        case nil:
            EmptyView()
        case .completed:
            // A command with nothing else to show still says it ran.
            if turn.isCommandWithoutAnswer {
                CommandDoneLine()
                    .transition(.opacity)
            }
        case .interrupted:
            HStack(spacing: Theme.grid * 1.5) {
                QuietNote(text: "Stopped", systemImage: "stop.circle")
                if offersRetry { retryButton }
            }
        case let .failed(failure):
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 1.5) { failureContent(failure) }
                VStack(alignment: .leading, spacing: Theme.grid) { failureContent(failure) }
            }
            .accessibilityIdentifier("turn-failure")
        }
    }

    @ViewBuilder
    private func failureContent(_ failure: TurnFailure) -> some View {
        Label(failure.message, systemImage: "exclamationmark.circle")
            .font(.app.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .copyMenu(failure.message)
        if failure.retryable, offersRetry {
            retryButton
        }
    }

    /// "Try again" sends your message again: there is none in a turn the host started.
    private var offersRetry: Bool {
        canRetry && turn.items.contains(where: \.isUserMessage)
    }

    private var retryButton: some View {
        Button("Try again", action: onRetry)
            .font(.app.footnote.weight(.semibold))
            .buttonStyle(.borderedCapsule)
            .controlSize(.small)
    }
}

/// A turn is redrawn only when what it shows changed. `onRetry` is left out: it is made
/// anew with every update of the chat, and stands for the same thing, retrying this
/// turn. Without this, every streamed word redrew every turn of the thread
/// (docs/perf-mac-scroll.md).
extension TurnView: Equatable {
    static func == (lhs: TurnView, rhs: TurnView) -> Bool {
        lhs.turn == rhs.turn && lhs.status == rhs.status && lhs.plan == rhs.plan && lhs.canRetry == rhs.canRetry
            && lhs.offersMessageFork == rhs.offersMessageFork && lhs.canForkMessage == rhs.canForkMessage
            && (lhs.startedThreads == nil) == (rhs.startedThreads == nil)
    }
}

// MARK: - Your message

/// A message you sent, with a line under it when the host did something other than
/// start a run with it. Each file it mentions (`@path`) is a chip that opens the file, where
/// the host reads its files, with the note on one the agent may not have read in whole.
struct UserBubble: View {
    let message: UserMessage
    /// Its item in the thread, which the notes on its chips are kept by.
    var id: UUID?
    /// Not part of a turn yet: drawn lighter.
    var isWaiting = false

    @Environment(\.chatFiles) private var files

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.grid / 2) {
            if !message.images.isEmpty {
                SentImages(images: message.images)
                    .opacity(isWaiting ? 0.6 : 1)
            }
            if !message.files.isEmpty {
                SentFiles(files: message.files)
                    .opacity(isWaiting ? 0.6 : 1)
            }
            // A message can be images or files alone.
            if !message.text.isEmpty {
                text
                    .padding(.horizontal, Theme.grid * 2)
                    .padding(.vertical, Theme.grid * 1.25)
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .opacity(isWaiting ? 0.6 : 1)
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .copyMenuWhenNotSelectable(message.text)
            }
            ForEach(mentionNotes, id: \.self) { note in
                Text(note)
                    .font(.app.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .padding(.trailing, Theme.grid / 2)
                    .accessibilityIdentifier("mention-note")
            }
            if let caption {
                Text(caption)
                    .font(.app.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, Theme.grid / 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, Theme.grid * 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel((["You: \(message.text)", imagesLabel, filesLabel, caption] + mentionNotes).compactMap(\.self).joined(separator: ", "))
    }

    /// Mentions are chips where they can be opened: the host reads the thread's files.
    private var chipsMentions: Bool { files?.isAvailable == true }

    /// The paths picked from the `@` menu for this message, sent from here while the app
    /// runs: chips whatever their shape (2026-10-27).
    private var picked: [String] {
        guard chipsMentions, let id, message.text.contains("@") else { return [] }
        return SentMentionsMemory.shared.sent.paths(of: id)
    }

    /// The note on each file it mentions that its agent may not have read in, as the host
    /// answered when it was sent from here (`SentMentionsMemory`).
    private var mentionNotes: [String] {
        guard chipsMentions, let id, message.text.contains("@") else { return [] }
        let sent = SentMentionsMemory.shared.sent
        return FileMention.paths(in: message.text).compactMap { path in
            sent.fit(of: path, in: id)?.note.map { "\((path as NSString).lastPathComponent): \($0)" }
        }
    }

    /// The message's text, selected where it is (`ProseSelection`), else held to copy.
    @ViewBuilder
    private var text: some View {
        if ProseSelection.isOn {
            SelectablePlainText(text: message.text, chipsMentions: chipsMentions, picked: picked)
        } else {
            Text(message.text)
                .font(.app.body)
        }
    }

    private var filesLabel: String? {
        switch message.files.count {
        case 0: nil
        case 1: "1 file, \(message.files[0].filename)"
        default: "\(message.files.count) files"
        }
    }

    private var imagesLabel: String? {
        switch message.images.count {
        case 0: nil
        case 1: "1 image"
        default: "\(message.images.count) images"
        }
    }

    private var caption: String? {
        switch message.delivery {
        case .steered: "Sent as guidance"
        case .redirected: "Redirected the run"
        case .queued: isWaiting ? "Queued" : nil
        case nil: isWaiting ? "Sending…" : nil
        case .started: nil
        }
    }
}

// MARK: - A message you did not type

/// A message another agent's thread or a script sent into the thread through Portals
/// (`portals send`), which the agent reads as such. It is a bubble on your side, as your
/// own messages are (2026-10-19, confirmed on 2026-10-20: it had
/// been a card on the agent's side since 2026-10-15), with who sent it in a small line
/// above it and its text as Markdown (bold, code, lists and links, as agents write them)
/// in a smaller type than yours. Quieter than yours (the ask of 2026-10-21: "more
/// translucent/subtle"), so it is told from them at a glance: a fainter bubble and text
/// (`RelayedLook`). The line names the agent, its thread's title, and another Mac by the
/// app's own name for it when it has that Mac as a host. The bubble is as wide as its
/// longest line, as yours is. A long one shows its first lines until opened.
struct RelayedMessageRow: View {
    let message: UserMessage
    let relayed: RelayedMessage

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard
    @Environment(\.macNames) private var macNames

    /// - Parameter row: where the chat keeps whether it is open.
    init(message: UserMessage, relayed: RelayedMessage, row: OpenRows.Row? = nil) {
        self.message = message
        self.relayed = relayed
        _isOpen = RowOpen(row, initially: false)
    }

    /// Lines shown before it is opened.
    private static let closedLines = 6

    private static let look = RelayedLook.current

    /// Long enough to be cut short until opened: by its lines, or by its length, which
    /// wraps into lines.
    private var isLong: Bool {
        relayed.text.count > 480 || relayed.text.reduce(0) { $1 == "\n" ? $0 + 1 : $0 } >= Self.closedLines
    }

    /// "From Codex on mini · Review": another Mac by the app's name for it.
    private var label: String {
        relayed.label { macNames[$0] }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.grid / 2) {
            sender
            if !message.images.isEmpty {
                SentImages(images: message.images)
            }
            if !message.files.isEmpty {
                SentFiles(files: message.files)
            }
            // A message can be images or files alone.
            if !relayed.text.isEmpty {
                bubble
            }
            if let caption {
                Text(caption)
                    .font(.app.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, Theme.grid / 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, Theme.grid * 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([relayed.text.isEmpty ? label : "\(label): \(relayed.plainText)", caption].compactMap(\.self).joined(separator: ", "))
        .accessibilityActions {
            if isLong {
                Button(isOpen ? "Show less" : "Show all", action: toggle)
            }
        }
        .accessibilityIdentifier("relayed-message")
    }

    private func toggle() {
        swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
    }

    /// Who sent it, over the message as a group chat names the one who wrote: what tells
    /// it apart from a message of yours.
    private var sender: some View {
        Label {
            Text(label)
                .lineLimit(1)
        } icon: {
            Image(systemName: relayed.isFromCommandLine ? "terminal" : "arrowshape.turn.up.right")
        }
        .font(Self.look == .before ? .app.caption.weight(.semibold) : .app.caption.weight(.medium))
        .foregroundStyle(Self.look == .before ? .secondary : .tertiary)
        .padding(.trailing, Theme.grid / 2)
    }

    /// The text in a bubble on your side, fainter than yours (`RelayedLook`), with Show
    /// all under it when it is long.
    private var bubble: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 0.75) {
            RelayedText(text: relayed.text)
                .equatable()
                .fixedSize(horizontal: false, vertical: true)
                .modifier(CutShort(height: isLong && !isOpen ? Self.closedHeight : nil))
                .foregroundStyle(Self.look == .before ? .primary : .secondary)
            if isLong {
                Button(isOpen ? "Show less" : "Show all", action: toggle)
                    .font(.app.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("relayed-message-more")
            }
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid * 1.25)
        .modifier(RelayedBubble(look: Self.look))
        .copyMenuWhenNotSelectable(relayed.text)
    }

    private var caption: String? {
        switch message.delivery {
        case .steered: "Sent as guidance"
        case .redirected: "Redirected the run"
        case .queued, .started, nil: nil
        }
    }

    /// The height of about its first `closedLines` lines of text, which a long one is cut
    /// to: the lines and some of the room between paragraphs and list items.
    private static var closedHeight: CGFloat {
        let font = AppTextStyles.fixedSize(of: .subheadline).map { UIFont.systemFont(ofSize: $0) }
            ?? UIFont.preferredFont(forTextStyle: .subheadline)
        return ((font.lineHeight + Theme.proseLineSpacing) * CGFloat(closedLines) + Theme.grid * 3).rounded(.up)
    }
}

extension EnvironmentValues {
    /// The app's own names for the Macs it has as hosts, by their stable ids
    /// (`HostConfig.machineID`, `Fleet.macNames`): who a relayed message came from.
    @Entry var macNames: [String: String] = [:]
}

/// How a relayed message's bubble looks: one chosen (`outline`, the user's pick on 2026-10-22),
/// and others to compare it with (`PORTALS_DEBUG_RELAYED`, in a debug build).
enum RelayedLook: String {
    /// A bubble fainter than yours, with fainter text.
    case veiled
    /// No fill, a thin outline, with fainter text: the default.
    case outline
    /// No bubble: a thin bar at its side, as a quote.
    case quote
    /// Your own bubble's fill, as it was until 2026-10-22.
    case before

    static let current = DebugLaunch.relayedLook.flatMap(RelayedLook.init(rawValue:)) ?? .outline
}

/// A relayed message's bubble, as `look` has it.
private struct RelayedBubble: ViewModifier {
    let look: RelayedLook

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 20, style: .continuous) }

    func body(content: Content) -> some View {
        switch look {
        case .veiled:
            content
                .background(Color(uiColor: .quaternarySystemFill), in: shape)
                .contentShape(.contextMenuPreview, shape)
        case .outline:
            content
                .overlay(shape.strokeBorder(Color(uiColor: .separator), lineWidth: 1))
                .contentShape(.contextMenuPreview, shape)
        case .quote:
            content
                .overlay(alignment: .trailing) {
                    Capsule().fill(Color(uiColor: .tertiaryLabel)).frame(width: 3)
                }
                .contentShape(.contextMenuPreview, Rectangle())
        case .before:
            content
                .background(Color(uiColor: .tertiarySystemFill), in: shape)
                .contentShape(.contextMenuPreview, shape)
        }
    }
}

/// A relayed message's text as Markdown, parsed again only when it changes: the row is
/// made again with the turn it opens, at each word of a reply streaming under it. As wide
/// as its longest line, so that a short message has a small bubble.
private struct RelayedText: View, Equatable {
    let text: String

    var body: some View {
        MarkdownBlocksView(
            blocks: Markdown.blocks(text),
            // Selected where it is, with Copy Message in its menu (`SelectableProse`).
            copying: ProseSelection.isOn ? .init(text: text, selecting: { Markdown.plainText(text) }, title: "Copy Message") : nil,
            textStyle: .subheadline, fillsColumn: false,
            // Fainter in the quieter looks, as `RelayedMessageRow` sets for the text that
            // is not selected in place.
            isFaint: RelayedLook.current != .before
        )
    }
}

/// Cuts a view to `height`, fading out over its last lines, when there is one.
private struct CutShort: ViewModifier {
    let height: CGFloat?

    func body(content: Content) -> some View {
        if let height {
            content
                .frame(maxHeight: height, alignment: .top)
                .clipped()
                .mask {
                    LinearGradient(stops: [.init(color: .black, location: 0.72), .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                }
        } else {
            content
        }
    }
}

// MARK: - Reply text

/// The agent's reply as Markdown. While it streams, the text shows at a steady pace as
/// it arrives, instead of in the bursts the network delivers it in.
extension EnvironmentValues {
    /// When the chat on screen was put there (`ChatScreen`); nil outside a chat.
    @Entry var chatShownSince: Date? = nil
    /// When the words a chat kept out of sight held were taken in, as it came back on
    /// screen (`ThreadController.caughtUpAt`): they show at once, as in a chat built anew.
    @Entry var chatCaughtUpAt: Date? = nil
}

struct ReplyTextView: View {
    let text: String
    var revealsGradually = false
    /// Its turn ended a moment ago: what comes now is still eased in, as it would have been
    /// a moment before.
    var justEnded = false
    /// The turn it is in, which draws its widgets.
    var turn: UUID?
    /// Which of the turn's pieces of text this is (`WidgetKey.segment`).
    var segment = 0

    /// How many characters the easing has reached; nil before any text was eased in.
    @State private var revealed: Int?
    /// How many characters there are to reach.
    @State private var target = 0
    /// The easing in progress. It belongs to the view, not to one state of the text:
    /// tied to the text's length it could be dropped between two lengths and leave the
    /// reply cut short on screen (seen when the next turn began as this one ended).
    @State private var easing: Task<Void, Never>?
    /// The blocks of the text shown last, kept so that a redraw that shows the same text
    /// (a word arriving while the easing is behind) does not parse it again.
    @State private var parsed = ParsedReply()
    /// How many characters each step shows of a burst that came at once, so that it plays
    /// in evenly; 0 while none is being played in.
    @State private var burstStep = 0
    /// Since when the chat has been on screen: a long reply new to the view after that
    /// came while someone was looking, and plays in.
    @Environment(\.chatShownSince) private var chatShownSince
    /// The chat is kept out of sight behind the one on screen (`ChatScreen.isShown`):
    /// nothing plays in where no one sees it.
    @Environment(\.isOutOfSight) private var isOutOfSight
    @Environment(\.chatCaughtUpAt) private var chatCaughtUpAt

    var body: some View {
        // Whether there is anything but space, found at its first letter: trimming the
        // reply copied all of it at every step of the reveal.
        if text.contains(where: { !$0.isWhitespace }) {
            // Text is held back only while it is being eased in. Otherwise all of it
            // shows, so nothing can be left hidden. Text new since the last look, which
            // the change below is about to start easing in, shows as that will from the
            // start: shown whole for one layout first, a reply that came at once was laid
            // out in full, then taken back to nothing and played in (seen in the user's
            // scroll log, 2026-10-26, as its turn growing by 524 points and shrinking by
            // 477 seven milliseconds later).
            let holding = easing == nil && text.count != target
                ? easesFrom(old: target == 0 ? text.count : target, count: text.count) : nil
            let shown = if let holding {
                String(text.prefix(holding))
            } else {
                easing == nil ? text : String(text.prefix(revealed ?? 0))
            }
            let isBeingWritten = revealsGradually || easing != nil || holding != nil
            let blocks = parsed.blocks(of: shown, isBeingWritten: isBeingWritten)
            MarkdownBlocksView(
                blocks: blocks,
                widgets: turn,
                widgetSegment: segment,
                isBeingWritten: isBeingWritten,
                copying: .init(text: text, selecting: { Markdown.plainText(text) }),
                settled: parsed.settled
            )
                .onChange(of: text.count, initial: true) { old, count in
                    target = count
                    guard let from = easesFrom(old: old, count: count) else {
                        // Out of sight, or come back on screen with the words held
                        // meanwhile: all of it at once, as a chat built anew shows it (an
                        // easing under way ends there too); what comes after plays in.
                        if (revealsGradually || justEnded), revealed != nil { revealed = count }
                        return
                    }
                    // A burst plays in evenly over `burstSteps`, a few words a step, from
                    // the top down, rather than most of it at the first step.
                    if count - from >= Self.burst {
                        burstStep = max(burstStep, (count - from + Self.burstSteps - 1) / Self.burstSteps)
                    }
                    guard easing == nil else { return }
                    revealed = from
                    easing = Task {
                        await catchUp()
                        easing = nil
                        burstStep = 0
                    }
                }
                .accessibilityIdentifier("reply-text")
                .preference(key: ShownVisualsKey.self, value: blocks.count(where: \.isWidget))
        }
    }

    /// Where the easing of text `old` characters long before and `count` now starts, or
    /// nil when it all shows at once.
    private func easesFrom(old: Int, count: Int) -> Int? {
        // Easing starts only while the reply is being written (or as its turn ends with
        // it); one already going carries on to the new length, and past the reply's end.
        guard revealsGradually || justEnded else { return nil }
        // Out of sight, or come back on screen with the words held meanwhile.
        if isOutOfSight || chatCaughtUpAt.map({ Date.now.timeIntervalSince($0) < Self.caughtUpMoment }) == true {
            return nil
        }
        // From where the text stood: nothing at first, then its last length. A reply
        // already long when this view is made is not eased in again from nothing: a
        // thread opened in the middle of one, or the reply coming back into view after the
        // chat let go of it far above. Unless it is new while the chat has been on screen:
        // then it came at once (Claude Code sends a reply whole once it has thought), and
        // plays in.
        let watched = chatShownSince.map { Date.now.timeIntervalSince($0) > Self.settling } ?? false
        return min(revealed ?? (count > Self.shownAtOnce && !watched ? count : 0), old)
    }

    /// How long a reply can be, when its view is made, and still be eased in from
    /// nothing: about the first few deltas of a reply.
    private static let shownAtOnce = 400
    /// How long after a chat kept out of sight comes back the words it held show at once.
    private static let caughtUpMoment: TimeInterval = 0.25

    /// Reveals towards the full text, about a word at a time twenty times a second,
    /// faster when it is further behind, so a burst eases in instead of jumping. Each
    /// step lays the reply out and draws it again: sixty a second kept a Mac's main
    /// thread too busy to keep up with scrolling, and twenty instead of thirty, at the
    /// same pace, took a tenth off what a reply costs the phone (docs/perf-mac-scroll.md).
    private func catchUp() async {
        while let shown = revealed, shown < target {
            let step = burstStep > 0 ? max(Self.smallestStep, burstStep) : max(Self.smallestStep, (target - shown) * 2 / 7)
            revealed = min(target, shown + step)
            try? await Task.sleep(for: Self.stepInterval)
        }
    }

    /// How much text coming at once is a burst, played in evenly; over how many steps
    /// (at `stepInterval`, about six tenths of a second); and how long the chat is on
    /// screen before a long reply new to it counts as one that came then.
    private static let burst = 160
    private static let burstSteps = 12
    private static let settling: TimeInterval = 1

    /// How often the reveal steps, and the fewest characters a step shows: together the
    /// slowest pace a reply comes in at, 120 characters a second, as at thirty steps a
    /// second of four. A step takes two sevenths of what is behind, which catches up with
    /// a burst as fast as a fifth thirty times a second did.
    private static let stepInterval = Duration.milliseconds(50)
    private static let smallestStep = 6
}

/// How many visuals the replies of a turn lay out, added up: the turn holds the place of
/// one the agent has begun until its reply shows it (`Turn.awaitsWidget(shown:)`).
struct ShownVisualsKey: PreferenceKey {
    static let defaultValue = 0

    static func reduce(value: inout Int, nextValue: () -> Int) {
        value += nextValue()
    }
}

/// A reply's blocks, parsed again only when its text changed. While the reply is being
/// written, only what follows its last finished block is parsed again
/// (`MarkdownStream`); once it is done, all of it, once. A block the new text leaves as
/// it was is kept as the very value it was, so that nothing drawn from it has to be
/// compared or laid out again.
private final class ParsedReply {
    private var source: String?
    private var isBeingWritten = false
    private var stream = MarkdownStream()
    /// How many of `blocks` the stream had settled: the very values it gives again.
    private var settledCount = 0
    private var blocks: [MarkdownBlock] = []
    /// Goes up each time the stream starts over, and its settled blocks with it.
    private var generation = 0

    /// Which of the blocks given last are settled, while the reply is being written: the
    /// stream gives them again as they are, so their views need not be compared
    /// (`MarkdownBlocksView.Settled`).
    var settled: MarkdownBlocksView.Settled? {
        isBeingWritten ? .init(count: settledCount, generation: generation) : nil
    }

    func blocks(of text: String, isBeingWritten: Bool) -> [MarkdownBlock] {
        guard text != source || isBeingWritten != self.isBeingWritten else { return blocks }
        source = text
        self.isBeingWritten = isBeingWritten
        var parsed: [MarkdownBlock]
        var kept = 0
        if isBeingWritten {
            let startedOver = stream.startedOver
            parsed = stream.blocks(text)
            // The text no longer carries on: what was settled is not any more.
            if stream.startedOver != startedOver { generation += 1 }
            kept = min(settledCount, stream.settledCount)
            settledCount = stream.settledCount
        } else {
            stream = MarkdownStream()
            settledCount = 0
            generation += 1
            parsed = Markdown.blocks(text)
        }
        for index in parsed.indices.dropFirst(kept) where index < blocks.count && blocks[index] == parsed[index] {
            parsed[index] = blocks[index]
        }
        blocks = parsed
        return blocks
    }
}

// MARK: - Small lines

struct NoticeLine: View {
    let notice: Notice

    var body: some View {
        Label(notice.text, systemImage: symbol)
            .font(.app.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .copyMenu(notice.text)
    }

    private var symbol: String {
        switch notice.level {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "exclamationmark.circle"
        }
    }
}

/// What set a turn going when it was not a message of yours: one quiet line.
struct EventLine: View {
    let event: HostEvent

    var body: some View {
        Label(event.text, systemImage: symbol)
            .font(.app.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Started by the host: \(event.text)")
            .accessibilityIdentifier("turn-event")
    }

    private var symbol: String {
        switch event.kind {
        case .backgroundProcess: "terminal"
        case .backgroundAgents: "person.2"
        case .recurringTask: "repeat"
        case .resumed: "arrow.clockwise"
        case .other: "bolt"
        }
    }
}

/// The line under an ended turn: "1m 42s · 52.3k tokens", as quiet as the figures on the
/// subagents line.
struct TurnFooter: View {
    let text: String
    var isRunning = false

    var body: some View {
        Text(text)
            .font(.app.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .accessibilityLabel(isRunning ? text : "Took \(text)")
            .accessibilityIdentifier("turn-footer")
    }
}

struct QuietNote: View {
    let text: String
    let systemImage: String

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.app.footnote)
            .foregroundStyle(.tertiary)
    }
}
