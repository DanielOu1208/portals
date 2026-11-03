import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// `folders.search` (feature `folder_search`): the folders under the host's home folder,
/// for the new-thread folder picker. The answers are shaped as the bridge's `FolderSearch`
/// gave them on 2026-10-26 for a test home folder, its path replaced.
@Suite struct FolderSearchWireTests {
    private func answer(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    private func connect(features: [JSONValue]) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": .array(features)]]
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    @Test func anAnswerIsReadWithItsHitsAndWhatTheHostSaysOfThem() throws {
        let results = try BridgeWire.folderSearchResults(from: answer(
            #"{"home":"/Users/dev","folders":[{"path":"/Users/dev/coding_projects/Portals","name":"Portals","relative":"coding_projects/Portals","ranges":[[0,3],[16,19]],"score":2140,"git":true,"last_used":1791324000,"added":true},{"path":"/Users/dev/work/repo-feature","name":"repo-feature","relative":"work/repo-feature","ranges":[[5,14]],"score":120,"repo":"/Users/dev/work/repo"}],"total":12,"matched":2,"mode":"path"}"#
        ))
        #expect(results.home == "/Users/dev")
        #expect(results.mode == .path)
        #expect(results.total == 12)
        #expect(results.matched == 2)
        #expect(!results.truncated && !results.refreshing && !results.superseded)
        let portals = try #require(results.hits.first)
        #expect(portals == FolderSearchHit(
            path: "/Users/dev/coding_projects/Portals", name: "Portals", relative: "coding_projects/Portals", ranges: [0 ..< 3, 16 ..< 19],
            score: 2140, isRepository: true, lastUsed: Date(timeIntervalSince1970: 1_791_324_000), isAdded: true
        ))
        #expect(portals.matchedRanges.map { String(portals.relative[$0]) } == ["cod", "Por"])
        #expect(portals.head == "~/coding_projects/")
        #expect(results.hits[1].repo == "/Users/dev/work/repo")
        #expect(!results.hits[1].isRepository)
    }

    @Test func aHitWithoutAPathIsLeftOutAndItsBadRangesToo() throws {
        let results = try BridgeWire.folderSearchResults(from: answer(
            #"{"home":"/Users/dev","folders":[{"relative":"x"},{"path":"/Users/dev/x"},{"path":"/Users/dev/🚀launch","relative":"🚀launch","ranges":[[2,8],[1,3],[9,"x"],[5,2],[7,99]]}],"total":3,"matched":3,"truncated":true,"refreshing":true}"#
        ))
        #expect(results.truncated && results.refreshing)
        #expect(results.mode == .fuzzy)
        let hit = try #require(results.hits.first)
        #expect(results.hits.count == 1)
        #expect(hit.name == "🚀launch")
        #expect(hit.head == "~/")
        // Into the middle of the emoji, and past the end: left out when drawn.
        #expect(hit.ranges == [2 ..< 8, 1 ..< 3, 7 ..< 99])
        #expect(hit.matchedRanges.map { String(hit.relative[$0]) } == ["launch"])
    }

    @Test func anAnswerWithoutItsHomeOrFoldersIsRefused() {
        #expect(throws: FolderError.self) { try BridgeWire.folderSearchResults(from: answer(#"{"folders":[]}"#)) }
        #expect(throws: FolderError.self) { try BridgeWire.folderSearchResults(from: answer(#"{"home":"/Users/dev"}"#)) }
    }

    @Test func aBridgeThatSearchesFoldersIsAskedAndItsRefusalIsItsSentence() async throws {
        let (backend, transport) = try await connect(features: ["folders", "folders_add", "folder_search"])
        #expect(await backend.searchesFolders == true)
        let search = Task { try await backend.searchFolders("~/cod/por", limit: 30) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "folders.search")
        #expect(request["params"] == ["query": "~/cod/por", "limit": 30])
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(request["id"]),
            "result": ["home": "/Users/dev", "folders": [["path": "/Users/dev/coding_projects/Portals", "relative": "coding_projects/Portals"]], "superseded": false],
        ])
        #expect(try await search.value.hits.map(\.name) == ["Portals"])

        let refused = Task { try await backend.searchFolders("a", limit: 500) }
        let second = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "error": ["code": -32602, "message": "limit must be a whole number."]])
        await #expect(throws: FolderError.refused("limit must be a whole number.")) { try await refused.value }
        await backend.disconnect()
    }

    @Test func aBridgeWithoutTheFeatureOrWithoutAddingFoldersIsNeverAsked() async throws {
        for features: [JSONValue] in [["folders", "folders_add"], ["folders", "folder_search"]] {
            let (backend, transport) = try await connect(features: features)
            #expect(await backend.searchesFolders == false)
            await #expect(throws: FolderError.unavailable) { try await backend.searchFolders("por", limit: 30) }
            // Nothing went out for it: the next thing sent is whatever is asked next.
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    @Test func aHostThatIsNoBridgeSearchesNoFolders() async throws {
        struct Plain: FolderProviding {
            var offersFolders: Bool? { true }
            func folders(for agent: Agent.ID) async throws -> FolderList { FolderList(general: Folder(path: "/g"), recent: []) }
            var addsFolders: Bool? { false }
            var machine: HostMachine? { nil }
            func addFolder(at path: String) async throws -> Folder { Folder(path: path) }
            func removeFolder(at path: String) async throws {}
        }
        #expect(await Plain().searchesFolders == false)
        await #expect(throws: FolderError.unavailable) { try await Plain().searchFolders("x", limit: 1) }
    }
}
