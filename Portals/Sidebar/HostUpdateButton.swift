import AgentCore
import SwiftUI

/// "Update available" in the sidebar's footer, beside Settings, while a host's bridge says
/// a later version is out (`HostModel.update`). The footer is under the lists on every
/// device, whichever Mac is shown and however far its list scrolls, so it is seen without
/// going anywhere, and a line of footnote there covers nothing and stops no work: nothing
/// is broken, and the update can wait for the person. It opens what to run on that
/// computer, with a box to copy it; Settings says the same on the host's row.
struct HostUpdateButton: View {
    /// The hosts with a later version out, at least one.
    let hosts: [HostModel]
    @State private var isShowing = false

    var body: some View {
        Button {
            isShowing = true
        } label: {
            HStack(spacing: Theme.grid * 0.5) {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.tint)
                Text(hosts.count == 1 ? "Update available" : "Updates available")
            }
            .frame(minHeight: Platform.isMac ? 36 : 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $isShowing) {
            HostUpdateList(hosts: hosts)
                .presentationCompactAdaptation(.popover)
        }
        .task {
            guard DebugLaunch.opensUpdateNotice else { return }
            try? await Task.sleep(for: .seconds(1))
            isShowing = true
        }
        .accessibilityLabel(hosts.count == 1 ? "Update available for \(hosts[0].host.name)" : "Updates available for \(hosts.count) hosts")
        .accessibilityHint("Shows what to run to update it")
        .accessibilityIdentifier("sidebar-host-update")
    }
}

/// Which hosts have a later version out, and the command that updates one, to copy.
private struct HostUpdateList: View {
    let hosts: [HostModel]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
            ForEach(hosts) { host in
                if let update = host.update {
                    VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
                        Text(host.host.name)
                            .font(.app.headline)
                        Text(update.headline)
                            .font(.app.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            Text(hosts.count == 1 ? "To update it, run this in a terminal on that computer:" : "To update one, run this in a terminal on its computer:")
                .font(.app.subheadline)
            CommandBox(command: HostUpdate.command, copyIdentifier: "sidebar-host-update-copy")
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(Theme.grid * 2)
        // Wide enough for the command whole; in the popover's own colours, not the
        // footer's grey, which a popover takes from where it opens.
        .frame(width: 344)
        .foregroundStyle(.primary)
    }
}
