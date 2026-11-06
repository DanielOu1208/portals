import AgentCore
import SwiftUI

// MARK: Usage

/// What all coding on each host spends (2026-11-06: "track token usage over time and get
/// more detailed insights on spending limits"): every host's usage, read from each agent's
/// own history there, added up for a range, on all hosts or one (`UsageReport`). Tiles, the
/// tokens by agent as lines, the dollars by type of token, the plans' limits with their
/// pace, lists by model, folder and host, and each host's switch for its anonymous totals.
struct UsageSettings: View {
    let fleet: Fleet

    private let memory = UsageMemory.shared
    @State private var range = UsageRange.week
    /// One host's usage, or nil for all of them.
    @State private var picked: HostID?
    /// The chart over an average day of the range, not day by day.
    @State private var overADay = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let sources = memory.sources(in: fleet)
        let shown = picked.flatMap { id in sources.contains { $0.host == id } ? id : nil }
        let report = memory.report(of: sources, range: range, host: shown)
        let colors = UsageColors.colors(for: report.agents, in: fleet)
        ScrollViewReader { scroller in
            Form {
                choices(sources: sources)
                if report.isEmpty {
                    Section {
                        Text(emptyText(sources: sources))
                            .foregroundStyle(.secondary)
                            .listRowOnMac()
                    }
                    .settingsRows()
                } else {
                    Section {
                        UsageTiles(report: report)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)

                    Section {
                        Picker("Shown", selection: $overADay) {
                            Text(range == .day ? "By hour" : "By day").tag(false)
                            Text("Over a day").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .accessibilityIdentifier("usage-chart-kind")
                        UsageLineChart(report: report, overADay: overADay, colors: colors)
                            .padding(.vertical, Theme.grid)
                            .id("chart")
                    } header: {
                        Text("Tokens by agent")
                            .formHeader()
                    } footer: {
                        Text(overADay
                            ? "How an average day of the \(range == .day ? "last 24 hours" : "last \(range.days) days") spreads over its hours, by the hours of each host's own day."
                            : "Every type of token added: input, output and the cache read and written.")
                            .formFooter()
                    }
                    .settingsRows()

                    Section {
                        UsageCostBar(costs: report.costByType, unpricedTokens: report.unpricedTokens)
                            .listRowOnMac()
                            .id("cost")
                    } header: {
                        Text("Cost by token type")
                            .formHeader()
                    } footer: {
                        Text("What the tokens would cost at API prices, split by each type's usual price. Not your bill: a plan charges by the month.")
                            .formFooter()
                    }
                    .settingsRows()
                }

                limits(report, colors: colors)

                if !report.isEmpty {
                    lists(report, colors: colors, showsMacs: shown == nil && sources.count > 1)
                }

                sharing
            }
            .task(id: report.isEmpty) {
                await openForDebug(scroller)
            }
        }
        // Asked only while this page is on screen and can be seen, and again as hosts connect.
        .task(id: Asking(hosts: Set(fleet.hosts.filter(\.isConnected).map(\.id)), isSeen: isSeen)) {
            guard isSeen else { return }
            await memory.keepAsking(fleet)
        }
    }

    /// `PORTALS_DEBUG_USAGE`: a range, the chart over a day, and a part scrolled to.
    private func openForDebug(_ scroller: ScrollViewProxy) async {
        let asked = DebugLaunch.usageView
        guard !asked.isEmpty else { return }
        if let given = UsageRange.allCases.first(where: { asked.contains($0.rawValue) }) { range = given }
        overADay = asked.contains("spread")
        guard let part = ["chart", "cost", "limits", "lists", "sharing"].first(where: asked.contains) else { return }
        try? await Task.sleep(for: .seconds(1))
        scroller.scrollTo(part, anchor: .top)
    }

    /// `items`' rows, the first with `anchor` for its id, for `PORTALS_DEBUG_USAGE` to scroll
    /// to: a form scrolls to a row it knows by an id of its own, not to one a `ForEach` makes.
    @ViewBuilder
    private func anchoredRows<Item: Identifiable, Row: View>(_ items: [Item], anchor: String, @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        if let first = items.first {
            row(first)
                .id(anchor)
            ForEach(items.dropFirst()) { row($0) }
        }
    }

    private var isSeen: Bool { scenePhase != .background && !WindowVisibility.shared.isHidden }

    private struct Asking: Hashable {
        let hosts: Set<HostID>
        let isSeen: Bool
    }

    // MARK: Range and host

    @ViewBuilder
    private func choices(sources: [UsageSource]) -> some View {
        Section {
            Picker("Range", selection: $range) {
                ForEach(UsageRange.allCases) { range in
                    Text(range.title).tag(range)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("usage-range")
            if sources.count > 1 {
                Picker("Host", selection: $picked) {
                    Text("All hosts").tag(HostID?.none)
                    ForEach(sources, id: \.host) { source in
                        Text(source.name).tag(Optional(source.host))
                    }
                }
                .accessibilityIdentifier("usage-mac")
            }
            ForEach(fleet.hosts) { host in
                if let line = statusLine(of: host) {
                    line
                        .listRowOnMac()
                }
            }
        } footer: {
            Text(countedText(sources: sources))
                .formFooter()
        }
        .settingsRows()
    }

    /// What a host's usage is doing, where that is anything but counted: being read for the
    /// first time, not kept by the host, or not to be had now.
    private func statusLine(of host: HostModel) -> AnyView? {
        let usage = memory.hosts[host.id]
        let name = host.host.name
        if let scan = usage?.history?.scan, scan.scanning {
            let progress = scan.progress ?? 0
            return AnyView(VStack(alignment: .leading, spacing: Theme.grid * 0.75) {
                Text("Reading history on \(name)… \(progress.formatted(.percent.precision(.fractionLength(0))))")
                ProgressView(value: progress)
                    .tint(.accentColor)
                Text("Its totals so far are counted; they grow as the rest is read.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine))
        }
        if usage?.keepsUsage == false {
            return AnyView(Label {
                Text(host.runsHermesAlone ? "Hermes on \(name) keeps no usage to show." : "\(name) needs an update to show its usage. Update Portals on it.")
            } icon: {
                Image(systemName: host.runsHermesAlone ? "minus.circle" : "arrow.up.circle")
                    .foregroundStyle(.secondary)
            })
        }
        if !host.isConnected {
            // What it said before it went is still counted: say so, rather than that it is not.
            return AnyView(Text(usage?.history == nil
                ? "\(name) is not connected; its usage shows once it is."
                : "\(name) is not connected; its usage is as it last said.")
                .foregroundStyle(.secondary))
        }
        if let problem = usage?.problem {
            return AnyView(Label("\(name): \(problem)", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary))
        }
        if usage == nil, host.usageProvider != nil {
            return AnyView(HStack(spacing: Theme.grid) {
                ProgressView()
                Text("Asking \(name)…")
                    .foregroundStyle(.secondary)
            })
        }
        return nil
    }

    /// Which agents are counted, and which not yet.
    private func countedText(sources: [UsageSource]) -> String {
        let counted = Set(sources.flatMap(\.history.agents))
        guard !counted.isEmpty else {
            return "All coding on each host is counted, in Portals, the terminal and other apps, from each agent's own history there."
        }
        let names = UsageAgentName.order.filter(counted.contains).map(UsageAgentName.of)
            + counted.subtracting(UsageAgentName.order).sorted().map(UsageAgentName.of)
        let missing = UsageAgentName.known.filter { !counted.contains($0) }.map(UsageAgentName.of)
        let rest = missing.isEmpty ? "" : " Not counted yet: \(missing.formatted(.list(type: .and)))."
        return "Counts \(names.formatted(.list(type: .and))), in Portals, the terminal and other apps, from each agent's own history on the host.\(rest)"
    }

    private func emptyText(sources: [UsageSource]) -> String {
        if fleet.hosts.isEmpty { return "Add a host in Net to see what its agents spend." }
        if sources.isEmpty { return "Usage shows once a host that keeps it is connected." }
        return range == .day ? "No tokens spent in the last 24 hours." : "No tokens spent in the last \(range.days) days."
    }

    // MARK: Limits

    @ViewBuilder
    private func limits(_ report: UsageReport, colors: [String: Color]) -> some View {
        if !report.limits.isEmpty {
            Section {
                anchoredRows(report.limits, anchor: "limits") { pace in
                    UsageLimitRow(pace: pace, color: colors[pace.agent] ?? UsageColors.color(of: pace.agent))
                        .listRowOnMac()
                }
            } header: {
                Text("Limits")
                    .formHeader()
            } footer: {
                Text("Each plan's windows as the agent last told its host. The mark is where an even pace would be by now.")
                    .formFooter()
            }
            .settingsRows()
        }
    }

    // MARK: Lists

    @ViewBuilder
    private func lists(_ report: UsageReport, colors: [String: Color], showsMacs: Bool) -> some View {
        sliceSection("By agent", report.byAgent, anchor: "lists") { colors[$0.id] ?? UsageColors.color(of: $0.id) }
        sliceSection("By model", report.byModel) { _ in .accentColor }
        sliceSection("By folder", report.byFolder, help: \.id) { _ in .accentColor }
        if showsMacs {
            sliceSection("By host", report.byHost) { _ in .accentColor }
        }
    }

    private func sliceSection(
        _ title: String, _ slices: [UsageSlice], help: KeyPath<UsageSlice, String>? = nil, anchor: String? = nil,
        color: @escaping (UsageSlice) -> Color
    ) -> some View {
        Section {
            anchoredRows(Array(slices.prefix(Self.longestList)), anchor: anchor ?? "\(title) first") { slice in
                UsageSliceRow(slice: slice, color: color(slice), help: help.map { slice[keyPath: $0] })
                    .listRowOnMac()
            }
            if slices.count > Self.longestList {
                let rest = slices.dropFirst(Self.longestList)
                Text("\(rest.count) more, \(UsageFormat.share(rest.reduce(0) { $0 + $1.share })) of the tokens")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .listRowOnMac()
            }
        } header: {
            Text(title)
                .formHeader()
        }
        .settingsRows()
    }

    private static let longestList = 8

    // MARK: Anonymous totals

    /// The hosts with the switch, each with its own: a host sends its own totals.
    @ViewBuilder
    private var sharing: some View {
        let hosts = fleet.hosts.filter { memory.hosts[$0.id]?.telemetry != nil }
        if !hosts.isEmpty {
            Section {
                anchoredRows(hosts, anchor: "sharing") { host in
                    sharingRow(host, alone: hosts.count == 1)
                }
                Link(destination: Self.whatIsSent) {
                    HStack {
                        Text("What is sent")
                        Spacer(minLength: Theme.grid)
                        Image(systemName: "arrow.up.right")
                            .font(.app.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(.rect)
                }
                .listRowOnMac()
                .accessibilityIdentifier("usage-what-is-sent")
            } header: {
                Text("Anonymous totals")
                    .formHeader()
            } footer: {
                Text("Once a day each host sends the totals of what went through Portals: tokens by agent and model, turns, and how many devices connected. Never prompts, titles, paths, folder names or account details.")
                    .formFooter()
            }
            .settingsRows()
        }
    }

    private func sharingRow(_ host: HostModel, alone: Bool) -> some View {
        let usage = memory.hosts[host.id]
        let telemetry = usage?.telemetry
        let isOn = Binding(
            get: { telemetry?.enabled ?? false },
            set: { on in Task { await memory.setTelemetry(on, on: host) } }
        )
        return VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
            Toggle(alone ? "Share anonymous totals" : "Share \(host.host.name)'s anonymous totals", isOn: isOn)
                .disabled(telemetry?.locked != nil || usage?.isSettingTelemetry == true || !host.isConnected)
                .accessibilityIdentifier("usage-share-\(host.id.rawValue)")
            if let reason = lockedText(telemetry?.locked, host: host.host.name) {
                Text(reason)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            } else if !host.isConnected {
                Text("\(host.host.name) is not connected.")
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .listRowOnMac()
    }

    private func lockedText(_ lock: UsageTelemetry.Lock?, host: String) -> String? {
        switch lock {
        case nil: nil
        case .environment: "Kept off on \(host) by DO_NOT_TRACK or PORTALS_TELEMETRY=0 where it runs."
        case let .other(reason): "Kept off on \(host) (\(reason))."
        }
    }

    /// The README's list of every field sent.
    static let whatIsSent = URL(string: "https://github.com/DanielOu1208/portals#anonymous-usage-totals")!
}

// MARK: Tiles

/// Tokens, dollars, the cache's hit rate and the share through Portals, side by side where
/// there is room, two by two on a phone.
private struct UsageTiles: View {
    let report: UsageReport

    @ScaledMetric(relativeTo: .body) private var narrowest: CGFloat = 150

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: narrowest), spacing: Theme.grid * 1.5)], spacing: Theme.grid * 1.5) {
            UsageTile(
                title: "Tokens", value: UsageFormat.tokens(report.totals.total),
                note: "\(report.totals.requests.formatted()) requests"
            )
            UsageTile(
                title: "API equivalent", value: UsageFormat.dollars(report.usd),
                note: report.unpricedTokens > 0 ? "Not your bill. \(UsageFormat.tokens(report.unpricedTokens)) tokens unpriced" : "Not your bill"
            )
            UsageTile(
                title: "Cache hit rate", value: report.cacheHitRate.map(UsageFormat.share) ?? "–",
                note: "Of input, read from the cache"
            )
            UsageTile(
                title: "Through Portals", value: report.portalsShare.map(UsageFormat.share) ?? "–",
                note: "\(UsageFormat.tokens(report.portalsTokens)) tokens"
            )
        }
    }
}

private struct UsageTile: View {
    let title: String
    let value: String
    let note: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.grid * 0.5) {
            Text(title)
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.app.title2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(note)
                .font(.app.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(Theme.grid * 1.5)
        .background(Self.fill, in: .rect(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    /// As a row of the form is drawn around it.
    private static let fill: Color = Platform.isMac ? SettingsScreen.rowFill : Theme.cardFill
}

// MARK: Colours and numbers

/// The colour each agent is drawn in: the one the app gives it where it has one (its
/// look's, as its avatar wears it), unless another agent drawn has it already; then its
/// maker's usual colour, then one no agent drawn has.
enum UsageColors {
    private static let usual: [String: Color] = [
        "claude": .orange, "codex": .blue, "pi": .purple, "droid": .green, "cursor": .teal, "hermes": .pink, "opencode": .indigo,
    ]
    private static let spare: [Color] = [.mint, .cyan, .brown, .red, .yellow, .gray]

    static func color(of agent: String) -> Color {
        usual[agent] ?? .gray
    }

    static func colors(for agents: [String], in fleet: Fleet) -> [String: Color] {
        var given: [String: Color] = [:]
        var taken: [Color] = []
        // The same order whatever the range, so an agent keeps its colour as it changes.
        let ordered = agents.sorted { (UsageAgentName.order.firstIndex(of: $0) ?? .max, $0) < (UsageAgentName.order.firstIndex(of: $1) ?? .max, $1) }
        for agent in ordered {
            let choices = [lookColor(of: agent, in: fleet), usual[agent]].compactMap { $0 } + spare
            let color = choices.first { !taken.contains($0) } ?? .gray
            given[agent] = color
            taken.append(color)
        }
        return given
    }

    /// The colour of the first agent of this kind on any host, as its look has it; nil for
    /// none, or one in ink.
    private static func lookColor(of agent: String, in fleet: Fleet) -> Color? {
        for host in fleet.hosts {
            guard let found = host.agents.first(where: { ($0.kind ?? $0.id.name) == agent }) else { continue }
            let tint = fleet.look(for: found.id).tint
            return AgentLookCatalogue.tints.indices.contains(tint) ? AgentLookCatalogue.tints[tint].color : nil
        }
        return nil
    }
}

/// How the page writes its numbers.
enum UsageFormat {
    /// "1.2M", "980K", "42".
    static func tokens(_ count: Int) -> String {
        Double(count).formatted(.number.notation(.compactName).precision(.fractionLength(0 ... 1)))
    }

    /// In dollars: cents below a hundred.
    static func dollars(_ usd: Double) -> String {
        usd.formatted(.currency(code: "USD").precision(.fractionLength(usd < 100 ? 2 : 0)))
    }

    /// "64%"; "<1%" for a share too small to round to one.
    static func share(_ share: Double) -> String {
        share > 0 && share < 0.005 ? "<1%" : share.formatted(.percent.precision(.fractionLength(0)))
    }
}
