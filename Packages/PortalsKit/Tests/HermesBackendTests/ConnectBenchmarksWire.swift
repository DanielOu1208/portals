import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// What a connect takes when each answer is a round trip away: from `connect()` to the
/// host's agents listed, the first thing the app asks for, with the host answering every
/// request `rtt` after it was sent and `gateway.ready` at once. Times only, nothing asserted
/// of them; only when asked, as the sync benchmarks (SyncBenchmarks.swift says how):
///
///     PORTALS_BENCH=1 swift test --no-parallel --filter ConnectBenchmarksWire
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1", "Only with PORTALS_BENCH=1"))
struct ConnectBenchmarksWire {
    @Test(arguments: [("a bridge", true), ("Hermes", false)])
    func aConnectUntilTheAgentsAreListed(host: String, isBridge: Bool) async throws {
        let rtt = Duration.milliseconds(100)
        let rounds = 5
        var times: [Double] = []
        var connects: [Double] = []
        var trips: [Double] = []
        for _ in 0..<rounds {
            // One round trip as this Mac sleeps it now: a busy Mac wakes a sleeper late.
            let slept = ContinuousClock.now
            try? await Task.sleep(for: rtt, tolerance: .zero)
            trips.append(Self.ms(ContinuousClock.now - slept))

            let transport = ScriptedTransport()
            let backend = HermesBackend(
                host: HostID(rawValue: "mac"),
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
                makeTransport: { _ in transport }
            )
            let ready: JSONValue = isBridge
                ? ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents"]]]
                : ["replay_epoch": "e1", "heartbeat": false]
            let host = Task { await Self.answer(on: transport, after: rtt) }
            let start = ContinuousClock.now
            transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
            try await backend.connect()
            connects.append(Self.ms(ContinuousClock.now - start))
            let agents = try await backend.listAgents()
            times.append(Self.ms(ContinuousClock.now - start))
            #expect(agents.count == 1)
            await backend.disconnect()
            host.cancel()
        }
        let median = { (values: [Double]) in String(format: "%.1f", values.sorted()[rounds / 2]) }
        print("""

        A connect until the agents are listed, \(host), every answer \(rtt) away: \(rounds) rounds, medians.

        | Host | One round trip as slept, ms | Connected, ms | Agents listed, ms |
        |---|---:|---:|---:|
        | \(host) | \(median(trips)) | \(median(connects)) | \(median(times)) |

        """)
    }

    private static func ms(_ duration: Duration) -> Double {
        Double(duration.components.seconds) * 1000 + Double(duration.components.attoseconds) / 1e15
    }

    /// Plays a host that answers each request `rtt` after it was sent, each on its own.
    private static func answer(on transport: ScriptedTransport, after rtt: Duration) async {
        while let frame = await transport.nextSent(), !Task.isCancelled {
            guard let id = frame["id"], let method = frame["method"]?.stringValue else { continue }
            let result: JSONValue = switch method {
            case "client.capabilities": ["server_requests": ["approval", "clarify"]]
            case "profiles.list": ["profiles": [["name": "claude"]]]
            default: [:]
            }
            Task {
                // Without the system's leeway, which on a busy Mac adds as much again.
                try? await Task.sleep(for: rtt, tolerance: .zero)
                transport.deliver(["jsonrpc": "2.0", "id": id, "result": result])
            }
        }
    }
}
