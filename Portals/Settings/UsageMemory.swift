import AgentCore
import Foundation
import Observation

/// What each host last said of its usage and its switch for anonymous totals, for Settings,
/// Usage (`UsageSettings`). Kept for the app's life, so the page opens on the last answers
/// while it asks again; asked only while the page is on screen.
@MainActor @Observable
final class UsageMemory {
    static let shared = UsageMemory()

    /// One host's, as last asked.
    nonisolated struct HostUsage: Sendable {
        var history: UsageHistory?
        /// The host keeps no usage: nil until asked, false for a host from before it.
        var keepsUsage: Bool?
        var telemetry: UsageTelemetry?
        /// Why the last ask failed, in the host's words or the connection's.
        var problem: String?
        /// The switch is being set.
        var isSettingTelemetry = false
    }

    private(set) var hosts: [HostID: HostUsage] = [:]

    /// Moves on whenever a host's usage changed, so the page's report is built again only then.
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var built: (key: ReportKey, report: UsageReport)?

    private struct ReportKey: Equatable {
        var revision: Int
        var range: UsageRange
        var host: HostID?
        var sources: [HostID]
        var names: [String]
        /// The minute it was built in: the 24 hours move on with the clock.
        var minute: Int
    }

    /// Whether any host is reading its whole history for the first time.
    var isScanning: Bool {
        hosts.values.contains { $0.history?.scan.scanning == true }
    }

    /// The answers of the hosts in `fleet` that have given one, by the names the app gives them.
    func sources(in fleet: Fleet) -> [UsageSource] {
        fleet.hosts.compactMap { host in
            hosts[host.id]?.history.map { UsageSource(host: host.id, name: host.host.name, history: $0) }
        }
    }

    /// `sources` added up for `range`, all of them or `host`'s, built again only when an
    /// answer, the range, the host or the minute changed: the page's body is drawn far more
    /// often than that (each answer, the chart's own switch, the fleet's changes), and a
    /// report of 90 days of several hosts takes a while to add up.
    func report(of sources: [UsageSource], range: UsageRange, host: HostID?, now: Date = .now) -> UsageReport {
        let key = ReportKey(
            revision: revision, range: range, host: host, sources: sources.map(\.host), names: sources.map(\.name),
            minute: Int(now.timeIntervalSince1970 / 60)
        )
        if let built, built.key == key { return built.report }
        let report = UsageReport(sources: sources, range: range, host: host, now: now)
        built = (key, report)
        return report
    }

    /// Asks every connected host of `fleet` again, all at once, until the task is cancelled:
    /// every few seconds while one reads its history for the first time, so its share moves,
    /// and every minute otherwise.
    func keepAsking(_ fleet: Fleet) async {
        while !Task.isCancelled {
            await ask(fleet)
            try? await Task.sleep(for: isScanning ? Self.whileScanning : Self.atRest)
        }
    }

    static let whileScanning: Duration = .seconds(3)
    static let atRest: Duration = .seconds(60)

    func ask(_ fleet: Fleet) async {
        let asked = fleet.hosts.compactMap { host -> (HostID, any UsageHistoryProviding)? in
            guard host.isConnected, let provider = host.usageProvider else { return nil }
            return (host.id, provider)
        }
        let days = UsageRange.askedDays()
        await withTaskGroup(of: (HostID, HostUsage?).self) { group in
            for (id, provider) in asked {
                let kept = hosts[id] ?? HostUsage()
                group.addTask { (id, await Self.ask(provider, days: days, keeping: kept)) }
            }
            for await (id, usage) in group {
                // Cancelled (the page went, or a host came or went): what came back says
                // nothing of the host, and what it said before stays.
                guard var usage, !Task.isCancelled else { continue }
                usage.isSettingTelemetry = hosts[id]?.isSettingTelemetry ?? false
                if usage.history != hosts[id]?.history { revision += 1 }
                hosts[id] = usage
            }
        }
    }

    /// `kept` brought up to date with what the host says; nil when the ask was cancelled.
    private nonisolated static func ask(_ provider: any UsageHistoryProviding, days: (from: String, to: String), keeping kept: HostUsage) async -> HostUsage? {
        var usage = kept
        guard await provider.readsUsageHistory != false else {
            return Task.isCancelled ? nil : HostUsage(keepsUsage: false)
        }
        usage.keepsUsage = true
        do {
            usage.history = try await provider.usageHistory(from: days.from, to: days.to)
            usage.problem = nil
        } catch {
            // A request cancelled with its task fails too, but that is no problem of the host's.
            if error is CancellationError || Task.isCancelled { return nil }
            usage.problem = error.localizedDescription
        }
        // A switch that could not be read this time is shown as it was last read.
        if await provider.sharesUsageTotals == true, let telemetry = try? await provider.usageTelemetry(enabled: nil) {
            usage.telemetry = telemetry
        }
        return Task.isCancelled ? nil : usage
    }

    /// Turns `host`'s anonymous totals on or off; what the host answers is what is shown.
    func setTelemetry(_ enabled: Bool, on host: HostModel) async {
        guard let provider = host.usageProvider else { return }
        hosts[host.id, default: HostUsage()].isSettingTelemetry = true
        defer { hosts[host.id]?.isSettingTelemetry = false }
        do {
            hosts[host.id]?.telemetry = try await provider.usageTelemetry(enabled: enabled)
        } catch {
            hosts[host.id]?.problem = error.localizedDescription
        }
    }
}
