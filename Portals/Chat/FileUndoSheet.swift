import AgentCore
import SwiftUI

/// A host preview is reviewed here, then confirmed in a separate explicit step.
struct FileUndoSheet: View {
    let canUndo: Bool
    let onDone: () -> Void
    let onPreview: () async throws -> TurnFileUndoPreview
    let onUndo: (TurnFileUndoPreview) async throws -> TurnFileUndoResult

    @State private var preview: TurnFileUndoPreview?
    @State private var isLoading = false
    @State private var isConfirming = false
    @State private var isApplying = false
    @State private var problem: String?

    private var canConfirm: Bool { canUndo && !isLoading && !isApplying && preview?.canConfirm() == true }

    var body: some View {
        PanelChrome(
            title: isConfirming ? "Confirm undo" : "Undo files",
            doneIdentifier: "file-undo-cancel", cancels: true,
            onDone: { if !isApplying { onDone() } },
            action: Button(role: isConfirming ? .destructive : nil) {
                if isConfirming { apply() } else { isConfirming = true }
            } label: {
                if isApplying { ProgressView() } else { Text(isConfirming ? "Undo files" : "Continue…") }
            }
            .disabled(!canConfirm)
            .accessibilityIdentifier(isConfirming ? "file-undo-confirm" : "file-undo-review")
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.grid * 2) {
                    Text("Restore tracked files to before the latest Claude turn. The conversation stays unchanged. Untracked files and changes made by shell commands may remain.")
                    Label(isConfirming
                          ? "Restore the files listed below? This can overwrite subsequent or manual edits. Stop other tools working in this folder before choosing Undo files."
                          : "This can overwrite subsequent or manual edits. Stop other tools working in this folder before continuing.",
                          systemImage: "exclamationmark.triangle")
                        .foregroundStyle(isConfirming ? .red : .secondary)
                        .accessibilityIdentifier("file-undo-warning")
                    if isLoading { ProgressView("Fetching file preview…") }
                    if let preview {
                        if preview.files.isEmpty {
                            Text("The host found no file changes to restore.")
                                .accessibilityIdentifier("file-undo-empty")
                        } else {
                            Text("\(preview.files.count) file(s)")
                                .font(.app.headline)
                            if preview.insertions != nil || preview.deletions != nil {
                                HStack {
                                    if let additions = preview.insertions { Text("+\(additions) additions") }
                                    if let deletions = preview.deletions { Text("−\(deletions) deletions") }
                                }
                                .font(.app.footnote.monospacedDigit())
                                .foregroundStyle(.secondary)
                            }
                            ForEach(Array(preview.files.enumerated()), id: \.offset) { _, path in
                                Text(path)
                                    .font(.app.body.monospaced())
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityIdentifier("file-undo-path")
                            }
                        }
                    }
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("file-undo-error")
                    }
                    if !canUndo && !isApplying {
                        Text("This turn, its connection, or work in the folder changed. Wait until the folder is idle, then refresh the preview.")
                            .foregroundStyle(.secondary)
                    }
                    if !isApplying {
                        Button("Refresh preview", systemImage: "arrow.clockwise") { Task { await refresh() } }
                            .disabled(!canUndo || isLoading)
                            .accessibilityIdentifier("file-undo-refresh")
                    }
                }
                .font(.app.body)
                .padding(Theme.grid * 2)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(isApplying)
        .task { await refresh() }
        .task(id: preview?.expiresAt) {
            guard let expires = preview?.expiresAt else { return }
            try? await Task.sleep(for: .seconds(max(0, expires.timeIntervalSinceNow)))
            guard !Task.isCancelled, !isApplying else { return }
            invalidate(TurnFileUndoError.stalePreview.localizedDescription)
        }
        .onChange(of: canUndo) { _, allowed in
            if !allowed && !isLoading && !isApplying { invalidate(TurnFileUndoError.stalePreview.localizedDescription) }
        }
    }

    private func invalidate(_ message: String) {
        preview = nil
        isConfirming = false
        problem = message
    }

    private func refresh() async {
        guard canUndo, !isLoading, !isApplying else { return }
        preview = nil
        isConfirming = false
        problem = nil
        isLoading = true
        defer { isLoading = false }
        do {
            let fetched = try await onPreview()
            guard !Task.isCancelled else { return }
            guard canUndo else { return invalidate(TurnFileUndoError.stalePreview.localizedDescription) }
            preview = fetched
        } catch {
            if !Task.isCancelled { invalidate(error.localizedDescription) }
        }
    }

    private func apply() {
        guard canConfirm, isConfirming, let reviewed = preview else { return }
        preview = nil
        isConfirming = false
        isApplying = true
        problem = nil
        Task {
            do {
                let result = try await onUndo(reviewed)
                isApplying = false
                if result.isComplete { onDone() } else { invalidate(result.message) }
            } catch {
                isApplying = false
                invalidate("\(error.localizedDescription) If a restore was attempted, some files may have changed. Review the folder before continuing.")
            }
        }
    }
}
