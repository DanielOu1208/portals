import AgentCore
import SwiftUI

// MARK: Agents

/// Every host's agents: one row for each program installed there, with its version, what
/// it is up to and how much of its plan is left, and the Hermes bots of a host all on one
/// row. A row opens the program's page (`AgentProgramDetail`), which updates it and changes
/// its look. On a host that does not list programs, the agents as they always were, each
/// row changing its look.
struct AgentSettings: View {
    let fleet: Fleet

    @Environment(\.showSettingsSheet) private var showSheet
    @Environment(\.scenePhase) private var scenePhase
    /// What the rings and their times go by, moved on while the page can be seen.
    @State private var now = Date.now
    /// `PORTALS_DEBUG_AGENT_PROGRAM` has opened its page.
    @State private var openedForDebug = false

    var body: some View {
        Form {
            ForEach(fleet.hosts) { host in
                let rows = AgentSettingsRowItem.rows(
                    agents: fleet.arrangedAgents(on: host.id), programs: AgentProgramsMemory.shared.programs[host.id], hostLists: host.listsPrograms
                )
                Section {
                    if rows.isEmpty {
                        Text(host.isConnected ? "No agents on this host." : "Its agents show once it is connected.")
                            .foregroundStyle(.secondary)
                            .listRowOnMac()
                    }
                    ForEach(rows) { row in
                        rowView(row, on: host)
                    }
                } header: {
                    Text(host.host.name)
                        .formHeader()
                }
                .settingsRows()
            }
            Section {
                if fleet.hosts.isEmpty {
                    Text("Add a host in Net to see its agents.")
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("Tap an agent for its version, its limits and how it looks. Which model and mode a thread runs on is chosen in the thread.")
                    .formFooter()
            }
            .settingsRows()
        }
        // Asked only while this page is on screen and can be seen.
        .task(id: Asking(hosts: Set(fleet.hosts.filter { $0.isConnected && $0.listsPrograms }.map(\.id)), isSeen: isSeen)) {
            guard isSeen else { return }
            await withTaskGroup(of: Void.self) { group in
                for host in fleet.hosts where host.isConnected && host.listsPrograms {
                    group.addTask { await keepAsking(host) }
                }
            }
        }
        // The rings' time, whether or not any host can be asked: asks nothing of one, and a
        // window that has reset leaves its ring, an older host's too.
        .task(id: isSeen) {
            guard isSeen else { return }
            while !Task.isCancelled {
                now = .now
                try? await Task.sleep(for: .seconds(Self.clockEvery))
            }
        }
        .onChange(of: AgentProgramsMemory.shared.programs) { openForDebug() }
    }

    private var isSeen: Bool { scenePhase != .background && !WindowVisibility.shared.isHidden }

    private static let clockEvery = 30

    private struct Asking: Hashable {
        let hosts: Set<HostID>
        let isSeen: Bool
    }

    /// Once a minute, as the host itself asks an agent no oftener (`usage.read`); every two
    /// seconds, for its programs alone, while it updates one.
    private func keepAsking(_ host: HostModel) async {
        guard let provider = host.programsProvider else { return }
        var asked: ContinuousClock.Instant?
        while !Task.isCancelled {
            let isDue = asked.map { $0.duration(to: .now) >= .seconds(60) } ?? true
            if isDue {
                asked = .now
                for agent in fleet.arrangedAgents(on: host.id) {
                    // Each on its own: Claude Code may be started only to be asked.
                    Task { try? await ThreadPanelMemory.shared.askUsage(of: agent.id, from: provider) }
                }
            }
            if isDue || AgentProgramsMemory.shared.isUpdating(on: host.id) {
                await AgentProgramsMemory.shared.ask(on: host.id, from: provider)
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    @ViewBuilder
    private func rowView(_ row: AgentSettingsRowItem, on host: HostModel) -> some View {
        switch row.kind {
        case let .program(id, program):
            Button { showSheet(.agentProgram(host.id, id)) } label: {
                AgentProgramRow(
                    program: program, id: id, agents: row.agents, isConnected: host.isConnected, now: now,
                    style: row.agents.first.map { fleet.style(for: $0.id) } ?? AgentProgramRow.style(ofProgram: id),
                    tint: { fleet.style(for: $0.id).tint }
                )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("program-row-\(id)")
        case .agent:
            if let agent = row.agents.first {
                Button { showSheet(.look(agent)) } label: {
                    AgentSettingsRow(agent: agent, style: fleet.style(for: agent.id), maker: maker(of: agent, on: host), now: now)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("agent-row-\(agent.id.name)")
            }
        }
    }

    /// Whose agent it is: a coding agent's maker, or Hermes for a bot.
    private func maker(of agent: Agent, on host: HostModel) -> String? {
        if let logo = fleet.logo(for: agent.id) { return logo.brand }
        // A Hermes profile, through a bridge or from Hermes on its own; nothing for a
        // development switch's scripted agents, which are no one's.
        return agent.kind == "hermes" || host.runsHermesAlone ? "Hermes" : nil
    }

    private func openForDebug() {
        guard !openedForDebug, let id = DebugLaunch.opensAgentProgram else { return }
        guard let host = fleet.hosts.first(where: { AgentProgramsMemory.shared.program(id, on: $0.id) != nil }) else { return }
        openedForDebug = true
        showSheet(.agentProgram(host.id, id))
    }
}

/// A program on its host: its logo or its bot's avatar, its name and how it stands, and what
/// is left of its plan.
private struct AgentProgramRow: View {
    let program: AgentProgram?
    let id: String
    let agents: [Agent]
    let isConnected: Bool
    let now: Date
    let style: AgentAvatarStyle
    let tint: (Agent) -> Color?

    /// A program with no agent here: its maker's logo, as its agent would wear it.
    static func style(ofProgram id: String) -> AgentAvatarStyle {
        var style = AgentAvatarStyle.standard
        if let logo = CodingAgentLogo(rawValue: id) {
            style.logo = logo
            style.showsLogo = true
        }
        return style
    }

    /// What it says of its plan: the first of its agents with something to say, as a host's
    /// bots mostly share one.
    private var limits: (limits: UsageLimits, agent: Agent)? {
        for agent in agents {
            if let known = ThreadPanelMemory.shared.pageUsage(of: agent.id), !known.windows.isEmpty { return (known, agent) }
        }
        return nil
    }

    private var name: String {
        program?.name ?? (id == "hermes" ? "Hermes" : agents.first?.displayName ?? id)
    }

    var body: some View {
        AgentRowContent(style: style, name: name, line: line, spokenLine: spokenLine, lineIsLoud: lineIsLoud) {
            if let limits {
                UsageRings(limits: limits.limits, now: now, tint: tint(limits.agent))
            }
        } end: {
            EmptyView()
        }
    }

    /// Its bots, for Hermes; its version and how it stands, in the row's one line.
    private var line: String? {
        guard let program else { return bots }
        return [bots, isConnected ? program.stateLine : program.version].compactMap(\.self).joined(separator: " · ")
    }

    private var spokenLine: String? {
        guard let program else { return bots }
        return [bots, isConnected ? program.spokenStateLine : program.version].compactMap(\.self).joined(separator: ", ")
    }

    private var bots: String? {
        id == "hermes" && !agents.isEmpty ? (agents.count == 1 ? "1 bot" : "\(agents.count) bots") : nil
    }

    private var lineIsLoud: Bool {
        guard isConnected, let program else { return false }
        switch program.state {
        case .updateFailed, .tooOld, .notFound: return true
        default: return false
        }
    }
}

/// An agent in Agents on a host that does not list programs, or with no program behind it:
/// its avatar as it rests, its name and whose it is, and what panels have heard of its plan.
private struct AgentSettingsRow: View {
    let agent: Agent
    let style: AgentAvatarStyle
    let maker: String?
    let now: Date

    var body: some View {
        AgentRowContent(style: style, name: agent.displayName, line: maker, spokenLine: maker, lineIsLoud: false) {
            if let known = ThreadPanelMemory.shared.pageUsage(of: agent.id) {
                UsageRings(limits: known, now: now, tint: style.tint)
            }
        } end: {
            Text("Change Look")
                .font(.app.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
        }
    }
}

/// What every row of Agents is made of.
private struct AgentRowContent<Rings: View, End: View>: View {
    let style: AgentAvatarStyle
    let name: String
    let line: String?
    let spokenLine: String?
    let lineIsLoud: Bool
    @ViewBuilder let rings: Rings
    @ViewBuilder let end: End

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            AgentAvatarView(state: .idle, frozenAt: 1, size: Self.avatar, style: style)
                .frame(width: Self.avatar, height: Self.avatar)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.app.body.weight(.medium))
                    .lineLimit(1)
                if let line, !line.isEmpty {
                    Text(line)
                        .font(.app.footnote)
                        .foregroundStyle(lineIsLoud ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                        // A later release is one line, however tight: it shrinks a little rather than breaks.
                        .lineLimit(line.contains("→") ? 1 : 2)
                        .minimumScaleFactor(line.contains("→") ? 0.8 : 1)
                        .accessibilityLabel(spokenLine ?? line)
                }
            }
            Spacer(minLength: Theme.grid)
            rings
            end
            Image(systemName: "chevron.forward")
                .font(.app.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .listRowOnMac()
        .contentShape(.rect)
    }

    private static var avatar: CGFloat { Platform.isMac ? 30 : 36 }
}

// MARK: Rings

/// How much is left of a plan's windows, as small rings: nothing at all where nothing is
/// known, as the panel's limits take no room then. At most four: the page has every one.
struct UsageRings: View {
    let limits: UsageLimits
    let now: Date
    let tint: Color?

    /// Those with something to draw: none for one the agent gave no number for, or past its
    /// reset, where what it said no longer holds and an empty ring would say none is left.
    private var shown: [UsageLimits.Window] {
        Array(limits.windows.filter { $0.left != nil && !$0.hasReset(at: now) }.prefix(4))
    }

    var body: some View {
        if !shown.isEmpty {
            HStack(spacing: Theme.grid * 0.625) {
                ForEach(shown) { window in
                    UsageRing(window: window, now: now, tint: tint)
                }
            }
        }
    }
}

/// What is left of one window: a plain ring, redrawn only as the numbers change (no
/// TimelineView or Canvas, which cost real CPU however little moves), in the agent's colour,
/// red once nearly none is, as the panel's bars.
struct UsageRing: View {
    let window: UsageLimits.Window
    let now: Date
    let tint: Color?
    var size: CGFloat = 24
    var lineWidth: CGFloat = 2.5
    /// In the middle: its short name where it has one that reads clearly, or at a larger size, how much is left.
    var label: String?

    private var left: Double { window.left ?? 0 }

    var body: some View {
        ZStack {
            // Inset by half its width: inside its frame, to line up with what is beside it.
            Circle()
                .inset(by: lineWidth / 2)
                .stroke(.primary.opacity(0.12), lineWidth: lineWidth)
            if left > 0 {
                Circle()
                    .inset(by: lineWidth / 2)
                    .trim(from: 0, to: left / 100)
                    .stroke((left <= 10 ? Color.red : tint ?? .accentColor).opacity(0.8), style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            if let text = label ?? window.shortName {
                Text(text)
                    .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .padding(.horizontal, lineWidth + 1)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.words(for: window, now: now))
    }

    /// "5-hour: 62% left, resets in 2h 17m".
    static func words(for window: UsageLimits.Window, now: Date) -> String {
        var words = "\(window.name): "
        if window.hasReset(at: now) {
            words += "has reset"
        } else if window.isUsedUp {
            words += "used up"
        } else if let left = window.left {
            words += "\(Int(left.rounded()))% left"
        } else {
            words += "not known"
        }
        if let resets = window.resetsAt, resets > now { words += ", resets in \(UsageWindowView.duration(resets.timeIntervalSince(now)))" }
        return words
    }
}
