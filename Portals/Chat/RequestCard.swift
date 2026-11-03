import AgentCore
import SwiftUI

/// What the agent is blocked on, in the composer's place so it cannot scroll out of
/// view: a command to approve, or questions to answer.
struct RequestCard: View {
    let request: PendingRequest
    let agentName: String
    /// What the agent's own settings come to, for a plan whose work follows them.
    var mode: ModeState?
    var onAnswer: (RequestAnswer) -> Void

    var body: some View {
        Group {
            switch request.kind {
            case let .approval(approval):
                if approval.options != nil {
                    RichApprovalCard(approval: approval, agentName: agentName, mode: mode, onAnswer: onAnswer)
                } else if let plan = approval.plan {
                    PlanCard(text: approval.command, plan: plan, agentName: agentName, mode: mode, onAnswer: onAnswer)
                } else {
                    ApprovalCard(approval: approval, agentName: agentName, onAnswer: onAnswer)
                }
            case let .clarify(questions):
                ClarifyCard(request: request, questions: questions, agentName: agentName, onAnswer: onAnswer)
            }
        }
        .padding(Theme.grid * 2)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        // A container of its own, so its buttons and fields keep their own identifiers.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("request-card")
    }
}

// MARK: - Approval

/// A command or a change to allow: what it is, why it asks, and the choices, Deny first.
/// Where the host takes one, the bubble by the heading opens a field for what to do
/// instead: a no then sends it along ("Use printf"), and Deny is the button that stands
/// out. A plain no is still the one tap, and the card no taller until the field is asked
/// for.
private struct ApprovalCard: View {
    let approval: ApprovalRequest
    let agentName: String
    var onAnswer: (RequestAnswer) -> Void

    @State private var writesNote = DebugLaunch.writesApprovalNote
    @State private var note = ""
    @FocusState private var isWritingNote: Bool

    /// What goes with a no: what was typed, while the field is open.
    private var said: String {
        writesNote ? note.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            HStack(spacing: Theme.grid) {
                Label("\(agentName) wants to run", systemImage: "exclamationmark.shield")
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: Theme.grid)
                if approval.takesNote == true {
                    noteButton
                }
            }
            ScrollView {
                Text(approval.command)
                    .font(.app.callout.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .copyMenu(approval.command)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 132)
            .fixedSize(horizontal: false, vertical: true)
            if let reason = approval.reason {
                Text(reason.capitalizedSentence)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
            if writesNote {
                TextField("What should \(agentName) do instead?", text: $note, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.app.subheadline)
                    .focused($isWritingNote)
                    .losesFocusOutOfSight($isWritingNote)
                    .padding(.horizontal, Theme.grid * 1.5)
                    .padding(.vertical, Theme.grid)
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHint("Sent with Deny")
                    .accessibilityIdentifier("approval-note")
                    .transition(.opacity)
            }
            // Four across when they fit, two rows otherwise.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.grid) { buttons }
                VStack(spacing: Theme.grid) {
                    HStack(spacing: Theme.grid) { buttons(for: Array(approval.choices.ordered.prefix(2))) }
                    HStack(spacing: Theme.grid) { buttons(for: Array(approval.choices.ordered.dropFirst(2))) }
                }
            }
        }
        .animation(.smooth(duration: 0.25), value: writesNote)
    }

    /// Opens the field for what to do instead, and closes it again.
    private var noteButton: some View {
        Button {
            writesNote.toggle()
            isWritingNote = writesNote
        } label: {
            Image(systemName: writesNote ? "text.bubble.fill" : "text.bubble")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                // A finger's room around a small symbol, without making the row taller.
                .contentShape(.rect.inset(by: -Theme.grid * 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(writesNote ? "Deny without a note" : "Deny with a note")
        .help("Deny with a note")
        .accessibilityIdentifier("approval-note-toggle")
    }

    private var buttons: some View {
        buttons(for: approval.choices.ordered)
    }

    private func buttons(for choices: [ApprovalChoice]) -> some View {
        ForEach(choices, id: \.self) { choice in
            // Once stands out, unless there is something to say with a no.
            if choice == (said.isEmpty ? .once : .deny) {
                Button { answer(choice) } label: { label(choice) }
                    .buttonStyle(.monochromeProminent)
                    .buttonBorderShape(.capsule)
                    .accessibilityIdentifier("approve-\(choice.rawValue)")
            } else {
                Button { answer(choice) } label: { label(choice) }
                    .buttonStyle(.borderedCapsule)
                    .accessibilityIdentifier("approve-\(choice.rawValue)")
            }
        }
    }

    /// A no carries what was typed; a yes leaves it.
    private func answer(_ choice: ApprovalChoice) {
        onAnswer(choice == .deny && !said.isEmpty ? .declined(note: said) : .approval(choice))
    }

    private func label(_ choice: ApprovalChoice) -> some View {
        Text(choice.title)
            .font(.app.subheadline.weight(.semibold))
            // Never cut a label short: when four do not fit across, they go on two rows.
            .fixedSize()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }
}

private extension ApprovalChoice {
    var title: String {
        switch self {
        case .deny: "Deny"
        case .once: "Once"
        case .session: "Session"
        case .always: "Always"
        }
    }
}

private extension [ApprovalChoice] {
    /// Deny first, then the allows from narrowest to widest, whatever order they came in.
    var ordered: [ApprovalChoice] {
        [.deny, .once, .session, .always].filter(contains)
    }
}

private extension String {
    var capitalizedSentence: String {
        prefix(1).uppercased() + dropFirst()
    }
}

// MARK: - Plan

/// The plan, laid out again only when it changes: typing what should change runs the
/// card's body at each key, and the plan's Markdown was parsed there each time (3.4 ms for
/// a 6 KB plan on the MBP16, before its views were made again).
private struct PlanText: View, Equatable {
    let text: String

    var body: some View {
        MarkdownBlocksView(blocks: Markdown.blocks(text))
    }
}

/// A plan to approve (Claude Code's plan mode): the plan as formatted text, scrolling
/// when long, a field for what to change, and Keep planning or Start. Start carries it
/// out, in the mode the thread had before planning; Keep planning sends what was typed
/// as what to change.
private struct PlanCard: View {
    let text: String
    let plan: PlanApproval
    let agentName: String
    let mode: ModeState?
    var onAnswer: (RequestAnswer) -> Void

    @State private var note = ""
    /// What to change is being typed: on a phone or an iPad the plan gives up room, so the
    /// field and the buttons stay above the keyboard.
    @FocusState private var isWritingNote: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            Label("\(agentName)'s plan", systemImage: "map")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            ScrollView {
                PlanText(text: text)
                    .equatable()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: isWritingNote && !Platform.isMac ? 120 : 360)
            .fixedSize(horizontal: false, vertical: true)
            .copyMenu(text)
            TextField("What should change? (optional)", text: $note, axis: .vertical)
                .lineLimit(1...4)
                .font(.app.subheadline)
                .focused($isWritingNote)
                .losesFocusOutOfSight($isWritingNote)
                .padding(.horizontal, Theme.grid * 1.5)
                .padding(.vertical, Theme.grid)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityIdentifier("plan-note")
            HStack(spacing: Theme.grid) {
                Button {
                    let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
                    onAnswer(said.isEmpty ? .approval(.deny) : .declined(note: said))
                } label: {
                    Text("Keep planning").font(.app.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                }
                .buttonStyle(.borderedCapsule)
                .accessibilityIdentifier("plan-keep")
                Button { onAnswer(.approval(.once)) } label: {
                    Text("Start").font(.app.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                }
                .buttonStyle(.monochromeProminent)
                .buttonBorderShape(.capsule)
                .accessibilityIdentifier("plan-start")
            }
            if let then = startsWith {
                Text(then)
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// What the agent does once the plan is under way, when the host says.
    private var startsWith: String? {
        plan.startDescription(agentName: agentName, mode: mode)
    }
}

// MARK: - Questions

/// The agent's questions, one at a time: its heading, the question, and each suggested
/// answer as a row with what it means, a radio button (or a checkbox when several can be
/// picked), then Other to type one's own. Picking an answer moves on to the next question;
/// with a single question it is sent at once. Back goes to the one before; Dismiss, on
/// the first, answers nothing.
private struct ClarifyCard: View {
    let request: PendingRequest
    let questions: [ClarifyQuestion]
    let agentName: String
    var onAnswer: (RequestAnswer) -> Void

    @State private var index = 0
    /// The suggested answers picked, per question.
    @State private var picked: [String: [String]] = [:]
    @State private var typed: [String: String] = [:]
    /// The questions whose Other row is open for typing.
    @State private var writing: Set<String> = []
    @FocusState private var isTyping: Bool

    private var question: ClarifyQuestion { questions[min(index, questions.count - 1)] }
    private var isLast: Bool { index >= questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            HStack(spacing: Theme.grid) {
                Label("\(agentName) asks", systemImage: "questionmark.bubble")
                    .font(.app.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: Theme.grid)
                if questions.count > 1 {
                    Text("\(index + 1) of \(questions.count)")
                        .font(.app.footnote)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
            }
            VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
                VStack(alignment: .leading, spacing: Theme.grid / 2) {
                    if let header = question.header {
                        Text(header.uppercased())
                            .font(.app.caption2.weight(.semibold))
                            .tracking(0.6)
                            .foregroundStyle(.secondary)
                    }
                    Text(question.text)
                        .font(.app.body.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(question.choices, id: \.self) { choice in
                            ChoiceRow(
                                label: choice,
                                detail: question.descriptions?[choice],
                                isPicked: picked[question.id]?.contains(choice) == true,
                                allowsMultiple: question.allowsMultiple
                            ) { pick(choice) }
                        }
                        if question.choices.isEmpty || writing.contains(question.id) {
                            field
                        } else {
                            ChoiceRow(
                                label: "Other…", detail: nil, isPicked: false,
                                allowsMultiple: question.allowsMultiple, identifier: "clarify-other"
                            ) {
                                writeOwn()
                            }
                            .accessibilityHint("Type an answer of your own")
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: true)
            }
            .id(question.id)
            .transition(.opacity)
            HStack(spacing: Theme.grid) {
                Button {
                    if index == 0 {
                        onAnswer(.cancelled)
                    } else {
                        withAnimation(.smooth(duration: 0.25)) { index -= 1 }
                    }
                } label: {
                    Text(index == 0 ? "Dismiss" : "Back").font(.app.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                }
                .buttonStyle(.borderedCapsule)
                .accessibilityIdentifier("clarify-skip")
                Button(action: next) {
                    Text(isLast ? "Send" : "Next").font(.app.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 2)
                }
                .buttonStyle(.monochromeProminent)
                .buttonBorderShape(.capsule)
                .disabled(!canAdvance)
                .accessibilityIdentifier(isLast ? "clarify-send" : "clarify-next")
            }
        }
        .animation(.smooth(duration: 0.25), value: index)
    }

    /// Where an answer of one's own is typed: under the suggestions, or alone when there are none.
    private var field: some View {
        TextField(question.choices.isEmpty ? "Your answer" : "Your own answer", text: binding(for: question), axis: .vertical)
            .lineLimit(1...4)
            .font(.app.subheadline)
            .focused($isTyping)
            .losesFocusOutOfSight($isTyping)
            .accessibilityIdentifier("clarify-custom-answer")
            .onKeyPress(.return, phases: .down) { press in
                guard press.modifiers.isDisjoint(with: [.shift, .option, .control, .command]),
                      !Platform.isComposingText else { return .ignored }
                next()
                return .handled
            }
            .onChange(of: typed[question.id] ?? "") { old, new in
                // As in the composer, a Mac's field can take Return before onKeyPress.
                if Platform.isMac, Platform.handlesPlainReturn, !Platform.isComposingText,
                   ComposerText.isLineBreakTyped(over: old, giving: new) {
                    typed[question.id] = old
                    next()
                }
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .padding(.vertical, Theme.grid * 1.25)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.top, question.choices.isEmpty ? 0 : Theme.grid / 2)
    }

    private func binding(for question: ClarifyQuestion) -> Binding<String> {
        Binding(
            get: { typed[question.id] ?? "" },
            set: { typed[question.id] = $0 }
        )
    }

    /// Picking a suggestion: one of several to tick, or the answer, which moves on (and
    /// with a single question sends it). Picking it again takes it back.
    private func pick(_ choice: String) {
        let id = question.id
        var current = picked[id] ?? []
        if let found = current.firstIndex(of: choice) {
            current.remove(at: found)
            picked[id] = current
            return
        }
        if question.allowsMultiple {
            current.append(choice)
            picked[id] = current
            return
        }
        picked[id] = [choice]
        // A suggestion picked is the answer, not what was typed under Other.
        typed[id] = nil
        writing.remove(id)
        isTyping = false
        if questions.count == 1 {
            onAnswer(.clarify(answers))
        } else if !isLast {
            Task {
                try? await Task.sleep(for: .seconds(0.25))
                // Only if that is still the answer: not taken back, nor replaced by one typed.
                guard self.question.id == id, picked[id] == [choice], !writing.contains(id) else { return }
                withAnimation(.smooth(duration: 0.25)) { index += 1 }
            }
        }
    }

    /// Other: a field to type in, which takes the place of a single answer picked.
    private func writeOwn() {
        writing.insert(question.id)
        if !question.allowsMultiple { picked[question.id] = [] }
        isTyping = true
    }

    private func next() {
        guard canAdvance else { return }
        isTyping = false
        if isLast {
            if !answers.isEmpty { onAnswer(.clarify(answers)) }
        } else {
            withAnimation(.smooth(duration: 0.25)) { index += 1 }
        }
    }

    private var canAdvance: Bool {
        if isLast { return request.acceptsClarification(answers) }
        if request.requiresAllAnswers == true {
            return answers[question.id] != nil
        }
        return true
    }

    /// What was picked and typed: for a single answer what was typed wins, where several
    /// can be picked it is one more. A question with neither is left out.
    private var answers: [String: String] {
        var result: [String: String] = [:]
        for question in questions {
            let text = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var given = picked[question.id] ?? []
            if !text.isEmpty { given = question.allowsMultiple ? given + [text] : [text] }
            if !given.isEmpty { result[question.id] = given.joined(separator: ", ") }
        }
        return result
    }
}

/// A suggested answer: a radio button (or a checkbox, when several can be picked), its
/// words, and what it means under them when the agent says.
private struct ChoiceRow: View {
    let label: String
    let detail: String?
    let isPicked: Bool
    let allowsMultiple: Bool
    var identifier = "clarify-choice"
    var onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 1.25) {
                Image(systemName: symbol)
                    .font(.app.body)
                    .foregroundStyle(isPicked ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.app.subheadline.weight(isPicked ? .semibold : .regular))
                        .foregroundStyle(.primary)
                    if let detail {
                        Text(detail)
                            .font(.app.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .padding(.vertical, Theme.grid * 1.25)
            .background {
                if isPicked {
                    RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(uiColor: .tertiarySystemFill))
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isPicked ? [.isSelected] : [])
        .accessibilityIdentifier(identifier)
    }

    private var symbol: String {
        if allowsMultiple { return isPicked ? "checkmark.square.fill" : "square" }
        return isPicked ? "largecircle.fill.circle" : "circle"
    }
}
