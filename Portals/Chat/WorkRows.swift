import AgentCore
import SwiftUI

/// Work folded into one line ("4 steps · 38s"). Tap to see it. The work under way in a
/// running turn is the status line's (`RunStatusLine`).
struct StepsFoldView: View {
    let steps: TurnLayout.Steps

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard

    init(steps: TurnLayout.Steps) {
        self.steps = steps
        _isOpen = RowOpen(.steps(steps.id))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            Button {
                swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
            } label: {
                HStack(spacing: Theme.grid * 0.75) {
                    Image(systemName: "chevron.right")
                        .font(.app.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(steps.summary)
                    if steps.failedCount > 0 {
                        Text("· \(steps.failedCount) failed")
                    }
                }
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(isOpen ? "Hides the steps" : "Shows the steps")
            .accessibilityIdentifier("steps-fold")

            if isOpen {
                FoldedItems(items: steps.items)
                    .transition(.opacity)
            }
        }
    }
}

/// The items of an opened fold, one under the other, with a quiet rule beside them; in
/// the status line opened while the agent thinks, its thought so far is the last of them.
struct FoldedItems: View {
    let items: [TurnItem]
    var thought: Reasoning?
    /// The thought's item, whose row it becomes once the agent moves on.
    var thoughtID: UUID?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.25) {
            ForEach(items) { item in
                WorkItemView(item: item)
            }
            if let thought {
                LiveThoughtRow(reasoning: thought, row: thoughtID.map { .item($0) })
            }
        }
        .padding(.leading, Theme.grid * 1.5)
        .overlay(alignment: .leading) {
            Capsule().fill(.quaternary).frame(width: 2)
        }
    }
}

/// One item of a turn's work, as it shows live and inside the fold.
struct WorkItemView: View {
    let item: TurnItem
    @Environment(\.dismissCommandAnswer) private var commandAnswers
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        switch item.content {
        case let .tool(run):
            ToolRunRow(run: run, row: .item(item.id))
        case let .reasoning(reasoning):
            ReasoningRow(reasoning: reasoning, row: .item(item.id))
        case let .request(record):
            RequestRecordRow(record: record)
        case let .text(text):
            MarkdownBlocksView(blocks: Markdown.blocks(text))
        case let .notice(notice):
            NoticeLine(notice: notice)
        case let .user(message):
            // One another agent or a script sent through Portals is a bubble like yours, with
            // who sent it above it.
            if let relayed = message.relayed {
                RelayedMessageRow(message: message, relayed: relayed, row: .item(item.id))
            } else {
                UserBubble(message: message, id: item.id)
            }
        case let .command(run):
            if let failure = run.failure {
                CommandFailureRow(command: run.command, reason: failure, onClose: { closeAnswer() })
            } else {
                CommandOutputView(run: run, row: .answer(item.id), onClose: { closeAnswer() })
            }
        case let .event(event):
            EventLine(event: event)
        case let .compaction(compaction):
            CompactionLine(compaction: compaction)
        }
    }

    private func closeAnswer() {
        swipeGuard { commandAnswers?.close(item.id) }
    }
}

// MARK: - Status line

/// What the agent is doing right now, at the end of the turn it is on: the tool call in
/// progress, or what it says it is working on (`StatusHeadline`: a GPT model's reasoning
/// title, Claude Code's to-do in progress or its summary of its calls; 2026-10-26,
/// in place of "Thinking…"), or that it is thinking, its words swept by a brighter sheen while the agent
/// works (`StatusSheen`; 2026-10-23, in place of the spinner it had). A tool call
/// stays on the line at least a moment (`StatusHold`, about 1.5 s), so a fast one can be
/// read. With the work under way
/// (`TurnLayout.UnderWay`), it is that work's one line (2026-10-19): what was done
/// since the agent last said something folds into it ("4 steps", tap to see the steps).
/// With "Show thinking" on (off unless chosen), the thought the agent streams shows under
/// the line in three lines (`ThoughtWindow`), a room that opens with the first thought of
/// the work and stays, empty between thoughts, until the agent says something, so the chat
/// does not move at each step (2026-10-20). Opened, the line lists the steps and
/// the whole thought. The line is one line tall whatever it says, and what it says changes
/// with a short cross-fade. The running turn's to-do list is a part of its own under the
/// line (`TodoPlanSection`); with `PORTALS_DEBUG_PLAN_SECTION=before` it is the line's, as
/// before: a compact line below the tool's live output, its checklist opened with the steps.
struct RunStatusLine: View {
    let status: RunStatus
    var underWay: TurnLayout.UnderWay?
    var plan: TodoPlan?

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard
    @AppStorage(ThoughtWindow.settingKey) private var showsThinking = false
    /// The elapsed text is empty initially; track the nonempty header instead.
    @State private var isInView = true
    /// What the line shows: `status`, but a tool call held there a moment.
    /// The line shows a call held after it gave way to something newer (`StatusHold`,
    /// kept by the turn so it outlasts the line going while the agent's words are written).
    var isHolding = false

    init(status: RunStatus, underWay: TurnLayout.UnderWay? = nil, plan: TodoPlan? = nil, isHolding: Bool = false) {
        self.status = status
        self.underWay = underWay
        self.plan = plan
        self.isHolding = isHolding
        // The fold the work becomes when the agent says something has the same id, so
        // opened here it stays open there.
        _isOpen = RowOpen(underWay.map { .steps($0.id) })
    }

    /// What the line says the agent does: the newest status, or a tool call still held.
    private var shown: RunStatus { status }
    /// The spinner as before, with no sheen (`PORTALS_DEBUG_STATUS_LINE=before`).
    private static let spins = DebugLaunch.statusLineBefore
    /// The words start at the chat's edge, in line with its text: no icon before them, the
    /// sheen saying the agent works and the words alone that it waits for the user (2026-10-23, of the spinner's indent kept empty: "just make it not offset i dont get why
    /// offsetting it helps we have no spinner anymore"). Its thought and its tool's output
    /// line up with its words. The spinner as before keeps its slot.
    private var wordsInset: CGFloat { Self.spins ? 20 + Theme.grid : 0 }

    private var items: [TurnItem] { underWay?.items ?? [] }
    private var thought: Reasoning? { underWay?.thought }
    private var planSummary: String? { plan?.summary }
    /// A running tool can be opened before the first step has finished.
    private var opens: Bool { planSummary != nil || !items.isEmpty || thought != nil }

    private var liveOutputTail: String? {
        // None for a call held on the line after it ended: its output then was not its last.
        guard !isHolding, case let .tool(run, _) = shown, run.state == .running, let output = run.output else { return nil }
        return output.suffix(512).split(whereSeparator: \.isNewline).last.map(String.init)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Button {
                guard opens else { return }
                swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityRemoveTraits(opens ? [] : .isButton)
            .accessibilityHint(hint)
            .accessibilityIdentifier("run-status")
            .id("tool-status")
            .onScrollVisibilityChange(threshold: 0.01) { isInView = $0 }

            if isOpen, !items.isEmpty || thought != nil {
                FoldedItems(items: items, thought: thought, thoughtID: underWay?.thoughtID)
                    .transition(.opacity)
            } else if !isOpen, showsThinking, underWay?.hasThought == true {
                // Under the line's words, without the titles the line says.
                ThoughtWindow(reasoning: thought, id: underWay?.thoughtID, dropsTitles: !DebugLaunch.statusHeadlineBefore)
                    .padding(.leading, wordsInset)
                    .transition(.opacity)
                    .accessibilityHidden(true)
            }
            if !isOpen, let tail = liveOutputTail {
                Text(tail)
                    .font(.app.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, wordsInset)
                    .accessibilityIdentifier("live-tool-output")
                    .id("live-tool-output")
            }
            if let planSummary {
                tasksRow(planSummary)
                    .id("tasks")
                if isOpen, let plan {
                    TodoChecklist(plan: plan, identifier: "run-status-checklist")
                        .padding(.leading, 20 + Theme.grid)
                        .transition(.opacity)
                }
            }
        }
        .animation(.smooth(duration: 0.25), value: showsThinking && underWay?.hasThought == true)
    }

    private var header: some View {
        HStack(spacing: Theme.grid) {
            if Self.spins {
                Group {
                    if shown == .waitingForUser {
                        Image(systemName: "hourglass")
                            .font(.app.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 20)
            }
            // What the agent does now. A new thing done cross-fades with the one before,
            // the two on top of each other in the same place; while the agent works, a
            // sheen sweeps over the words.
            ZStack(alignment: .leading) {
                StatusSheen(sweeps: !Self.spins && shown != .waitingForUser) { statusWords }
                    .id(nowKey)
                    .transition(.opacity)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .animation(.smooth(duration: 0.25), value: nowKey)
            if let summary = underWay?.summary {
                Text(summary)
                    .font(.app.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .contentTransition(.numericText())
                    .animation(.smooth(duration: 0.25), value: summary)
            }
            if opens {
                Image(systemName: "chevron.right")
                    .font(.app.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
        }
        .contentShape(.rect)
    }

    /// What the line is about, for its cross-fade: what changes within one of these
    /// (another call beside the one running, a thought's words) changes in place.
    private enum Now: Hashable {
        case thinking
        case tool(String)
        case note(String)
        case headline(String)
        case waiting
    }

    private var nowKey: Now {
        switch shown {
        case .thinking: return .thinking
        case let .tool(run, _): return .tool(run.id)
        case let .note(text): return .note(text)
        case let .headline(text): return .headline(text)
        case .waitingForUser: return .waiting
        }
    }

    private func tasksRow(_ summary: String) -> some View {
        Button {
            swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
        } label: {
            HStack(spacing: Theme.grid) {
                Image(systemName: "checklist")
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                ZStack(alignment: .leading) {
                    words(summary)
                        .id(summary)
                        .transition(.opacity)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(.smooth(duration: 0.25), value: summary)
                Image(systemName: "chevron.right")
                    .font(.app.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary)
        .accessibilityHint(hint)
        .accessibilityAddTraits(.updatesFrequently)
        .accessibilityIdentifier("run-status-plan")
    }

    @ViewBuilder
    private var statusWords: some View {
        switch shown {
        case .thinking:
            words("Thinking…")
        case .waitingForUser:
            words("Waiting for you")
        case let .note(text):
            words(text)
        case let .headline(text):
            // One line, cut with an ellipsis: the line is as tall whatever it says.
            words(text)
        case let .tool(run, others):
            HStack(spacing: Theme.grid) {
                ToolTitle(run: run)
                if others > 0 {
                    Text("+\(others) more")
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                // A call running long with nothing to show says how long so far.
                if !isHolding, run.state == .running, run.output?.isEmpty != false {
                    ElapsedSince(start: run.startedAt, isInView: isInView)
                }
            }
        }
    }

    private func words(_ text: String) -> some View {
        Text(text)
            .font(.app.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .contentTransition(.opacity)
    }

    private var hint: String {
        guard opens else { return "" }
        let what = [
            !items.isEmpty ? "the steps" : nil,
            thought != nil ? "the thought" : nil,
            planSummary != nil ? "the checklist" : nil,
        ].compactMap(\.self).joined(separator: " and ")
        return isOpen ? "Hides \(what)" : "Shows \(what)"
    }

    private var accessibilityLabel: String {
        let now = switch shown {
        case .thinking: "Thinking"
        case .waitingForUser: "Waiting for you"
        case let .note(text): text
        case let .headline(text): text
        case let .tool(run, others):
            [run.subagentCall?.words(running: true) ?? ToolPresentation.title(for: run.name), run.subagentCall == nil ? run.label : nil, others > 0 ? "and \(others) more" : nil]
                .compactMap(\.self).joined(separator: ", ")
        }
        return [now, underWay?.summary].compactMap(\.self).joined(separator: ", ")
    }
}

/// The thought the agent is streaming, whole, as the last row of the status line opened:
/// under the line, closed, only its newest lines show, when "Show thinking" is on. It grows as the thought comes in, inside
/// the list you opened.
private struct LiveThoughtRow: View {
    let reasoning: Reasoning
    /// Where the chat keeps whether the thought's row is open: read here, it stays open as
    /// the thought's row once the thought ends, so what you were reading does not fold away.
    @RowOpen private var isOpen: Bool

    init(reasoning: Reasoning, row: OpenRows.Row?) {
        self.reasoning = reasoning
        _isOpen = RowOpen(row, initially: true)
    }

    var body: some View {
        let text = reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines)
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Image(systemName: "sparkle")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            Text(ThoughtText.attributed(text))
                .font(.app.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .copyMenu(text)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Thinking: \(text)")
        .accessibilityIdentifier("live-thought")
        .onAppear { isOpen = true }
    }
}

// MARK: - Tool call

/// A tool call's name and what it is working on, for a row: "Terminal  pytest -q".
struct ToolTitle: View {
    let run: ToolRun

    var body: some View {
        if let call = run.subagentCall {
            // A call about the agents it set to work says what it did, by their names.
            Text(call.words(running: run.state == .running))
                .font(.app.subheadline.weight(.medium))
                .lineLimit(1)
        } else {
            Text(ToolPresentation.title(for: run.name))
                .font(.app.subheadline.weight(.medium))
                .fixedSize()
            if let label = run.label {
                Text(label)
                    .font(.app.subheadline.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// One tool call on one line: what it is, what it is working on, how long it took.
/// Tap to see its input, output and diff.
struct ToolRunRow: View {
    let run: ToolRun

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard

    /// - Parameter row: where the chat keeps whether it is open.
    init(run: ToolRun, row: OpenRows.Row? = nil) {
        self.run = run
        _isOpen = RowOpen(row)
    }

    private var diff: DiffText? { run.diff.map(DiffText.init) }
    private var hasDetails: Bool { run.execution != nil || run.plan != nil || run.input != nil || run.output?.isEmpty == false || run.diff != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Button {
                guard hasDetails else { return }
                swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
            } label: {
                header
            }
            .buttonStyle(.plain)
            .opensFileInMenu(run)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityHint(hasDetails ? (isOpen ? "Hides the details" : "Shows the details") : "")

            if isOpen {
                details.transition(.opacity)
            }
            if run.state == .running, let progress = run.progress, !progress.isEmpty {
                Text(progress)
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.leading, 20 + Theme.grid)
                    .accessibilityIdentifier("tool-progress")
            }
        }
        .accessibilityIdentifier("tool-row")
        // When opened through the running status line, stdout is visible at once.
        // A user's later close is respected until a different row first gains output.
        .onChange(of: run.output?.isEmpty == false, initial: true) { _, hasOutput in
            if run.state == .running, hasOutput { isOpen = true }
        }
    }

    private var header: some View {
        HStack(spacing: Theme.grid) {
            Image(systemName: ToolPresentation.symbol(for: run.name))
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            ToolTitle(run: run)
            if let stats = diff?.stats {
                Text(stats)
                    .font(.app.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            Spacer(minLength: Theme.grid / 2)
            trailing
        }
        .contentShape(.rect)
    }

    @ViewBuilder
    private var trailing: some View {
        switch run.state {
        case .running:
            ProgressView().controlSize(.mini)
        case .failed:
            Image(systemName: "xmark.circle")
                .font(.app.footnote)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Failed")
        case .succeeded:
            if let duration = run.duration {
                Text(TurnLayout.toolDuration(duration))
                    .font(.app.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
        }
        if hasDetails {
            Image(systemName: "chevron.right")
                .font(.app.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isOpen ? 90 : 0))
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            if let execution = run.execution {
                ToolExecutionView(execution: execution)
            }
            if let plan = run.plan, !plan.items.isEmpty {
                TodoChecklist(plan: plan)
            } else if let input = run.input {
                MonoBlock(title: "Input", text: input)
                    .equatable()
            }
            if let diff {
                InlineDiffView(diff: diff)
                    .copyMenu(run.diff ?? "")
            }
            if let output = run.output, !output.isEmpty {
                MonoBlock(title: run.state == .failed ? "Result" : "Output", text: output)
                    .equatable()
            }
            if run.outputTruncated == true {
                Text("Earlier output omitted")
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
            }
            OpenFileButton(run: run)
        }
        .padding(.leading, 20 + Theme.grid)
    }

    private var accessibilityLabel: String {
        let state = switch run.state {
        case .running: "running"
        case .failed: "failed"
        case .succeeded: run.duration.map { "took \(TurnLayout.toolDuration($0))" } ?? "done"
        }
        if let call = run.subagentCall { return [call.words(running: run.state == .running), state].joined(separator: ", ") }
        return [ToolPresentation.title(for: run.name), run.label, state].compactMap(\.self).joined(separator: ", ")
    }
}

/// How a tool is named and drawn. Unknown tools get a readable version of their name.
enum ToolPresentation {
    static func title(for name: String) -> String {
        switch name {
        case "terminal", "process": "Terminal"
        case "read_file": "Read"
        case "write_file": "Write"
        case "patch": "Edit"
        case "search_files": "Search"
        case "web_search": "Web search"
        case "web_extract": "Read page"
        case "execute_code": "Run code"
        case "delegate_task": "Delegate"
        case "todo": "To-do"
        case "memory": "Memory"
        case "vision_analyze": "Look"
        case "image_generate": "Draw"
        default:
            name.replacingOccurrences(of: "_", with: " ").capitalizedFirst
        }
    }

    static func symbol(for name: String) -> String {
        switch name {
        case "terminal", "process": "terminal"
        case "read_file": "doc.text"
        case "write_file": "square.and.pencil"
        case "patch": "pencil.line"
        case "search_files": "magnifyingglass"
        case "web_search", "web_extract": "globe"
        case "execute_code": "chevron.left.forwardslash.chevron.right"
        case "delegate_task": "person.2"
        case "todo": "checklist"
        case "memory": "brain"
        case "vision_analyze": "eye"
        case "image_generate": "photo"
        default:
            name.hasPrefix("browser") ? "safari" : "wrench.and.screwdriver"
        }
    }
}

private extension String {
    var capitalizedFirst: String {
        prefix(1).uppercased() + dropFirst()
    }
}

/// Monospaced text under a small title: a command, a file's contents, a tool's output.
/// Long lines wrap; tall text scrolls inside the block.
/// Compare only these words before rebuilding: progress metadata can change beside
/// an unchanged output tail. The host's replacement text is rendered as-is, not appended.
struct MonoBlock: View, Equatable {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.app.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, Theme.grid * 1.5)
                .padding(.top, Theme.grid)
                .padding(.bottom, Theme.grid / 2)
            // Wrapped, not scrolled sideways: on a phone a long line is easier read
            // broken than chased, and sideways drags stay free for the sidebar.
            ScrollView {
                output
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.grid * 1.5)
                    .padding(.bottom, Theme.grid)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12, style: .continuous))
        .copyMenuWhenNotSelectable(text)
    }

    /// The text, selected where it is (`ProseSelection`), with Copy All in its menu.
    @ViewBuilder
    private var output: some View {
        if ProseSelection.isOn {
            SelectablePlainText(text: text, font: .monospacedFootnote, fillsColumn: true, copiesAll: "Copy All")
        } else {
            Text(verbatim: text)
                .font(.app.footnote.monospaced())
        }
    }
}

/// A unified diff: the file's name and counts on top, then each line, added lines on
/// green and removed lines on red.
struct InlineDiffView: View {
    let diff: DiffText

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(diff.fileName ?? "Changes")
                    .font(.app.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                if let stats = diff.stats {
                    Text(stats)
                        .font(.app.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .padding(.vertical, Theme.grid)
            Divider()
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(diff.lines) { line in
                        HStack(spacing: Theme.grid) {
                            Text(marker(line.kind))
                                .foregroundStyle(.secondary)
                                .frame(width: 10, alignment: .leading)
                            Text(line.text.isEmpty ? " " : line.text)
                                .foregroundStyle(line.kind == .hunk ? .secondary : .primary)
                        }
                        .font(.app.footnote.monospaced())
                        .padding(.horizontal, Theme.grid * 1.5)
                        .padding(.vertical, 2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(background(line.kind))
                    }
                }
                .fixedSize(horizontal: true, vertical: true)
                .padding(.vertical, Theme.grid / 2)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 260)
        }
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Changes to \(diff.fileName ?? "a file"): \(diff.added) added, \(diff.removed) removed")
    }

    private func marker(_ kind: DiffText.Kind) -> String {
        switch kind {
        case .added: "+"
        case .removed: "\u{2212}"
        case .context, .hunk: " "
        }
    }

    private func background(_ kind: DiffText.Kind) -> Color {
        switch kind {
        case .added: .green.opacity(0.16)
        case .removed: .red.opacity(0.16)
        case .context, .hunk: .clear
        }
    }
}

// MARK: - Reasoning

/// The model's reasoning on one line: "Thinking…" while it goes, "Thought for 12s"
/// after. Tap to read it.
struct ReasoningRow: View {
    let reasoning: Reasoning

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard

    /// - Parameter row: where the chat keeps whether it is open.
    init(reasoning: Reasoning, row: OpenRows.Row? = nil) {
        self.reasoning = reasoning
        _isOpen = RowOpen(row)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Button {
                swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
            } label: {
                HStack(spacing: Theme.grid) {
                    Image(systemName: "sparkle")
                        .font(.app.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    Text(title)
                        .font(.app.subheadline.weight(.medium))
                    Spacer(minLength: Theme.grid / 2)
                    if reasoning.endedAt == nil {
                        ProgressView().controlSize(.mini)
                    }
                    Image(systemName: "chevron.right")
                        .font(.app.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(isOpen ? "Hides the reasoning" : "Shows the reasoning")

            if isOpen {
                Text(ThoughtText.attributed(reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines)))
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .copyMenu(reasoning.text.trimmingCharacters(in: .whitespacesAndNewlines))
                    .padding(.leading, 20 + Theme.grid)
                    .transition(.opacity)
            }
        }
        .accessibilityIdentifier("reasoning-row")
    }

    private var title: String {
        guard let duration = reasoning.duration else { return "Thinking…" }
        return duration < 1 ? "Thought" : "Thought for \(TurnLayout.shortDuration(duration))"
    }
}

/// A thought's text as it reads where it is shown whole (the status line opened, a "Thought
/// for 12s" row): its inline Markdown drawn, so a GPT model's titles (`**Validating prime
/// numbers**`) are bold rather than between raw asterisks, as `Text` showed a thought's
/// string until 2026-10-26; its line breaks kept. Copy gives the text as the agent wrote it.
enum ThoughtText {
    static func attributed(_ text: String) -> AttributedString {
        guard text.contains(where: { "*_`[".contains($0) }) else { return AttributedString(text) }
        return (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

// MARK: - Answered request

/// An approval or a question after it was answered: what was asked and what you said,
/// or the agent that started the thread said for you.
struct RequestRecordRow: View {
    let record: RequestRecord

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Image(systemName: symbol)
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.answer)
                    .font(.app.subheadline.weight(.medium))
                if let by = record.answeredBy {
                    Text("Answered by \(by)")
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                }
                Text(record.prompt)
                    .font(record.kind == .approval ? .app.footnote.monospaced() : .app.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("request-record")
    }

    private var symbol: String {
        switch record.kind {
        // "Denied", or "Denied: " and what to do instead.
        case .approval: record.answer.hasPrefix("Denied") ? "xmark.shield" : "checkmark.shield"
        case .question: "questionmark.bubble"
        }
    }
}

/// How long a running call has taken so far (`ToolElapsed`), once a few seconds have gone:
/// its text changes once a second, nothing else of the line is laid out again for it.
private struct ElapsedSince: View {
    let start: Date
    let isInView: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isOutOfSight) private var isOutOfSight

    var body: some View {
        TimelineView(ElapsedSchedule(paused: isOutOfSight || scenePhase != .active || !isInView)) { context in
            if let text = ToolElapsed.text(context.date.timeIntervalSince(start)) {
                Text(text)
                    .font(.app.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .accessibilityLabel("for \(text)")
            }
        }
    }
}
