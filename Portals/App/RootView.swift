import AgentCore
import SwiftUI

/// The top of the app: the chat with every Mac's agents, or, before any Mac is added,
/// how to add one, or the demo offered there (`Demo`) while it is on. The sheets for
/// setting up Macs open from here, also from a `portals://pair` link, the code the
/// bridge's setup shows, or a `portals://join` link, the code Add a device shows, scanned
/// with the Camera.
struct RootView: View {
    /// A sheet about hosts.
    private enum Sheet: Identifiable {
        case add
        /// Adding one, starting with the camera.
        case scan
        case edit(HostID)
        /// From Settings (`SettingsSheet`): a code for adding a portal, an agent's look, the
        /// acknowledgements.
        case addPortal
        case look(Agent)
        case agentProgram(HostID, AgentProgram.ID)
        case acknowledgements
        /// Adding, or updating, the Mac a link is for; or joining the net a link is a way into.
        case link(PortalsLink)

        var id: String {
            switch self {
            case .add: "add"
            case .scan: "scan"
            case let .edit(host): "edit-\(host.rawValue)"
            case .addPortal: "add-portal"
            case let .look(agent): "look-\(agent.id.host.rawValue)-\(agent.id.name)"
            case let .agentProgram(host, program): "agent-program-\(host.rawValue)-\(program)"
            case .acknowledgements: "acknowledgements"
            case let .link(link): "link-\(link.hashValue)"
            }
        }
    }

    @State private var fleet: Fleet
    /// The demo's fleet while the demo is on (`Demo`): shown in place of `fleet`, which has
    /// no host then.
    @State private var demo: Fleet?
    @State private var sheet: Sheet?
    /// Settings is open over the window (`SettingsScreen`), at this part.
    @State private var showsSettings = false
    @State private var settingsSection = DebugLaunch.settingsOpensAt ?? .net
    /// Light, dark or the system's (Settings, Appearance), for every window.
    @AppStorage(AppearanceChoice.settingKey) private var appearance = AppearanceChoice.system
    /// Why a link that opened the app adds nothing.
    @State private var linkProblem: String?
    /// Why the demo did not open, or end.
    @State private var demoProblem: Demo.Problem?
    /// Settings a demo changed are still to be put back, with no demo on (`Demo.hasSettingsLeft`):
    /// nothing that would change them is offered until they are, adding a host included.
    @State private var waitsForSettings = Demo.hasSettingsLeft

    /// The app's one fleet, made the first time a RootView is. SwiftUI makes a RootView again
    /// each time it builds the scene and keeps the state of the first, so a fleet made in each
    /// was thrown away, after reading every store and, with a thread left on screen, decoding
    /// its history again: SwiftUI watched what that build read, the new fleet's own work
    /// changed it, and the scene was built again, without end. On an iPhone on
    /// 2026-10-19 that kept the main thread busy all the time (15.3 s of CPU in 15 s).
    /// The menu bar's commands act on it too (`TabCommands`).
    static let fleetForTheRun = Fleet()
    /// The demo's fleet while it is on, which the menu bar's commands act on instead.
    static var demoForTheRun: Fleet?

    init() {
        SidebarProbe.listen()
        RowProbe.listen()
        SidebarProbe.mark("fleet-start", once: true)
        _fleet = State(initialValue: Self.fleetForTheRun)
        // A demo on as the window was made again (a Mac's window closed during it and opened
        // from the Dock, the app still running) goes on in it: else the new window showed
        // the welcome, waiting on the demo's settings, while the menu bar's commands acted
        // on the demo out of sight and another demo deleted its folder (bug hunt round 4, APP2).
        _demo = State(initialValue: Self.demoForTheRun)
        SidebarProbe.mark("fleet-made", once: true)
    }

    var body: some View {
        ZStack {
            Group {
                if let demo {
                    // Its host's settings are not to be opened: it is no host to edit.
                    MainScreen(fleet: demo, onShowHosts: { openSettings() })
                } else if fleet.hosts.isEmpty {
                    HostWelcome(onScan: { sheet = .scan }, onAddByHand: { sheet = .add }, waitsForSettings: waitsForSettings)
                        // Under a sheet on an iPhone or iPad (adding a host, the camera) its
                        // avatar holds still; a Mac's sheet leaves the window in view.
                        .outOfSight(sheet != nil && !Platform.isMac)
                } else {
                    MainScreen(fleet: fleet, onEditHost: { sheet = .edit($0) }, onShowHosts: { openSettings() })
                }
            }
            // Under Settings it stays as it was, out of sight: nothing in it moves, takes
            // the keyboard or is read out (`isOutOfSight`).
            .outOfSight(showsSettings)
            .accessibilityHidden(showsSettings)
            .disabled(showsSettings)

            if showsSettings {
                // At once, whole, as it closes too (2026-10-26: "just have everything
                // appear at once on the screen"): a fade drew its bar and its page in turn.
                SettingsScreen(fleet: shown, section: $settingsSection, onClose: closeSettings)
                    .environment(\.showSettingsSheet) { request in sheet = Self.sheet(for: request) }
                    .zIndex(1)
            }
        }
        .transaction(value: showsSettings) { $0.animation = nil }
        .environment(\.endDemo, demoEnding)
        // A reply's image opened on its own covers the whole window, the sidebar too.
        .showsPicturesHere()
        .onAppear { ScreenCommands.shared.showSettings = { openSettings() } }
        .onChange(of: appearance, initial: true) { _, appearance in Platform.apply(appearance) }
        // A tapped notification opens its thread under Settings (`MainScreen`): Settings
        // makes way for it.
        .onChange(of: PushCoordinator.shared.requestedThread) { _, route in
            if route != nil { showsSettings = false }
        }
        .onChange(of: showsSettings) { _, shows in ScreenCommands.shared.showsSettings = shows }
        // Settings is for a device with a Mac; without one, the welcome is all there is.
        .onChange(of: fleet.hosts.isEmpty) { _, isEmpty in if isEmpty { showsSettings = false } }
        .sheet(item: $sheet) { sheet in
            let existing = fleet.hosts.map(\.host)
            switch sheet {
            case .add:
                HostSettingsSheet(host: nil, savedPassword: nil, existing: existing, net: fleet.net, onSave: fleet.saveHost)
            case .scan:
                HostSettingsSheet(host: nil, savedPassword: nil, existing: existing, net: fleet.net, scans: true, onSave: fleet.saveHost)
            case let .edit(id):
                HostSettingsSheet(
                    host: fleet.model(for: id)?.host, savedPassword: fleet.password(for: id), net: fleet.net,
                    update: fleet.model(for: id)?.update, onSave: fleet.saveHost
                )
            case let .link(link):
                HostSettingsSheet(host: nil, savedPassword: nil, link: link, existing: existing, net: fleet.net, onSave: fleet.saveHost)
            case .addPortal:
                AddDeviceSheet(net: fleet.net)
            case let .look(agent):
                AgentLookEditor(agent: agent, look: shown.look(for: agent.id), logo: shown.logo(for: agent.id)) { look in
                    shown.setLook(look, for: agent.id)
                }
            case let .agentProgram(host, program):
                AgentProgramDetail(fleet: shown, hostID: host, programID: program, onDone: { self.sheet = nil })
            case .acknowledgements:
                PanelChrome(title: "Acknowledgements", onDone: { self.sheet = nil }) {
                    Acknowledgements()
                }
                .sheetOnMac(width: 620, height: 700)
            }
        }
        .onOpenURL { url in open(url.absoluteString) }
        .alert(
            "Can't add this host",
            isPresented: Binding(get: { linkProblem != nil }, set: { if !$0 { linkProblem = nil } }),
            presenting: linkProblem
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem)
        }
        .alert(
            demoProblem?.title ?? "",
            isPresented: Binding(get: { demoProblem != nil }, set: { if !$0 { demoProblem = nil } }),
            presenting: demoProblem
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem.localizedDescription)
        }
        // Settings a demo left that could not be read at launch (before the device was first
        // unlocked): put back as the app comes to the front, before anything changes them.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            guard demo == nil else { return }
            Demo.putBackSettingsLeftByADemo()
            waitsForSettings = Demo.hasSettingsLeft
        }
        // Taken out of the net from elsewhere: said once.
        .alert(
            "Not in your net any more",
            isPresented: Binding(get: { fleet.net.notice != nil }, set: { if !$0 { fleet.net.notice = nil } }),
            presenting: fleet.net.notice
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { notice in
            Text(notice)
        }
        // A net switched away from that no host of took this device out of, given up: said once.
        .alert(
            "Still listed in your old net",
            isPresented: Binding(get: { fleet.net.leftBehindNotice != nil }, set: { if !$0 { fleet.net.leftBehindNotice = nil } }),
            presenting: fleet.net.leftBehindNotice
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { notice in
            Text(notice)
        }
        .task(id: fleet.net.isInNet) {
            // A development launch that opened a link into a net, and asks for Settings too:
            // Settings once the net is joined, for a look at it.
            guard DebugLaunch.openLink != nil, DebugLaunch.settingsOpensAt != nil, fleet.net.isInNet else { return }
            try? await Task.sleep(for: .seconds(1.5))
            sheet = nil
            showsSettings = true
        }
        .task {
            Platform.prepareWindows()
            if DebugLaunch.opensDemo { startDemo() }
            if let link = DebugLaunch.openLink {
                open(link)
            } else if DebugLaunch.settingsOpensAt != nil {
                openSettings()
            } else if DebugLaunch.scansForHost {
                sheet = .scan
            } else if DebugLaunch.opensHostSettings {
                sheet = fleet.hosts.first.map { .edit($0.id) } ?? .add
            }
        }
    }
}

extension RootView {
    /// The sheet a part of Settings asks for.
    private static func sheet(for request: SettingsSheet) -> Sheet {
        switch request {
        case .addHost: .add
        case let .editHost(id): .edit(id)
        case .addPortal: .addPortal
        case let .look(agent): .look(agent)
        case let .agentProgram(host, program): .agentProgram(host, program)
        case .acknowledgements: .acknowledgements
        }
    }

    /// The fleet on screen: the demo's while it is on.
    private var shown: Fleet {
        demo ?? fleet
    }

    /// The way out of the demo, while it is on.
    private var demoEnding: DemoEnding? {
        demo == nil ? nil : DemoEnding { endDemo() }
    }

    /// Opens Settings over the window, where it was left; not before there is a Mac.
    private func openSettings() {
        // Not under a sheet that is up (a look being changed, a file open, adding a host):
        // that sheet would take what Settings passes the screen, and lose its keys.
        guard !shown.hosts.isEmpty, !Platform.isSheetUp else { return }
        // The keyboard's holder under it would take what is typed next, out of sight.
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        showsSettings = true
    }

    private func closeSettings() {
        showsSettings = false
    }

    /// Opens the demo (`DebugLaunch.opensDemo`): never once a host is added.
    private func startDemo() {
        guard demo == nil, fleet.hosts.isEmpty else { return }
        do {
            let started = try Demo.start()
            Self.demoForTheRun = started
            demo = started
        } catch {
            demoProblem = error as? Demo.Problem
        }
    }

    /// Ends the demo: back at the welcome, as it was before. False, the demo still on, when
    /// the settings it kept cannot be read back just now (which the screen says).
    @discardableResult
    private func endDemo() -> Bool {
        guard let ending = demo else { return true }
        do {
            try Demo.end(ending)
        } catch {
            demoProblem = error as? Demo.Problem
            return false
        }
        showsSettings = false
        settingsSection = DebugLaunch.settingsOpensAt ?? .net
        sheet = nil
        Self.demoForTheRun = nil
        demo = nil
        // Made again during the demo, the window started out waiting for its settings: they
        // are back now.
        waitsForSettings = Demo.hasSettingsLeft
        return true
    }

    /// Opens the sheet a `portals://` link is for, or says why it is none. A link opened
    /// during the demo ends it first: the host it adds is a real one. Not while settings a
    /// demo changed are still to be put back.
    private func open(_ link: String) {
        guard endDemo() else { return }
        if waitsForSettings {
            Demo.putBackSettingsLeftByADemo()
            waitsForSettings = Demo.hasSettingsLeft
            guard !waitsForSettings else {
                linkProblem = "Portals is still putting your settings back as they were before the demo. Try the link again in a moment."
                return
            }
        }
        do {
            sheet = .link(try PortalsLink(parsing: link))
        } catch {
            linkProblem = error.localizedDescription
        }
    }
}

/// Shown on a device before any Mac is added: the three steps to the first one, with the
/// bridge's setup on the Mac at the centre. Scrolls only on a screen too short for it.
/// The last step is scanning the code setup shows; on a Mac, which has no camera to
/// hold up to it, opening or pasting the link under the code. Tailscale is the first step
/// everywhere; on a Mac, going without it is the exception that step mentions (2026-11-03).
private struct HostWelcome: View {
    var onScan: () -> Void
    var onAddByHand: () -> Void
    /// Settings a demo changed are still to be put back: nothing is offered until they are.
    var waitsForSettings = false

    var body: some View {
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { AmbientGradient(mood: .calm) }
    }

    private var content: some View {
        VStack(spacing: Theme.grid * 3) {
            VStack(spacing: Theme.grid) {
                AgentAvatarView(mood: .idle, size: 72)
                Text("Talk to your agents")
                    .font(.app.title2.weight(.semibold))
                Text("Claude Code, Codex, Pi, Cursor, Droid and Hermes run on your Mac or Linux computer. Portals reaches them over Tailscale.")
                    .font(.app.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: Theme.grid * 2.5) {
                // On a Mac, this Mac is the host as a rule; another Mac is the aside.
                WelcomeStep(number: 1, title: Platform.isMac ? "Tailscale on this Mac" : "Tailscale on both") {
                    if Platform.isMac {
                        Text("Install it and sign in. On your iPhone too, with the same account, to reach your agents from it.")
                    } else {
                        Text("Install it on \(Platform.thisDevice) and on your Mac or Linux computer, signed in to the same account.")
                    }
                    GetTailscaleLink(identifier: "welcome-get-tailscale")
                    if Platform.isMac {
                        Text("Only using Portals on this Mac? You can go without it: setup lets you skip it, and you can add it later for your iPhone or iPad.")
                            .font(.app.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                WelcomeStep(number: 2, title: Platform.isMac ? "Make this Mac or another machine a host" : "Make your Mac or Linux computer a host") {
                    Text(Platform.isMac ? "In Terminal, run:" : "In a terminal there, run:")
                    CommandBox(command: PairingLink.setupCommand, copyIdentifier: "welcome-copy-command")
                    Group {
                        Text("It needs Node 22.18 or later, from nodejs.org.")
                        if Platform.isMac {
                            Text("For another machine, a Mac or Linux, run it there instead, with Tailscale on it too.")
                        }
                    }
                    .font(.app.caption)
                    .foregroundStyle(.tertiary)
                }
                if Platform.scansCodes {
                    WelcomeStep(number: 3, title: "Scan the code it shows") {
                        Text("Setup ends with a QR code. Scan it here, or with the Camera.")
                    }
                } else {
                    WelcomeStep(number: 3, title: "Add it here") {
                        Text("Setup opens Portals with this Mac filled in. From another machine, copy the link setup shows under its code and paste it in Add a host.")
                    }
                }
            }
            .cardSurface()

            VStack(spacing: Theme.grid * 1.5) {
                if waitsForSettings {
                    Text("Putting your settings back as they were before the demo…")
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if Platform.scansCodes {
                    Button("Scan the code", systemImage: "qrcode.viewfinder", action: onScan)
                        .buttonStyle(.monochromeProminent)
                        .buttonBorderShape(.capsule)
                        .accessibilityIdentifier("welcome-scan")
                    Button("Enter the address instead", action: onAddByHand)
                        .font(.app.subheadline)
                        .accessibilityIdentifier("welcome-add-by-hand")
                } else {
                    // The sheet takes the link pasted, or the address typed.
                    Button("Add a host", systemImage: "plus", action: onAddByHand)
                        .buttonStyle(.monochromeProminent)
                        .buttonBorderShape(.capsule)
                        .accessibilityIdentifier("welcome-add-by-hand")
                }
            }
        }
        .disabled(waitsForSettings)
        .pageMargins()
        .padding(.vertical, Theme.grid * 3)
        .frame(maxWidth: WindowLayout.pageWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// One numbered step of a list of them: a title, and what to do under it.
struct WelcomeStep<Content: View>: View {
    let number: Int
    let title: LocalizedStringKey
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 1.5) {
            Text(number, format: .number)
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(Theme.plainBackground)
                .frame(width: 22, height: 22)
                .background(.primary, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.grid * 0.75) {
                Text(title)
                    .font(.app.subheadline.weight(.semibold))
                    .accessibilityLabel(Text("Step \(number): \(Text(title))"))
                content()
                    .font(.app.subheadline)
                    .foregroundStyle(.secondary)
            }
            // Every line wraps to its full height, also while ViewThatFits measures it.
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// "Get Tailscale ↗": to the App Store, as text, also on a Mac, where a link is a push
/// button unless told.
struct GetTailscaleLink: View {
    let identifier: String

    var body: some View {
        Link(destination: Platform.tailscaleURL) {
            Label("Get Tailscale", systemImage: "arrow.up.right")
                .labelStyle(TrailingIconLabelStyle())
        }
        .font(.app.subheadline.weight(.medium))
        .foregroundStyle(.primary)
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

/// A label with its symbol after the title, small: "Get Tailscale ↗".
private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.title
            configuration.icon
                .imageScale(.small)
        }
    }
}

/// A command in a box of its own, to copy and paste on the Mac (Universal Clipboard
/// carries it over): the setup command, or a host's update (`HostUpdate.command`). Where
/// the command and the word Copy do not both fit, as on an iPhone SE, the button is its
/// symbol alone.
struct CommandBox: View {
    let command: String
    let copyIdentifier: String
    /// How many lines it may take, for a long path.
    var lines = 1
    @State private var copied = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(wordy: true)
            row(wordy: false)
        }
        .padding(.horizontal, Theme.grid * 1.5)
        .padding(.vertical, Theme.grid * 1.25)
        .background(Theme.insetFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }

    private func row(wordy: Bool) -> some View {
        HStack(spacing: Theme.grid) {
            Text(command)
                .font(.app.callout.monospaced())
                .foregroundStyle(.primary)
                .lineLimit(lines)
                .minimumScaleFactor(wordy ? 1 : 0.8)
            Spacer(minLength: Theme.grid)
            Button {
                UIPasteboard.general.string = command
                copied = true
            } label: {
                let label = Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "square.on.square")
                if wordy { label } else { label.labelStyle(.iconOnly) }
            }
            .font(.app.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .buttonStyle(.plain)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityIdentifier(copyIdentifier)
        }
    }
}
