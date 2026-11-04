import AgentCore
import SwiftUI

/// Settings' Net: the net as a picture (`NetPicture`), then every Mac the app talks to,
/// with how its connection is doing (tap one to edit it, swipe or hold it to remove it, or
/// add another), and in a net every portal of it (Portals: swipe or hold one to rename or
/// remove it) and a code for adding another (Add a portal).
struct NetSettings: View {
    let fleet: Fleet

    /// Adding or editing a host, adding a portal: shown by the app's top (`SettingsSheet`).
    @Environment(\.showSettingsSheet) private var showSheet
    /// Ends the demo, while it is on (`Demo`): its host is no host to edit or remove, and
    /// another is added once it is over.
    @Environment(\.endDemo) private var endDemo
    /// The host whose removal is being confirmed.
    @State private var removing: HostConfig?
    /// The member of the net whose removal is being confirmed: for this device, leaving.
    @State private var removingMember: NetMember?
    /// Why a change to the net did not happen.
    @State private var netProblem: String?
    /// The portal being renamed, and the name typed for it.
    @State private var renamingMember: NetMember?
    @State private var newName = ""
    /// Whether a connected Mac of the net renames a portal for the whole net
    /// (`Net.renamesDevices`): Rename is offered only then.
    @State private var renamesDevices = false

    var body: some View {
        ScrollViewReader { scroller in
            Form {
                Section {
                    NetPicture(
                        macs: pictured, deviceSymbol: Self.thisDeviceSymbol,
                        onOpenMac: { id in if !fleet.isDemo { host(id).map { showSheet(.editHost($0.id)) } } },
                        onRemoveMac: { id in if !fleet.isDemo { host(id).map(remove) } }
                    )
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                Section {
                    if fleet.isDemo {
                        ForEach(fleet.hosts) { host in
                            HostRow(host: host, isDemo: true)
                                .accessibilityIdentifier("host-row-\(host.id.rawValue)")
                        }
                        Button("End the demo", systemImage: "xmark.circle") { endDemo?() }
                            .accessibilityIdentifier("settings-end-demo")
                    }
                    ForEach(fleet.isDemo ? [] : fleet.hosts) { host in
                        Button { showSheet(.editHost(host.id)) } label: {
                            HostRow(host: host)
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Remove", systemImage: "trash") { remove(host.host) }
                                .tint(.red)
                        }
                        .contextMenu {
                            Button("Edit", systemImage: "pencil") { showSheet(.editHost(host.id)) }
                            Button("Remove", systemImage: "trash", role: .destructive) { remove(host.host) }
                        }
                        .accessibilityIdentifier("host-row-\(host.id.rawValue)")
                    }
                    // A Mac of the net that is no host here (its list gives no address to
                    // reach it at): listed, to be taken out of the net.
                    ForEach(unreachableNetMacs) { member in
                        MemberRow(member: member, isThisDevice: false)
                            .swipeActions {
                                Button("Remove", systemImage: "trash") { removingMember = member }
                                    .tint(.red)
                            }
                            .contextMenu {
                                Button("Remove", systemImage: "trash", role: .destructive) { removingMember = member }
                            }
                            .accessibilityIdentifier("member-row-\(member.id)")
                    }
                    if !fleet.isDemo {
                        Button("Add a host", systemImage: "plus") { showSheet(.addHost) }
                            .accessibilityIdentifier("add-host")
                    }
                } header: {
                    Text("Hosts")
                        .formHeader()
                } footer: {
                    Text(fleet.isDemo
                        ? "The demo's host is made up, and its agents follow a script. End the demo to go back to the start, where you add your own computer."
                        : "The computers your agents run on. Each has a space in the sidebar, with its bots and its folders: swipe across to the next, or pick its tab over them.")
                        .formFooter()
                }
                .settingsRows()

                if fleet.net.isInNet {
                    devices
                        .id("devices")
                }
            }
            .task {
                // Portals in view, for a look at them or at a removal from the net.
                guard DebugLaunch.showsDevices || DebugLaunch.removesFromNet != nil || DebugLaunch.renamesDevice != nil, fleet.net.isInNet else { return }
                try? await Task.sleep(for: .seconds(1))
                scroller.scrollTo("devices", anchor: .top)
            }
        }
        .confirmationDialog(
            removingMember.map { removalTitle(of: $0) } ?? "",
            isPresented: Binding(get: { removingMember != nil }, set: { if !$0 { removingMember = nil } }),
            titleVisibility: .visible,
            presenting: removingMember
        ) { member in
            Button(isThisDevice(member) ? "Leave" : "Remove", role: .destructive) {
                Task { await confirmRemoval(of: member) }
            }
            .accessibilityIdentifier("confirm-remove-member")
        } message: { member in
            Text(removalMessage(of: member))
        }
        .alert(
            "Not changed",
            isPresented: Binding(get: { netProblem != nil }, set: { if !$0 { netProblem = nil } }),
            presenting: netProblem
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem)
        }
        .task {
            // Once a Mac of the net is connected to make the code, or take a member out.
            guard DebugLaunch.addsDevice || DebugLaunch.removesFromNet != nil else { return }
            while !fleet.hosts.contains(where: { $0.host.isNetHost && $0.isConnected }) {
                // Gone before then (another part chosen): no more waiting.
                guard (try? await Task.sleep(for: .milliseconds(250))) != nil else { return }
            }
            if DebugLaunch.addsDevice { showSheet(.addPortal) }
            if let name = DebugLaunch.removesFromNet, let member = fleet.net.membership.shownMembers.first(where: { $0.name == name }) {
                removingMember = member
                try? await Task.sleep(for: .seconds(3))
                removingMember = nil
                await confirmRemoval(of: member)
            }
        }
        .confirmationDialog(
            removing.map { "Remove \($0.name)?" } ?? "",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { host in
            Button("Remove Host", role: .destructive) {
                withAnimation { fleet.removeHost(host.id) }
            }
            .accessibilityIdentifier("confirm-remove-host")
        } message: { _ in
            Text("Its threads and password are removed from \(Platform.thisDevice). Nothing changes on the host.")
        }
    }

    /// The devices of the net, this one marked, each with Rename (where a connected Mac of
    /// the net takes it) and Remove; this device's is Leave. The hosts are the list above.
    private var devices: some View {
        Section {
            ForEach(fleet.net.membership.shownMembers.filter { $0.kind == .device }) { member in
                MemberRow(member: member, isThisDevice: isThisDevice(member))
                    .swipeActions {
                        Button(isThisDevice(member) ? "Leave" : "Remove", systemImage: "trash") { removingMember = member }
                            .tint(.red)
                        if renamesDevices {
                            Button("Rename", systemImage: "pencil") { startRenaming(member) }
                        }
                    }
                    .contextMenu {
                        if renamesDevices {
                            Button("Rename…", systemImage: "pencil") { startRenaming(member) }
                                .accessibilityIdentifier("rename-member")
                        }
                        Button(isThisDevice(member) ? "Leave the net" : "Remove", systemImage: "trash", role: .destructive) { removingMember = member }
                    }
                    .accessibilityIdentifier("member-row-\(member.id)")
            }
            Button("Add a portal", systemImage: "qrcode") { showSheet(.addPortal) }
                .accessibilityIdentifier("add-device")
        } header: {
            Text("Portals")
                .formHeader()
        } footer: {
            Text(fleet.net.portalsNeedTailscale
                ? "The iPhones, iPads and Macs you use Portals on. Only this Mac can reach your host for now: your iPhone or iPad needs Tailscale. Add a portal shows how."
                : "The iPhones, iPads and Macs you use Portals on. Each reaches every host above, and any of them can add another.")
                .formFooter()
        }
        .settingsRows()
        // Asked again as the net's Macs connect and drop: one connected that takes it is what
        // renames a portal for the whole net.
        .task(id: fleet.net.connectedNetHostIDs) {
            renamesDevices = await fleet.net.renamesDevices()
        }
        .task {
            // Once a Mac of the net that renames portals is connected: this device renamed, as
            // Rename would, the name shown typed for a moment first.
            guard let name = DebugLaunch.renamesDevice else { return }
            while !renamesDevices {
                guard (try? await Task.sleep(for: .milliseconds(250))) != nil else { return }
            }
            guard let own = fleet.net.membership.ownEntry else { return }
            startRenaming(own)
            try? await Task.sleep(for: .seconds(1))
            newName = name
            try? await Task.sleep(for: .seconds(2))
            renamingMember = nil
            await confirmRename(of: own, to: name)
        }
        .alert(
            "Rename portal",
            isPresented: Binding(get: { renamingMember != nil }, set: { if !$0 { renamingMember = nil } }),
            presenting: renamingMember
        ) { member in
            TextField("Name", text: $newName)
                .submitLabel(.done)
                .accessibilityIdentifier("rename-member-field")
            Button("Rename") { Task { await confirmRename(of: member, to: newName) } }
                .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("confirm-rename-member")
            Button("Cancel", role: .cancel) {}
        } message: { member in
            Text(isThisDevice(member) ? "Every host and portal of your net calls \(Platform.thisDevice) this." : "Every host and portal of your net calls it this.")
        }
    }

    // MARK: Renaming

    private func startRenaming(_ member: NetMember) {
        newName = member.name
        renamingMember = member
    }

    /// Renames a portal on every host and portal of the net, once confirmed; says why not.
    private func confirmRename(of member: NetMember, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != member.name else { return }
        do {
            try await fleet.net.renameDevice(member, to: name)
        } catch {
            netProblem = error.localizedDescription
        }
    }

    // MARK: The picture

    /// The hosts the picture shows: the fleet's, or made-up ones for a development
    /// switch's look (`DebugLaunch.netPicture`).
    private var pictured: [NetPicture.Mac] {
        if let demo = DebugLaunch.netPicture { return NetPictureDemo.named(demo) }
        return fleet.hosts.map { host in
            NetPicture.Mac(id: host.id.rawValue, name: host.host.name, symbol: Self.symbol(for: host.host), link: Self.link(of: host))
        }
    }

    /// The Macs of the net that are no host here: the list gives no address for them.
    private var unreachableNetMacs: [NetMember] {
        guard fleet.net.isInNet else { return [] }
        let hosts = Set(fleet.hosts.compactMap(\.host.netMember))
        return fleet.net.membership.shownMembers.filter { $0.kind == .mac && !hosts.contains($0.id) }
    }

    private static func link(of host: HostModel) -> NetPicture.Mac.Link {
        switch host.status {
        case .connected: host.isViaRelay ? .relay : .direct
        case .connecting: .connecting
        case .problem: .unreachable
        }
    }

    /// A host's symbol: a Linux computer's as it says, else a Mac's by what its name says.
    static func symbol(for host: HostConfig) -> String {
        host.isLinux ? "pc" : symbol(forMacNamed: host.name)
    }

    /// A Mac's symbol by what its name says it is, a laptop when it says nothing.
    static func symbol(forMacNamed name: String) -> String {
        let name = name.lowercased()
        if name.contains("mini") { return "macmini" }
        if name.contains("studio") { return "macstudio" }
        if name.contains("imac") { return "desktopcomputer" }
        if name.contains("mac pro") { return "macpro.gen3" }
        return "laptopcomputer"
    }

    private static var thisDeviceSymbol: String {
        if Platform.isMac { return "macwindow" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }

    private func host(_ id: NetPicture.Mac.ID) -> HostConfig? {
        fleet.hosts.first { $0.id.rawValue == id }?.host
    }


    // MARK: Removing

    /// Takes a member out of the net, once confirmed; this device leaves it.
    private func confirmRemoval(of member: NetMember) async {
        do {
            try await fleet.net.remove(member)
        } catch {
            netProblem = error.localizedDescription
        }
    }

    /// A Mac of the net is taken out of the net, on every device; a Mac added by hand only
    /// from this device.
    private func remove(_ host: HostConfig) {
        if let id = host.netMember, let member = fleet.net.membership.members.first(where: { $0.id == id }) {
            removingMember = member
        } else {
            removing = host
        }
    }

    private func isThisDevice(_ member: NetMember) -> Bool {
        member.id == fleet.net.membership.deviceID
    }

    private func removalTitle(of member: NetMember) -> String {
        isThisDevice(member) ? "Leave the net?" : "Remove \(member.name) from your net?"
    }

    private func removalMessage(of member: NetMember) -> String {
        if isThisDevice(member) {
            return "Your net's hosts and their threads are removed from \(Platform.thisDevice). The other portals and hosts stay in the net."
        }
        if member.kind == .mac {
            return "It leaves the net on every host and portal, and its threads are removed from \(Platform.thisDevice). Nothing changes on the computer itself."
        }
        return "It can't reach your hosts any more, until it is added again."
    }
}

/// A member of the net in Portals (or a Mac of it that is no host here, under Hosts): what
/// it is, its name, and which is this device.
struct MemberRow: View {
    let member: NetMember
    let isThisDevice: Bool

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: Self.symbol(of: member))
                .font(.app.body)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name)
                    .font(.app.body.weight(.medium))
                    .lineLimit(1)
                Text(kind)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .listRowOnMac()
    }

    /// What it is, as a symbol: a Mac Portals is used on is a window, apart from the Macs
    /// in the middle, whose agents it reaches.
    static func symbol(of member: NetMember) -> String {
        switch member.kind {
        case .mac: "laptopcomputer"
        case .device:
            switch member.platform {
            case "ipados": "ipad"
            case "macos": "macwindow"
            default: "iphone"
            }
        }
    }

    /// "Mac", "iPhone", or for this device "This iPhone".
    private var kind: String {
        if isThisDevice { return Platform.thisDeviceCapitalized }
        switch member.kind {
        case .mac: return "Mac"
        case .device:
            switch member.platform {
            case "ipados": return "iPad"
            case "macos": return "Mac"
            default: return "iPhone"
            }
        }
    }
}

/// A host in the list: its name, its address, and how its connection is doing.
private struct HostRow: View {
    let host: HostModel
    /// The demo's host (`Demo`): made up, at no address, and not to be edited.
    var isDemo = false

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: NetSettings.symbol(for: host.host))
                .font(.app.body)
                .foregroundStyle(.secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.host.name)
                    .font(.app.body.weight(.medium))
                    .lineLimit(1)
                Text(isDemo ? "Made up for the demo, with scripted agents" : Self.address(of: host.host))
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: Theme.grid * 0.75) {
                    HostStatusDot(status: host.status)
                    Text(host.statusText)
                        .lineLimit(2)
                    if host.isViaRelay {
                        Text("via relay")
                            .font(.app.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.app.footnote)
                .foregroundStyle(.secondary)
                // The free space on its disk, while connected, and a warning while it runs
                // low (`HostDisk`). None in the demo, which has no disk.
                if !isDemo, host.status == .connected, let disk = host.disk {
                    Text("\(Image(systemName: disk.isLow ? "exclamationmark.triangle.fill" : "internaldrive")) \(disk.message)")
                        .font(.app.caption)
                        .foregroundStyle(Self.colour(of: disk))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("host-disk")
                }
                if let hint = host.tailscaleHint {
                    Text(hint)
                        .font(.app.caption)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let warning = host.relayWarning {
                    Text(warning)
                        .font(.app.caption)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // A later version of its bridge: what to run on that computer, which the
                // host's page has in a box to copy (`HostSettingsSheet`). None in the demo,
                // which has no bridge.
                if !isDemo, let update = host.update {
                    Text("\(Image(systemName: "arrow.up.circle.fill")) \(update.message)")
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("host-update")
                }
            }
            Spacer(minLength: Theme.grid)
            if !isDemo {
                Image(systemName: "chevron.right")
                    .font(.app.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .listRowOnMac()
        .contentShape(.rect)
    }

    /// Grey while there is room, orange as the disk runs low, red once it is all but full.
    private static func colour(of disk: HostDisk) -> AnyShapeStyle {
        switch disk.level {
        case .ok: AnyShapeStyle(.secondary)
        case .low: AnyShapeStyle(.orange)
        case .critical: AnyShapeStyle(.red)
        }
    }

    /// The address without its scheme: `mini.example.ts.net:8443`.
    private static func address(of host: HostConfig) -> String {
        guard let name = host.url.host() else { return host.url.absoluteString }
        return host.url.port.map { "\(name):\($0)" } ?? name
    }
}

/// A host's connection at a glance: green when connected, grey while connecting, orange
/// when it is failing.
struct HostStatusDot: View {
    let status: HostModel.Status

    var body: some View {
        Circle()
            .fill(colour)
            .frame(width: 7, height: 7)
            .accessibilityLabel(label)
    }

    private var colour: Color {
        switch status {
        case .connected: .green
        case .connecting: Color(uiColor: .tertiaryLabel)
        case .problem: .orange
        }
    }

    private var label: String {
        switch status {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .problem: "Not connected"
        }
    }
}

/// Made-up hosts for a look at how the net picture lays them out (`DebugLaunch.netPicture`):
/// `demo` (three, one of each way of being reached), `one`, `many` (seven) or a number of
/// hosts, all reached directly.
enum NetPictureDemo {
    static func named(_ name: String) -> [NetPicture.Mac] {
        switch name {
        case "one":
            return [NetPicture.Mac(id: "m1", name: "MacBook Pro", symbol: "laptopcomputer", link: .direct)]
        case "many":
            let links: [NetPicture.Mac.Link] = [.direct, .relay, .direct, .connecting, .unreachable, .direct, .relay]
            return ["MBP16", "Mac mini", "Studio", "MBP14", "iMac", "Office mini", "Lab"].enumerated().map { index, name in
                NetPicture.Mac(id: "m\(index)", name: name, symbol: NetSettings.symbol(forMacNamed: name), link: links[index])
            }
        default:
            if let count = Int(name) {
                return (0..<count).map { NetPicture.Mac(id: "m\($0)", name: "Mac \($0 + 1)", symbol: "laptopcomputer", link: .direct) }
            }
            return [
                NetPicture.Mac(id: "m1", name: "MBP16", symbol: "laptopcomputer", link: .direct),
                NetPicture.Mac(id: "m2", name: "Mac mini", symbol: "macmini", link: .relay),
                NetPicture.Mac(id: "m3", name: "MBP14", symbol: "laptopcomputer", link: .unreachable),
            ]
        }
    }
}
