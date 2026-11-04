import SwiftUI

/// The composer is editing an earlier message until Send or Cancel is chosen.
struct EditingMessageRow: View {
    var isLoading = false
    var isSending = false
    var onCancel: () -> Void

    var body: some View {
        HStack(spacing: Theme.grid) {
            Image(systemName: "square.and.pencil")
                .foregroundStyle(.secondary)
            Text("Editing message")
                .font(.app.subheadline)
            Spacer(minLength: Theme.grid)
            if isLoading || isSending {
                ProgressView()
                    .controlSize(.small)
            }
            Button("Cancel", action: onCancel)
                .font(.app.footnote.weight(.medium))
                .buttonStyle(.borderedCapsule)
                .controlSize(.small)
                .disabled(isLoading || isSending)
                .accessibilityIdentifier("message-edit-cancel")
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        .accessibilityIdentifier("message-edit-row")
    }
}
