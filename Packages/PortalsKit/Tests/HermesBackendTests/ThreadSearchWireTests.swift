import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Search inside threads on the wire (feature `thread_search`): what the app asks with,
/// what it reads of the answer, and a bridge without the feature asked nothing.
@Suite struct ThreadSearchWireTests {
    private static let base = URL(string: "http://127.0.0.1:9120")!
    private static let answer: JSONValue = [
        "threads": [
            [
                "id": "019a2b3c-4d5e", "agent": "codex", "agent_name": "Codex", "title": "Relay decisions", "folder": "/Users/dev/portals",
                "updated": 1_761_500_000, "count": 4, "partial": true,
                "hits": [
                    ["role": "assistant", "text": "…the 🙂 relay keeps it", "ranges": [["start": 8, "end": 13]], "timestamp": 1_761_499_000.5, "id": "item-a1"],
                    ["role": "user", "text": "Résumé of the RELAY", "ranges": [["start": 0, "end": 6], ["start": 14, "end": 19]], "timestamp": 1_761_498_000],
                    // Not a hit the app knows: left out, the rest kept.
                    ["role": "tool", "text": "x", "ranges": [], "timestamp": 1],
                ],
            ],
            ["id": "mini/abc", "agent": "claude", "folder": "/w", "updated": 1_761_400_000, "count": 1, "archived": true, "hits": []],
            // A Claude Code thread with a hit from before its compaction: marked, with the compaction row's time.
            [
                "id": "c1", "agent": "claude", "folder": "/w", "updated": 1_761_300_000, "count": 2, "compacted_at": 1_761_200_000.25,
                "hits": [
                    ["role": "user", "text": "relay after", "ranges": [["start": 0, "end": 5]], "timestamp": 1_761_250_000],
                    ["role": "assistant", "text": "relay before", "ranges": [["start": 0, "end": 5]], "timestamp": 1_761_100_000, "before_compaction": true],
                ],
            ],
            // No id: left out.
            ["agent": "claude", "folder": "/w", "updated": 1, "count": 1, "hits": []],
        ],
        "cursor": "eyJ2IjoxfQ",
        "scanned": 12,
        "unsearched": [["agent": "hermes", "count": 2, "reason": "Searched only while it is open."]],
    ]

    @Test func anAnswerIsReadThreadByThreadAndARowThatDoesNotFitCostsOnlyItself() throws {
        let page = try BridgeWire.threadSearchPage(Self.answer)
        #expect(page.threads.map(\.threadID.rawValue) == ["019a2b3c-4d5e", "mini/abc", "c1"])
        #expect(page.cursor == "eyJ2IjoxfQ" && page.hasMore)
        #expect(page.scanned == 12)
        #expect(page.unsearched == [ThreadSearchGap(agent: "hermes", count: 2, reason: "Searched only while it is open.")])
        #expect(page.replaced == false)
        let first = page.threads[0]
        #expect(first.agentName == "Codex" && first.title == "Relay decisions" && first.count == 4 && first.partial && !first.archived)
        #expect(first.updated == Date(timeIntervalSince1970: 1_761_500_000))
        #expect(first.hits.map(\.role) == [.assistant, .user])
        #expect(first.hits[0].agentMessageID == "item-a1" && first.hits[1].agentMessageID == nil)
        #expect(first.hits[0].timestamp == Date(timeIntervalSince1970: 1_761_499_000.5))
        let second = page.threads[1]
        #expect(second.agentName == "claude" && second.title == nil && second.archived)
        #expect(first.compactedAt == nil && first.hits.allSatisfy { !$0.beforeCompaction })
    }

    @Test func aHitFromBeforeACompactionIsMarkedWithTheCompactionsTimeToOpenAt() throws {
        let page = try BridgeWire.threadSearchPage(Self.answer)
        let thread = try #require(page.threads.first { $0.threadID.rawValue == "c1" })
        #expect(thread.compactedAt == Date(timeIntervalSince1970: 1_761_200_000.25))
        #expect(thread.hits.map(\.beforeCompaction) == [false, true])
        // A host from before the key: nothing marked.
        let older = try #require(BridgeWire.threadSearchResult([
            "id": "c2", "agent": "claude", "folder": "/w", "updated": 1, "count": 1,
            "hits": [["role": "user", "text": "relay", "ranges": [], "timestamp": 1]],
        ]))
        #expect(older.compactedAt == nil && older.hits.map(\.beforeCompaction) == [false])
    }

    @Test func theMatchesAreMarkedInTheSnippetPastEmojiAndAccents() throws {
        let page = try BridgeWire.threadSearchPage(Self.answer)
        let emoji = page.threads[0].hits[0]
        // In UTF-16 "…" is one unit and "🙂" two: "relay" is 8..<13, as JavaScript counts.
        #expect(emoji.matchRanges.map { String(emoji.snippet[$0]) } == ["relay"])
        let accents = page.threads[0].hits[1]
        #expect(accents.matchRanges.map { String(accents.snippet[$0]) } == ["Résumé", "RELAY"])
        // A range past the snippet, or ending inside a surrogate pair, is not trusted.
        let broken = ThreadSearchHit(role: .user, snippet: "a🙂b", utf16Ranges: [0 ..< 2, 1 ..< 3, 3 ..< 9], timestamp: .now)
        #expect(broken.matchRanges.map { String(broken.snippet[$0]) } == ["🙂"])
    }

    @Test func aReplacedSearchAndAnAnswerThatIsNotASearchAreToldApart() throws {
        let replaced = try BridgeWire.threadSearchPage(["threads": [], "cursor": .null, "scanned": 0, "replaced": true])
        #expect(replaced.replaced && replaced.threads.isEmpty && !replaced.hasMore)
        #expect(throws: HermesConnectionError.self) { try BridgeWire.threadSearchPage(["results": []]) }
    }

    @Test func theQueryIsSentAsTheBridgeTakesItAndItsRefusalIsReadInItsWords() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: LoopbackTokenAuthenticator(baseURL: Self.base, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, features: ["activity", "thread_search"])
        #expect(await backend.searchesThreads == true)

        let query = ThreadSearchQuery(text: "relay \"push token\"", limit: 10, hits: 2, agent: "codex", folder: "/Users/dev/portals")
        async let searched = backend.searchThreads(query, cursor: "c1")
        var sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "thread.search")
        #expect(sent["params"] == ["query": "relay \"push token\"", "limit": 10, "hits": 2, "cursor": "c1", "agent": "codex", "folder": "/Users/dev/portals"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": Self.answer])
        #expect(try await searched.threads.count == 3)

        // Only the words when nothing else is asked.
        async let plain = backend.searchThreads(ThreadSearchQuery(text: "relay"), cursor: nil)
        sent = try #require(await transport.nextSentRequest())
        #expect(sent["params"] == ["query": "relay"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": ["threads": [], "cursor": .null, "scanned": 3]])
        #expect(try await plain == ThreadSearchPage(threads: [], scanned: 3))

        let refused = Task { try await backend.searchThreads(ThreadSearchQuery(text: "relay"), cursor: "old") }
        sent = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "error": ["code": -32602, "message": "The cursor belongs to another search."]])
        await #expect(throws: ThreadSearchError.refused("The cursor belongs to another search.")) { try await refused.value }

        // Nothing to look for is not sent.
        await #expect(throws: ThreadSearchError.refused("Type something to look for.")) {
            try await backend.searchThreads(ThreadSearchQuery(text: " \"\" "), cursor: nil)
        }
        await backend.disconnect()
    }

    @Test func aHostWithoutTheFeatureIsAskedNothing() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: LoopbackTokenAuthenticator(baseURL: Self.base, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, features: ["activity"])
        #expect(await backend.searchesThreads == false)
        await #expect(throws: ThreadSearchError.unavailable) { try await backend.searchThreads(ThreadSearchQuery(text: "relay"), cursor: nil) }
        await backend.disconnect()
    }

    @Test func theSearchStaysInsideTheBridgesPartOfTheContract() throws {
        let subset = try Fixtures.json("contract-subset.json")
        let entry = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.threadSearch], "thread.search is missing from contract-subset.json")
        #expect(entry["feature"]?.stringValue == BridgeWire.Feature.threadSearch)
        let allowed = Set(try #require(entry["params"]?.arrayValue).compactMap(\.stringValue))
        let params = BridgeWire.ThreadSearchParams(query: "q", limit: 1, hits: 1, cursor: "c", agent: "a", folder: "/f")
        #expect(Set(try #require(try JSONValue(encoding: params).objectValue).keys) == allowed)
        #expect(subset["methods"]?[BridgeWire.Method.threadSearch] == nil, "thread.search is never sent to Hermes")
        let features = try #require(subset["bridge"]?["features"]?.arrayValue).compactMap(\.stringValue)
        #expect(features.contains(BridgeWire.Feature.threadSearch))
    }

    // MARK: Helpers

    private func connect(_ backend: HermesBackend, _ transport: ScriptedTransport, features: [JSONValue]) async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": .array(features)]]
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        #expect(capabilities["method"]?.stringValue == "client.capabilities")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": [:]])
        try await connecting.value
    }
}
