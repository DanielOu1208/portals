import AgentCore
import SwiftUI

/// A folder on a host for a new thread whose agent is still to be chosen.
struct NewThreadChoice: Equatable {
    var host: HostID
    var folder: Folder
}

/// Which agent a new thread in a folder is with: the host's agents, each with its avatar
/// as its row in the sidebar has it, in the sidebar's order. A popover from the new
/// thread's agent chip (`NewThreadPickers`).
struct AgentPicker: View {
    let fleet: Fleet
    let choice: NewThreadChoice
    var onPick: (Agent) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.folder.isGeneral ? "New thread with no project" : "New thread in \(choice.folder.name)")
                        .font(.app.subheadline.weight(.semibold))
                        .lineLimit(2)
                    // Which Mac's agents these are, once there is more than one.
                    if fleet.hosts.count > 1, let host = fleet.model(for: choice.host) {
                        Text(host.host.name)
                            .font(.app.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, Self.inset)
                .padding(.top, Theme.grid * 1.5)
                .padding(.bottom, Theme.grid / 2)
                ForEach(fleet.agentsForFolder(on: choice.host)) { agent in
                    row(agent)
                }
            }
            .padding(.bottom, Theme.grid * 0.75)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: Self.width)
    }

    private func row(_ agent: Agent) -> some View {
        Button { onPick(agent) } label: {
            HStack(spacing: Theme.grid) {
                RowAvatar(style: fleet.style(for: agent.id), side: Self.avatar)
                Text(agent.displayName)
                    .font(.app.callout)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, Self.inset)
            .frame(minHeight: Self.rowHeight)
            .contentShape(.rect)
        }
        .buttonStyle(PressedRowStyle())
        .accessibilityIdentifier("agent-choice-\(agent.id.name)")
    }

    // Compact, as a menu is: a pointer's row on a Mac, still a finger's elsewhere.
    private static let width: CGFloat = Platform.isMac ? 220 : 240
    private static let rowHeight: CGFloat = Platform.isMac ? 32 : 44
    private static let avatar: CGFloat = Platform.isMac ? 20 : 26
    private static let inset: CGFloat = Theme.grid * 1.5
}
