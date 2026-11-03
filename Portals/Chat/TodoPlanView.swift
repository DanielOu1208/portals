import AgentCore
import SwiftUI

/// The running turn's to-do list, a part of its own directly under the status line (2026-10-26: "below the status line, a section that is always showing and can be expanded
/// independently from the content about the tasks and agents that are running", and "it
/// should stay visible when the task is running. It shouldn't be hidden in the agent or
/// sub-agent view"). Shown whenever the running turn has a list, from any agent: one line
/// closed, the step and its words ("Step 2 of 5 · Run the tests", "Plan complete · 5 of
/// 5"), which a tap opens into the checklist and closes again, apart from the status line's
/// steps and from the line of subagents at the chat's foot (opening one opens or closes
/// none of the others). Closed it is one line tall whatever it says, the words cross-fading
/// as the list moves on, so the chat does not move at each update; it goes with the turn's
/// end. `PORTALS_DEBUG_PLAN_SECTION=before` puts the list back in the status line, opened
/// with its steps.
struct TodoPlanSection: View {
    let plan: TodoPlan

    @RowOpen private var isOpen: Bool
    @Environment(\.swipeGuard) private var swipeGuard

    /// - Parameter turn: the turn it is under, by which the chat keeps whether it is open.
    init(plan: TodoPlan, turn: UUID) {
        self.plan = plan
        _isOpen = RowOpen(.plan(turn), initially: DebugLaunch.expandsWork || DebugLaunch.expandsPlan)
    }

    /// The list back in the status line, as before (`PORTALS_DEBUG_PLAN_SECTION=before`).
    static let inStatusLine = DebugLaunch.planSectionBefore

    var body: some View {
        if let summary = plan.summary {
            VStack(alignment: .leading, spacing: Theme.grid) {
                Button {
                    swipeGuard { withAnimation(.smooth(duration: 0.25)) { isOpen.toggle() } }
                } label: {
                    HStack(spacing: Theme.grid) {
                        Image(systemName: "checklist")
                            .font(.app.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        // The words of the step it is on, the one before fading out in place.
                        ZStack(alignment: .leading) {
                            Text(summary)
                                .font(.app.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
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
                .accessibilityHint(isOpen ? "Hides the checklist" : "Shows the checklist")
                .accessibilityAddTraits(.updatesFrequently)
                .accessibilityIdentifier("plan-section")

                if isOpen {
                    TodoChecklist(plan: plan, identifier: "plan-section-checklist")
                        .padding(.leading, 20 + Theme.grid)
                        .transition(.opacity)
                }
            }
        }
    }
}

struct TodoChecklist: View {
    let plan: TodoPlan
    var identifier = "todo-checklist"

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                    Image(systemName: symbol(item.status))
                        .font(.app.footnote.weight(.medium))
                        .frame(width: 20)
                        .accessibilityHidden(true)
                    Text(item.text)
                        .font(.app.subheadline)
                        // One dropped is no step still to take, as one done is not.
                        .strikethrough(item.status == .completed || item.status == .cancelled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(item.status == .inProgress ? .primary : .secondary)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(label(item.status)): \(item.text)")
            }
        }
        .accessibilityIdentifier(identifier)
    }

    private func symbol(_ status: TodoItem.Status) -> String {
        switch status {
        case .pending: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .completed: "checkmark.circle.fill"
        case .cancelled: "xmark.circle"
        }
    }

    private func label(_ status: TodoItem.Status) -> String {
        switch status {
        case .pending: "Pending"
        case .inProgress: "In progress"
        case .completed: "Completed"
        case .cancelled: "Cancelled"
        }
    }
}
