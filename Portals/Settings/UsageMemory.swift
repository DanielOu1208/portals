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
        await withTaskGroup(of: (HostID, HostUsage).self) { group in
            for (id, provider) in asked {
                let kept = hosts[id] ?? HostUsage()
                group.addTask { (id, await Self.ask(provider, days: days, keeping: kept)) }
            }
            for await (id, usage) in group {
                var usage = usage
                usage.isSettingTelemetry = hosts[id]?.isSettingTelemetry ?? false
                hosts[id] = usage
            }
        }
    }

    private nonisolated static func ask(_ provider: any UsageHistoryProviding, days: (from: String, to: String), keeping kept: HostUsage) async -> HostUsage {
        var usage = kept
        guard await provider.readsUsageHistory != false else {
            return HostUsage(keepsUsage: false)
        }
        usage.keepsUsage = true
        do {
            usage.history = try await provider.usageHistory(from: days.from, to: days.to)
            usage.problem = nil
        } catch {
            usage.problem = error.localizedDescription
        }
        if await provider.sharesUsageTotals == true {
            usage.telemetry = try? await provider.usageTelemetry(enabled: nil)
        }
        return usage
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
