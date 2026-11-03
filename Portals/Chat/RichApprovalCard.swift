import AgentCore
import SwiftUI

/// Provider-offered grants: Deny and Once stay close; broader choices explain their
/// effects before a second, deliberate tap. Nothing synthesizes an unoffered outcome.
struct RichApprovalCard: View {
    let approval: ApprovalRequest
    let agentName: String
    var mode: ModeState?
    var onAnswer: (RequestAnswer) -> Void

    @State private var note = ""
    /// More options while it is open, with the option it opens on (nil: their list). One
    /// value, which the sheet is made from: an option set beside a flag that opened the
    /// sheet was not in it, the sheet being made from the card as it was before.
    @State private var optionsShown: OptionsShown?
    @FocusState private var isWriting: Bool

    private var options: [ApprovalOption] { (approval.options ?? []).filter(\.isSupported) }
    private var once: ApprovalOption? { options.first(where: \.isOnce) }
    private var cancel: ApprovalOption? { options.first(where: \.isCancel) }
    private var isPlan: Bool { approval.plan != nil }
    private var more: [ApprovalOption] { options.filter { !$0.isOnce && !$0.isCancel } }
    private var contentHeight: CGFloat {
        if isWriting && !Platform.isMac { return 120 }
        return isPlan ? 320 : 200
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            Label(isPlan ? "\(agentName)'s plan" : "\(agentName) asks permission", systemImage: isPlan ? "map" : "exclamationmark.shield")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.grid) {
                    if isPlan {
                        ApprovalPlanText(text: approval.planContent ?? approval.command).equatable()
                    } else {
                        Text(approval.command)
                            .font(.app.callout.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    if let reason = approval.reason {
                        Text(reason).font(.app.footnote).foregroundStyle(.secondary)
                    }
                    if let details = approval.details, !details.isEmpty {
                        ApprovalDetailsView(details: details).equatable()
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: contentHeight)
            .fixedSize(horizontal: false, vertical: true)
            if isPlan || approval.takesNote == true {
                TextField(isPlan ? "What should change? (optional)" : "What should the agent do instead? (optional)", text: $note, axis: .vertical)
                    .lineLimit(1...3)
                    .font(.app.subheadline)
                    .focused($isWriting)
                    .losesFocusOutOfSight($isWriting)
                    .padding(Theme.grid)
                    .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 12))
                    .accessibilityIdentifier(isPlan ? "plan-note" : "approval-note")
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.grid) { primaryButtons; moreButton }
                VStack(alignment: .leading, spacing: Theme.grid) {
                    HStack(spacing: Theme.grid) { primaryButtons }
                    moreButton
                }
            }
            .font(.app.subheadline.weight(.semibold))
            if let startsWith = approval.plan?.startDescription(agentName: agentName, mode: mode) {
                Text(startsWith)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(item: $optionsShown) { shown in
            ApprovalOptionsSheet(approval: approval, options: more, initial: shown.initial, note: note, onAnswer: onAnswer)
        }
        // For screenshots: More options opened as the card comes.
        .onDebugLaunch(DebugLaunch.approvalOptions != nil && !more.isEmpty, after: .seconds(1)) {
            optionsShown = OptionsShown(initial: more.first { $0.id == DebugLaunch.approvalOptions })
        }
    }

    @ViewBuilder private var primaryButtons: some View {
        if let cancel {
            Button(isPlan ? "Keep planning" : cancel.label) { choose(cancel) }
                .buttonStyle(.borderedCapsule)
                .accessibilityIdentifier(isPlan ? "plan-keep" : "approve-deny")
        } else {
            Button("Dismiss") { onAnswer(.cancelled) }.buttonStyle(.borderedCapsule)
        }
        if let once {
            Button(isPlan ? "Start" : once.label) { choose(once) }
                .buttonStyle(.monochromeProminent)
                .buttonBorderShape(.capsule)
                .accessibilityIdentifier(isPlan ? "plan-start" : "approve-once")
        }
    }

    @ViewBuilder private var moreButton: some View {
        if !more.isEmpty {
            Button("More options", systemImage: "ellipsis") {
                optionsShown = OptionsShown(initial: nil)
            }
            .buttonStyle(.borderedCapsule)
            .accessibilityIdentifier("approval-more")
        }
    }

    private func choose(_ option: ApprovalOption) {
        if option.requiresConfirmation == true || option.editsPlan {
            optionsShown = OptionsShown(initial: option)
        } else {
            let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
            onAnswer(.option(option.id, note: option.isCancel && !said.isEmpty ? said : nil))
        }
    }
}

/// More options as they are opened: on their list, or on one option.
private struct OptionsShown: Identifiable {
    let id = UUID()
    let initial: ApprovalOption?
}

private struct ApprovalPlanText: View, Equatable {
    let text: String
    var body: some View {
        MarkdownBlocksView(blocks: Markdown.blocks(text)).frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ApprovalOptionsSheet: View {
    let approval: ApprovalRequest
    let options: [ApprovalOption]
    let note: String
    var onAnswer: (RequestAnswer) -> Void

    @State private var selected: ApprovalOption?
    @State private var edited: String
    @Environment(\.dismiss) private var dismiss

    init(approval: ApprovalRequest, options: [ApprovalOption], initial: ApprovalOption?, note: String, onAnswer: @escaping (RequestAnswer) -> Void) {
        self.approval = approval
        self.options = options
        self.note = note
        self.onAnswer = onAnswer
        _selected = State(initialValue: initial)
        _edited = State(initialValue: approval.planContent ?? approval.command)
    }

    var body: some View {
        // On a Mac the panel's own bar: in the window's, Done and Back were cut to "D…" and
        // "B…". At the start of the bar on an iPhone and an iPad, as before. Esc does what it
        // does: back to the list from an option, else close.
        PanelChrome(
            title: selected?.label ?? "More options",
            doneIdentifier: "approval-options-close",
            cancels: true,
            doneTitle: selected == nil ? "Done" : "Back",
            onDone: { if selected != nil && !options.isEmpty { selected = nil } else { dismiss() } }
        ) {
            Group {
                if let selected {
                    confirmation(selected)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Theme.grid * 2) {
                            ForEach(options) { option in
                                Button { selected = option } label: {
                                    VStack(alignment: .leading, spacing: Theme.grid / 2) {
                                        Text(option.label).font(.app.headline)
                                        Text(option.description).font(.app.footnote).foregroundStyle(.secondary)
                                        ApprovalEffects(effects: option.effects)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(Theme.grid * 1.5)
                                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("approval-option-\(option.id)")
                            }
                        }
                        .padding(Theme.grid * 2)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func confirmation(_ option: ApprovalOption) -> some View {
        VStack(alignment: .leading, spacing: Theme.grid * 2) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.grid) {
                    Text(option.description).font(.app.body)
                    ApprovalEffects(effects: option.effects)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: option.editsPlan ? 140 : nil)
            if option.editsPlan {
                TextEditor(text: $edited)
                    .font(.app.callout.monospaced())
                    .scrollContentBackground(.hidden)
                    .padding(Theme.grid)
                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                    .accessibilityLabel("Edited plan Markdown")
                    .accessibilityIdentifier("approval-edited-plan")
            }
            Button(option.editsPlan ? "Send edited plan" : option.label) {
                let said = note.trimmingCharacters(in: .whitespacesAndNewlines)
                onAnswer(.option(option.id, editedPlan: option.editsPlan ? edited : nil, note: option.isCancel && !said.isEmpty ? said : nil))
                dismiss()
            }
            .font(.app.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .buttonStyle(.monochromeProminent)
            .buttonBorderShape(.capsule)
            .disabled(option.editsPlan && edited.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("approval-confirm-\(option.id)")
        }
        .padding(Theme.grid * 2)
    }
}

private struct ApprovalEffects: View {
    let effects: [ApprovalEffect]
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid / 2) {
            ForEach(Array(effects.enumerated()), id: \.offset) { _, effect in
                Text(effect.text)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
