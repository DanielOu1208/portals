import AgentCore
import HermesBackend
import SwiftUI

/// Where the agents live and how to sign in there: the Mac's address, and the user name
/// and password set on it. A new one is best added from the code the bridge's setup
/// shows, scanned here or with the Camera, or on a Mac from the link under the code,
/// opened or pasted; the connection can be tried before saving.
///
/// With a net (`Net`), a Mac's code adds the Mac to the device's net, or the device to the
/// Mac's, and the code Add a device shows on another device joins its net; a Mac of the net
/// is signed in to with the net's token, and its address is the net's, and so is its name
/// where its Macs take renames: a new one renames it on every device and Mac of the net.
struct HostSettingsSheet: View {
    /// The host being edited; nil adds one.
    private let host: HostConfig?
    /// The hosts already added, so that a code for one of them updates it.
    private let existing: [HostConfig]
    /// The device's net, which a code goes through; nil adds a Mac by itself.
    private let net: Net?
    /// A later version of the host's bridge that is out, as it said (`HostModel.update`).
    private let update: HostUpdate?
    var onSave: (HostConfig, _ password: String) -> Void

    @State private var name: String
    @State private var address: String
    @State private var username: String
    @State private var password: String
    /// Test connection: a try under way, or what the last came to (`ConnectionTrial`).
    @State private var trial = ConnectionTrial()
    /// The try of the connection under way, one at a time: stopped as what it tries is
    /// changed and as the sheet closes, its connection with it.
    @State private var probe: Task<Void, Never>?
    /// The Mac already added that a code was for: saving updates it.
    @State private var matched: HostConfig?
    /// Everything was filled in from a code, so one tap adds it.
    @State private var isFromCode: Bool
    @State private var isScanning = false
    /// What is in the field for the link setup shows, on a Mac.
    @State private var pastedLink = ""
    /// Why what was pasted is not a link to add.
    @State private var pasteProblem: String?
    /// The pairing link the sheet was filled in from.
    @State private var pairing: PairingLink?
    /// The way into a net a code was, filled in instead of a Mac.
    @State private var joinLink: JoinLink?
    /// The net is being joined, or a Mac added to it.
    @State private var isWorking = false
    /// That work, held by the sheet: cancelled when the sheet closes, so that it makes no
    /// further call to a Mac (`NetAttempt`).
    @State private var netWork: Task<Void, Never>?
    /// Why that did not happen.
    @State private var netProblem: String?
    /// The Mac would not join the device's net, with its sentence: the device may switch
    /// to that Mac's net instead.
    @State private var macRefused: String?
    @State private var confirmsSwitch = false
    /// A new name renames the Mac on every device and Mac of the net (`Net.renamesEverywhere`),
    /// as found when the sheet came up; else it is this device's alone, as before.
    @State private var renamesEverywhere = false
    /// The rename is on its way to a Mac of the net.
    @State private var isRenaming = false
    /// Why the rename did not happen: the host kept its name.
    @State private var renameProblem: String?
    /// Opens the camera as soon as the sheet is up.
    private let scansFirst: Bool

    @Environment(\.dismiss) private var dismiss

    /// `link` fills the sheet in from a code; `scans` opens the camera at once.
    init(
        host: HostConfig?, savedPassword: String?, link: PortalsLink? = nil, existing: [HostConfig] = [], net: Net? = nil, scans: Bool = false,
        update: HostUpdate? = nil, onSave: @escaping (HostConfig, _ password: String) -> Void
    ) {
        self.host = host
        self.existing = existing
        self.net = net
        self.update = host == nil ? nil : update
        self.onSave = onSave
        _name = State(initialValue: host?.name ?? "")
        _address = State(initialValue: host?.url.absoluteString ?? "")
        _username = State(initialValue: host?.username ?? "")
        _password = State(initialValue: savedPassword ?? "")
        _matched = State(initialValue: nil)
        _isFromCode = State(initialValue: false)
        scansFirst = scans && host == nil && link == nil && Platform.scansCodes
        if case let .join(join) = link {
            _joinLink = State(initialValue: join)
            _isFromCode = State(initialValue: true)
        }
        if case let .pair(pairing) = link {
            _pairing = State(initialValue: pairing)
            let paired = pairing.host(updating: existing)
            _name = State(initialValue: paired.name)
            _address = State(initialValue: paired.url.absoluteString)
            _username = State(initialValue: pairing.username)
            _password = State(initialValue: pairing.password)
            _matched = State(initialValue: pairing.match(in: existing))
            _isFromCode = State(initialValue: true)
        }
    }

    var body: some View {
        // On a Mac the panel's own bar: in the window's, the sheet's Cancel was cut to "C…".
        // Filled in from a code, the one button is the big one in the form.
        PanelChrome(
            title: joinLink != nil ? "Join a net" : host == nil && matched == nil ? "Add a host" : "Host",
            doneIdentifier: "host-settings-cancel",
            cancels: true,
            onDone: { dismiss() },
            action: isFromCode ? nil : saveButton
        ) {
            Form {
                if let joinLink {
                    joining(joinLink)
                } else if isFromCode {
                    fromCode
                } else if host == nil {
                    if Platform.scansCodes { scan } else { paste }
                }

                if joinLink == nil {
                    details
                }
            }
            // A result is about what was typed when it was tried.
            .onChange(of: [address, username, password]) {
                stopTrial()
                trial.reset()
                netProblem = nil
                macRefused = nil
            }
            .onChange(of: name) { renameProblem = nil }
            #if !targetEnvironment(macCatalyst)
            .sheet(isPresented: $isScanning) {
                PairingScanner(onFound: fill)
            }
            #endif
            .confirmationDialog(
                "Switch to this net?", isPresented: $confirmsSwitch, titleVisibility: .visible
            ) {
                Button("Switch", role: .destructive, action: switchNet)
                    .accessibilityIdentifier("confirm-switch-net")
            } message: {
                Text("Your current hosts will be removed from \(Platform.thisDevice).")
            }
            // Asked again as the net's Macs connect and drop: one connected that takes renames
            // is what makes a new name the net's.
            .task(id: net?.connectedNetHostIDs) {
                if let host, let net, host.isNetHost { renamesEverywhere = await net.renamesEverywhere(host) }
            }
            .task {
                if let typed = DebugLaunch.renamesHost, host != nil {
                    try? await Task.sleep(for: .seconds(3))
                    name = typed
                    try? await Task.sleep(for: .seconds(1))
                    save()
                }
                if DebugLaunch.testsHostSettings { await tryConnection() }
                if DebugLaunch.pressesFromCode, isFromCode {
                    try? await Task.sleep(for: .seconds(1))
                    pressFromCode()
                }
                if scansFirst {
                    // Once this sheet has come up: one presentation at a time.
                    try? await Task.sleep(for: .seconds(0.45))
                    isScanning = true
                }
            }
        }
        .onDisappear {
            netWork?.cancel()
            stopTrial()
        }
        .sheetOnMac()
        .accessibilityIdentifier("host-settings-sheet")
    }

    /// Add or Save at the end of the bar, a spinner while a rename goes round the net.
    @ViewBuilder private var saveButton: some View {
        if isRenaming {
            ProgressView()
        } else {
            Button(host == nil ? "Add" : "Save", action: save)
                .disabled(config == nil)
                .accessibilityIdentifier("save-host")
        }
    }

    /// The Mac's address, name and sign-in, and trying them. A Mac of the net has its
    /// address from the net and signs in with the net's token: only its name is the user's.
    @ViewBuilder
    private var details: some View {
        Section {
            TextField("Address", text: $address, prompt: Text("mac.example.ts.net:10010"))
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(isNetHost)
                .accessibilityIdentifier("host-address")
            TextField("Name", text: $name, prompt: Text(suggestedName))
                .accessibilityIdentifier("host-name")
        } header: {
            Text("Host")
                .formHeader()
        } footer: {
            Group {
                if let renameProblem {
                    Text(renameProblem)
                        .foregroundStyle(.red)
                } else if isNetHost {
                    Text("Where \(Platform.thisDevice) reaches the host over Tailscale, as your net says. Portals signs in to it as one of your net's portals, with no password."
                        + (renamesEverywhere ? " A new name renames it on all your portals and hosts." : ""))
                } else {
                    Text("Where \(Platform.thisDevice) reaches the host over Tailscale: the address setup showed, or the one `tailscale serve` gives it.")
                }
            }
            .formFooter()
        }

        if let update {
            Section {
                VStack(alignment: .leading, spacing: Theme.grid) {
                    Text(update.headline)
                    CommandBox(command: HostUpdate.command, copyIdentifier: "host-update-copy")
                }
                .padding(.vertical, Theme.grid * 0.5)
            } header: {
                Text("Update")
                    .formHeader()
            } footer: {
                Text("Nothing updates a host by itself. Run this in a terminal on that computer, a Mac or a Linux computer: it installs the latest Portals host and restarts it.")
                    .formFooter()
            }
        }

        if !isNetHost {
            Section {
                TextField("User name", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("host-user")
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .accessibilityIdentifier("host-password")
            } header: {
                Text("Sign-in")
                    .formHeader()
            } footer: {
                Text("The user name and password setup showed; for Hermes on its own, the ones under `dashboard.basic_auth`. The password is kept in this device's Keychain.")
                    .formFooter()
            }
        }

        Section {
            Button(action: startTrial) {
                HStack {
                    Text("Test connection")
                    Spacer()
                    if trial.phase == .running { ProgressView() }
                }
            }
            .disabled(config == nil || trial.phase == .running)
            switch trial.phase {
            case .none, .running:
                EmptyView()
            case let .passed(agents):
                Label(agents == 1 ? "Connected. 1 agent." : "Connected. \(agents) agents.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case let .failed(reason):
                Label(reason, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
        }
    }

    /// For a sheet filled in from a code: which Mac, and the one button that adds it. With
    /// a net, the Mac comes into the device's net, or the device into the Mac's.
    @ViewBuilder
    private var fromCode: some View {
        Section {
            CodeCard(symbol: "laptopcomputer", name: config?.name ?? suggestedName, address: Self.shortAddress(address))
        } footer: {
            Group {
                if let macRefused {
                    Text("\(macRefused) You can switch \(Platform.thisDevice) to that host's net instead.")
                } else if let netProblem {
                    Text(netProblem)
                        .foregroundStyle(.red)
                } else if case .known = decision {
                    Text("\(config?.name ?? suggestedName) is in your net already.")
                } else if let matched {
                    Text("\(matched.name) is added already. This updates how Portals signs in to it.")
                } else if case .addMac = decision {
                    Text("From the code setup showed on the host. Adding it brings it into your net as a host, and every portal in the net reaches it.")
                } else if case .pairIntoNet = decision {
                    Text("From the code setup showed on the host. Adding it reaches the other hosts in its net too.")
                } else {
                    Text("From the code setup showed on the host. Everything is filled in below.")
                }
            }
            .formFooter()
        }

        Section {
            if case .known = decision {
                CodeButton(title: "Done", isWorking: false) { dismiss() }
            } else if macRefused != nil {
                CodeButton(title: "Switch to this host's net", isWorking: isWorking) { confirmsSwitch = true }
                    .accessibilityIdentifier("switch-net")
            } else {
                CodeButton(title: matched == nil ? "Add this host" : "Update this host", isWorking: isWorking, action: addFromCode)
                    .disabled(config == nil)
                    .accessibilityIdentifier("add-from-code")
            }
        }
    }

    /// For a sheet opened with the code Add a device shows: whose net, and the one button
    /// that joins it.
    @ViewBuilder
    private func joining(_ link: JoinLink) -> some View {
        Section {
            CodeCard(symbol: "point.3.filled.connected.trianglepath.dotted", name: link.macName, address: Self.shortAddress(link.url.absoluteString))
        } footer: {
            Group {
                if let netProblem {
                    Text(netProblem)
                        .foregroundStyle(.red)
                } else if case .known = decision {
                    Text("\(Platform.thisDeviceCapitalized) is in this net already.")
                } else if case .switchNet = decision {
                    Text("\(Platform.thisDeviceCapitalized) is in another net. Joining this one removes your current hosts from it.")
                } else {
                    Text("From the code Add a portal showed on a portal in the net. Joining reaches every host in it.")
                }
            }
            .formFooter()
        }

        Section {
            switch decision {
            case .known:
                CodeButton(title: "Done", isWorking: false) { dismiss() }
            case .switchNet:
                CodeButton(title: "Switch to this net", isWorking: isWorking) { confirmsSwitch = true }
                    .accessibilityIdentifier("switch-net")
            default:
                CodeButton(title: "Join", isWorking: isWorking) { run { try await $0.open(.join(link)) } }
                    .accessibilityIdentifier("join-net")
            }
        }
    }

    /// For a new Mac typed in by hand: scanning instead.
    private var scan: some View {
        Section {
            Button("Scan the code", systemImage: "qrcode.viewfinder") { isScanning = true }
                .accessibilityIdentifier("scan-code")
        } footer: {
            Text("On your Mac or Linux computer, run `\(PairingLink.setupCommand)` in a terminal. It shows a code that fills all of this in.")
                .formFooter()
        }
    }

    /// For a new Mac typed in by hand where there is no camera to scan with: a field for
    /// the link setup shows under its code. A link pasted there fills the sheet in.
    private var paste: some View {
        Section {
            TextField("Link", text: $pastedLink, prompt: Text("Paste the link setup showed"))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("paste-link")
                // Pasted, the link arrives whole; typed, it is only read once it is done.
                .onChange(of: pastedLink) { old, new in read(pasted: new, complaining: new.count - old.count > 1) }
                .onSubmit { read(pasted: pastedLink, complaining: true) }
        } footer: {
            Group {
                if let pasteProblem {
                    Text(pasteProblem)
                        .foregroundStyle(.red)
                } else {
                    Text("Run `\(PairingLink.setupCommand)` in Terminal, on this Mac or the computer your agents run on, a Mac or Linux. It ends with a link that fills all of this in; on this Mac, setup opens it here.")
                }
            }
            .formFooter()
        }
    }

    /// Fills the sheet in from the link in the field, if it is one; says why not when
    /// asked to.
    private func read(pasted text: String, complaining: Bool) {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            fill(from: try PortalsLink(parsing: link))
            pasteProblem = nil
        } catch {
            pasteProblem = complaining && !link.isEmpty ? error.localizedDescription : nil
        }
    }

    /// Fills the sheet in from a scanned code, or a pasted link.
    private func fill(from link: PortalsLink) {
        netProblem = nil
        macRefused = nil
        let pairing: PairingLink
        switch link {
        case let .join(join):
            withAnimation {
                joinLink = join
                isFromCode = true
            }
            return
        case let .pair(paired):
            pairing = paired
        }
        joinLink = nil
        self.pairing = pairing
        let paired = pairing.host(updating: existing)
        name = paired.name
        address = paired.url.absoluteString
        username = pairing.username
        password = pairing.password
        matched = pairing.match(in: existing)
        withAnimation { isFromCode = true }
    }

    private func save() {
        guard let config else { return }
        // A Mac of the net whose Macs take renames: renamed on every device and Mac, through
        // the net, and not saved here as a name of this device's own. Asked once more as
        // Save is pressed, for a sheet that came up before any Mac of the net connected.
        if let host, let net, host.isNetHost, config.name != host.name {
            return rename(host, to: config.name, through: net, orSave: config)
        }
        onSave(config, password)
        dismiss()
    }

    /// Renames the host's Mac for the whole net, and closes the sheet once a Mac took it;
    /// saves `config` here as before when the net's Macs that are connected do not take
    /// renames. When none takes it (none of the net connected, or the name refused), says
    /// why, and the host keeps its name: the device does not go its own way from the others
    /// without a word.
    private func rename(_ host: HostConfig, to name: String, through net: Net, orSave config: HostConfig) {
        isRenaming = true
        renameProblem = nil
        Task {
            defer { isRenaming = false }
            if !renamesEverywhere { renamesEverywhere = await net.renamesEverywhere(host) }
            guard renamesEverywhere || net.connectedNetHostIDs.isEmpty else {
                onSave(config, password)
                return dismiss()
            }
            do {
                try await net.rename(host, to: name)
                dismiss()
            } catch {
                withAnimation { renameProblem = error.localizedDescription }
            }
        }
    }

    /// What the code comes to with the device's net, as far as can be said before the Mac
    /// answers (`NetScan`); nil without a net.
    private var decision: NetScan.Decision? {
        guard let net, let link = joinLink.map(PortalsLink.join) ?? pairingAsTyped.map(PortalsLink.pair) else { return nil }
        return NetScan.decide(link, membership: net.membership, hosts: existing)
    }

    /// The code's pairing, with the same validated fields Test connection uses.
    private var pairingAsTyped: PairingLink? {
        guard pairing != nil, let config else { return nil }
        return PairingLink(url: config.url, username: config.username ?? "", password: password, name: config.name)
    }

    /// Whether the host being edited is a Mac of the device's net.
    private var isNetHost: Bool {
        host?.isNetHost == true
    }

    /// What the one button of a sheet filled in from a code does (`DebugLaunch.pressesFromCode`).
    private func pressFromCode() {
        switch decision {
        case .known: dismiss()
        case .switchNet: switchNet()
        default:
            if let joinLink { run { try await $0.open(.join(joinLink)) } } else { addFromCode() }
        }
    }

    /// Adds the Mac of the code: through the net, into it or with the device into the Mac's;
    /// by itself, as before the net, for a Mac whose bridge has none or with no net here.
    private func addFromCode() {
        guard let pairing = pairingAsTyped, joinLink == nil else { return save() }
        run { try await $0.open(.pair(pairing)) }
    }

    /// The device leaves its net for the code's: a join link's, or the Mac's that would not
    /// join the device's net.
    private func switchNet() {
        if let joinLink {
            run { try await $0.open(.join(joinLink)) }
        } else if let pairing = pairingAsTyped {
            run { try await $0.switchToNet(of: pairing) }
        }
    }

    /// Does something with the net, and closes the sheet once it is done. The sheet holds
    /// it: closed first, the work is cancelled, and what it comes to is not acted on.
    private func run(_ work: @escaping (Net) async throws -> Net.Outcome) {
        guard let net else { return save() }
        isWorking = true
        netProblem = nil
        netWork?.cancel()
        netWork = Task {
            defer { isWorking = false }
            do {
                let outcome = try await work(net)
                guard !Task.isCancelled else { return }
                switch outcome {
                case .joined, .added, .known:
                    dismiss()
                case .withoutNet:
                    save()
                case let .refused(reason):
                    withAnimation { macRefused = reason }
                }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                withAnimation { netProblem = error.localizedDescription }
            }
        }
    }

    /// The host as typed; nil until the address is one. A code for a Mac already added
    /// keeps that one's id, so it is updated, not added twice.
    private var config: HostConfig? {
        guard let url = HostConfig.url(fromTyped: address) else { return nil }
        let typedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = host?.id ?? matched.flatMap { HostConfig.isSameAddress($0.url, url) ? $0.id : nil } ?? HostID(rawValue: UUID().uuidString)
        var config = HostConfig(
            id: id,
            name: typedName.isEmpty ? suggestedName : typedName,
            url: url,
            username: user.isEmpty ? nil : user
        )
        // Kept for the test of the connection; saving keeps them from the host itself.
        config.netMember = host?.netMember
        return config
    }

    /// The first label of the address ("mini" for mini.example.ts.net), for a Mac that
    /// was given no name.
    private var suggestedName: String {
        HostConfig.suggestedName(for: HostConfig.url(fromTyped: address))
    }

    /// The address without its scheme: `mini.example.ts.net:10010`.
    private static func shortAddress(_ typed: String) -> String {
        guard let url = HostConfig.url(fromTyped: typed), let name = url.host() else { return typed }
        return url.port.map { "\(name):\($0)" } ?? name
    }

    /// Connects with what is typed, without saving anything.
    /// Tries the connection, in place of a try under way.
    private func startTrial() {
        probe?.cancel()
        probe = Task { await tryConnection() }
    }

    private func stopTrial() {
        probe?.cancel()
        probe = nil
    }

    /// The longest a try of the connection takes, sign-in and listing included: a host that
    /// does not answer leaves no attempt waiting behind the sheet.
    private static let trialLimit: Duration = .seconds(45)

    private func tryConnection() async {
        // Stopped before its first turn (a field changed just after the tap): it never begins.
        guard let config, let id = trial.begin(cancelled: Task.isCancelled) else { return }
        let typed = password
        // A Mac of the net signs in with the token, which the test does not save either.
        let authenticator = isNetHost
            ? HostDirectory.authenticator(for: config, credentials: InMemoryCredentialStore(netToken: net?.token))
            : HostDirectory.authenticator(for: config) { typed }
        let backend = HermesBackend(host: config.id, authenticator: authenticator)
        let outcome: Result<Int, any Error>
        do {
            outcome = .success(try await Deadline.run(within: Self.trialLimit) {
                // Its connection goes when it ends, whenever that is: an attempt the deadline
                // or a cancel left behind may only connect after the disconnect below.
                do {
                    try await backend.connect()
                    try Task.checkCancellation()
                    let count = try await backend.listAgents().count
                    await backend.disconnect()
                    return count
                } catch {
                    await backend.disconnect()
                    throw error
                }
            })
        } catch {
            outcome = .failure(error)
        }
        // Over, given up or stopped: no reconnecting, no heartbeat.
        await backend.disconnect()
        // Every end leaves the trial as it should show: stopped, nothing; else how it went.
        switch outcome {
        case let .success(count):
            trial.end(id, with: .success(count), cancelled: Task.isCancelled)
        case .failure(is Deadline.Passed):
            trial.end(id, with: .failure("The host did not answer in time. Check the address, and that Tailscale is on here and on the host."), cancelled: Task.isCancelled)
        case let .failure(error):
            trial.end(id, with: .failure(error.localizedDescription), cancelled: Task.isCancelled)
        }
    }
}

#Preview {
    HostSettingsSheet(
        host: HostConfig(name: "Mini", url: URL(string: "https://mini.example.ts.net:8443")!, username: "dana"),
        savedPassword: "secret"
    ) { _, _ in }
}

#Preview("From a code") {
    HostSettingsSheet(
        host: nil, savedPassword: nil,
        link: .pair(PairingLink(url: URL(string: "https://mbp16.example.ts.net:10010")!, username: "dana", password: "secret", name: "MacBook Pro"))
    ) { _, _ in }
}

#Preview("Joining a net") {
    HostSettingsSheet(
        host: nil, savedPassword: nil,
        link: .join(JoinLink(url: URL(string: "https://mbp16.example.ts.net:10010")!, code: "x7Hq2b9LkPz0aW4vR1sYtA", name: "MacBook Pro"))
    ) { _, _ in }
}

/// What a code is for, at the top of the sheet it filled in: a Mac, or a net.
private struct CodeCard: View {
    let symbol: String
    let name: String
    let address: String

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: symbol)
                .font(.app.title2)
                .foregroundStyle(.secondary)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.app.headline)
                Text(address)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, Theme.grid / 2)
    }
}

/// The one button of a sheet filled in from a code, with a spinner while it works.
private struct CodeButton: View {
    let title: String
    let isWorking: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.grid) {
                if isWorking { ProgressView() }
                Text(title)
            }
            .font(.app.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.grid / 2)
        }
        .buttonStyle(.monochromeProminent)
        .buttonBorderShape(.capsule)
        .disabled(isWorking)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }
}
