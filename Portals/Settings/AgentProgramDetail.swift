import AgentCore
import SwiftUI

/// A program on a host: its version, updating it, how much of
/// its plan is left and when that resets, and how its agents look. The host's word on it is
/// asked for by the page beneath (`AgentSettings`), which stays on screen under this sheet.
struct AgentProgramDetail: View {
    let fleet: Fleet
    let hostID: HostID
    let programID: AgentProgram.ID
    let onDone: () -> Void

    /// Asking whether to update, with what it would say.
    @State private var confirming: Confirmation?
    /// Why the host would not.
    @State private var refusal: String?
    /// An agent's look being changed: over this sheet, which is still here after.
    @State private var changingLook: Agent?
    /// Moves the times on while this is up.
    @State private var now = Date.now

    private struct Confirmation: Identifiable {
        let title: String
        let message: String
        var id: String { title }
    }

    private var host: HostModel? { fleet.model(for: hostID) }
    private var program: AgentProgram? { AgentProgramsMemory.shared.program(programID, on: hostID) }
    private var agents: [Agent] { fleet.arrangedAgents(on: hostID).filter { $0.kind == programID } }
    private var name: String { program?.name ?? (programID == "hermes" ? "Hermes" : agents.first?.displayName ?? programID) }

    var body: some View {
        PanelChrome(title: name, onDone: onDone) {
            Form {
                if let program {
                    versionSection(program)
                    updateSection(program)
                } else if let failure = AgentProgramsMemory.shared.failures[hostID] {
                    Section {
                        Text(failure).foregroundStyle(.secondary)
                    }
                    .settingsRows()
                } else if host?.isConnected == true {
                    Section {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    }
                    .settingsRows()
                }
                limitsSections
                looksSection
            }
            .formStyle(.grouped)
            .modifier(SettingsSurface())
        }
        .sheetOnMac(width: 560, height: 640)
        .confirmationDialog(confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { _ in
            Button("Update") { startUpdate() }
                .accessibilityIdentifier("confirm-update-program")
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(confirmation.message)
        }
        .alert("Can't update this here", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } }), presenting: refusal) { _ in
            Button("OK", role: .cancel) {}
        } message: { refusal in
            Text(refusal)
        }
        .sheet(item: $changingLook) { agent in
            AgentLookEditor(agent: agent, look: fleet.look(for: agent.id), logo: fleet.logo(for: agent.id)) { look in
                fleet.setLook(look, for: agent.id)
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                now = .now
            }
        }
    }

    // MARK: Version

    private func versionSection(_ program: AgentProgram) -> some View {
        Section {
            value("Installed", program.isInstalled ? program.version ?? "Unknown" : "Not found on this host")
            if let latest = program.latest {
                value("Latest", latest)
            }
            if program.standing == .tooOld, let minimum = program.minimum {
                value("Portals needs", "\(minimum) or newer")
            }
            if let running = program.runningVersion {
                value("Its threads run", running)
            }
            if let how = program.how {
                value("Installed with", Self.words(for: how))
            }
        } header: {
            Text(host?.host.name ?? "").formHeader()
        } footer: {
            if agents.isEmpty, program.isInstalled {
                Text("Portals does not run \(program.name) on this host: it is turned off in the host's settings.")
                    .formFooter()
            }
        }
        .settingsRows()
    }

    private func value(_ title: String, _ text: String) -> some View {
        LabeledContent(title) {
            Text(text)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .listRowOnMac()
    }

    private static func words(for how: AgentProgram.InstallMethod) -> String {
        switch how {
        case .own: "Its own installer"
        case .npm: "npm"
        case .homebrew: "Homebrew"
        case .app: "An app"
        case .other: "Another way"
        }
    }

    // MARK: Updating

    @ViewBuilder
    private func updateSection(_ program: AgentProgram) -> some View {
        Section {
            if let file = program.update?.cannotTellFile {
                VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
                    Text(AgentProgram.Update.cannotTellWords)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(file)
                        .font(.app.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .listRowOnMac()
                .accessibilityIdentifier("program-update-cannot-tell")
            } else if program.isUpdating {
                HStack(spacing: Theme.grid) {
                    ProgressView().controlSize(.small)
                    Text(program.stateWords ?? "Updating…")
                }
                .listRowOnMac()
                .accessibilityIdentifier("program-updating")
                if let line = program.update?.line {
                    Text(line)
                        .font(.app.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .listRowOnMac()
                }
            }
            if let update = program.update, update.state == .failed {
                VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
                    Text(update.timedOut ? "The update took too long and was stopped." : "The update failed.")
                        .foregroundStyle(.orange)
                    if let tail = update.tail {
                        Text(tail)
                            .font(.app.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .listRowOnMac()
                .accessibilityIdentifier("program-update-failed")
            }
            if let update = program.update, update.state == .done {
                Text(doneWords(update, program))
                    .listRowOnMac()
                    .accessibilityIdentifier("program-update-done")
            }
            if program.offersUpdate, host?.isConnected == true {
                Button(updateTitle(program)) { confirming = confirmation(for: program) }
                    .listRowOnMac()
                    .accessibilityIdentifier("update-program")
            } else if !program.canUpdate, program.isInstalled {
                howToUpdate(program)
            } else if program.state == .upToDate, program.update == nil {
                Text("Up to date")
                    .foregroundStyle(.secondary)
                    .listRowOnMac()
            }
        } footer: {
            if let word = afterwards(program) {
                Text(word).formFooter()
            }
        }
        .settingsRows()
    }

    private func updateTitle(_ program: AgentProgram) -> String {
        if program.update?.state == .failed { return "Try Again" }
        guard program.updateAvailable == true, let latest = program.latest else { return "Update" }
        return "Update to \(latest)"
    }

    private func doneWords(_ update: AgentProgram.Update, _ program: AgentProgram) -> String {
        if let from = update.from, let to = update.to, from != to { return "Updated from \(from) to \(to)." }
        return "Updated. It is still \(update.to ?? program.version ?? "the same version"): its updater had nothing newer."
    }

    /// An installation the host cannot update: what to run there.
    @ViewBuilder
    private func howToUpdate(_ program: AgentProgram) -> some View {
        if let command = program.command {
            VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
                Text("Portals cannot update this installation. To update it, run this on \(host?.host.name ?? "the host"):")
                    .foregroundStyle(.secondary)
                Text(command)
                    .font(.app.body.monospaced())
                    .textSelection(.enabled)
            }
            .listRowOnMac()
            .accessibilityIdentifier("program-update-command")
        } else {
            Text("It updates with the app it came in.")
                .foregroundStyle(.secondary)
                .listRowOnMac()
        }
    }

    /// Under the section: when threads move to a new version, once one has been installed or may be.
    private func afterwards(_ program: AgentProgram) -> String? {
        guard program.isInstalled else { return nil }
        switch program.takesEffect {
        case .nextStart: return nil
        case .serviceRestart: return Self.serviceWords(program)
        case .botsRestart: return "Updating Hermes restarts it, and its bots with it."
        }
    }

    /// Codex's threads run on a service every Codex on the host shares, which Portals never restarts.
    private static func serviceWords(_ program: AgentProgram) -> String {
        "\(program.name) threads run on a background service it shares across this host. It keeps its version until it restarts, and only then do its threads move to a new version. Portals does not restart it."
    }

    private func confirmation(for program: AgentProgram) -> Confirmation {
        let threads = host?.threadsAtWork(of: Set(agents.map(\.id.name))) ?? []
        var words: [String] = []
        switch program.takesEffect {
        case .nextStart:
            words.append(threads.isEmpty
                ? "Threads at work are not stopped, and keep their version until their process next starts."
                : "\(Self.named(threads)) \(threads.count == 1 ? "is" : "are") at work: not stopped, keeping \(threads.count == 1 ? "its" : "their") version until \(threads.count == 1 ? "its" : "their") process next starts.")
        case .serviceRestart:
            if !threads.isEmpty { words.append("\(Self.named(threads)) \(threads.count == 1 ? "is" : "are") at work, and not stopped.") }
            words.append(Self.serviceWords(program))
        case .botsRestart:
            let bots = agents.map(\.displayName).formatted(.list(type: .and))
            words.append(bots.isEmpty ? "Hermes restarts its bots as it updates." : "Hermes restarts its bots as it updates: \(bots).")
            if !threads.isEmpty { words.append("\(Self.named(threads)) \(threads.count == 1 ? "is" : "are") at work now.") }
        }
        let to = program.updateAvailable == true ? program.latest.map { " to \($0)" } ?? "" : ""
        return Confirmation(title: "Update \(program.name)\(to) on \(host?.host.name ?? "this host")?", message: words.joined(separator: " "))
    }

    /// "“Fix the login” and “Tidy up”", and how many more past three.
    private static func named(_ threads: [ThreadRecord]) -> String {
        let shown = threads.prefix(3).map { "“\($0.displayTitle)”" }
        let rest = threads.count - shown.count
        return (rest > 0 ? shown + ["\(rest) more"] : shown).formatted(.list(type: .and))
    }

    private func startUpdate() {
        guard let provider = host?.programsProvider else { return }
        Task {
            do {
                try await AgentProgramsMemory.shared.update(programID, on: hostID, from: provider)
            } catch {
                refusal = error.localizedDescription
            }
        }
    }

    // MARK: Limits

    /// One part for each thing said of a plan: a host's bots mostly say the same.
    @ViewBuilder
    private var limitsSections: some View {
        ForEach(limitGroups, id: \.agent.id) { group in
            Section {
                ForEach(group.limits.windows) { window in
                    UsageWindowRow(window: window, now: now, tint: fleet.style(for: group.agent.id).tint)
                }
                if let note = group.limits.note {
                    Text(note).font(.app.caption).foregroundStyle(.secondary).listRowOnMac()
                }
                if let failure = ThreadPanelMemory.shared.pageUsageFailure(of: group.agent.id) {
                    Text(failure).font(.app.caption).foregroundStyle(.orange).listRowOnMac()
                }
            } header: {
                Text(group.limits.title ?? (limitGroups.count > 1 ? group.agent.displayName : "Limits"))
                    .formHeader()
            } footer: {
                if let asOf = ThreadPanelMemory.shared.pageUsageAsOf(of: group.agent.id, isConnected: host?.isConnected == true) {
                    Text(UsagePart.asOf(asOf)).formFooter()
                }
            }
            .settingsRows()
        }
        // A limit that turns work away, where the host has no window to draw for it.
        if limitGroups.isEmpty, let note = agents.lazy.compactMap({ ThreadPanelMemory.shared.pageUsage(of: $0.id)?.blockingNote }).first {
            Section {
                Text(note).foregroundStyle(.orange).listRowOnMac()
            }
            .settingsRows()
        }
    }

    private var limitGroups: [(agent: Agent, limits: UsageLimits)] {
        var groups: [(agent: Agent, limits: UsageLimits)] = []
        for agent in agents {
            guard let limits = ThreadPanelMemory.shared.pageUsage(of: agent.id), !limits.windows.isEmpty else { continue }
            if !groups.contains(where: { $0.limits.windows == limits.windows }) { groups.append((agent, limits)) }
        }
        return groups
    }

    // MARK: Looks

    /// How it shows: one row for an agent, a row for each Hermes bot, each with its own look.
    @ViewBuilder
    private var looksSection: some View {
        if !agents.isEmpty {
            Section {
                ForEach(agents) { agent in
                    Button { changingLook = agent } label: {
                        HStack(spacing: Theme.grid * 1.5) {
                            AgentAvatarView(state: .idle, frozenAt: 1, size: 30, style: fleet.style(for: agent.id))
                                .frame(width: 30, height: 30)
                            Text(programID == "hermes" ? agent.displayName : "Appearance")
                                .font(.app.body)
                                .lineLimit(1)
                            Spacer(minLength: Theme.grid)
                            Text("Change Look")
                                .font(.app.footnote)
                                .foregroundStyle(.secondary)
                            Image(systemName: "chevron.forward")
                                .font(.app.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .listRowOnMac()
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("change-look-\(agent.id.name)")
                }
            } header: {
                if programID == "hermes" {
                    Text("Bots").formHeader()
                }
            } footer: {
                Text("An agent's look is how it shows in the sidebar, its chats and its notifications, on every device.")
                    .formFooter()
            }
            .settingsRows()
        }
    }
}

/// One window of a plan: its ring larger, what it is, how much is left and when it resets.
private struct UsageWindowRow: View {
    let window: UsageLimits.Window
    let now: Date
    let tint: Color?

    var body: some View {
        let hasReset = window.hasReset(at: now)
        HStack(spacing: Theme.grid * 1.5) {
            if !hasReset, window.left != nil {
                UsageRing(window: window, now: now, tint: tint, size: 44, lineWidth: 4.5, label: window.left.map { "\(Int($0.rounded()))" })
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(heading(hasReset: hasReset))
                    .font(.app.body)
                if !hasReset, let resets = window.resetsAt, resets > now {
                    Text("Resets in \(UsageWindowView.duration(resets.timeIntervalSince(now)))")
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Spacer(minLength: 0)
        }
        .listRowOnMac()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(UsageRing.words(for: window, now: now))
    }

    private func heading(hasReset: Bool) -> String {
        let name = window.name.prefix(1).uppercased() + window.name.dropFirst()
        if hasReset { return "\(name) has reset" }
        if window.isUsedUp { return "\(name) used up" }
        return window.left.map { "\(name): \(Int($0.rounded()))% left" } ?? name
    }
}
