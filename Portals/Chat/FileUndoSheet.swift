import AgentCore
import SwiftUI

/// One compact confirmation of the host's authoritative preview.
struct FileUndoSheet: View {
    let canUndo: Bool
    var workingDirectory: String? = nil
    var turnDiff: TurnDiff? = nil
    let onDone: () -> Void
    let onPreview: () async throws -> TurnFileUndoPreview
    let onUndo: (TurnFileUndoPreview) async throws -> TurnFileUndoResult

    @State private var review = FileUndoReviewState()
    @State private var detailsHeight: CGFloat = 44
    @State private var headerHeight: CGFloat = 36
    @State private var explanationHeight: CGFloat = 42
    @State private var actionHeight: CGFloat = 50
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var detailsLimit: CGFloat {
        if UIDevice.current.userInterfaceIdiom == .phone { return verticalSizeClass == .compact ? 120 : 340 }
        return 380
    }

    private var canConfirm: Bool { canUndo && review.canConfirm() }
    private var fittedHeight: CGFloat {
        headerHeight + explanationHeight + min(detailsHeight, detailsLimit) + actionHeight + Theme.grid * 10
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 2) {
            HStack(spacing: Theme.grid * 2) {
                Text("Undo changes")
                    .font(.app.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Theme.grid)
                Button("Cancel", action: onDone)
                    .buttonStyle(.borderedCapsule)
                    .keyboardShortcut(.cancelAction)
                    .disabled(review.isApplying)
                    .accessibilityIdentifier("file-undo-cancel")
            }
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            Text("Puts these files back as they were before Claude’s last turn. The chat is kept.")
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { explanationHeight = $0 }
            ScrollView {
                details
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailsHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(detailsHeight, detailsLimit))
            Button(role: .destructive, action: apply) {
                HStack(spacing: Theme.grid) {
                    if review.isApplying { ProgressView().tint(.white) }
                    Text("Undo Changes")
                }
                .frame(maxWidth: .infinity)
            }
            .font(.app.body.weight(.semibold))
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(!canConfirm)
            .accessibilityIdentifier("file-undo-confirm")
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { actionHeight = $0 }
        }
        .padding(Theme.grid * 2)
        .frame(idealWidth: 440, alignment: .topLeading)
        // Size from the individual rows: measuring the whole sheet feeds the native
        // presentation's allocated height back into its next requested height.
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.pageBackground)
        .modifier(FileUndoPresentation(height: fittedHeight))
        .presentationBackground(Theme.pageBackground)
        .interactiveDismissDisabled(review.isApplying)
        .task { await loadPreview() }
        .task(id: review.preview?.expiresAt) {
            guard let expires = review.preview?.expiresAt else { return }
            try? await Task.sleep(for: .seconds(max(0, expires.timeIntervalSinceNow)))
            guard !Task.isCancelled, !review.isApplying else { return }
            review.invalidate("Preview expired. Close and reopen to check the latest changes.")
        }
        .onChange(of: canUndo) { _, allowed in
            if !allowed && !review.isLoading && !review.isApplying {
                review.invalidate("The folder or connection changed. Close and reopen to check the latest changes.")
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            if review.isLoading { ProgressView("Checking changes…") }
            if let list = review.fileList(workingDirectory: workingDirectory, turnDiff: turnDiff) {
                if list.files.isEmpty {
                    Text("No file changes to undo.")
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("file-undo-empty")
                } else {
                    HStack(spacing: Theme.grid) {
                        Text(list.filesLine)
                        if let counts = list.aggregate {
                            if let added = counts.added { Text("+\(added)").foregroundStyle(Color.green) }
                            if let removed = counts.removed { Text("−\(removed)").foregroundStyle(Color.red) }
                        }
                    }
                    .font(.app.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    VStack(spacing: 0) {
                        ForEach(Array(list.files.enumerated()), id: \.offset) { index, file in
                            if index > 0 { Divider().padding(.leading, Theme.grid * 5.5) }
                            TurnDiffFileRow(file: file, showsDisclosure: false)
                                .accessibilityIdentifier("file-undo-path")
                        }
                    }
                    .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
            if let message = review.message {
                Text(message)
                    .font(.app.footnote)
                    .foregroundStyle(review.requiresFolderReview ? Color.red : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("file-undo-error")
            }
            if !canUndo && !review.isApplying && review.message == nil {
                Text("Wait until the folder is idle and connected.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func loadPreview() async {
        guard canUndo, review.beginPreview() else { return }
        do {
            let fetched = try await onPreview()
            guard !Task.isCancelled else { return }
            guard canUndo else { return review.previewFailed("The folder or connection changed. Close and reopen to check the latest changes.") }
            review.receivedPreview(fetched)
        } catch {
            if !Task.isCancelled { review.previewFailed(error.localizedDescription) }
        }
    }

    private func apply() {
        guard canUndo, let reviewed = review.beginRestore() else { return }
        Task {
            do {
                let result = try await onUndo(reviewed)
                review.restored(result)
                if result.isComplete { onDone() }
            } catch {
                if review.restoreFailed(error) { await loadPreview() }
            }
        }
    }
}


private struct FileUndoPresentation: ViewModifier {
    let height: CGFloat

    @ViewBuilder
    func body(content: Content) -> some View {
        if UIDevice.current.userInterfaceIdiom == .phone {
            content
                .presentationDetents([.height(height)])
        } else {
            content
                .frame(width: 440, height: height, alignment: .topLeading)
                .presentationSizing(.fitted)
        }
    }
}
