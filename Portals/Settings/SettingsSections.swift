import AgentCore
import SwiftUI
import UserNotifications

// The parts of Settings after Net (`NetSettings`), each a form (`SettingsPage`); Agents has a file of its own (`AgentSettings`).

// MARK: Chat

/// How messages and thoughts go in every thread.
struct ChatSettings: View {
    let fleet: Fleet

    /// What a message sent while an agent works does (`ThreadController.whenBusy`).
    @AppStorage(WhenBusy.settingKey) private var whenBusy = WhenBusy.steer
    /// Whether a working agent's thought shows under its status line (`ThoughtWindow`).
    @AppStorage(ThoughtWindow.settingKey) private var showsThinking = false
    /// Whether the commands an agent left running show at the foot of a chat (`ChatFoot`).
    @AppStorage(FootLine.showsCommandsKey) private var showsBackgroundTasks = true

    var body: some View {
        Form {
            Section {
                Picker("Sent while an agent works", selection: $whenBusy) {
                    Text("Steer").tag(WhenBusy.steer)
                    Text("Queue").tag(WhenBusy.queue)
                }
                .accessibilityIdentifier("when-busy")
            } header: {
                Text("Messages")
                    .formHeader()
            } footer: {
                Text(whenBusy == .steer
                    ? "The agent reads your message during the turn it is on. An agent that cannot take one in (Cursor, Hermes) queues it."
                    : "Your message waits above the composer and starts a turn of its own when the agent is done. You can steer it in or remove it while it waits.")
                    .formFooter()
            }
            .settingsRows()

            Section {
                Toggle("Show thinking while agents work", isOn: $showsThinking)
                    .accessibilityIdentifier("shows-thinking")
            } footer: {
                Text(showsThinking
                    ? "What an agent thinks shows in three lines under what it is doing, as it thinks."
                    : "An agent thinking shows as Thinking…. Tap the line to read its thought.")
                    .formFooter()
            }
            .settingsRows()

            Section {
                Toggle("Show background tasks", isOn: $showsBackgroundTasks)
                    .accessibilityIdentifier("shows-background-tasks")
            } footer: {
                Text(showsBackgroundTasks
                    ? "Commands an agent leaves running show at the foot of the chat."
                    : "Commands an agent leaves running go on running, with no line at the foot of the chat and no Stop. Turn this on to see or stop them.")
                    .formFooter()
            }
            .settingsRows()

            // Only where some Mac's agents work in folders: elsewhere no agent is asked.
            if fleet.offersProjects {
                Section {
                    Toggle("Ask Hermes agents for a folder", isOn: Binding(
                        get: { fleet.asksHermesAgentsForFolder },
                        set: { fleet.asksHermesAgentsForFolder = $0 }
                    ))
                    .accessibilityIdentifier("ask-hermes-agents-for-folder")
                } header: {
                    Text("New threads")
                        .formHeader()
                } footer: {
                    Text(fleet.asksHermesAgentsForFolder
                        ? "A new thread with a Hermes agent starts by choosing the folder it works in, as a coding agent's does."
                        : "A coding agent's new thread starts by choosing its folder. A Hermes agent's starts at once; to start one in a folder, use New thread on the folder in the sidebar, or the agent's menu there.")
                        .formFooter()
                }
                .settingsRows()
            }
        }
    }
}

// MARK: Notifications

/// Whether the app may notify at all, and which notifications the user wants.
struct NotificationSettings: View {
    let fleet: Fleet

    @AppStorage(NotificationChoices.needsYouKey) private var needsYou = true
    @AppStorage(NotificationChoices.doneKey) private var done = true
    /// What the system lets the app do, as of when the page was last shown or the app came
    /// back to the front (the user may have changed it in the system's Settings).
    @State private var allowed: UNAuthorizationStatus?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        Form {
            Section {
                HStack(spacing: Theme.grid) {
                    Text("Notifications")
                    Spacer(minLength: Theme.grid)
                    Text(allowedText)
                        .foregroundStyle(.secondary)
                }
                .listRowOnMac()
                switch allowed {
                // The demo registers for none (`Demo`).
                case .notDetermined where !fleet.isDemo:
                    Button("Turn On Notifications") {
                        Task {
                            await PushCoordinator.shared.enable()
                            await readAllowed()
                        }
                    }
                    .accessibilityIdentifier("allow-notifications")
                case .denied:
                    Button("Open Notification Settings", action: openSystemSettings)
                default:
                    EmptyView()
                }
            } footer: {
                Text(fleet.isDemo
                    ? "The demo sends no notifications. With your own computer added, Portals tells you when an agent needs you or is done."
                    : allowed == .denied
                    ? "Notifications are off for Portals in \(Platform.isMac ? "System Settings" : "Settings"). Turn them on there to hear from your agents while you are away."
                    : "Portals tells you about the threads on \(Platform.thisDevice) while you are away from them.")
                    .formFooter()
            }
            .settingsRows()

            Section {
                Toggle("When an agent needs you", isOn: $needsYou)
                    .accessibilityIdentifier("notify-needs-you")
                Toggle("When an agent is done", isOn: $done)
                    .accessibilityIdentifier("notify-done")
            } header: {
                Text("Notify me")
                    .formHeader()
            } footer: {
                Text(choicesFooter)
                    .formFooter()
            }
            .settingsRows()
            .disabled(allowed == .denied)
        }
        .onChange(of: needsYou) { fleet.registerForPush() }
        .onChange(of: done) { fleet.registerForPush() }
        .task(id: scenePhase) { await readAllowed() }
    }

    private var allowedText: String {
        switch allowed {
        case .authorized, .provisional, .ephemeral: "On"
        case .denied: "Off"
        case .notDetermined: "Not turned on"
        default: ""
        }
    }

    /// What the two choices cover, and the Macs that cannot keep to them yet.
    private var choicesFooter: String {
        let what = "An agent needs you when it asks to run something or asks a question. It is done when its turn ends, or fails."
        let sendingAll = fleet.hosts.filter { $0.isConnected && !$0.mutesNotifications }.map(\.host.name)
        guard !needsYou || !done, !sendingAll.isEmpty else { return what }
        let names = sendingAll.formatted(.list(type: .and))
        let them = sendingAll.count == 1 ? "it is" : "they are"
        return what + " \(names) \(sendingAll.count == 1 ? "sends" : "send") every kind until \(them) updated; while Portals is open, the ones turned off are not shown."
    }

    private func readAllowed() async {
        allowed = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func openSystemSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
    }
}

// MARK: Appearance

/// Light, dark or the system's, for the whole app (`PortalsApp`).
enum AppearanceChoice: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: Self { self }

    static let settingKey = "appearance.mode"

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
}

/// Light or dark, the colour behind the chats, and how much of Recent the sidebar shows.
struct AppearanceSettings: View {
    let fleet: Fleet

    @AppStorage(AppearanceChoice.settingKey) private var appearance = AppearanceChoice.system
    /// Whether a chat is washed in its agent's colour (`ChatScreen`).
    @AppStorage(ChatWash.settingKey) private var tintsChats = true

    var body: some View {
        Form {
            Section {
                HStack(spacing: Theme.grid * 2) {
                    ForEach(AppearanceChoice.allCases) { choice in
                        AppearanceTile(choice: choice, isSelected: appearance == choice) { appearance = choice }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.grid)
            } header: {
                Text("Appearance")
                    .formHeader()
            } footer: {
                Text(appearance == .system
                    ? "Light or dark as \(Platform.isMac ? "the Mac" : "the device") is."
                    : "Always \(appearance.title.lowercased()), whatever \(Platform.isMac ? "the Mac" : "the device") is set to.")
                    .formFooter()
            }
            .settingsRows()

            Section {
                Toggle("Agent's colour behind its chat", isOn: $tintsChats)
                    .accessibilityIdentifier("tints-chats")
            } footer: {
                Text(tintsChats
                    ? "Each chat is washed in its agent's colour, which you choose in Agents."
                    : "Every chat is washed in grey, whichever agent it is with.")
                    .formFooter()
            }
            .settingsRows()

            Section {
                Toggle("Show recent threads", isOn: Binding(
                    get: { fleet.recentChoice.shows },
                    set: { fleet.recentChoice.shows = $0 }
                ))
                .accessibilityIdentifier("shows-recent")
                if fleet.recentChoice.shows {
                    Picker("Threads to show", selection: Binding(
                        get: { fleet.recentChoice.count },
                        set: { fleet.recentChoice.count = $0 }
                    )) {
                        ForEach(RecentChoice.counts, id: \.self) { count in
                            Text("\(count)").tag(count)
                        }
                    }
                    .accessibilityIdentifier("recent-count")
                }
            } header: {
                Text("Sidebar")
                    .formHeader()
            } footer: {
                Text(fleet.recentChoice.shows
                    ? "The threads you used last, on any of your devices. Threads that finished while you were away are under Finished and are not counted. This choice is only for this \(Platform.isMac ? "Mac" : "device")."
                    : "Threads that finished while you were away still show under Finished, until you open them. This choice is only for this \(Platform.isMac ? "Mac" : "device").")
                    .formFooter()
            }
            .settingsRows()
        }
    }
}

/// One of System, Light and Dark: a little window drawn in it, its name under it.
private struct AppearanceTile: View {
    let choice: AppearanceChoice
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.grid) {
                window
                    .frame(width: 76, height: 52)
                    .clipShape(.rect(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(isSelected ? Color.accentColor : Color(uiColor: .separator), lineWidth: isSelected ? 2.5 : 1)
                    }
                Text(choice.title)
                    .font(.app.footnote.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? .primary : .secondary)
            }
            .frame(maxWidth: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("appearance-\(choice.rawValue)")
    }

    @ViewBuilder
    private var window: some View {
        switch choice {
        case .light: Self.page(dark: false)
        case .dark: Self.page(dark: true)
        case .system:
            HStack(spacing: 0) {
                Self.page(dark: false)
                Self.page(dark: true)
            }
        }
    }

    /// A page with a sidebar and two lines of a chat, in light or dark.
    private static func page(dark: Bool) -> some View {
        let back = dark ? Color(hex: 0x1C1C1E) : Color(hex: 0xF2F2F7)
        let side = dark ? Color(hex: 0x2C2C2E) : Color.white
        let line = dark ? Color.white.opacity(0.35) : Color.black.opacity(0.18)
        return HStack(spacing: 0) {
            side.frame(width: 20)
            VStack(alignment: .leading, spacing: 5) {
                Capsule().fill(line).frame(width: 30, height: 4)
                Capsule().fill(line).frame(width: 20, height: 4)
                Spacer(minLength: 0)
                Capsule().fill(line.opacity(0.7)).frame(height: 7)
            }
            .padding(6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(back)
    }
}

/// Whether chats are washed in their agent's colour (Settings, Appearance).
enum ChatWash {
    static let settingKey = "appearance.tintsChats"
}

// MARK: About

/// The app's version, each Mac's bridge's, and the acknowledgements.
struct AboutSettings: View {
    let fleet: Fleet

    @Environment(\.showSettingsSheet) private var showSheet

    @State private var checksForUpdatesNow = MacUpdater.checksAutomatically

    private var checksForUpdates: Binding<Bool> {
        Binding(get: { checksForUpdatesNow }, set: {
            checksForUpdatesNow = $0
            MacUpdater.checksAutomatically = $0
        })
    }

    /// "Portals 0.1.0 (1)".
    static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Portals \(version) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                VStack(spacing: Theme.grid) {
                    Image("AboutIcon")
                        .resizable()
                        .frame(width: 72, height: 72)
                        .clipShape(.rect(cornerRadius: 16, style: .continuous))
                        .accessibilityHidden(true)
                    Text("Portals")
                        .font(.app.title2.weight(.bold))
                    Text(Self.appVersion.replacingOccurrences(of: "Portals ", with: "Version "))
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.grid)
                .listRowBackground(Color.clear)
            }

            if MacUpdater.isAvailable {
                Section {
                    Toggle("Check for updates automatically", isOn: checksForUpdates)
                        .listRowOnMac()
                    Button("Check for Updates…") { MacUpdater.checkForUpdates() }
                        .listRowOnMac()
                } header: {
                    Text("Updates")
                        .formHeader()
                }
                .settingsRows()
            }

            if !fleet.hosts.isEmpty {
                Section {
                    ForEach(fleet.hosts) { host in
                        HStack(spacing: Theme.grid) {
                            Text(host.host.name)
                            Spacer(minLength: Theme.grid)
                            Text(bridgeText(of: host))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .listRowOnMac()
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text("Hosts")
                        .formHeader()
                } footer: {
                    Text("The version of the Portals bridge each host runs, which its agents work through.")
                        .formFooter()
                }
                .settingsRows()
            }

            Section {
                Button {
                    showSheet(.acknowledgements)
                } label: {
                    HStack {
                        Text("Acknowledgements")
                            .foregroundStyle(.primary)
                        Spacer(minLength: Theme.grid)
                        Image(systemName: "chevron.forward")
                            .font(.app.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowOnMac()
                .accessibilityIdentifier("acknowledgements")
            }
            .settingsRows()
        }
    }

    /// The bridge's version as the Mac said it, or why there is none to show.
    private func bridgeText(of host: HostModel) -> String {
        // The demo's host is no bridge, and has none to update (`Demo`).
        if fleet.isDemo { return "Made up for the demo" }
        if let version = host.bridgeVersion {
            return host.update.map { "Version \(version), \($0.latest) out" } ?? "Version \(version)"
        }
        guard host.isConnected else { return "Not connected" }
        if host.host.kind == .bridge { return "Older version" }
        // Hermes on its own runs no bridge.
        return host.runsHermesAlone ? "Hermes, no bridge" : "No version"
    }
}

/// The third-party notices (THIRD_PARTY_NOTICES.md, in the app as Acknowledgements.md):
/// its headings, paragraphs and licence texts.
struct Acknowledgements: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.grid * 1.5) {
                ForEach(Array(Self.blocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case let .heading(text):
                        Text(text)
                            .font(.app.headline)
                            .padding(.top, Theme.grid)
                    case let .paragraph(text):
                        Text(Self.inline(text))
                            .font(.app.subheadline)
                    case let .licence(text):
                        Text(text)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.margin)
        }
    }

    private enum Block {
        case heading(String), paragraph(String), licence(String)
    }

    private static let blocks: [Block] = {
        guard let url = Bundle.main.url(forResource: "Acknowledgements", withExtension: "md"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return [.paragraph("The notices could not be read.")] }
        var blocks: [Block] = []
        var lines: [String] = []
        var inLicence = false
        func flush() {
            let joined = lines.joined(separator: inLicence ? "\n" : " ").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { blocks.append(inLicence ? .licence(joined) : .paragraph(joined)) }
            lines = []
        }
        for line in text.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                flush()
                inLicence.toggle()
            } else if inLicence {
                lines.append(line)
            } else if line.hasPrefix("#") {
                flush()
                let heading = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                // The file's own title is the sheet's.
                if !line.hasPrefix("# ") { blocks.append(.heading(heading)) }
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
            } else {
                lines.append(line)
            }
        }
        flush()
        return blocks
    }()

    private static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}
