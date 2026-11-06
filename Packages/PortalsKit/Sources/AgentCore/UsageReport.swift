import Foundation

// Settings, Usage (docs/plans/2026-11-06-token-analytics.md, section 5): every host's
// `usage.history` added up for a range, on all Macs or one. The hosts keep days in their
// own time zones; a range is counted on each host in its own days, so "7 days" is each
// host's last seven, today included.

/// How far back the page looks.
public enum UsageRange: String, CaseIterable, Hashable, Sendable, Identifiable {
    case day, week, month, quarter

    public var id: Self { self }

    /// Days counted, today included: the 24 hours reach into yesterday.
    public var days: Int {
        switch self {
        case .day: 1
        case .week: 7
        case .month: 30
        case .quarter: 90
        }
    }

    public var title: String {
        switch self {
        case .day: "24 Hours"
        case .week: "7 Days"
        case .month: "30 Days"
        case .quarter: "90 Days"
        }
    }

    /// The days to ask every host for: enough for the longest range in any time zone, so
    /// changing the range asks nothing again.
    public static func askedDays(now: Date = .now, in zone: TimeZone = .current) -> (from: String, to: String) {
        let today = UsageDay.string(for: now, in: zone)
        return (UsageDay.adding(-(quarter.days + 1), to: today, in: zone), UsageDay.adding(1, to: today, in: zone))
    }
}

/// One host's answer, with the name the app gives the host.
public struct UsageSource: Hashable, Sendable {
    public var host: HostID
    public var name: String
    public var history: UsageHistory

    public init(host: HostID, name: String, history: UsageHistory) {
        self.host = host
        self.name = name
        self.history = history
    }
}

/// The usage of one agent, model, folder or Mac over the range.
public struct UsageSlice: Hashable, Sendable, Identifiable {
    /// The agent's id, the model's or folder's name as the host says it, the host's id.
    public var id: String
    /// What to call it: the agent's name, the folder's last part, the Mac's name.
    public var name: String
    public var tokens: UsageTokens
    /// At API prices, of the priced tokens.
    public var usd: Double
    /// Tokens of models with no price, which `usd` leaves out.
    public var unpricedTokens: Int
    /// Of all tokens in the range, 0 to 1.
    public var share: Double
}

/// Tokens an agent spent in one day of the range, or one hour of the 24 hours.
public struct UsagePoint: Hashable, Sendable, Identifiable {
    public var agent: String
    /// The start of the day (on this device) or of the hour.
    public var date: Date
    public var tokens: Int

    public var id: String { "\(agent) \(date.timeIntervalSince1970)" }
}

/// Tokens an agent spends in one hour of an average day of the range.
public struct UsageSpreadPoint: Hashable, Sendable, Identifiable {
    public var agent: String
    /// 0 to 23, of the host's day.
    public var hour: Int
    public var tokens: Double

    public var id: String { "\(agent) \(hour)" }
}

/// What one type of token costs over the range.
public struct UsageTypeCost: Hashable, Sendable, Identifiable {
    public var type: UsageTokenType
    public var tokens: Int
    /// An estimate: the host prices each day's row as a whole, and the app splits it by
    /// the usual ratios of the types' prices (`UsageReport.typeWeights`).
    public var usd: Double

    public var id: UsageTokenType { type }
}

/// A plan's window as last read, and how fast it is being used.
public struct UsageLimitPace: Hashable, Sendable, Identifiable {
    public var agent: String
    public var name: String
    /// Of the window, 0 to 100, as of `readAt`.
    public var percent: Double
    public var readAt: Date
    public var resetsAt: Date?
    public var windowSeconds: TimeInterval?
    /// How much of the window has passed by now, 0 to 1: where the pace mark goes. nil
    /// without the window's length or reset.
    public var passed: Double?
    /// The window started again after the reading, which says nothing of it any more.
    public var hasReset: Bool
    /// When it runs out at the rate so far; nil when it lasts until the reset, or no rate
    /// can be told.
    public var runsOutAt: Date?
    /// The host it was read on, and its name, when another host read a window of the same
    /// name that is not this one (another account): nil when it is shown once.
    public var host: HostID?
    public var hostName: String?

    public var id: String { "\(agent) \(name)\(host.map { " \($0.rawValue)" } ?? "")" }

    /// Points under an even pace by now: in reserve when positive, over pace when negative.
    public var reserve: Double? {
        passed.map { $0 * 100 - percent }
    }

    /// Used faster than the window passes.
    public var isOverPace: Bool {
        (reserve ?? 0) < 0
    }

    public var isUsedUp: Bool { percent >= 100 && !hasReset }

    /// The share of a window that must have gone, at the reading, before a rate is told.
    static let earliest = 0.02

    /// `reading` against the time now.
    public init(_ reading: UsageLimitReading, now: Date) {
        agent = reading.agent
        name = reading.name
        percent = min(max(reading.percent, 0), 100)
        readAt = reading.at
        resetsAt = reading.resetsAt
        windowSeconds = reading.windowSeconds ?? Self.windowSeconds(named: reading.name)
        hasReset = resetsAt.map { $0 <= now } ?? false
        passed = nil
        runsOutAt = nil
        guard let resetsAt, let window = windowSeconds, window > 0, !hasReset else { return }
        passed = min(max(1 - resetsAt.timeIntervalSince(now) / window, 0), 1)
        // The rate is the reading's own: used so far over the time gone in the window when
        // it was read, not since, which would make an old reading look slower than it is.
        let elapsed = window - resetsAt.timeIntervalSince(reading.at)
        guard percent > 0, percent < 100, elapsed >= window * Self.earliest else { return }
        let toEmpty = (100 - percent) / (percent / elapsed)
        let out = reading.at.addingTimeInterval(toEmpty)
        if out < resetsAt { runsOutAt = out }
    }

    /// The length of a window a host gave no length for, by its name.
    static func windowSeconds(named name: String) -> TimeInterval? {
        let lower = name.lowercased()
        let parts = lower.split(separator: "-")
        if parts.count == 2, let count = Double(parts[0]) {
            if parts[1].hasPrefix("hour") { return count * 3600 }
            if parts[1].hasPrefix("day") { return count * 86400 }
        }
        if lower.hasPrefix("weekly") { return 7 * 86400 }
        if lower.hasPrefix("daily") { return 86400 }
        if lower.hasPrefix("monthly") { return 30 * 86400 }
        return nil
    }
}

/// Every host's usage added up, for a range and all Macs or one.
public struct UsageReport: Hashable, Sendable {
    public var range: UsageRange
    public var totals: UsageTokens
    /// At API prices: an estimate, not the bill.
    public var usd: Double
    /// Tokens of models with no price, which `usd` leaves out.
    public var unpricedTokens: Int
    /// Tokens that went through Portals.
    public var portalsTokens: Int
    /// The agents with any tokens, most first.
    public var agents: [String]
    public var byAgent: [UsageSlice]
    public var byModel: [UsageSlice]
    public var byFolder: [UsageSlice]
    public var byHost: [UsageSlice]
    public var costByType: [UsageTypeCost]
    /// Tokens a day by agent over the range, every day of it (an hour of the 24 hours for
    /// that range), a day with none at 0.
    public var series: [UsagePoint]
    /// Tokens by hour of an average day of the range, by agent.
    public var spread: [UsageSpreadPoint]
    /// The latest reading of each agent's windows.
    public var limits: [UsageLimitPace]
    /// The agents whose history is read, on the hosts counted.
    public var counted: [String]

    public var isEmpty: Bool { totals.total == 0 }

    /// Of the tokens read as input, the share read from the cache; nil with none.
    public var cacheHitRate: Double? {
        let all = totals.input + totals.cacheRead + totals.cacheWrite
        return all > 0 ? Double(totals.cacheRead) / Double(all) : nil
    }

    /// The share of all tokens that went through Portals; nil with none.
    public var portalsShare: Double? {
        totals.total > 0 ? Double(portalsTokens) / Double(totals.total) : nil
    }

    /// The agents a host could count that none of the hosts counted reads.
    public var notCounted: [String] {
        UsageAgentName.known.filter { !counted.contains($0) }
    }

    /// `sources` added up for `range`, all of them or only `host`'s; `calendar` lays the
    /// chart's days out as this device has them.
    public init(sources: [UsageSource], range: UsageRange, host: HostID? = nil, now: Date = .now, calendar: Calendar = .current) {
        self.range = range
        let chosen = sources.filter { host == nil || $0.host == host }

        var rows: [(source: UsageSource, row: UsageDayRow)] = []
        var byDay: [String: [String: Int]] = [:]
        /// The 24 hours' tokens by agent, by how many hours before the hour in progress
        /// each began: 0 is the hour in progress, 23 the first of the 24.
        var byHoursBack: [Int: [String: Int]] = [:]
        /// The start of the hour in progress on the first host counted: the last point.
        var lastHour: Date?
        var hourSums: [String: [Double]] = [:]

        for source in chosen {
            let history = source.history
            let zone = history.timeZone
            let today = UsageDay.string(for: now, in: zone)
            if range == .day {
                // The last 24 hours: the hour in progress on the host and the 23 before it,
                // each hour placed by when it began there, so a host half an hour off, or
                // on a day its clocks change, still has 24 and draws each where it was.
                let yesterday = UsageDay.adding(-1, to: today, in: zone)
                let hourNow = UsageDay.hour(of: now, in: zone)
                let current = UsageDay.startOfHour(containing: now, in: zone)
                if lastHour == nil { lastHour = current }
                func hoursBack(_ hour: Int, of day: String) -> Int? {
                    guard let start = UsageDay.start(ofHour: hour, of: day, in: zone) else { return nil }
                    let back = Int((current.timeIntervalSince(start) / 3600).rounded(.down))
                    return (0 ..< 24).contains(back) ? back : nil
                }
                var shares: [String: Double] = [:]
                for hours in history.hours where hours.day == today || hours.day == yesterday {
                    let all = hours.tokens.reduce(0, +)
                    var within = 0
                    for hour in 0 ..< 24 where hours.tokens[hour] > 0 {
                        guard let back = hoursBack(hour, of: hours.day) else { continue }
                        within += hours.tokens[hour]
                        byHoursBack[back, default: [:]][hours.agent, default: 0] += hours.tokens[hour]
                        hourSums[hours.agent, default: Array(repeating: 0, count: 24)][hour] += Double(hours.tokens[hour])
                    }
                    shares[Self.key(hours.day, hours.agent, hours.viaPortals)] = all > 0 ? Double(within) / Double(all) : nil
                }
                for row in history.days where row.day == today || row.day == yesterday {
                    // A day's rows are cut to the share of its tokens the hours put in the
                    // window; without hours, today whole and yesterday by the hours left.
                    let share = shares[Self.key(row.day, row.agent, row.viaPortals)]
                        ?? (row.day == today ? 1 : Double(23 - hourNow) / 24)
                    guard share > 0 else { continue }
                    var cut = row
                    cut.tokens = row.tokens.scaled(by: share)
                    cut.usd = row.usd.map { $0 * share }
                    rows.append((source, cut))
                }
            } else {
                let from = UsageDay.adding(-(range.days - 1), to: today, in: zone)
                for row in history.days where row.day >= from && row.day <= today {
                    rows.append((source, row))
                    byDay[row.day, default: [:]][row.agent, default: 0] += row.tokens.total
                }
                for hours in history.hours where hours.day >= from && hours.day <= today {
                    for hour in 0 ..< 24 where hours.tokens[hour] > 0 {
                        hourSums[hours.agent, default: Array(repeating: 0, count: 24)][hour] += Double(hours.tokens[hour])
                    }
                }
            }
        }

        var totals = UsageTokens.zero
        var usd = 0.0
        var unpriced = 0
        var portals = 0
        var typeTokens: [UsageTokenType: Int] = [:]
        var typeCost: [UsageTokenType: Double] = [:]
        for (_, row) in rows {
            totals += row.tokens
            if let cost = row.usd {
                usd += cost
                for (type, part) in Self.split(cost, of: row) { typeCost[type, default: 0] += part }
            } else {
                unpriced += row.tokens.total
            }
            if row.viaPortals { portals += row.tokens.total }
            for type in UsageTokenType.allCases { typeTokens[type, default: 0] += row.tokens[type] }
        }
        self.totals = totals
        self.usd = usd
        unpricedTokens = unpriced
        portalsTokens = portals
        costByType = UsageTokenType.allCases.map { UsageTypeCost(type: $0, tokens: typeTokens[$0] ?? 0, usd: typeCost[$0] ?? 0) }

        let all = totals.total
        byAgent = Self.slices(rows, all: all, key: { $0.row.agent }, name: UsageAgentName.of)
        byModel = Self.slices(rows, all: all, key: { $0.row.model }, name: { $0 })
        byFolder = Self.slices(rows, all: all, key: { $0.row.folder }, name: Self.folderName)
        let names = Dictionary(chosen.map { ($0.host.rawValue, $0.name) }) { first, _ in first }
        byHost = Self.slices(rows, all: all, key: { $0.source.host.rawValue }, name: { names[$0] ?? $0 })

        // Every agent with tokens in the range, those the chart draws, most first.
        let drawn = Set(byDay.values.flatMap(\.keys)).union(byHoursBack.values.flatMap(\.keys)).union(byAgent.map(\.id))
        let ranked = byAgent.map(\.id)
        let agents = ranked + drawn.subtracting(ranked).sorted(by: Self.agentOrder)
        self.agents = agents

        if range == .day {
            let last = lastHour ?? UsageDay.startOfHour(containing: now, in: calendar.timeZone)
            series = (0 ..< 24).flatMap { index -> [UsagePoint] in
                let back = 23 - index
                let start = last.addingTimeInterval(-Double(back) * 3600)
                return agents.map { UsagePoint(agent: $0, date: start, tokens: byHoursBack[back]?[$0] ?? 0) }
            }
        } else {
            // This device's days of the range, and any day a host a zone ahead is in already.
            let here = calendar.timeZone
            let today = UsageDay.string(for: now, in: here)
            var days = Set((0 ..< range.days).map { UsageDay.adding(-$0, to: today, in: here) })
            days.formUnion(byDay.keys)
            series = days.sorted().flatMap { day -> [UsagePoint] in
                guard let start = UsageDay.start(of: day, in: here) else { return [] }
                return agents.map { UsagePoint(agent: $0, date: start, tokens: byDay[day]?[$0] ?? 0) }
            }
        }
        spread = agents.flatMap { agent in
            (0 ..< 24).map { UsageSpreadPoint(agent: agent, hour: $0, tokens: (hourSums[agent]?[$0] ?? 0) / Double(range.days)) }
        }

        limits = Self.limits(of: chosen, now: now)

        var counted = Set(chosen.flatMap(\.history.agents))
        counted.formUnion(agents)
        self.counted = counted.sorted(by: Self.agentOrder)
    }

    // MARK: Helpers

    private static func key(_ day: String, _ agent: String, _ viaPortals: Bool) -> String {
        "\(day) \(agent) \(viaPortals)"
    }

    /// The name a folder is shown by: its last part.
    public static func folderName(_ path: String) -> String {
        let trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        guard !trimmed.isEmpty else { return "No folder" }
        return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    }

    /// Known agents in their usual order, then the rest by name.
    static func agentOrder(_ one: String, _ other: String) -> Bool {
        let first = UsageAgentName.order.firstIndex(of: one) ?? Int.max
        let second = UsageAgentName.order.firstIndex(of: other) ?? Int.max
        return first == second ? one < other : first < second
    }

    /// The shortest window first: the one that runs out soonest is the one to watch.
    private static func windowOrder(_ one: UsageLimitPace, _ other: UsageLimitPace) -> Bool {
        let first = one.windowSeconds ?? .infinity
        let second = other.windowSeconds ?? .infinity
        if first != second { return first < second }
        return one.name == other.name ? (one.hostName ?? "") < (other.hostName ?? "") : one.name < other.name
    }

    /// The latest reading of each window on each host. Hosts signed in to one account read
    /// the same windows: a reading another host made later, with the same reset and no less
    /// used, is the same window read again, and only the later is kept. What is left of one
    /// name on more than one host is another account's, and says which host it is.
    static func limits(of sources: [UsageSource], now: Date) -> [UsageLimitPace] {
        var latest: [String: (source: UsageSource, reading: UsageLimitReading)] = [:]
        for source in sources {
            for reading in source.history.limits {
                let key = "\(source.host.rawValue) \(reading.agent) \(reading.name)"
                if latest[key].map({ $0.reading.at < reading.at }) ?? true { latest[key] = (source, reading) }
            }
        }
        var paces: [UsageLimitPace] = []
        for group in Dictionary(grouping: latest.values, by: { "\($0.reading.agent) \($0.reading.name)" }).values {
            var kept: [(source: UsageSource, reading: UsageLimitReading)] = []
            for entry in group.sorted(by: { $0.reading.at > $1.reading.at }) {
                let again = kept.contains { later in
                    later.reading.resetsAt == entry.reading.resetsAt
                        && (later.reading.resetsAt == nil ? later.reading.percent == entry.reading.percent : later.reading.percent >= entry.reading.percent)
                }
                if !again { kept.append(entry) }
            }
            // A window that started again since it was read says nothing beside one read since.
            let current = kept.filter { $0.reading.resetsAt.map { $0 > now } ?? true }
            if !current.isEmpty { kept = current }
            for entry in kept {
                var pace = UsageLimitPace(entry.reading, now: now)
                if kept.count > 1 {
                    pace.host = entry.source.host
                    pace.hostName = entry.source.name
                }
                paces.append(pace)
            }
        }
        return paces.sorted { $0.agent == $1.agent ? windowOrder($0, $1) : agentOrder($0.agent, $1.agent) }
    }

    private static func slices(
        _ rows: [(source: UsageSource, row: UsageDayRow)], all: Int,
        key: ((source: UsageSource, row: UsageDayRow)) -> String, name: (String) -> String
    ) -> [UsageSlice] {
        var grouped: [String: (tokens: UsageTokens, usd: Double, unpriced: Int)] = [:]
        for entry in rows {
            var slice = grouped[key(entry)] ?? (.zero, 0, 0)
            slice.tokens += entry.row.tokens
            if let usd = entry.row.usd { slice.usd += usd } else { slice.unpriced += entry.row.tokens.total }
            grouped[key(entry)] = slice
        }
        return grouped
            .map { id, slice in
                UsageSlice(id: id, name: name(id), tokens: slice.tokens, usd: slice.usd, unpricedTokens: slice.unpriced,
                           share: all > 0 ? Double(slice.tokens.total) / Double(all) : 0)
            }
            .filter { $0.tokens.total > 0 }
            .sorted { $0.tokens.total == $1.tokens.total ? $0.id < $1.id : $0.tokens.total > $1.tokens.total }
    }

    /// The usual prices of a model's types against its input's: Anthropic's (output 5
    /// times, cache read a tenth, cache write 1.25 times, the hour's twice) and OpenAI's
    /// (output 8 times, cache read a tenth, nothing to write). Only to split a row's dollars
    /// by type; the dollars themselves are the host's.
    static func typeWeights(model: String, agent: String) -> (input: Double, output: Double, cacheRead: Double, cacheWrite: Double, cacheWrite1h: Double) {
        let lower = model.lowercased()
        let openAI = lower.hasPrefix("gpt") || lower.hasPrefix("o3") || lower.hasPrefix("o4") || lower.contains("codex")
            || (agent == "codex" && !lower.contains("claude"))
        return openAI ? (1, 8, 0.1, 1, 1) : (1, 5, 0.1, 1.25, 2)
    }

    /// `usd` of `row` split by type of token.
    static func split(_ usd: Double, of row: UsageDayRow) -> [(UsageTokenType, Double)] {
        let weight = typeWeights(model: row.model, agent: row.agent)
        let tokens = row.tokens
        let shortWrite = max(tokens.cacheWrite - tokens.cacheWrite1h, 0)
        let parts: [(UsageTokenType, Double)] = [
            (.input, Double(tokens.input) * weight.input),
            (.output, Double(tokens.output) * weight.output),
            (.cacheRead, Double(tokens.cacheRead) * weight.cacheRead),
            (.cacheWrite, Double(shortWrite) * weight.cacheWrite + Double(min(tokens.cacheWrite1h, tokens.cacheWrite)) * weight.cacheWrite1h),
        ]
        let sum = parts.reduce(0) { $0 + $1.1 }
        guard sum > 0 else { return [(.input, usd)] }
        return parts.map { ($0.0, usd * $0.1 / sum) }
    }
}
