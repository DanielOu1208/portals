import Foundation

// Settings, Usage without a host (`UsageHistoryProviding`): made-up days of a person who
// codes with four agents, the same for a host each time it is asked, different from
// another host's, so the page can be looked at and laid out.

extension FakeBackend {
    /// How the made-up host's usage is told.
    public struct UsageSample: Hashable, Sendable {
        /// A first read of history under way, this far through; nil for one finished.
        public var scanning: Double?
        /// The host keeps no usage: one from before it, which needs an update.
        public var keepsNone: Bool
        /// The host's environment keeps its anonymous totals off (`DO_NOT_TRACK`).
        public var totalsLocked: Bool

        public init(scanning: Double? = nil, keepsNone: Bool = false, totalsLocked: Bool = false) {
            self.scanning = scanning
            self.keepsNone = keepsNone
            self.totalsLocked = totalsLocked
        }
    }

    /// A model of each agent's, with its made-up dollars a million tokens of each type;
    /// nil prices for a model with none.
    private struct SampleModel {
        var agent: String
        var model: String
        /// Of the agent's tokens.
        var share: Double
        var price: (input: Double, output: Double, cacheRead: Double, cacheWrite: Double)?
    }

    private static let sampleModels: [SampleModel] = [
        SampleModel(agent: "claude", model: "claude-opus-5-5", share: 0.8, price: (5, 25, 0.5, 6.25)),
        SampleModel(agent: "claude", model: "claude-sonnet-5", share: 0.2, price: (3, 15, 0.3, 3.75)),
        SampleModel(agent: "codex", model: "gpt-5.5-codex", share: 1, price: (1.25, 10, 0.125, 0)),
        SampleModel(agent: "pi", model: "kimi-k3", share: 1, price: nil),
        SampleModel(agent: "droid", model: "claude-sonnet-5", share: 1, price: (3, 15, 0.3, 3.75)),
    ]

    /// Tokens a working day, by agent, before the day's own swing.
    private static let dailyTokens: [String: Double] = ["claude": 42_000_000, "codex": 18_000_000, "pi": 2_400_000, "droid": 5_000_000]
    /// Of each agent's, what went through Portals.
    private static let portalsShare: [String: Double] = ["claude": 0.7, "codex": 0.5, "pi": 0.3, "droid": 0.35]
    private static let sampleFolders = [("/Users/dana/code/app", 0.55), ("/Users/dana/code/site", 0.3), ("/Users/dana/notes", 0.15)]
    /// How a day's tokens fall over its hours: mornings and afternoons, a little at night.
    private static let dayShape: [Double] = [
        0.2, 0.1, 0, 0, 0, 0, 0.1, 0.3, 1.2, 2.6, 3.4, 3.1, 1.6, 2.2, 3.6, 3.9, 3.3, 2.4, 1.2, 0.8, 1.3, 1.6, 1.1, 0.5,
    ]

    /// A number from 0 to 1 for `text`, the same each time.
    private static func dice(_ text: String) -> Double {
        // FNV-1a: `hashValue` changes from one launch to the next.
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01B3
        }
        hash ^= hash >> 33
        hash = hash &* 0xFF51_AFD7_ED55_8CCD
        hash ^= hash >> 33
        return Double(hash % 10000) / 10000
    }

    /// The made-up history of `host`, `from` to `to` and no later than today.
    public static func sampleUsage(on host: HostID, from: String, to: String, now: Date = .now, sample: UsageSample = UsageSample()) -> UsageHistory {
        let zone = TimeZone.current
        let today = UsageDay.string(for: now, in: zone)
        let last = min(to, today)
        // Each host is used more or less than another, and some run no Pi.
        let scale = 0.35 + dice(host.rawValue) * 0.9
        let agents = dice(host.rawValue + "pi") < 0.5 ? ["claude", "codex", "droid"] : ["claude", "codex", "pi", "droid"]
        var days: [UsageDayRow] = []
        var hours: [UsageHourRow] = []
        var day = max(from, UsageDay.adding(-120, to: today, in: zone))
        let hourNow = UsageDay.hour(of: now, in: zone)
        while day <= last {
            let weekday = UsageDay.start(of: day, in: zone).map { Calendar.current.component(.weekday, from: $0) } ?? 2
            let weekend = weekday == 1 || weekday == 7
            for agent in agents {
                let roll = dice("\(host.rawValue) \(day) \(agent)")
                guard roll > (weekend ? 0.55 : 0.08) else { continue }
                var amount = (dailyTokens[agent] ?? 0) * scale * (0.3 + roll * 1.4) * (weekend ? 0.4 : 1)
                // Today only so far.
                if day == today { amount *= Double(dayShape.prefix(hourNow + 1).reduce(0, +)) / dayShape.reduce(0, +) }
                var counted: [Bool: Int] = [:]
                for model in sampleModels where model.agent == agent {
                    for (folder, folderShare) in sampleFolders {
                        let part = amount * model.share * folderShare * (0.6 + dice("\(day) \(agent) \(folder)") * 0.8)
                        guard part >= 1000 else { continue }
                        let viaPortals = portalsShare[agent] ?? 0
                        for (via, share) in [(true, viaPortals), (false, 1 - viaPortals)] where share > 0 {
                            let made = row(day: day, agent: agent, model: model, folder: folder, viaPortals: via, tokens: part * share)
                            days.append(made)
                            counted[via, default: 0] += made.tokens.total
                        }
                    }
                }
                // The day's tokens spread over its hours, today's only up to now.
                let shown = day == today ? Array(dayShape.prefix(hourNow + 1)) + Array(repeating: 0, count: 23 - hourNow) : dayShape
                let sum = shown.reduce(0, +)
                for (via, total) in counted where sum > 0 && total > 0 {
                    let tokens = shown.enumerated().map { hour, weight in
                        Int(Double(total) * weight / sum * (0.7 + dice("\(day) \(agent) \(hour)") * 0.6))
                    }
                    hours.append(UsageHourRow(day: day, agent: agent, viaPortals: via, tokens: tokens))
                }
            }
            day = UsageDay.adding(1, to: day, in: zone)
        }
        let limits = [
            UsageLimitReading(at: now.addingTimeInterval(-600), agent: "claude", name: "5-hour", percent: 38, resetsAt: now.addingTimeInterval(2 * 3600), windowSeconds: 5 * 3600),
            UsageLimitReading(at: now.addingTimeInterval(-900), agent: "claude", name: "weekly", percent: 71, resetsAt: now.addingTimeInterval(2.5 * 86400), windowSeconds: 7 * 86400),
            UsageLimitReading(at: now.addingTimeInterval(-1200), agent: "codex", name: "5-hour", percent: 12, resetsAt: now.addingTimeInterval(4 * 3600), windowSeconds: 5 * 3600),
            UsageLimitReading(at: now.addingTimeInterval(-1200), agent: "codex", name: "weekly", percent: 30, resetsAt: now.addingTimeInterval(4 * 86400), windowSeconds: 7 * 86400),
        ]
        return UsageHistory(
            timeZone: zone, agents: agents,
            scan: UsageScan(scanning: sample.scanning != nil, progress: sample.scanning, scannedAt: sample.scanning == nil ? now : nil),
            days: days, hours: hours, limits: limits, pricesAt: now.addingTimeInterval(-3 * 3600)
        )
    }

    /// One made-up row of `tokens` in all, most of them read from the cache, as coding is.
    private static func row(day: String, agent: String, model: SampleModel, folder: String, viaPortals: Bool, tokens: Double) -> UsageDayRow {
        let codex = agent == "codex"
        let input = Int(tokens * (codex ? 0.06 : 0.004))
        let output = Int(tokens * (codex ? 0.02 : 0.012))
        let cacheWrite = codex ? 0 : Int(tokens * 0.05)
        let cacheRead = max(Int(tokens) - input - output - cacheWrite, 0)
        let counts = UsageTokens(
            input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite, cacheWrite1h: agent == "claude" ? cacheWrite / 2 : 0,
            reasoning: output / 3, requests: max(Int(tokens / 60000), 1)
        )
        let usd = model.price.map { price in
            (Double(input) * price.input + Double(output) * price.output + Double(cacheRead) * price.cacheRead + Double(cacheWrite) * price.cacheWrite) / 1_000_000
        }
        return UsageDayRow(day: day, agent: agent, model: model.model, folder: folder, viaPortals: viaPortals, tokens: counts, usd: usd)
    }
}

extension FakeBackend: UsageHistoryProviding {
    public var readsUsageHistory: Bool? { !usageSample.keepsNone }
    public var sharesUsageTotals: Bool? { !usageSample.keepsNone }

    public func usageHistory(from: String, to: String) async throws -> UsageHistory {
        guard !usageSample.keepsNone else { throw UsageHistoryError.unavailable }
        return Self.sampleUsage(on: host, from: from, to: to, sample: usageSample)
    }

    public func usageTelemetry(enabled: Bool?) async throws -> UsageTelemetry {
        guard !usageSample.keepsNone else { throw UsageHistoryError.unavailable }
        if usageSample.totalsLocked { return UsageTelemetry(enabled: false, locked: .environment) }
        if let enabled { sharesUsage = enabled }
        let yesterday = UsageDay.adding(-1, to: UsageDay.string(for: .now, in: .current), in: .current)
        return UsageTelemetry(enabled: sharesUsage, lastSentDay: sharesUsage ? yesterday : nil)
    }
}
