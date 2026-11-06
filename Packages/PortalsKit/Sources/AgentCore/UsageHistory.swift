import Foundation

// Token analytics (docs/plans/2026-11-06-token-analytics.md): what a host says all coding
// on it spent, read from each agent's own history files, as daily totals. A Portals host's
// `usage_history` and `usage_telemetry`; Settings, Usage adds up every host's
// (`UsageReport`).

/// Tokens by type, each counted once, as the host keeps them.
public struct UsageTokens: Hashable, Sendable {
    /// Input not read from the cache and not written to it.
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    /// Written to the cache, all lifetimes.
    public var cacheWrite: Int
    /// Of `cacheWrite`, written for an hour (priced higher).
    public var cacheWrite1h: Int
    /// Already inside `output`: shown apart, never added twice.
    public var reasoning: Int
    public var requests: Int

    public init(input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, cacheWrite1h: Int = 0, reasoning: Int = 0, requests: Int = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.cacheWrite1h = cacheWrite1h
        self.reasoning = reasoning
        self.requests = requests
    }

    public static let zero = UsageTokens()

    /// Every token once: reasoning is inside output, the hour's cache inside the cache written.
    public var total: Int { input + output + cacheRead + cacheWrite }

    /// How many of `type`.
    public subscript(type: UsageTokenType) -> Int {
        switch type {
        case .input: input
        case .output: output
        case .cacheRead: cacheRead
        case .cacheWrite: cacheWrite
        }
    }

    public static func + (one: UsageTokens, other: UsageTokens) -> UsageTokens {
        UsageTokens(
            input: one.input + other.input, output: one.output + other.output, cacheRead: one.cacheRead + other.cacheRead,
            cacheWrite: one.cacheWrite + other.cacheWrite, cacheWrite1h: one.cacheWrite1h + other.cacheWrite1h,
            reasoning: one.reasoning + other.reasoning, requests: one.requests + other.requests
        )
    }

    public static func += (one: inout UsageTokens, other: UsageTokens) {
        one = one + other
    }

    /// A share of these, each type rounded: a day's rows cut to the part of it in the last
    /// 24 hours (`UsageReport`).
    public func scaled(by share: Double) -> UsageTokens {
        func cut(_ value: Int) -> Int { Int((Double(value) * share).rounded()) }
        return UsageTokens(
            input: cut(input), output: cut(output), cacheRead: cut(cacheRead), cacheWrite: cut(cacheWrite),
            cacheWrite1h: cut(cacheWrite1h), reasoning: cut(reasoning), requests: cut(requests)
        )
    }
}

/// The four kinds of token a price is set for.
public enum UsageTokenType: String, CaseIterable, Hashable, Sendable, Identifiable {
    case input, output, cacheRead, cacheWrite

    public var id: Self { self }

    public var title: String {
        switch self {
        case .input: "Input"
        case .output: "Output"
        case .cacheRead: "Cache read"
        case .cacheWrite: "Cache write"
        }
    }
}

/// A day's totals for one agent, model, folder and whether they went through Portals.
public struct UsageDayRow: Hashable, Sendable {
    /// "YYYY-MM-DD" in the host's time zone.
    public var day: String
    /// The agent's id on the host: `claude`, `codex`, `pi`, `droid`, or one this app does not know yet.
    public var agent: String
    /// As the agent names it; "unknown" when it does not say.
    public var model: String
    /// The folder's path on the host; "" when not known.
    public var folder: String
    public var viaPortals: Bool
    public var tokens: UsageTokens
    /// What the tokens would cost at API prices, as of now; nil for a model with no price.
    public var usd: Double?

    public init(day: String, agent: String, model: String, folder: String, viaPortals: Bool, tokens: UsageTokens, usd: Double?) {
        self.day = day
        self.agent = agent
        self.model = model
        self.folder = folder
        self.viaPortals = viaPortals
        self.tokens = tokens
        self.usd = usd
    }
}

/// A day's tokens by hour of the host's day, all types added.
public struct UsageHourRow: Hashable, Sendable {
    public var day: String
    public var agent: String
    public var viaPortals: Bool
    /// 24 numbers, hour 0 first.
    public var tokens: [Int]

    public init(day: String, agent: String, viaPortals: Bool, tokens: [Int]) {
        self.day = day
        self.agent = agent
        self.viaPortals = viaPortals
        // Exactly 24, whatever came: a short list is padded, a long one cut.
        self.tokens = Array((tokens + Array(repeating: 0, count: 24)).prefix(24))
    }
}

/// One reading of a plan's window, as the host kept it.
public struct UsageLimitReading: Hashable, Sendable {
    public var at: Date
    public var agent: String
    /// "5-hour", "weekly", "weekly Opus".
    public var name: String
    /// 0 to 100.
    public var percent: Double
    public var resetsAt: Date?
    public var windowSeconds: TimeInterval?

    public init(at: Date, agent: String, name: String, percent: Double, resetsAt: Date?, windowSeconds: TimeInterval?) {
        self.at = at
        self.agent = agent
        self.name = name
        self.percent = percent
        self.resetsAt = resetsAt
        self.windowSeconds = windowSeconds
    }
}

/// What the host's reading of history is doing.
public struct UsageScan: Hashable, Sendable {
    /// A first read of everything is under way.
    public var scanning: Bool
    /// 0 to 1 while scanning.
    public var progress: Double?
    public var scannedAt: Date?

    public init(scanning: Bool, progress: Double? = nil, scannedAt: Date? = nil) {
        self.scanning = scanning
        self.progress = progress
        self.scannedAt = scannedAt
    }
}

/// What `usage.history` answers: one host's days.
public struct UsageHistory: Hashable, Sendable {
    /// The host's, which its days are in.
    public var timeZone: TimeZone
    /// The agents whose history the host reads.
    public var agents: [String]
    public var scan: UsageScan
    public var days: [UsageDayRow]
    public var hours: [UsageHourRow]
    public var limits: [UsageLimitReading]
    /// When the host's prices were last brought up to date.
    public var pricesAt: Date?

    public init(
        timeZone: TimeZone, agents: [String], scan: UsageScan = UsageScan(scanning: false), days: [UsageDayRow] = [],
        hours: [UsageHourRow] = [], limits: [UsageLimitReading] = [], pricesAt: Date? = nil
    ) {
        self.timeZone = timeZone
        self.agents = agents
        self.scan = scan
        self.days = days
        self.hours = hours
        self.limits = limits
        self.pricesAt = pricesAt
    }
}

/// A host's switch for the anonymous daily totals it sends (`usage.telemetry`).
public struct UsageTelemetry: Hashable, Sendable {
    /// What keeps the switch from being changed from the app.
    public enum Lock: Hashable, Sendable {
        /// `DO_NOT_TRACK` or `PORTALS_TELEMETRY=0` in the host's environment keeps it off.
        case environment
        /// One this app does not know yet, by the host's word.
        case other(String)
    }

    public var enabled: Bool
    public var locked: Lock?
    /// The last day sent, "YYYY-MM-DD".
    public var lastSentDay: String?

    public init(enabled: Bool, locked: Lock? = nil, lastSentDay: String? = nil) {
        self.enabled = enabled
        self.locked = locked
        self.lastSentDay = lastSentDay
    }
}

public enum UsageHistoryError: LocalizedError, Hashable, Sendable {
    /// The host does not keep usage (Hermes, an older host).
    case unavailable
    /// The host would not, and says why.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host does not keep its usage. Update Portals on it."
        case let .refused(message): message
        }
    }
}

/// A host that says what coding on it spent.
public protocol UsageHistoryProviding: Sendable {
    /// Whether the host keeps usage history, as of the last connection; nil before the first.
    var readsUsageHistory: Bool? { get async }
    /// Whether the host has the switch for its anonymous totals; nil before the first connection.
    var sharesUsageTotals: Bool? { get async }
    /// The days `from` to `to`, "YYYY-MM-DD" in the host's time zone, inclusive.
    func usageHistory(from: String, to: String) async throws -> UsageHistory
    /// The switch as it is, after setting it to `enabled` when that is given.
    func usageTelemetry(enabled: Bool?) async throws -> UsageTelemetry
}

/// "YYYY-MM-DD" days, in a given time zone, as the host's wire says them.
public enum UsageDay {
    private static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar
    }

    /// The day `date` falls on in `zone`.
    public static func string(for date: Date, in zone: TimeZone) -> String {
        let parts = calendar(zone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The start of `day` in `zone`; nil for a string that is no day.
    public static func start(of day: String, in zone: TimeZone) -> Date? {
        let parts = day.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let dayOfMonth = Int(parts[2]),
              (1 ... 12).contains(month), (1 ... 31).contains(dayOfMonth) else { return nil }
        let calendar = calendar(zone)
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: dayOfMonth)),
              calendar.component(.day, from: date) == dayOfMonth else { return nil }
        return date
    }

    /// `day` moved by `offset` days; `day` itself when it is no day.
    public static func adding(_ offset: Int, to day: String, in zone: TimeZone) -> String {
        guard let start = start(of: day, in: zone),
              let moved = calendar(zone).date(byAdding: .day, value: offset, to: start) else { return day }
        return string(for: moved, in: zone)
    }

    /// The hour of the day `date` is in, 0 to 23, in `zone`.
    public static func hour(of date: Date, in zone: TimeZone) -> Int {
        calendar(zone).component(.hour, from: date)
    }

    /// The start of hour `hour` of `day` in `zone`, as the clock there says it: from the
    /// day and the hour, not midnight and the hours gone since, which on a day the clocks
    /// change is an hour off from the change on (the host counts by the clock's hour).
    public static func start(ofHour hour: Int, of day: String, in zone: TimeZone) -> Date? {
        guard (0 ..< 24).contains(hour), let midnight = start(of: day, in: zone) else { return nil }
        let calendar = calendar(zone)
        var parts = calendar.dateComponents([.year, .month, .day], from: midnight)
        parts.hour = hour
        return calendar.date(from: parts)
    }

    /// The start of the hour `date` is in, in `zone`: on the half hour in a zone half an hour off.
    public static func startOfHour(containing date: Date, in zone: TimeZone) -> Date {
        calendar(zone).dateInterval(of: .hour, for: date)?.start ?? Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 3600).rounded(.down) * 3600)
    }
}

/// The agents' names as people know them, for the ids a host gives them.
public enum UsageAgentName {
    public static func of(_ agent: String) -> String {
        switch agent {
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "pi": "Pi"
        case "droid": "Droid"
        case "cursor": "Cursor"
        case "hermes": "Hermes"
        case "opencode": "OpenCode"
        default: agent.prefix(1).uppercased() + agent.dropFirst()
        }
    }

    /// The order agents are listed in when nothing else decides.
    public static let order = ["claude", "codex", "pi", "droid", "cursor", "hermes", "opencode"]

    /// Every agent a host could count, for saying which are not.
    public static let known = order
}
