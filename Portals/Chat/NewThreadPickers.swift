import AgentCore
import SwiftUI

/// Under a new thread's question: its Mac (with more than one), its agent and its folder,
/// each a chip that changes it, on a phone too since 2026-10-27 ("can we have this
/// on mobile as well"), where they go on as many lines as its width needs. A
/// new tab starts at once with the agent and the folder of the tab that was on screen
/// (`Fleet.newTab`), as a browser's does, and is changed here before its first message,
/// with what the sidebar already has for it: the agent from the picker a folder's New
/// thread opens (`AgentPicker`), the folder from the folders the Mac's space lists, as
/// +'s menu has them, or any other from the folder sheet (`FolderSheet`). 2026-10-24: "try to find a better system for creating new tabs", "reuse as much of the
/// components that we have right now as possible". The Mac is the tab's too, and is
/// changed here among the Macs, as their tabs over the sidebar's space name them
/// (`MacTabs`), the agent and the folder kept where that Mac has them (2026-10-24,
/// of a new tab while the sidebar shows another Mac's space: "tabs mac but add a dropdown
/// to pic device"). What is typed goes along to the new choice (`Fleet.remakeNewThread`).
struct NewThreadPickers: View {
    let fleet: Fleet
    let chat: ThreadController
    /// Another folder than the space lists: the folder sheet, for this agent.
    var onOtherFolder: (Agent) -> Void

    @State private var choosesAgent = DebugLaunch.opensNewThreadAgentPicker

    private var host: HostID { chat.agent.id.host }

    var body: some View {
        // Side by side, and on a line more where the width runs out (a phone's), not cut.
        ChipFlow(spacing: Theme.grid) {
            // Only where there is a choice: a Mac among others that can start one, an
            // agent among others, a folder for an agent that works in one.
            if fleet.macsForNewThread.count > 1 { macChip }
            if fleet.agentsForFolder(on: host).count > 1 { agentChip }
            if fleet.choosesFolder(for: chat.agent.id) { folderChip }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    // MARK: The Mac

    private var macChip: some View {
        let mac = fleet.model(for: host)?.host
        let name = mac?.name ?? ""
        return Menu {
            MacChoices(fleet: fleet, chat: chat)
        } label: {
            chip {
                Image(systemName: mac?.macSymbol ?? "laptopcomputer")
                    .font(.app.footnote.weight(.medium))
                    .frame(width: Self.icon, height: Self.icon)
            } title: {
                name
            }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .tip("Choose the host")
        .accessibilityLabel("Host")
        .accessibilityValue(name)
        .accessibilityHint("Starts the new thread on another host")
        .accessibilityIdentifier("new-thread-mac")
    }

    // MARK: The agent

    private var agentChip: some View {
        Button { choosesAgent = true } label: {
            chip {
                RowAvatar(style: fleet.style(for: chat.agent.id), side: Self.icon)
            } title: {
                chat.agent.displayName
            }
        }
        .buttonStyle(.plain)
        .tip("Choose the Agent")
        .accessibilityLabel("Agent")
        .accessibilityValue(chat.agent.displayName)
        .accessibilityHint("Starts the new thread with another agent")
        .accessibilityIdentifier("new-thread-agent")
        .popover(isPresented: $choosesAgent, arrowEdge: .top) {
            AgentPicker(fleet: fleet, choice: NewThreadChoice(host: host, folder: folder)) { agent in
                choosesAgent = false
                fleet.remakeNewThread(with: agent, in: chat.folder)
            }
            .presentationCompactAdaptation(.popover)
        }
    }

    /// The folder the thread is in, for the agent picker's heading: General while the
    /// host has not said where that is, or for an agent with none.
    private var folder: Folder {
        chat.folder ?? Folder(path: fleet.model(for: host)?.host.generalFolder ?? "", name: Folder.generalName, isGeneral: true)
    }

    // MARK: The folder

    private var folderChip: some View {
        Menu {
            FolderChoices(fleet: fleet, chat: chat, onOtherFolder: onOtherFolder)
        } label: {
            chip {
                Image(systemName: folder.isGeneral ? Folder.generalSymbol : "folder")
                    .font(.app.footnote.weight(.medium))
                    .frame(width: Self.icon, height: Self.icon)
            } title: {
                folder.isGeneral ? Folder.generalName : folder.name
            }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .tip("Choose the Folder")
        .accessibilityLabel("Folder")
        .accessibilityValue(folder.isGeneral ? Folder.generalName : folder.name)
        .accessibilityHint("Starts the new thread in another folder")
        .accessibilityIdentifier("new-thread-folder")
    }

    // MARK: Look

    /// A chip as the composer's are (`ModeChip`): its mark, its name and a chevron, on a
    /// tab's capsule, which keeps it plain to see on any part of the wash.
    private func chip(@ViewBuilder icon: () -> some View, title: () -> String) -> some View {
        HStack(spacing: 6) {
            icon()
            Text(title())
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                .font(.app.caption2.weight(.bold))
                .imageScale(.small)
        }
        .font(.app.footnote.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, Theme.grid * 1.25)
        .frame(height: Self.height)
        .background { TabCapsule(overWash: true) }
        .contentShape(.capsule)
    }

    private static let height: CGFloat = Platform.isMac ? 26 : 32
    private static let icon: CGFloat = Platform.isMac ? 15 : 17
}

/// Chips side by side, each as wide as it would be, on as many lines as the width needs,
/// each line centred. One wider than the whole line has the line, and its name gives way
/// in its middle there.
private struct ChipFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = rows(of: subviews, in: width)
        let widest = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: min(widest, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(of: subviews, in: bounds.width) {
            var x = bounds.midX - min(row.width, bounds.width) / 2
            for (index, size) in zip(row.indices, row.sizes) {
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var sizes: [CGSize] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(of subviews: Subviews, in width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let ideal = subviews[index].sizeThatFits(.unspecified)
            // Kept to the line's width: a chip alone too wide for it is offered that.
            let size = ideal.width <= width ? ideal : subviews[index].sizeThatFits(ProposedViewSize(width: width, height: ideal.height))
            if !row.indices.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            row.sizes.append(size)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}

/// The folder chip's menu: the folders the Mac's space lists, as the sidebar has them, then
/// Other Folder…. A view of its own, so that the layout is read where the menu is made, not
/// each time the new thread's screen is drawn.
private struct FolderChoices: View {
    let fleet: Fleet
    let chat: ThreadController
    var onOtherFolder: (Agent) -> Void

    var body: some View {
        let folders = fleet.layout.spaces.first { $0.id == chat.agent.id.host }?.folders ?? []
        ForEach(folders) { project in
            Button {
                fleet.remakeNewThread(with: chat.agent, in: Folder(project: project))
            } label: {
                if project.id.path == chat.folder?.path {
                    Label(project.name, systemImage: "checkmark")
                } else {
                    Text(project.name)
                }
            }
        }
        if !folders.isEmpty { Divider() }
        Button("Other Folder…", systemImage: "folder.badge.plus") { onOtherFolder(chat.agent) }
    }
}

/// The Mac chip's menu: the Macs a new thread can start on, by the names their tabs show,
/// in their order (`Fleet.macsForNewThread`), as the folder chip's lists its folders.
private struct MacChoices: View {
    let fleet: Fleet
    let chat: ThreadController

    var body: some View {
        ForEach(fleet.macsForNewThread, id: \.id) { host in
            Button {
                fleet.remakeNewThread(on: host.id)
            } label: {
                if host.id == chat.agent.id.host {
                    Label(host.host.name, systemImage: "checkmark")
                } else {
                    Text(host.host.name)
                }
            }
        }
    }
}
