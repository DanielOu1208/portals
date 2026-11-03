import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The bridge's list of threads for every device (feature `thread_sync`, `BridgeWire`):
/// what is sent and how the answers read, and that nothing of it goes to a host that does
/// not list the feature.
@Suite struct ThreadSyncWireTests {
    private static let syncing: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "rename", "thread_sync"]],
    ]
    /// What `portals-bridge` 0.1.0, the version on npm, says.
    private static let npm010: JSONValue = [
        "replay_epoch": "e1", "heartbeat": true,
        "bridge": ["protocol": 1, "features": [
            "folders", "model_levels", "push_host", "desk_sessions", "model_names", "compaction", "rename", "activity",
            "model_default_levels", "question_details", "modes", "push_relay", "push_sealed",
        ]],
    ]
    private static let hermes: JSONValue = ["replay_epoch": "e1", "heartbeat": true]

    private func connect(ready: JSONValue) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    /// Answers the next request, after checking what it asked.
    private func answer(
        _ transport: ScriptedTransport, method: String, params: JSONValue, with result: JSONValue,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws {
        let request = try #require(await transport.nextSentRequest(), sourceLocation: sourceLocation)
        #expect(request["method"]?.stringValue == method, sourceLocation: sourceLocation)
        #expect(request["params"] == params, sourceLocation: sourceLocation)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": result])
    }

    private func refuse(_ transport: ScriptedTransport, code: Int, message: String) async throws {
        let request = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "error": ["code": .number(Double(code)), "message": .string(message)]])
    }

    private func id(_ raw: String) -> ThreadRef.ID { ThreadRef.ID(rawValue: raw) }

    /// A thread as the bridge lists it (bridge/src/fleet/fleet.ts, `listed`).
    private static let listedRow: JSONValue = [
        "id": "6d3c", "agent": "claude", "agent_name": "Claude Code", "title": "Fix the login",
        "folder": "/Users/dev/coding_projects/app", "state": "idle", "updated": 1_791_324_000, "created": 1_791_320_000,
        "revision": 805, "preview": "Make the login keep its session", "pinned": true, "unseen": true,
        "started_by": ["name": "Aeri", "thread": "aeri"],
    ]

    // MARK: threads.changes

    @Test func aBridgeThatKeepsTheListSaysWhatChangedOrEverything() async throws {
        let (backend, transport) = try await connect(ready: Self.syncing)
        #expect(await backend.syncsThreads == true)

        // Every thread, for a device that holds no list.
        let everything = Task { try await backend.threadListChanges(since: nil) }
        try await answer(transport, method: "threads.changes", params: [:], with: [
            "list": ["id": "3f9a1c0e7b2d4a65", "revision": 812],
            "threads": [
                Self.listedRow,
                [
                    "id": "aeri", "agent": "aeri", "agent_name": "Aeri", "folder": "/Users/dev", "state": "working",
                    "updated": 1_791_323_000, "created": 1_791_000_000, "revision": 3, "ongoing": true, "read_only": true,
                    "archived": true,
                ],
            ],
            "removed": ["gone"], "full": true,
        ])
        let full = try await everything.value
        #expect(full.isFull)
        #expect(full.list == ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812))
        #expect(full.removed == [id("gone")])
        #expect(full.unreadable.isEmpty)
        #expect(full.threads == [
            ListedThread(
                id: id("6d3c"), agent: "claude", title: "Fix the login", folder: "/Users/dev/coding_projects/app",
                created: Date(timeIntervalSince1970: 1_791_320_000), updated: Date(timeIntervalSince1970: 1_791_324_000),
                revision: 805, preview: "Make the login keep its session", pinned: true, unseen: true,
                startedBy: ThreadStarter(name: "Aeri", thread: id("aeri"))
            ),
            ListedThread(
                id: id("aeri"), agent: "aeri", folder: "/Users/dev", readOnly: true,
                created: Date(timeIntervalSince1970: 1_791_000_000), updated: Date(timeIntervalSince1970: 1_791_323_000),
                revision: 3, archived: true
            ),
        ])

        // What changed since a revision of it.
        let since = Task { try await backend.threadListChanges(since: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812)) }
        try await answer(
            transport, method: "threads.changes", params: ["list": "3f9a1c0e7b2d4a65", "since": 812],
            with: ["list": ["id": "3f9a1c0e7b2d4a65", "revision": 812], "threads": [], "removed": []]
        )
        #expect(try await since.value == ThreadListChanges(list: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812)))
        await backend.disconnect()
    }

    /// A thread working in a git worktree carries its repository's folder, read only from a
    /// bridge that offers `worktrees`, from the list and from a mark's answer alike.
    @Test func aThreadsRepositoryIsReadOnlyFromABridgeThatOffersWorktrees() async throws {
        var row = try #require(Self.listedRow.objectValue)
        row["folder"] = "/Users/dev/coding_projects/portals-night"
        row["repo"] = "/Users/dev/coding_projects/Portals"
        let answer: JSONValue = ["list": ["id": "3f9a1c0e7b2d4a65", "revision": 812], "threads": [.object(row)], "removed": []]
        let result = try answer.decode(BridgeWire.ThreadsChangesResult.self)
        let read = try #require(try result.changes(readsRepo: true).threads.first)
        #expect(read.repo == "/Users/dev/coding_projects/Portals")
        #expect(read.folder == "/Users/dev/coding_projects/portals-night")
        #expect(try result.changes().threads.first?.repo == nil)

        let ready: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "rename", "thread_sync", "worktrees"]],
        ]
        let (backend, transport) = try await connect(ready: ready)
        let asking = Task { try await backend.threadListChanges(since: nil) }
        try await self.answer(transport, method: "threads.changes", params: [:], with: answer)
        #expect(try await asking.value.threads.first?.repo == "/Users/dev/coding_projects/Portals")
        await backend.disconnect()

        let (plain, plainTransport) = try await connect(ready: Self.syncing)
        let plainAsking = Task { try await plain.threadListChanges(since: nil) }
        try await self.answer(plainTransport, method: "threads.changes", params: [:], with: answer)
        #expect(try await plainAsking.value.threads.first?.repo == nil)
        await plain.disconnect()
    }

    @Test func aThreadsBranchIsReadOnlyFromABridgeThatOffersThreadBranch() async throws {
        var row = try #require(Self.listedRow.objectValue)
        row["branch"] = "night/phone-wins"
        let answer: JSONValue = ["list": ["id": "3f9a1c0e7b2d4a65", "revision": 812], "threads": [.object(row)], "removed": []]
        let result = try answer.decode(BridgeWire.ThreadsChangesResult.self)
        #expect(try result.changes(readsBranch: true).threads.first?.branch == "night/phone-wins")
        #expect(try result.changes().threads.first?.branch == nil)

        let ready: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "rename", "thread_sync", "thread_branch"]],
        ]
        let (backend, transport) = try await connect(ready: ready)
        let asking = Task { try await backend.threadListChanges(since: nil) }
        try await self.answer(transport, method: "threads.changes", params: [:], with: answer)
        #expect(try await asking.value.threads.first?.branch == "night/phone-wins")
        await backend.disconnect()

        let (plain, plainTransport) = try await connect(ready: Self.syncing)
        let plainAsking = Task { try await plain.threadListChanges(since: nil) }
        try await self.answer(plainTransport, method: "threads.changes", params: [:], with: answer)
        #expect(try await plainAsking.value.threads.first?.branch == nil)
        await plain.disconnect()
    }

    @Test func anOddThreadCostsOnlyItselfAndKeepsItsPlace() throws {
        let result = try JSONValue.object([
            "list": ["id": "3f9a1c0e7b2d4a65", "revision": 9],
            "threads": [
                // No agent: listed, but not read.
                ["id": "no-agent", "updated": 1, "revision": 2],
                // No id at all: nothing to keep.
                ["agent": "claude", "updated": 1, "revision": 2],
                // Odd extras cost only themselves.
                [
                    "id": "odd", "agent": "claude", "updated": 1_791_324_000.5, "revision": 4, "title": "  ", "preview": 3,
                    "started_by": ["thread": "x"], "pinned": "yes", "folder": "",
                ],
                "not a thread",
            ],
            "removed": ["", 7, "gone"],
        ]).decode(BridgeWire.ThreadsChangesResult.self).changes()
        #expect(result.unreadable == [id("no-agent")])
        #expect(result.threads == [ListedThread(id: id("odd"), agent: "claude", updated: Date(timeIntervalSince1970: 1_791_324_000.5), revision: 4)])
        #expect(result.removed == [id("gone")])
        #expect(!result.isFull)

        // An answer that does not say which list it is about cannot be merged.
        let unnamed = try JSONValue.object(["threads": [], "removed": [], "full": true]).decode(BridgeWire.ThreadsChangesResult.self)
        #expect(throws: DecodingError.self) { try unnamed.changes() }
        // Nor can a full one that leaves out its threads, or has one without an id: every
        // thread it leaves out would be forgotten.
        let list: JSONValue = ["id": "3f9a1c0e7b2d4a65", "revision": 9]
        for partial: JSONValue in [
            ["list": list, "removed": [], "full": true],
            ["list": list, "threads": [Self.listedRow, ["agent": "claude", "updated": 1, "revision": 2]], "removed": [], "full": true],
        ] {
            let result = try partial.decode(BridgeWire.ThreadsChangesResult.self)
            #expect(throws: DecodingError.self) { try result.changes() }
        }
        // A delta without threads changed none.
        #expect(try JSONValue.object(["list": list, "removed": ["gone"]]).decode(BridgeWire.ThreadsChangesResult.self).changes()
            == ThreadListChanges(list: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 9), removed: [id("gone")]))
    }

    @Test func anAnswerReadAsTheFrameWasParsedIsWhatDecodingItGives() throws {
        let list: JSONValue = ["id": "3f9a1c0e7b2d4a65", "revision": 9]
        let answers: [JSONValue] = [
            ["list": list, "threads": [Self.listedRow, ["id": "no-agent", "updated": 1, "revision": 2], "not a thread"], "removed": ["", 7, "gone"]],
            ["list": list, "threads": [Self.listedRow], "removed": [], "full": true],
            ["list": list, "threads": nil, "removed": nil, "full": nil],
            ["list": list],
            ["list": list, "full": false, "more": ["of": "anything"]],
        ]
        for answer in answers {
            let read = try BridgeWire.ThreadsChangesResult(reading: answer).changes()
            #expect(try read == answer.decode(BridgeWire.ThreadsChangesResult.self).changes())
        }
        // What cannot be merged is refused either way: no list, a full answer without its
        // threads, and an answer, its threads, its removed or its full of another kind.
        let refused: [JSONValue] = [
            ["threads": [], "removed": [], "full": true],
            ["list": nil, "threads": []],
            ["list": list, "removed": [], "full": true],
            "threads",
            [list],
            ["list": list, "threads": "none"],
            ["list": list, "threads": ["id": "a"]],
            ["list": list, "threads": [], "removed": "gone"],
            ["list": list, "threads": [], "full": "yes"],
            ["list": list, "threads": [], "full": 1],
        ]
        for answer in refused {
            #expect(throws: DecodingError.self) { try BridgeWire.ThreadsChangesResult(reading: answer).changes() }
            #expect(throws: DecodingError.self) { try answer.decode(BridgeWire.ThreadsChangesResult.self).changes() }
        }
    }

    /// An answer with every thread is the largest frame the app is sent. Its result is
    /// read as the frame was parsed: a typed call makes text of the parsed result and
    /// decodes that again, which took longer than parsing the frame did. So the whole
    /// way from the frame's text to the list is held against parsing that text alone,
    /// the best of several rounds of each, taken one beside the other.
    @Test func anAnswerWithEveryThreadIsNotDecodedASecondTime() async throws {
        let (backend, transport) = try await connect(ready: Self.syncing)
        let rows = (0..<400).map { index -> JSONValue in
            var row: [String: JSONValue] = [
                "agent": .string("claude"), "agent_name": .string("Claude Code"), "state": .string("idle"),
                "title": .string("Merge the sync list and the café notes 修正"),
                "preview": .string("merge the sync list, then the sidebar's layout"),
                "folder": .string("/Users/dev/coding_projects/project-07"), "created": .number(1_791_320_000),
            ]
            row["id"] = .string("thread-\(index)")
            row["updated"] = .number(Double(1_791_324_000 + index))
            row["revision"] = .number(Double(index + 1))
            row["pinned"] = .bool(index % 20 == 3)
            return .object(row)
        }
        let result = try JSONValue.object([
            "list": ["id": "3f9a1c0e7b2d4a65", "revision": 400], "threads": .array(rows), "removed": [], "full": true,
        ]).serialized()
        let clock = ContinuousClock()
        var whole: [Duration] = [], parsing: [Duration] = []
        for _ in 0..<10 {
            let asking = Task { try await backend.threadListChanges(since: nil) }
            let request = try #require(await transport.nextSentRequest())
            let frame = #"{"jsonrpc":"2.0","id":\#(try #require(request["id"]).serialized()),"result":\#(result)}"#
            var start = clock.now
            transport.deliver(text: frame)
            let changes = try await asking.value
            whole.append(clock.now - start)
            #expect(changes.isFull && changes.threads.count == 400)
            start = clock.now
            _ = try JSONValue.parse(frame)
            parsing.append(clock.now - start)
        }
        await backend.disconnect()
        let best = (whole: try #require(whole.min()), parsing: try #require(parsing.min()))
        // Reading the threads out of the parsed answer adds a few hundredths to the
        // parsing; the second decoding added as much as the parsing again.
        #expect(best.whole < best.parsing * 1.6, "from the text to the list took \(best.whole), parsing the text \(best.parsing)")
    }

    // MARK: thread.mark, session.rename, thread.delete

    @Test func marksGoAsGivenAndNothingElse() async throws {
        let (backend, transport) = try await connect(ready: Self.syncing)
        let listed: JSONValue = ["thread": Self.listedRow]

        // Answered with the thread as the list gives it now, read as a listing's row is.
        let pinning = Task { try await backend.markThread(id("6d3c"), ThreadMarks(pinned: true)) }
        try await answer(transport, method: "thread.mark", params: ["thread": "6d3c", "pinned": true], with: listed)
        let pinned = try #require(try await pinning.value)
        #expect(pinned == BridgeWire.listedThread(from: Self.listedRow))
        #expect(pinned.revision == 805 && pinned.pinned && pinned.title == "Fix the login")

        // An answer without a thread that can be read gives none, and the step fetches.
        let seen = Task { try await backend.markThread(id("6d3c"), ThreadMarks(unseen: false, revision: 805, list: "3f9a1c0e7b2d4a65")) }
        try await answer(
            transport, method: "thread.mark", params: ["thread": "6d3c", "unseen": false, "revision": 805, "list": "3f9a1c0e7b2d4a65"],
            with: ["thread": ["id": "6d3c"]]
        )
        #expect(try await seen.value == nil)

        let carried = Task {
            try await backend.markThread(id("6d3c"), ThreadMarks(pinned: true, archived: true, unseen: true, preview: "What did the build say?"))
        }
        try await answer(
            transport, method: "thread.mark",
            params: ["thread": "6d3c", "pinned": true, "archived": true, "unseen": true, "preview": "What did the build say?"],
            with: listed
        )
        #expect(try await carried.value?.id == id("6d3c"))

        let unknown = Task { try await backend.markThread(id("elsewhere/6d3c"), ThreadMarks(pinned: true)) }
        try await refuse(transport, code: 4007, message: "There is no thread elsewhere/6d3c.")
        await #expect(throws: ThreadSyncError.unknownThread) { try await unknown.value }
        await backend.disconnect()
    }

    @Test func aRemovalIsTheBridgesToTakeOrRefuseWithItsSentence() async throws {
        let (backend, transport) = try await connect(ready: Self.syncing)
        let removing = Task { try await backend.removeThread(id("6d3c")) }
        try await answer(transport, method: "thread.delete", params: ["thread": "6d3c"], with: [:])
        try await removing.value

        let busy = Task { try await backend.removeThread(id("6d3c")) }
        let sentence = "Claude Code is still working in this thread. Stop it, then remove it."
        try await refuse(transport, code: -32602, message: sentence)
        await #expect(throws: ThreadSyncError.refused(sentence)) { try await busy.value }

        let aeri = Task { try await backend.removeThread(id("aeri")) }
        try await refuse(transport, code: -32602, message: "Aeri's conversation is always there: it cannot be removed.")
        await #expect(throws: ThreadSyncError.refused("Aeri's conversation is always there: it cannot be removed.")) { try await aeri.value }

        // One the bridge could not do is said no to the same way, with its sentence.
        let unasked = Task { try await backend.removeThread(id("codex-thread")) }
        try await refuse(transport, code: -32603, message: "Portals could not ask Codex whether this thread is at work (socket closed). Try again in a moment.")
        await #expect(throws: ThreadSyncError.refused("Portals could not ask Codex whether this thread is at work (socket closed). Try again in a moment.")) { try await unasked.value }

        let gone = Task { try await backend.removeThread(id("gone")) }
        try await refuse(transport, code: 4007, message: "There is no thread gone.")
        await #expect(throws: ThreadSyncError.unknownThread) { try await gone.value }
        await backend.disconnect()
    }

    @Test func aTitleGoesAsARename() async throws {
        let (backend, transport) = try await connect(ready: Self.syncing)
        let thread = ThreadRef(id: id("6d3c"), agent: Agent.ID(host: HostID(rawValue: "mac"), name: "claude"))
        let renaming = Task { try await backend.renameThread(thread, to: "Retry failed pushes") }
        try await answer(transport, method: "session.rename", params: ["session_id": "6d3c", "title": "Retry failed pushes", "profile": "claude"], with: [:])
        try await renaming.value

        let readOnly = Task { try await backend.renameThread(thread, to: "No") }
        try await refuse(transport, code: -32602, message: "This thread is only for reading.")
        await #expect(throws: ThreadSyncError.refused("This thread is only for reading.")) { try await readOnly.value }
        await backend.disconnect()
    }

    // MARK: Hosts without the feature

    @Test func npm010AndHermesAreSentNothingOfTheList() async throws {
        let thread = ThreadRef(id: id("6d3c"), agent: Agent.ID(host: HostID(rawValue: "mac"), name: "claude"))
        for ready in [Self.npm010, Self.hermes] {
            let (backend, transport) = try await connect(ready: ready)
            #expect(await backend.syncsThreads == false)
            await #expect(throws: ThreadSyncError.unavailable) { try await backend.threadListChanges(since: nil) }
            await #expect(throws: ThreadSyncError.unavailable) { try await backend.markThread(thread.id, ThreadMarks(pinned: true)) }
            await #expect(throws: ThreadSyncError.unavailable) { try await backend.renameThread(thread, to: "No") }
            await #expect(throws: ThreadSyncError.unavailable) { try await backend.removeThread(thread.id) }
            // Nothing went out for them: the next thing sent is whatever is asked next.
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    @Test func aHostSyncStepSendsNothingToAHostWithoutTheFeature() async throws {
        for ready in [Self.npm010, Self.hermes] {
            let (backend, transport) = try await connect(ready: ready)
            let store = ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("portals-wire-\(UUID().uuidString)"))
            defer { try? FileManager.default.removeItem(at: store.directory) }
            // A device that synced with this host before: it was updated back to an older bridge.
            store.saveSync(HostSyncState(list: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812)), for: HostID(rawValue: "mac"))
            let steps = await MainActor.run { HostSync(host: HostID(rawValue: "mac"), store: store, remote: backend) }
            try await MainActor.run { _ = try steps.record(PendingThreadChange(thread: id("6d3c"), pinned: true)) }
            let step = await steps.step()
            #expect(step.error == nil && !step.merged)
            #expect(await MainActor.run { steps.isSyncing } == false)
            #expect(await MainActor.run { steps.pending } == [PendingThreadChange(thread: id("6d3c"), pinned: true)])
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    @Test func beforeConnectingNobodyKnowsWhetherTheListIsKept() async {
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t")
        )
        #expect(await backend.syncsThreads == nil)
    }

    // MARK: Recorded

    /// `threads.changes` recorded from this branch's bridge with the fake agent
    /// (`portals-probe threads`, then `threads --list … --since 10` after one thread
    /// was removed and the other archived), cleaned by `scripts/capture-frames.sh`. Also in
    /// `CapturedFrameTests.captures`.
    static let captures = ["bridge-threads-changes.jsonl"]

    @Test func theRecordedListMergesIntoADeviceThatHadNone() async throws {
        let capture = "bridge-threads-changes.jsonl"
        let received = try Fixtures.frames(capture, direction: "in")
        let answers = received.filter { $0["id"] == "r2" }.compactMap { $0["result"] }
        #expect(answers.count == 2)
        let (backend, transport) = try await connect(ready: try #require(received.first?["params"]?["payload"]))
        #expect(await backend.syncsThreads == true)

        let mac = HostID(rawValue: "mac")
        let full = Task { try await backend.threadListChanges(since: nil) }
        try await answer(transport, method: "threads.changes", params: [:], with: answers[0])
        let everything = try await full.value
        #expect(everything.isFull && everything.unreadable.isEmpty)
        var merged = ThreadSync.merge(everything, into: [], heldWhenAsking: [], pending: [], list: nil, host: mac)
        let started = id("04d1b10d-fb9f-4e9f-917c-b7bb5d9668e7"), first = id("e070dad7-ac64-4c58-9fcb-0cce35244985")
        #expect(merged.threads.map(\.id) == [started, first])
        #expect(merged.threads.allSatisfy { $0.isFromHost && $0.isUnseen && $0.ref.workingDirectory == "/Users/dev/Portals" })
        #expect(merged.threads[0].startedBy == ThreadStarter(name: "Fake agent", thread: first))
        #expect(merged.threads[0].preview == "Check the build")
        #expect(merged.threads[1].isPinned)
        #expect(merged.threads[1].ref.title == "Fake: Make the login keep its session")
        #expect(merged.pending.isEmpty)

        let held = merged.list
        let since = Task { try await backend.threadListChanges(since: held) }
        try await answer(transport, method: "threads.changes", params: ["list": "3d3875ede077b6a1", "since": 10], with: answers[1])
        let delta = try await since.value
        merged = ThreadSync.merge(delta, into: merged.threads, heldWhenAsking: Set(merged.threads.map(\.id)), pending: [], list: merged.list, host: mac)
        #expect(merged.forgotten.map(\.id) == [started])
        #expect(merged.threads.map(\.id) == [first])
        // Archiving unpinned it.
        #expect(merged.threads[0].isArchived && !merged.threads[0].isPinned)
        #expect(merged.list == ThreadListRevision(id: "3d3875ede077b6a1", revision: 12))
        await backend.disconnect()
    }

    // MARK: sessions.activity

    @Test func theActivityAnswerCarriesTheListOnlyFromABridgeThatKeepsIt() async throws {
        let result: JSONValue = [
            "sessions": [["session_id": "a", "state": "running"]],
            "thread_list": ["id": "3f9a1c0e7b2d4a65", "revision": 812],
        ]
        let (backend, transport) = try await connect(ready: Self.syncing)
        let asking = Task { try await backend.threadActivity() }
        try await answer(transport, method: "sessions.activity", params: [:], with: result)
        #expect(try await asking.value == ThreadActivityReport(
            threads: [id("a"): .running], list: ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812)
        ))
        await backend.disconnect()

        // A bridge without the feature that sent it anyway is not read for it.
        let (older, olderTransport) = try await connect(ready: Self.npm010)
        let olderAsking = Task { try await older.threadActivity() }
        try await answer(olderTransport, method: "sessions.activity", params: [:], with: result)
        #expect(try await olderAsking.value == ThreadActivityReport(threads: [id("a"): .running]))
        await older.disconnect()
    }

    @Test func todaysActivityAnswerStillReadsWithTheListInIt() throws {
        // As npm 0.1.0 answers, and as this bridge does, to an app that reads the list
        // and to one that does not.
        let before = try JSONValue.object(["sessions": [["session_id": "a", "state": "waiting"]]]).decode(BridgeWire.SessionsActivityResult.self)
        #expect(before.activity == [id("a"): .waiting])
        #expect(before.list == nil)
        let now = try JSONValue.parse(#"{"sessions":[{"session_id":"a","state":"waiting"}],"thread_list":{"id":"3f9a1c0e7b2d4a65","revision":812}}"#)
            .decode(BridgeWire.SessionsActivityResult.self)
        #expect(now.activity == [id("a"): .waiting])
        #expect(now.list == ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812))
        // An odd list costs only itself.
        for odd: JSONValue in ["yes", ["id": "", "revision": 3], ["id": "x", "revision": -1], ["id": "x", "revision": 1.5], .null] {
            let read = try JSONValue.object(["sessions": [["session_id": "a", "state": "running"]], "thread_list": odd])
                .decode(BridgeWire.SessionsActivityResult.self)
            #expect(read.activity == [id("a"): .running])
            #expect(read.list == nil)
        }
    }

    /// A thread listed only for the threads started from it at work says so (n14/foot,
    /// Codex's review): read beside its state, and nothing from an answer without it.
    @Test func aThreadRunningForTheThreadsItStartedIsReadAsInherited() throws {
        let read = try JSONValue.parse(
            #"{"sessions":[{"session_id":"child","state":"running"},{"session_id":"parent","state":"running","inherited":true},{"session_id":"odd","state":"resting","inherited":true}]}"#
        ).decode(BridgeWire.SessionsActivityResult.self)
        #expect(read.activity == [id("child"): .running, id("parent"): .running])
        #expect(read.inherited == [id("parent")])
        let before = try JSONValue.object(["sessions": [["session_id": "a", "state": "running"]]]).decode(BridgeWire.SessionsActivityResult.self)
        #expect(before.inherited.isEmpty)
        #expect(before.withoutTurn.isEmpty)
    }

    /// A thread running with no turn of its own says so, kept at work by its subagents or
    /// inherited (2026-10-27, of the unseen dot it took when they ended: "yes fix that").
    @Test func aThreadRunningWithNoTurnOfItsOwnIsReadSo() throws {
        let read = try JSONValue.parse(
            #"{"sessions":[{"session_id":"turn","state":"running"},{"session_id":"crew","state":"running","turn":false},{"session_id":"parent","state":"running","inherited":true,"turn":false},{"session_id":"odd","state":"resting","turn":false}]}"#
        ).decode(BridgeWire.SessionsActivityResult.self)
        #expect(read.withoutTurn == [id("crew"), id("parent")])
        #expect(read.inherited == [id("parent")])
    }
}
