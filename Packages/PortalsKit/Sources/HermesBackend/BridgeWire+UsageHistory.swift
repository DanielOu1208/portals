import AgentCore
import Foundation

// Token analytics on the wire (docs/plans/2026-11-06-token-analytics.md, section 4):
// `usage.history`, a host's daily totals, and `usage.telemetry`, its switch for the
// anonymous totals. Read leniently: a row that does not fit costs only itself, a field
// this app does not know is passed over, and one left out is zero or not known.

extension BridgeWire.Feature {
    /// `usage.history` says what all coding on the host spent, by day, agent, model and folder.
    public static let usageHistory = "usage_history"
    /// `usage.telemetry` says and sets whether the host sends its anonymous daily totals.
    public static let usageTelemetry = "usage_telemetry"
}

extension BridgeWire.Method {
    public static let usageHistory = "usage.history"
    public static let usageTelemetry = "usage.telemetry"
}

extension BridgeWire {
    /// The host's days, "YYYY-MM-DD", inclusive; at most 400 of them.
    public struct UsageHistoryParams: Encodable, Sendable {
        public var from: String
        public var to: String

        public init(from: String, to: String) {
            self.from = from
            self.to = to
        }
    }

    /// Without `enabled` it only asks.
    public struct UsageTelemetryParams: Encodable, Sendable {
        public var enabled: Bool?

        public init(enabled: Bool?) {
            self.enabled = enabled
        }
    }

    /// A count of tokens: a whole number not below zero; anything else is none.
    private static func count(_ value: JSONValue?) -> Int {
        guard let number = value?.doubleValue, number.isFinite, number > 0 else { return 0 }
        return Int(min(number, 9.0e15).rounded())
    }

    /// One day's row; nil for one without its day or agent.
    public static func usageDayRow(_ value: JSONValue) -> UsageDayRow? {
        guard let day = value["day"]?.stringValue, UsageDay.start(of: day, in: .gmt) != nil,
              let agent = value["agent"]?.stringValue, !agent.isEmpty else { return nil }
        let model = value["model"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "unknown"
        let tokens = UsageTokens(
            input: count(value["input"]), output: count(value["output"]), cacheRead: count(value["cache_read"]),
            cacheWrite: count(value["cache_write"]), cacheWrite1h: count(value["cache_write_1h"]),
            reasoning: count(value["reasoning"]), requests: count(value["requests"])
        )
        let usd = value["usd"]?.doubleValue.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        return UsageDayRow(
            day: day, agent: agent, model: model, folder: value["folder"]?.stringValue ?? "",
            viaPortals: value["via"]?.stringValue == "portals", tokens: tokens, usd: usd
        )
    }

    /// One day's hours; nil for one without its day, agent or hours.
    public static func usageHourRow(_ value: JSONValue) -> UsageHourRow? {
        guard let day = value["day"]?.stringValue, UsageDay.start(of: day, in: .gmt) != nil,
              let agent = value["agent"]?.stringValue, !agent.isEmpty,
              let hours = value["tokens"]?.arrayValue else { return nil }
        return UsageHourRow(day: day, agent: agent, viaPortals: value["via"]?.stringValue == "portals", tokens: hours.map { count($0) })
    }

    /// One limit reading; nil for one without its time, agent, name or percent.
    public static func usageLimitReading(_ value: JSONValue) -> UsageLimitReading? {
        guard let at = value["at"]?.doubleValue, at > 0,
              let agent = value["agent"]?.stringValue, !agent.isEmpty,
              let name = value["name"]?.stringValue, !name.isEmpty,
              let percent = value["percent"]?.doubleValue, percent.isFinite else { return nil }
        let resets = value["resets_at"]?.doubleValue.flatMap { $0 > 0 ? $0 : nil }
        let window = value["window_seconds"]?.doubleValue.flatMap { $0 > 0 ? $0 : nil }
        return UsageLimitReading(
            at: Date(timeIntervalSince1970: at / 1000), agent: agent, name: name, percent: percent,
            resetsAt: resets.map { Date(timeIntervalSince1970: $0) }, windowSeconds: window
        )
    }

    /// What `usage.history` answers.
    public static func usageHistory(_ value: JSONValue) throws -> UsageHistory {
        guard value.objectValue != nil, let days = value["days"]?.arrayValue else {
            throw UsageHistoryError.refused("The host's answer is not its usage.")
        }
        // A zone this device does not know is read as this device's: the days are still the
        // host's, only the hours of the 24 hours may be off.
        let zone = value["time_zone"]?.stringValue.flatMap(TimeZone.init(identifier:)) ?? .current
        let scan = value["scan"]
        let progress = scan?["progress"]?.doubleValue.map { min(max($0, 0), 1) }
        let scannedAt = scan?["scanned_at"]?.doubleValue.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        return UsageHistory(
            timeZone: zone,
            agents: (value["agents"]?.arrayValue ?? []).compactMap(\.stringValue),
            scan: UsageScan(scanning: scan?["scanning"]?.boolValue ?? false, progress: progress, scannedAt: scannedAt),
            days: days.compactMap(usageDayRow),
            hours: (value["hours"]?.arrayValue ?? []).compactMap(usageHourRow),
            limits: (value["limits"]?.arrayValue ?? []).compactMap(usageLimitReading),
            pricesAt: value["prices_at"]?.doubleValue.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        )
    }

    /// What `usage.telemetry` answers.
    public static func usageTelemetry(_ value: JSONValue) throws -> UsageTelemetry {
        guard let enabled = value["enabled"]?.boolValue else {
            throw UsageHistoryError.refused("The host's answer is not its switch for anonymous totals.")
        }
        let lock: UsageTelemetry.Lock? = switch value["locked"]?.stringValue {
        case nil, "": nil
        case "env": .environment
        case let other?: .other(other)
        }
        let last = value["last_sent_day"]?.stringValue
        return UsageTelemetry(enabled: enabled, locked: lock, lastSentDay: last?.isEmpty == false ? last : nil)
    }
}

// MARK: - The backend

extension HermesBackend: UsageHistoryProviding {
    public var readsUsageHistory: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.usageHistory) }
    }

    public var sharesUsageTotals: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.usageTelemetry) }
    }

    /// The host answers from its kept totals; a first read of history goes on apart from it.
    public func usageHistory(from: String, to: String) async throws -> UsageHistory {
        guard offers(BridgeWire.Feature.usageHistory) else { throw UsageHistoryError.unavailable }
        let answer = try await usageCall(BridgeWire.Method.usageHistory, BridgeWire.UsageHistoryParams(from: from, to: to))
        return try BridgeWire.usageHistory(answer)
    }

    public func usageTelemetry(enabled: Bool?) async throws -> UsageTelemetry {
        guard offers(BridgeWire.Feature.usageTelemetry) else { throw UsageHistoryError.unavailable }
        let answer = try await usageCall(BridgeWire.Method.usageTelemetry, BridgeWire.UsageTelemetryParams(enabled: enabled))
        return try BridgeWire.usageTelemetry(answer)
    }

    /// The host's sentence on why not, as a `UsageHistoryError`.
    private func usageCall(_ method: String, _ params: some Encodable & Sendable) async throws -> JSONValue {
        do {
            return try await peer().request(method, params: JSONValue(encoding: params), timeout: .seconds(30))
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode || error.code == -32603 {
            throw UsageHistoryError.refused(error.message)
        }
    }
}
