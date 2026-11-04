import AgentCore
import SwiftUI

/// The agents the thread's agent has set to work, under the chat while any of them is
/// still at it (and, from a host that keeps them, once they have ended): how many, and
/// when opened, what each was asked, what it is doing or what it answered, and for how
/// long. They work on after the agent's own turn is over, which is when nothing else on
/// screen would say so. A workflow is one row, with its phase and how many of its agents
/// are at work; any row opens what is known of it. One that can be stopped by itself has
/// a Stop. The line as it was before it became a part of the one line at the foot of the
/// chat (`ChatFootLine`), shown with `PORTALS_DEBUG_FOOT_LINE=before`.
struct SubagentsLine: View {
    let subagents: [Subagent]
    /// The one whose detail is open: the chat's, which shows it (`detail`), so that it
    /// stays open while the line itself comes and goes.
    @Binding var opened: Subagent.ID?
    /// As `FootDisclosure.onToggle`.
    var onToggle: () -> Void = {}
    /// Stop pressed on one of them.
    var onStop: (Subagent.ID) -> Void = { _ in }

    private var working: Int { subagents.count(where: \.isWorking) }

    var body: some View {
        FootDisclosure(
            hints: FootLine.hints(of: subagents, threads: false),
            identifier: "subagents-line", onToggle: onToggle
        ) {
            HStack(spacing: Theme.grid) {
                FootMark(mark: working > 0 ? .working : .ended)
                FootTitle(text: FootLine.title(of: subagents, threads: []))
            }
        } rows: {
            // A subagent's own subagent under the one that started it, set in.
            ForEach(subagents.nested, id: \.agent.id) { entry in
                SubagentRow(agent: entry.agent, depth: entry.depth, opened: $opened, onStop: onStop)
            }
        }
        .animation(.smooth(duration: 0.25), value: subagents)
    }

    /// The detail of the one `id` names among `subagents`, as the line opens it: looked
    /// up each time, so it follows the news while it is open. Nothing once it has left
    /// them.
    @ViewBuilder
    static func detail(
        of id: Subagent.ID, in subagents: [Subagent], read: ((Subagent.ID) async throws -> Transcript?)? = nil,
        onStop: @escaping (Subagent.ID) -> Void, onDone: @escaping () -> Void
    ) -> some View {
        if let agent = subagents.first(where: { $0.id == id }) {
            // The one on the line that started it, for a subagent's own subagent.
            let parent = agent.parentID.flatMap { parent in subagents.first { $0.id == parent } }
            SubagentDetail(
                agent: agent, startedBy: parent.map(SubagentLook.title(of:)), read: agent.canRead ? read : nil, onStop: onStop, onDone: onDone
            )
        }
    }
}

/// One agent, workflow or command on the line: its symbol, title, what it is doing or how
/// it ended, its time, and Stop where it can be stopped by itself. A tap opens its detail
/// (`opened`), from a host that keeps them. A subagent's own subagent is set in by how
/// deep it is.
struct SubagentRow: View {
    let agent: Subagent
    var depth = 0
    @Binding var opened: Subagent.ID?
    let onStop: (Subagent.ID) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            // Only a host that keeps them says enough to open.
            if agent.isKept {
                Button {
                    swipeGuard { opened = agent.id }
                } label: {
                    content
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Shows what is known of it")
                .accessibilityIdentifier("subagent-row-\(agent.id)")
            } else {
                content
                    .accessibilityElement(children: .combine)
            }
            if agent.canStop {
                StopSubagentButton(agent: agent, onStop: onStop)
            }
        }
        .padding(.leading, Theme.grid * 2.5 * CGFloat(min(depth, 2)))
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Image(systemName: SubagentLook.symbol(for: agent))
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(SubagentLook.tint(for: agent.state))
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(SubagentLook.title(of: agent))
                    .font(.app.footnote)
                    .foregroundStyle(agent.isWorking ? .primary : .secondary)
                    .lineLimit(2)
                if let doing = SubagentLook.detail(of: agent) {
                    Text(doing)
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(agent.isWorking ? 1 : 2)
                }
            }
            Spacer(minLength: Theme.grid)
            ElapsedTime(agent: agent)
        }
        .contentShape(.rect)
    }
}

/// How long one has worked: counting while it works, how long it took once it ended.
private struct ElapsedTime: View {
    let agent: Subagent
    var font: Font = .app.caption
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isOutOfSight) private var isOutOfSight
    @State private var isInView = true

    var body: some View {
        if let started = agent.startedAt {
            Group {
                if let ended = agent.endedAt {
                    Text(TurnLayout.shortDuration(ended.timeIntervalSince(started)))
                } else {
                    TimelineView(ElapsedSchedule(paused: isOutOfSight || scenePhase != .active || !isInView)) { context in
                        Text(TurnLayout.shortDuration(context.date.timeIntervalSince(started)))
                    }
                    .onScrollVisibilityChange(threshold: 0.01) { isInView = $0 }
                }
            }
            .font(font.monospacedDigit())
            .foregroundStyle(.tertiary)
        }
    }
}

/// Stops one subagent or workflow by itself; the turn and the others go on.
private struct StopSubagentButton: View {
    let agent: Subagent
    let onStop: (Subagent.ID) -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        Button {
            swipeGuard { onStop(agent.id) }
        } label: {
            Image(systemName: "stop.circle")
                .font(.app.body)
                .foregroundStyle(.secondary)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop \(SubagentLook.title(of: agent))")
        .accessibilityIdentifier("subagent-stop-\(agent.id)")
    }
}

/// What the line and the detail say of an agent.
enum SubagentLook {
    static func title(of agent: Subagent) -> String {
        agent.title
    }

    static func symbol(for agent: Subagent) -> String {
        switch agent.state {
        case .working:
            switch agent.kind {
            case .agent: "circle.dotted"
            case .workflow: "square.stack.3d.up"
            case .command: "terminal"
            }
        case .finished: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .stopped: "stop.circle"
        }
    }

    /// A part's small icon on the closed line at the foot of the chat (`FootLine.icons`):
    /// the workflows' as a workflow's row has it, the subagents' as the chat has a hand-off
    /// to agents (`delegate_task`, `HostEvent.backgroundAgents`), since an agent's row has
    /// only the dotted circle of anything at work.
    static func symbol(for part: FootLine.Part) -> String {
        switch part {
        case .subagents: "person.2"
        case .workflows: "square.stack.3d.up"
        case .threads: "arrow.turn.down.right"
        case .commands: "terminal"
        }
    }

    static func symbol(for state: Subagent.State) -> String {
        switch state {
        case .working: "circle.dotted"
        case .finished: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .stopped: "stop.circle"
        }
    }

    static func tint(for state: Subagent.State) -> AnyShapeStyle {
        state == .failed ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary)
    }

    static func stateText(_ state: Subagent.State) -> String {
        switch state {
        case .working: "Working"
        case .finished: "Done"
        case .failed: "Did not finish"
        case .stopped: "Stopped"
        }
    }

    /// What an agent is doing, or how it ended; for a workflow, its phase and agents.
    static func detail(of agent: Subagent) -> String? {
        if agent.kind == .workflow { return workflowDetail(of: agent) }
        if agent.kind == .command {
            // Its last line of output while it runs; how it ended once it has.
            switch agent.state {
            case .working: return agent.summary ?? "Running"
            case .finished: return agent.summary.map { "Done · \($0)" } ?? "Done"
            case .failed: return agent.result.map(firstLine) ?? "Failed"
            case .stopped: return "Stopped"
            }
        }
        switch agent.state {
        case .working:
            if let summary = agent.summary { return summary }
            guard let tool = agent.tool else { return nil }
            return [ToolPresentation.title(for: tool), agent.toolDetail].compactMap(\.self).joined(separator: " · ")
        case .finished:
            return agent.result.map(firstLine) ?? "Done"
        case .failed:
            return agent.result.map(firstLine) ?? "Did not finish"
        case .stopped:
            return "Stopped"
        }
    }

    private static func workflowDetail(of agent: Subagent) -> String? {
        let running = agent.agents.count(where: \.isWorking)
        let done = agent.agents.count(where: { $0.state == .finished })
        var parts: [String] = []
        switch agent.state {
        case .working:
            if let phase = agent.currentPhase, !phase.isEmpty { parts.append(phase) }
            if running > 0 { parts.append("\(running) running") }
            if done > 0 { parts.append("\(done) done") }
            if parts.isEmpty { return agent.goal.isEmpty ? nil : agent.goal }
        case .finished:
            parts.append("Done")
            if !agent.agents.isEmpty { parts.append(agent.agents.count == 1 ? "1 agent" : "\(agent.agents.count) agents") }
        case .failed:
            parts.append(agent.result.map(firstLine) ?? "Did not finish")
        case .stopped:
            parts.append("Stopped")
            if done > 0 { parts.append("\(done) of \(agent.agents.count) done") }
        }
        return parts.joined(separator: " · ")
    }

    static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
    }
}

/// All that is known of one subagent or workflow: how it stands, for how long, what it
/// used and answered; for a workflow, each phase with its agents. From a host that can
/// read it, a subagent's own messages, on a page of their own.
private struct SubagentDetail: View {
    let agent: Subagent
    /// The subagent that started it, by its title, for a subagent's own subagent.
    var startedBy: String?
    /// Reads its messages; nil where they cannot be read.
    var read: ((Subagent.ID) async throws -> Transcript?)?
    let onStop: (Subagent.ID) -> Void
    let onDone: () -> Void

    @State private var showsMessages = DebugLaunch.opensSubagent == .messages
    /// Its messages take the whole height of an iPhone's sheet.
    @State private var detent: PresentationDetent = DebugLaunch.opensSubagent == .messages ? .large : .medium

    var body: some View {
        PanelChrome(
            title: SubagentLook.title(of: agent), doneIdentifier: "subagent-detail-done", cancels: showsMessages,
            doneTitle: showsMessages ? "Back" : nil, onDone: { if showsMessages { showsMessages = false } else { onDone() } }
        ) {
            if showsMessages, let read {
                SubagentMessages(agent: agent, read: read)
            } else {
                facts
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .onChange(of: showsMessages) { if showsMessages { detent = .large } }
    }

    private var facts: some View {
        List {
            Section {
                LabeledContent("Status") {
                    HStack(spacing: Theme.grid * 0.75) {
                        Image(systemName: SubagentLook.symbol(for: agent.state))
                        Text(SubagentLook.stateText(agent.state))
                    }
                    .foregroundStyle(SubagentLook.tint(for: agent.state))
                }
                if agent.startedAt != nil {
                    LabeledContent("Time") { ElapsedTime(agent: agent, font: .app.body) }
                }
                if let startedBy { LabeledContent("Started by", value: startedBy) }
                // Its role, where the title does not say it already.
                if let role = agent.role, agent.nickname == nil, agent.kind == .agent { LabeledContent("Role", value: role) }
                if let model = agent.model { LabeledContent("Model", value: model) }
                if let tokens = agent.tokens { LabeledContent("Tokens", value: tokens.formatted()) }
                if let uses = agent.toolUses, agent.kind == .agent { LabeledContent("Tool calls", value: uses.formatted()) }
            } header: {
                if !agent.goal.isEmpty, agent.kind == .workflow || agent.goal != SubagentLook.title(of: agent) {
                    Text(agent.goal)
                }
            }
            // Under how it stands, above its answer, which can run long.
            if read != nil {
                Section {
                    Button { showsMessages = true } label: {
                        HStack {
                            Text("Messages")
                            Spacer(minLength: Theme.grid)
                            Image(systemName: "chevron.right")
                                .font(.app.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows what this agent did")
                    .accessibilityIdentifier("subagent-detail-messages")
                }
            }
            if agent.kind == .agent, agent.isWorking, let doing = SubagentLook.detail(of: agent) {
                Section("Doing") { Text(doing) }
            }
            if agent.kind == .command, let output = agent.output, !output.isEmpty {
                Section(agent.isWorking ? "Output so far" : "Output") {
                    CommandOutputTail(output: output, truncated: agent.outputTruncated)
                }
            }
            if let result = agent.result, agent.kind == .agent || agent.state == .failed {
                Section(agent.state == .failed ? "Why it did not finish" : "Answer") {
                    Text(result)
                        .textSelection(.enabled)
                }
            }
            if agent.kind == .workflow {
                ForEach(groups, id: \.id) { group in
                    Section(group.title) {
                        if group.agents.isEmpty {
                            Text("No agents yet")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(group.agents) { member in
                            WorkflowAgentRow(agent: member)
                        }
                    }
                }
            }
            if agent.canStop {
                Section {
                    Button("Stop", systemImage: "stop.circle", role: .destructive) {
                        onStop(agent.id)
                    }
                    .accessibilityIdentifier("subagent-detail-stop")
                } footer: {
                    Text(stopFooter)
                }
            }
        }
    }

    private var stopFooter: String {
        switch agent.kind {
        case .agent: "Stops this agent. The thread goes on."
        case .workflow: "Stops this workflow and its agents. The thread goes on."
        case .command: "Stops this command. The thread goes on."
        }
    }

    /// The workflow's agents by phase, in the phases' order; any not in a known phase last.
    private var groups: [(id: Int, title: String, agents: [WorkflowAgent])] {
        var groups = agent.phases.map { phase in
            (id: phase.index, title: phase.title.isEmpty ? "Phase \(phase.index)" : phase.title, agents: agent.agents.filter { $0.phase == phase.title })
        }
        let placed = Set(agent.phases.map(\.title))
        let others = agent.agents.filter { $0.phase.map { !placed.contains($0) } ?? true }
        if !others.isEmpty || groups.isEmpty { groups.append((id: Int.min, title: "Agents", agents: others)) }
        return groups
    }
}

/// A subagent's own messages, read only, as the chat shows a thread's: what it was asked,
/// its tool calls and what it said, in the chat's own rows. Read as the page opens, and
/// again as the line hears more of one at work.
private struct SubagentMessages: View {
    let agent: Subagent
    let read: (Subagent.ID) async throws -> Transcript?

    @State private var turns: [Turn]?
    @State private var failure: String?
    @State private var width: CGFloat = 0

    var body: some View {
        ScrollView {
            if let turns, !turns.isEmpty {
                LazyVStack(alignment: .leading, spacing: Theme.grid * 3) {
                    ForEach(turns) { turn in
                        TurnView(turn: turn, canRetry: false, onRetry: {})
                    }
                }
                .padding(.horizontal, ChatFeature.margin)
                .padding(.vertical, Theme.grid * 2)
                .onGeometryChange(for: CGFloat.self) { max(0, $0.size.width - ChatFeature.margin * 2) } action: { width = $0 }
                .environment(\.widgetLayoutWidth, width)
            } else if let failure {
                QuietNote(text: failure, systemImage: "exclamationmark.triangle")
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.grid * 6)
            } else if turns != nil {
                QuietNote(text: agent.isWorking ? "Nothing yet" : "No messages", systemImage: "text.bubble")
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.grid * 6)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.top, Theme.grid * 6)
            }
        }
        .background(Theme.pageBackground)
        .task(id: news) {
            do {
                let transcript = try await read(agent.id)
                // Under the ids of the last read, so what the reader opened stays open.
                turns = transcript?.keepingIdentities(of: Transcript(turns: turns ?? [])).turns ?? []
                failure = nil
            } catch is CancellationError {
            } catch {
                // What was read before stays.
                if turns == nil { failure = "Its messages could not be read." }
            }
        }
        .accessibilityIdentifier("subagent-messages")
    }

    /// What the line has heard of it: read again when that changes.
    private var news: [String?] {
        [SubagentLook.stateText(agent.state), agent.summary, agent.tool, agent.toolUses.map(String.init), agent.result]
    }
}

/// One agent of a workflow: its label and state, its model, time and tokens, and the
/// start of what it answered.
private struct WorkflowAgentRow: View {
    let agent: WorkflowAgent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                Image(systemName: SubagentLook.symbol(for: agent.state))
                    .foregroundStyle(SubagentLook.tint(for: agent.state))
                Text(agent.label)
                    .font(.app.body)
                Spacer(minLength: Theme.grid)
                Text(SubagentLook.stateText(agent.state))
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
            }
            let facts = [agent.model, agent.duration.map(TurnLayout.shortDuration), agent.tokens.map { "\($0.formatted()) tokens" }].compactMap(\.self)
            if !facts.isEmpty {
                Text(facts.joined(separator: " · "))
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
            }
            if let result = agent.result {
                Text(result)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workflow-agent-\(agent.label)")
    }
}

/// The end of a background command's output, as the bridge keeps it: its last lines, in a
/// box of its own that keeps its height while more comes, following the newest line while
/// it is scrolled to the end (scrolled up to read, it stays where it is).
private struct CommandOutputTail: View {
    let output: String
    let truncated: Bool

    @State private var atEnd = true
    @State private var phase: ScrollPhase = .idle
    /// Where the box was scrolled to as a scroll of it began, when it was at its end.
    @State private var heldAtEnd: CGFloat?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if truncated {
                        Text("Earlier output left out")
                            .font(.app.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Text(output)
                        .font(.app.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(height: 1).id("end")
                }
            }
            .frame(height: 220)
            // Opened at its end, and kept there as more comes only while it is at its end
            // and not being scrolled, as the chat does: a bottom anchor for every change
            // of size pulled a reader scrolled up back to the newest line.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(atEnd && phase == .idle ? .bottom : nil, for: .sizeChanges)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 12
            } action: { _, isAtEnd in
                atEnd = isAtEnd
            }
            .onScrollPhaseChange { old, new, context in
                phase = new
                // Lines that came while it was scrolled, not followed meanwhile, left it
                // short of its end, and it stopped following for good (a wheel scroll of the
                // chat passing over the box scrolls it for a moment): taken back to its end
                // once let go, unless it was scrolled up.
                if old == .idle {
                    heldAtEnd = atEnd ? context.geometry.contentOffset.y : nil
                } else if new == .idle, let from = heldAtEnd {
                    heldAtEnd = nil
                    if !atEnd, context.geometry.contentOffset.y >= from - 12 {
                        atEnd = true
                        proxy.scrollTo("end", anchor: .bottom)
                    }
                }
            }
            .onChange(of: output) {
                // Within a few points of the end is still at it, but not while a hand is
                // on it: a slow scroll up from the end was taken back to it.
                if atEnd, phase == .idle { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
        .accessibilityIdentifier("command-output")
    }
}

