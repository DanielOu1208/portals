import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Token analytics on the wire (features `usage_history` and `usage_telemetry`): the
/// answers read as the plan writes them, a row that does not fit costing only itself and
/// fields this app does not know passed over; asked only of a host that lists the feature.
@Suite struct UsageHistoryWireTests {
    /// The answer as docs/plans/2026-11-06-token-analytics.md gives it, with a field from a
    /// later host and rows that do not fit.
    private static let answer: JSONValue = [
        "time_zone": "Europe/London",
        "agents": ["claude", "codex", "pi", "droid"],
        "scan": ["scanning": true, "progress": 0.42, "scanned_at": 1_762_416_000_000],
        "days": [
            ["day": "2026-11-05", "agent": "claude", "model": "claude-opus-5-5", "folder": "/Users/dana/code/app",
             "via": "portals", "input": 1200, "output": 5400, "cache_read": 980_000, "cache_write": 41000,
             "cache_write_1h": 41000, "reasoning": 300, "requests": 61, "usd": 2.41, "later": ["kept": true]],
            ["day": "2026-11-05", "agent": "pi", "model": "", "via": "elsewhere", "input": 10, "usd": .null],
            ["day": "2026-11-04", "agent": "codex", "via": "terminal", "input": -5, "output": 2.6, "usd": -1],
            ["day": "yesterday", "agent": "claude", "input": 1],
            ["agent": "claude", "input": 1],
            "row",
        ],
        "hours": [
            ["day": "2026-11-05", "agent": "claude", "via": "portals", "tokens": [1, 2, 3]],
            ["day": "2026-11-05", "agent": "codex", "via": "elsewhere", "tokens": .array(Array(repeating: 7, count: 30))],
            ["day": "2026-11-05", "agent": "claude"],
        ],
        "limits": [
            ["at": 1_762_416_000_000, "agent": "claude", "name": "weekly", "percent": 62, "resets_at": 1_762_588_800, "window_seconds": 604_800],
            ["at": 1_762_416_000_000, "agent": "codex", "name": "5-hour", "percent": 12],
            ["at": 1_762_416_000_000, "agent": "codex", "name": "5-hour"],
        ],
        "prices_at": 1_762_400_000_000,
    ]

    @Test func theAnswerIsReadAsThePlanWritesIt() throws {
        let history = try BridgeWire.usageHistory(Self.answer)
        #expect(history.timeZone.identifier == "Europe/London")
        #expect(history.agents == ["claude", "codex", "pi", "droid"])
        #expect(history.scan == UsageScan(scanning: true, progress: 0.42, scannedAt: Date(timeIntervalSince1970: 1_762_416_000)))
        #expect(history.pricesAt == Date(timeIntervalSince1970: 1_762_400_000))

        #expect(history.days.count == 3)
        let claude = try #require(history.days.first)
        #expect(claude == UsageDayRow(
            day: "2026-11-05", agent: "claude", model: "claude-opus-5-5", folder: "/Users/dana/code/app", viaPortals: true,
            tokens: UsageTokens(input: 1200, output: 5400, cacheRead: 980_000, cacheWrite: 41000, cacheWrite1h: 41000, reasoning: 300, requests: 61),
            usd: 2.41
        ))
        #expect(claude.tokens.total == 1200 + 5400 + 980_000 + 41000)
        // No model is "unknown", no folder "", no price nil.
        let pi = history.days[1]
        #expect(pi.model == "unknown")
        #expect(pi.folder == "")
        #expect(pi.usd == nil)
        #expect(!pi.viaPortals)
        // A count below zero is none, a fraction rounded; a via this app does not know is
        // not Portals; dollars below zero are none.
        let codex = history.days[2]
        #expect(codex.tokens.input == 0)
        #expect(codex.tokens.output == 3)
        #expect(!codex.viaPortals)
        #expect(codex.usd == nil)
    }

    @Test func hoursAreAlwaysTwentyFour() throws {
        let hours = try BridgeWire.usageHistory(Self.answer).hours
        #expect(hours.count == 2)
        #expect(hours[0].tokens.count == 24)
        #expect(hours[0].tokens.prefix(4) == [1, 2, 3, 0])
        #expect(hours[0].viaPortals)
        #expect(hours[1].tokens == Array(repeating: 7, count: 24))
    }

    @Test func limitReadingsTakeMillisecondsAndSeconds() throws {
        let limits = try BridgeWire.usageHistory(Self.answer).limits
        #expect(limits.count == 2)
        #expect(limits[0] == UsageLimitReading(
            at: Date(timeIntervalSince1970: 1_762_416_000), agent: "claude", name: "weekly", percent: 62,
            resetsAt: Date(timeIntervalSince1970: 1_762_588_800), windowSeconds: 604_800
        ))
        #expect(limits[1].resetsAt == nil)
        #expect(limits[1].windowSeconds == nil)
    }

    @Test func aBareAnswerIsReadAndOneThatIsNoneIsRefused() throws {
        let bare = try BridgeWire.usageHistory(["days": []])
        #expect(bare.timeZone == .current)
        #expect(bare.agents.isEmpty)
        #expect(!bare.scan.scanning)
        #expect(bare.hours.isEmpty && bare.limits.isEmpty)
        #expect(throws: UsageHistoryError.self) { try BridgeWire.usageHistory(["time_zone": "UTC"]) }
        #expect(throws: UsageHistoryError.self) { try BridgeWire.usageHistory("days") }
        // A zone this device does not know is its own.
        #expect(try BridgeWire.usageHistory(["days": [], "time_zone": "Mars/Olympus"]).timeZone == .current)
    }

    @Test func theTelemetrySwitchIsRead() throws {
        #expect(try BridgeWire.usageTelemetry(["enabled": true, "locked": .null, "last_sent_day": "2026-11-05"])
            == UsageTelemetry(enabled: true, locked: nil, lastSentDay: "2026-11-05"))
        #expect(try BridgeWire.usageTelemetry(["enabled": false, "locked": "env", "last_sent_day": .null])
            == UsageTelemetry(enabled: false, locked: .environment, lastSentDay: nil))
        #expect(try BridgeWire.usageTelemetry(["enabled": false, "locked": "policy"]).locked == .other("policy"))
        #expect(throws: UsageHistoryError.self) { try BridgeWire.usageTelemetry(["locked": "env"]) }
    }

    @Test func theParamsAreThePlans() throws {
        #expect(try JSONValue(encoding: BridgeWire.UsageHistoryParams(from: "2026-08-01", to: "2026-11-06")).serialized()
            == #"{"from":"2026-08-01","to":"2026-11-06"}"#)
        #expect(try JSONValue(encoding: BridgeWire.UsageTelemetryParams(enabled: false)).serialized() == #"{"enabled":false}"#)
        #expect(try JSONValue(encoding: BridgeWire.UsageTelemetryParams(enabled: nil)).serialized() == "{}")
    }

    // MARK: The backend

    private func connect(features: [JSONValue]) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "version": "0.3.4", "features": .array(features)]]
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    @Test func aHostWithTheFeaturesIsAsked() async throws {
        let (backend, transport) = try await connect(features: ["usage_history", "usage_telemetry"])
        #expect(await backend.readsUsageHistory == true)
        #expect(await backend.sharesUsageTotals == true)

        let asking = Task { try await backend.usageHistory(from: "2026-08-01", to: "2026-11-06") }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"]?.stringValue == "usage.history")
        #expect(request["params"] == ["from": "2026-08-01", "to": "2026-11-06"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": Self.answer])
        #expect(try await asking.value.days.count == 3)

        let setting = Task { try await backend.usageTelemetry(enabled: false) }
        let set = try #require(await transport.nextSentRequest())
        #expect(set["method"]?.stringValue == "usage.telemetry")
        #expect(set["params"] == ["enabled": false])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(set["id"]), "result": ["enabled": false, "locked": .null, "last_sent_day": .null]])
        #expect(try await setting.value == UsageTelemetry(enabled: false))

        // The host's sentence for a range it will not give.
        let refused = Task { try await backend.usageHistory(from: "2025-01-01", to: "2026-11-06") }
        let tooLong = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(tooLong["id"]), "error": ["code": -32602, "message": "At most 400 days."]])
        await #expect(throws: UsageHistoryError.refused("At most 400 days.")) { try await refused.value }
        await backend.disconnect()
    }

    @Test func aHostWithoutThemIsNotAsked() async throws {
        let (backend, _) = try await connect(features: ["activity"])
        #expect(await backend.readsUsageHistory == false)
        #expect(await backend.sharesUsageTotals == false)
        await #expect(throws: UsageHistoryError.unavailable) { try await backend.usageHistory(from: "2026-11-01", to: "2026-11-06") }
        await #expect(throws: UsageHistoryError.unavailable) { try await backend.usageTelemetry(enabled: nil) }
        await backend.disconnect()
    }
}
