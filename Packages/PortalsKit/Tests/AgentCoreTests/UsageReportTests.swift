import Foundation
import Testing
@testable import AgentCore

/// Settings, Usage's sums (`UsageReport`): a range is each host's own last days, the 24
/// hours come from the hours, several hosts add up or one is picked, dollars leave out
/// unpriced models and count their tokens, and a limit's pace is told from its last reading.
@Suite struct UsageReportTests {
    private static let london = TimeZone(identifier: "Europe/London")!
    private static let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    /// 2026-11-05 15:30 in London (GMT in November).
    private static let now = Date(timeIntervalSince1970: 1_793_892_600)

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = london
        return calendar
    }

    private static func row(
        _ day: String, _ agent: String = "claude", model: String = "claude-opus-5-5", folder: String = "/Users/dana/code/app",
        portals: Bool = false, input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite: Int = 0, usd: Double? = 1
    ) -> UsageDayRow {
        UsageDayRow(
            day: day, agent: agent, model: model, folder: folder, viaPortals: portals,
            tokens: UsageTokens(input: input, output: output, cacheRead: cacheRead, cacheWrite: cacheWrite, requests: 1), usd: usd
        )
    }

    private static func source(_ id: String, _ name: String, zone: TimeZone = london, days: [UsageDayRow], hours: [UsageHourRow] = [], limits: [UsageLimitReading] = []) -> UsageSource {
        UsageSource(host: HostID(rawValue: id), name: name, history: UsageHistory(timeZone: zone, agents: ["claude", "codex"], days: days, hours: hours, limits: limits))
    }

    private static func report(_ sources: [UsageSource], _ range: UsageRange, host: String? = nil) -> UsageReport {
        UsageReport(sources: sources, range: range, host: host.map { HostID(rawValue: $0) }, now: now, calendar: calendar)
    }

    @Test func daysAreReadInTheHostsZone() {
        #expect(UsageDay.string(for: Self.now, in: Self.london) == "2026-11-05")
        #expect(UsageDay.string(for: Self.now, in: Self.tokyo) == "2026-11-06")
        #expect(UsageDay.adding(-6, to: "2026-11-05", in: Self.london) == "2026-10-30")
        #expect(UsageDay.adding(1, to: "2026-12-31", in: Self.london) == "2027-01-01")
        #expect(UsageDay.hour(of: Self.now, in: Self.london) == 15)
        for odd in ["2026-13-01", "2026-02-30", "26-11-05", "yesterday", ""] {
            #expect(UsageDay.start(of: odd, in: Self.london) == nil, "\(odd)")
        }
    }

    @Test func aRangeCountsItsDaysTodayIncluded() {
        let mac = Self.source("mac", "MacBook", days: [
            Self.row("2026-11-05", input: 10), Self.row("2026-10-30", input: 100), Self.row("2026-10-29", input: 1000),
            Self.row("2026-08-08", input: 10000), Self.row("2026-08-07", input: 100_000),
        ])
        #expect(Self.report([mac], .week).totals.input == 110)
        #expect(Self.report([mac], .month).totals.input == 1110)
        #expect(Self.report([mac], .quarter).totals.input == 11110)
        // Seven days drawn, each agent at each, a day with none at 0.
        let week = Self.report([mac], .week)
        #expect(week.series.count == 7)
        #expect(week.series.map(\.tokens) == [100, 0, 0, 0, 0, 0, 10])
        #expect(week.series.first?.date == UsageDay.start(of: "2026-10-30", in: Self.london))
    }

    @Test func aHostAheadCountsItsOwnToday() {
        // Already 6 November in Tokyo: its week is 31 October to 6 November.
        let tokyo = Self.source("tokyo", "Studio", zone: Self.tokyo, days: [
            Self.row("2026-11-06", input: 1), Self.row("2026-10-31", input: 10), Self.row("2026-10-30", input: 100),
        ])
        let week = Self.report([tokyo], .week)
        #expect(week.totals.input == 11)
        // Its day ahead is drawn too.
        #expect(week.series.last?.date == UsageDay.start(of: "2026-11-06", in: Self.london))
    }

    @Test func theTwentyFourHoursComeFromTheHours() {
        // Now is 15:30: today's hours 0 to 15, and yesterday's 16 to 23.
        var today = Array(repeating: 0, count: 24)
        today[9] = 300
        today[15] = 100
        var yesterday = Array(repeating: 0, count: 24)
        yesterday[10] = 600
        yesterday[20] = 200
        let mac = Self.source("mac", "MacBook", days: [
            Self.row("2026-11-05", input: 400, usd: 4),
            Self.row("2026-11-04", input: 800, usd: 8),
            Self.row("2026-11-03", input: 5000),
        ], hours: [
            UsageHourRow(day: "2026-11-05", agent: "claude", viaPortals: false, tokens: today),
            UsageHourRow(day: "2026-11-04", agent: "claude", viaPortals: false, tokens: yesterday),
        ])
        let day = Self.report([mac], .day)
        // All of today, and a quarter of yesterday (200 of its 800 after 15:00).
        #expect(day.totals.input == 600)
        #expect(abs(day.usd - 6) < 0.0001)
        #expect(day.series.count == 24)
        #expect(day.series.reduce(0) { $0 + $1.tokens } == 600)
        let start = UsageDay.start(ofHour: 9, of: "2026-11-05", in: Self.london)!
        #expect(day.series.first { $0.date == start }?.tokens == 300)
        // The first hour drawn is 16:00 yesterday, the last this one.
        #expect(day.series.first?.date == UsageDay.start(ofHour: 16, of: "2026-11-04", in: Self.london))
        #expect(day.series.last?.date == UsageDay.start(ofHour: 15, of: "2026-11-05", in: Self.london))
        // An average day of one.
        #expect(day.spread.first { $0.hour == 20 }?.tokens == 200)
        #expect(day.spread.first { $0.hour == 10 }?.tokens == 0)
    }

    @Test func anAverageDaySpreadsTheRangesHours() {
        var hours = Array(repeating: 0, count: 24)
        hours[10] = 700
        let mac = Self.source("mac", "MacBook", days: [Self.row("2026-11-04", input: 700)], hours: [
            UsageHourRow(day: "2026-11-04", agent: "claude", viaPortals: true, tokens: hours),
            UsageHourRow(day: "2026-11-03", agent: "claude", viaPortals: false, tokens: hours),
        ])
        let week = Self.report([mac], .week)
        #expect(week.spread.first { $0.agent == "claude" && $0.hour == 10 }?.tokens == 200)
        #expect(week.spread.count == 24)
    }

    @Test func hostsAddUpOrOneIsPicked() {
        let one = Self.source("one", "MacBook", days: [
            Self.row("2026-11-05", model: "claude-opus-5-5", folder: "/Users/dana/code/app", portals: true, input: 600, usd: 3),
            Self.row("2026-11-05", "codex", model: "gpt-5.5-codex", folder: "/Users/dana/code/site/", input: 200, usd: 1),
        ])
        let two = Self.source("two", "Mac mini", days: [
            Self.row("2026-11-04", model: "claude-opus-5-5", folder: "/Users/dana/code/app", input: 200, usd: 1),
        ])
        let all = Self.report([one, two], .week)
        #expect(all.totals.input == 1000)
        #expect(all.byHost.map(\.name) == ["MacBook", "Mac mini"])
        #expect(all.byHost.map(\.share) == [0.8, 0.2])
        #expect(all.byAgent.map(\.name) == ["Claude Code", "Codex"])
        #expect(all.agents == ["claude", "codex"])
        #expect(all.byModel.first?.id == "claude-opus-5-5")
        #expect(all.byModel.first?.tokens.input == 800)
        #expect(all.byFolder.map(\.name) == ["app", "site"])
        #expect(all.portalsShare == 0.6)
        let picked = Self.report([one, two], .week, host: "two")
        #expect(picked.totals.input == 200)
        #expect(picked.byHost.map(\.name) == ["Mac mini"])
        #expect(picked.portalsShare == 0)
    }

    @Test func dollarsLeaveOutUnpricedModelsAndCountTheirTokens() {
        let mac = Self.source("mac", "MacBook", days: [
            Self.row("2026-11-05", input: 100, output: 50, usd: 2.5),
            Self.row("2026-11-05", "pi", model: "kimi-k3", input: 400, output: 100, usd: nil),
            Self.row("2026-11-04", input: 10, usd: 0.25),
        ])
        let week = Self.report([mac], .week)
        #expect(abs(week.usd - 2.75) < 0.0001)
        #expect(week.unpricedTokens == 500)
        let pi = week.byModel.first { $0.id == "kimi-k3" }
        #expect(pi?.usd == 0)
        #expect(pi?.unpricedTokens == 500)
        // The split by type adds up to the priced dollars.
        #expect(abs(week.costByType.reduce(0) { $0 + $1.usd } - 2.75) < 0.0001)
        #expect(week.costByType.first { $0.type == .input }?.tokens == 510)
    }

    @Test func costByTypeFollowsTheUsualPriceRatios() {
        // Anthropic: 1 000 input at 1, 1 000 output at 5, 10 000 cache read at a tenth.
        let parts = UsageReport.split(7, of: Self.row("2026-11-05", input: 1000, output: 1000, cacheRead: 10000))
        let byType = Dictionary(uniqueKeysWithValues: parts)
        #expect(abs((byType[.input] ?? 0) - 1) < 0.0001)
        #expect(abs((byType[.output] ?? 0) - 5) < 0.0001)
        #expect(abs((byType[.cacheRead] ?? 0) - 1) < 0.0001)
        // OpenAI's output is eight times its input.
        let codex = Dictionary(uniqueKeysWithValues: UsageReport.split(9, of: Self.row("2026-11-05", "codex", model: "gpt-5.5-codex", input: 1000, output: 1000)))
        #expect(abs((codex[.output] ?? 0) - 8) < 0.0001)
    }

    @Test func cacheHitRateIsTheCachedShareOfInput() {
        let mac = Self.source("mac", "MacBook", days: [Self.row("2026-11-05", input: 100, output: 999, cacheRead: 800, cacheWrite: 100)])
        #expect(Self.report([mac], .week).cacheHitRate == 0.8)
        #expect(Self.report([], .week).cacheHitRate == nil)
        #expect(Self.report([], .week).isEmpty)
    }

    @Test func theAgentsCountedAreEveryHostsAndTheRestAreNamed() {
        let mac = Self.source("mac", "MacBook", days: [])
        let report = Self.report([mac], .week)
        #expect(report.counted == ["claude", "codex"])
        #expect(report.notCounted == ["pi", "droid", "cursor", "hermes", "opencode"])
    }

    // MARK: Limits

    @Test func theLatestReadingOfEachWindowIsTaken() {
        let old = UsageLimitReading(at: Self.now.addingTimeInterval(-7200), agent: "claude", name: "weekly", percent: 40, resetsAt: Self.now.addingTimeInterval(86400), windowSeconds: 604_800)
        let new = UsageLimitReading(at: Self.now.addingTimeInterval(-600), agent: "claude", name: "weekly", percent: 50, resetsAt: Self.now.addingTimeInterval(86400), windowSeconds: 604_800)
        let short = UsageLimitReading(at: Self.now.addingTimeInterval(-600), agent: "claude", name: "5-hour", percent: 10, resetsAt: Self.now.addingTimeInterval(3600), windowSeconds: nil)
        let one = Self.source("one", "MacBook", days: [], limits: [old, short])
        let two = Self.source("two", "Mac mini", days: [], limits: [new])
        let limits = Self.report([one, two], .week).limits
        #expect(limits.map(\.name) == ["5-hour", "weekly"])
        #expect(limits.last?.percent == 50)
        // A window with no length is known by its name.
        #expect(limits.first?.windowSeconds == 18000)
        #expect(Self.report([one, two], .week, host: "one").limits.last?.percent == 40)
    }

    @Test func paceIsTheShareUsedAgainstTheShareGone() {
        // A week with 2.5 days left: 64% of it gone, 71% used, so over pace; at its rate
        // (71% in 4.5 days) the rest lasts 1.84 days, before the reset.
        let reading = UsageLimitReading(at: Self.now, agent: "claude", name: "weekly", percent: 71, resetsAt: Self.now.addingTimeInterval(2.5 * 86400), windowSeconds: 7 * 86400)
        let pace = UsageLimitPace(reading, now: Self.now)
        #expect(abs((pace.passed ?? 0) - 4.5 / 7) < 0.0001)
        #expect(pace.isOverPace)
        #expect(abs((pace.runsOutAt ?? .distantPast).timeIntervalSince(Self.now) - 29 / (71 / (4.5 * 86400))) < 1)

        // Under pace it lasts until the reset.
        let slow = UsageLimitPace(UsageLimitReading(at: Self.now, agent: "codex", name: "weekly", percent: 30, resetsAt: Self.now.addingTimeInterval(4 * 86400), windowSeconds: 7 * 86400), now: Self.now)
        #expect(!slow.isOverPace)
        #expect(slow.runsOutAt == nil)
        #expect(abs((slow.reserve ?? 0) - (3.0 / 7 * 100 - 30)) < 0.0001)
    }

    @Test func anOldReadingKeepsItsOwnRateAndAResetEndsIt() {
        // Read a day ago, 2 days into the week, at 50%: its rate is the reading's.
        let readAt = Self.now.addingTimeInterval(-86400)
        let resets = readAt.addingTimeInterval(5 * 86400)
        let pace = UsageLimitPace(UsageLimitReading(at: readAt, agent: "claude", name: "weekly", percent: 50, resetsAt: resets, windowSeconds: 7 * 86400), now: Self.now)
        #expect(abs((pace.runsOutAt ?? .distantPast).timeIntervalSince(readAt) - 2 * 86400) < 1)
        #expect(abs((pace.passed ?? 0) - 3.0 / 7) < 0.0001)

        let reset = UsageLimitPace(UsageLimitReading(at: readAt, agent: "claude", name: "5-hour", percent: 100, resetsAt: Self.now.addingTimeInterval(-60), windowSeconds: 18000), now: Self.now)
        #expect(reset.hasReset)
        #expect(reset.passed == nil)
        #expect(reset.runsOutAt == nil)
        #expect(!reset.isUsedUp)

        // Too early in a window to tell a rate; and one without a reset has no pace at all.
        let early = UsageLimitPace(UsageLimitReading(at: Self.now, agent: "claude", name: "weekly", percent: 5, resetsAt: Self.now.addingTimeInterval(7 * 86400 - 600), windowSeconds: 7 * 86400), now: Self.now)
        #expect(early.runsOutAt == nil)
        let unknown = UsageLimitPace(UsageLimitReading(at: Self.now, agent: "claude", name: "included", percent: 5, resetsAt: nil, windowSeconds: nil), now: Self.now)
        #expect(unknown.passed == nil)
        #expect(!unknown.isOverPace)
    }

    @Test func theSampleIsTheSameEachTimeAndDiffersByHost() {
        let first = FakeBackend.sampleUsage(on: HostID(rawValue: "one"), from: "2026-08-01", to: "2026-11-06", now: Self.now)
        let again = FakeBackend.sampleUsage(on: HostID(rawValue: "one"), from: "2026-08-01", to: "2026-11-06", now: Self.now)
        let other = FakeBackend.sampleUsage(on: HostID(rawValue: "two"), from: "2026-08-01", to: "2026-11-06", now: Self.now)
        #expect(first == again)
        #expect(first.days != other.days)
        #expect(!first.days.isEmpty)
        #expect(first.days.allSatisfy { $0.day <= UsageDay.string(for: Self.now, in: .current) })
        let report = UsageReport(sources: [UsageSource(host: HostID(rawValue: "one"), name: "MacBook", history: first)], range: .month, now: Self.now)
        #expect(report.usd > 0)
        #expect(report.unpricedTokens >= 0)
        #expect(report.cacheHitRate.map { $0 > 0.5 } == true)
    }
}
