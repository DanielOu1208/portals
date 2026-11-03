import AgentCore
import SwiftUI

/// Local outgoing messages have no remote thread row yet. Opening reviews them;
/// discarding needs its own confirmation and never invokes a remote thread action.
struct RecoverableDraftsSection: View {
    let drafts: [RecoverableDraft]
    let caption: (RecoverableDraft) -> String
    let onOpen: (RecoverableDraft) -> Void
    let onDiscard: (RecoverableDraft) -> Void

    @State private var discarding: RecoverableDraft?
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Text("Unsent drafts")
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            Text("Saved on this device. Open to review before sending.")
                .font(.app.caption2)
                .foregroundStyle(.secondary)
            ForEach(drafts, id: \.sidebarKey) { draft in
                let title = draft.preview.isEmpty ? draft.title : draft.preview
                let context = caption(draft)
                HStack(spacing: Theme.grid) {
                    Button {
                        swipeGuard { onOpen(draft) }
                    } label: {
                        HStack(spacing: Theme.grid) {
                            Image(systemName: "square.and.pencil")
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title)
                                    .font(.app.subheadline)
                                    .lineLimit(1)
                                Text(context)
                                    .font(.app.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: Platform.isMac ? 46 : 50)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Unsent draft: \(title), \(context)")
                    .accessibilityHint("Opens the saved message without sending it")
                    .accessibilityIdentifier("unsent-draft-\(draft.agent.host.rawValue)-\(draft.id)")
                    Menu {
                        Button("Open", systemImage: "square.and.pencil") {
                            swipeGuard { onOpen(draft) }
                        }
                        Button("Discard…", systemImage: "trash", role: .destructive) {
                            swipeGuard { discarding = draft }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(minWidth: 28, minHeight: 32)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .plainMenuOnMac()
                    .accessibilityLabel("Actions for unsent draft")
                    .accessibilityIdentifier("unsent-draft-actions-\(draft.agent.host.rawValue)-\(draft.id)")
                }
            }
        }
        .padding(.horizontal, Theme.grid)
        .padding(.vertical, Theme.grid)
        .accessibilityIdentifier("unsent-drafts")
        .alert(
            "Discard unsent draft?",
            isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }),
            presenting: discarding
        ) { draft in
            Button("Discard", role: .destructive) {
                onDiscard(draft)
                discarding = nil
            }
            Button("Cancel", role: .cancel) { discarding = nil }
        } message: { _ in
            Text("This removes the saved message and its attachments from this device.")
        }
    }
}

private struct DraftSidebarKey: Hashable {
    var host: HostID
    var id: UUID
}

private extension RecoverableDraft {
    var sidebarKey: DraftSidebarKey { DraftSidebarKey(host: agent.host, id: id) }
}
