import AgentCore
import SwiftUI

/// Kept by the chat, so scrolling the selected turn away never dismisses its draft.
struct MessageForkRequest: Hashable {
    let id = UUID()
    let message: UserMessage
    let checkpoint: MessageCheckpoint
    let before: Bool
}

struct MessageForkSheet: View {
    let request: MessageForkRequest
    let canCreate: Bool
    let onDone: () -> Void
    let onCreate: (String?) async throws -> Void

    @State private var draft: String
    @State private var isCreating = false
    @State private var problem: String?

    init(request: MessageForkRequest, canCreate: Bool, onDone: @escaping () -> Void, onCreate: @escaping (String?) async throws -> Void) {
        self.request = request
        self.canCreate = canCreate
        self.onDone = onDone
        self.onCreate = onCreate
        _draft = State(initialValue: request.message.text)
    }

    private var hasAttachments: Bool { !request.message.images.isEmpty || !request.message.files.isEmpty }
    private var editingAttachments: Bool { request.before && hasAttachments }
    private var canSubmit: Bool {
        canCreate && !isCreating && !editingAttachments
            && (!request.before || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        PanelChrome(
            title: request.before ? "Edit in a new thread" : "Fork from here",
            doneIdentifier: "message-fork-cancel", cancels: true,
            onDone: { if !isCreating { onDone() } },
            action: Button(action: create) {
                if isCreating { ProgressView() } else { Text("Create thread") }
            }
            .disabled(!canSubmit)
            .accessibilityIdentifier("message-fork-create")
        ) {
            VStack(alignment: .leading, spacing: Theme.grid * 2) {
                Text(request.before
                     ? "Create a new thread before this message. Review your edited draft there, then choose Send."
                     : "Create a new thread through this agent run, including messages sent while it was working.")
                Text("The original thread stays here. Both threads use the same host folder and files; this does not copy or restore files.")
                    .foregroundStyle(.secondary)
                if editingAttachments {
                    Label("Editing messages with attachments is unavailable because the original attachment data may no longer be available. Start a new thread and attach the files again.", systemImage: "paperclip")
                        .accessibilityIdentifier("message-fork-attachments")
                } else if request.before {
                    TextEditor(text: $draft)
                        .font(.app.body)
                        .frame(minHeight: 160)
                        .padding(Theme.grid)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                        .disabled(isCreating)
                        .accessibilityLabel("Edited message")
                        .accessibilityIdentifier("message-fork-draft")
                }
                if !canCreate && !isCreating {
                    Text("Wait until this thread is idle and connected to create the new thread.")
                        .foregroundStyle(.secondary)
                }
                if let problem {
                    Label(problem, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("message-fork-error")
                }
                Spacer(minLength: 0)
            }
            .font(.app.body)
            .padding(Theme.grid * 2)
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(isCreating)
    }

    private func create() {
        guard canSubmit else { return }
        isCreating = true
        problem = nil
        Task {
            do {
                try await onCreate(request.before ? draft : nil)
                isCreating = false
                onDone()
            } catch {
                isCreating = false
                problem = error.localizedDescription
            }
        }
    }
}
