import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The one row of the app's sync benchmarks that needs a connection (the others are in
/// AgentCoreTests, SyncBenchmarks.swift, which says how to run them): a `threads.changes`
/// answer with every thread, from the frame's text as the socket hands it over to the
/// list the merge takes. That is the frame parsed, the result decoded into its typed
/// form, and each thread read out of it. Only when asked, as the others.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1", "Only with PORTALS_BENCH=1"))
struct SyncBenchmarksWire {
    private struct Row: Encodable {
        var at = Date.now
        var build: String
        var load: Double
        var row = "A full threads.changes answer decoded"
        var threads: Int
        var rounds: Int
        /// The middle one of the rounds' times, the shortest and the longest.
        var ms: Double
        var msMin: Double
        var msMax: Double
        var answerBytes: Int
    }

    @Test(arguments: [100, 1000, 5000]) func whatAFullAnswerCostsToDecode(threads count: Int) async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["thread_sync"]]]
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value

        let result = try Self.answer(count)
        let rounds = count > 1000 ? 3 : 5
        var times: [Double] = []
        var bytes = 0
        // The first is to warm it up, and is not timed.
        for round in 0...rounds {
            let asking = Task { try await backend.threadListChanges(since: nil) }
            let request = try #require(await transport.nextSentRequest())
            let id = try #require(request["id"]).serialized()
            let frame = #"{"jsonrpc":"2.0","id":\#(id),"result":\#(result)}"#
            bytes = frame.utf8.count
            let start = ContinuousClock.now
            transport.deliver(text: frame)
            let changes = try await asking.value
            let took = ContinuousClock.now - start
            #expect(changes.isFull && changes.threads.count == count && changes.unreadable.isEmpty)
            if round > 0 { times.append(Double(took.components.seconds) * 1000 + Double(took.components.attoseconds) / 1e15) }
        }
        await backend.disconnect()

        times = times.sorted().map { ($0 * 10_000).rounded() / 10_000 }
        var load = [0.0, 0.0, 0.0]
        getloadavg(&load, 3)
        #if DEBUG
        let build = "debug"
        #else
        let build = "release"
        #endif
        let row = Row(
            build: build, load: (load[0] * 100).rounded() / 100, threads: count, rounds: rounds,
            ms: times[times.count / 2], msMin: times[0], msMax: times[times.count - 1], answerBytes: bytes
        )
        print("""

        App sync, an answer decoded, with \(count) threads: \(build) build, \(Date.now.formatted(.iso8601)), load average \(row.load).

        | Step | ms | The answer's bytes |
        |---|---:|---:|
        | \(row.row) | \(String(format: "%.3f", row.ms)) | \(bytes) |

        """)
        try Self.append(row)
    }

    /// An answer with `count` threads as the bridge lists them (bridge/src/fleet/fleet.ts,
    /// `listed`), as the JSON text of a result: a title and a preview of the middle
    /// length of the other benchmarks' threads, one in five of them not ASCII.
    private static func answer(_ count: Int) throws -> String {
        let rows = (0..<count).map { index -> JSONValue in
            let words = index % 5 == 4 ? "修正 the café sync 🚀 " : "merge the sync list "
            var row: [String: JSONValue] = [
                "id": .string(String(format: "%08lx-4c1d-4e7a-9b3f-%012lx", index, index)),
                "agent": "claude", "agent_name": "Claude Code", "state": "idle",
                "title": .string(String(String(repeating: words, count: 5).prefix(80))),
                "preview": .string(String(String(repeating: words, count: 5).prefix(80))),
                "folder": .string(String(format: "/Users/dev/coding_projects/project-%02ld", index % 20 + 1)),
                "created": .number(Double(1_791_320_000 + index * 60)), "updated": .number(Double(1_791_324_000 + index * 60)),
                "revision": .number(Double(index + 1)),
            ]
            if index % 20 == 3 { row["pinned"] = true }
            if index % 20 == 11 { row["archived"] = true }
            return .object(row)
        }
        return try JSONValue.object([
            "list": ["id": "3f9a1c0e7b2d4a65", "revision": .number(Double(count))], "threads": .array(rows), "removed": [], "full": true,
        ]).serialized()
    }

    /// Appends the row as a line to the file PORTALS_BENCH_JSON names, in one write, as
    /// the other benchmarks do theirs.
    private static func append(_ row: Row) throws {
        guard let path = ProcessInfo.processInfo.environment["PORTALS_BENCH_JSON"], !path.isEmpty else { return }
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let line = try encoder.encode(row) + Data("\n".utf8)
        let file = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        let written = file < 0 ? -1 : line.withUnsafeBytes { write(file, $0.baseAddress, $0.count) }
        if file >= 0 { close(file) }
        if written != line.count { Issue.record("PORTALS_BENCH_JSON: the row could not be written to \(path)") }
    }
}
