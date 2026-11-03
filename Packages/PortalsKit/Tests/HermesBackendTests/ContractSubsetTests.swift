import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Hermes rejects a request that carries a key its contract does not define (error
/// 4000). These tests pin every key the param types can produce to the list in
/// `Fixtures/contract-subset.json`, which `scripts/check-contract.sh` checks against a
/// real host. A new field on a param type fails here until it is added to that list.
@Suite struct ContractSubsetTests {
    private func allowedKeys(_ method: String) throws -> Set<String> {
        let subset = try Fixtures.json("contract-subset.json")
        let keys = try #require(subset["methods"]?[method]?.arrayValue, "\(method) is missing from contract-subset.json")
        return Set(keys.compactMap(\.stringValue))
    }

    /// Encodes `params` with every field set and compares its keys to the allowed list.
    private func expectKeys(of params: some Encodable, equal method: String, sourceLocation: SourceLocation = #_sourceLocation) throws {
        let encoded = try #require(try JSONValue(encoding: params).objectValue, sourceLocation: sourceLocation)
        #expect(Set(encoded.keys) == (try allowedKeys(method)), sourceLocation: sourceLocation)
    }

    @Test func clientCapabilities() throws {
        try expectKeys(of: HermesWire.ClientCapabilitiesParams(serverRequests: true), equal: HermesWire.Method.clientCapabilities)
    }

    @Test func profilesList() throws {
        try expectKeys(of: HermesWire.ProfilesListParams(), equal: HermesWire.Method.profilesList)
    }

    @Test func sessionCreate() throws {
        try expectKeys(
            of: HermesWire.SessionCreateParams(
                profile: "aeri", source: "tui", title: "t", cwd: "/tmp", model: "m", provider: "p", reasoningEffort: "high"
            ),
            equal: HermesWire.Method.sessionCreate
        )
    }

    @Test func sessionResume() throws {
        try expectKeys(
            of: HermesWire.SessionResumeParams(sessionID: "stored-1", profile: "aeri", inlineImages: false),
            equal: HermesWire.Method.sessionResume
        )
    }

    @Test func sessionEventsSince() throws {
        try expectKeys(
            of: HermesWire.SessionEventsSinceParams(sessionID: "run-1", lastSeen: 42, profile: "aeri"),
            equal: HermesWire.Method.sessionEventsSince
        )
        // Hermes validates `last_seen` as an integer.
        #expect(try JSONValue(encoding: HermesWire.SessionEventsSinceParams(sessionID: "s", lastSeen: 42)).serialized()
            == #"{"last_seen":42,"session_id":"s"}"#)
    }

    @Test func sessionInterrupt() throws {
        try expectKeys(
            of: HermesWire.SessionInterruptParams(sessionID: "s1", profile: "aeri"),
            equal: HermesWire.Method.sessionInterrupt
        )
    }

    @Test func modelCallsStayInsideTheContract() throws {
        try expectKeys(of: HermesWire.ModelOptionsParams(profile: "aeri"), equal: HermesWire.Method.modelOptions)
        try expectKeys(of: HermesWire.ConfigGetParams(key: "reasoning", profile: "aeri"), equal: HermesWire.Method.configGet)
        try expectKeys(
            of: HermesWire.ConfigSetParams(key: "model", value: "m", sessionID: "s1", profile: "aeri", confirmExpensiveModel: true),
            equal: HermesWire.Method.configSet
        )
    }

    @Test func commandCallsStayInsideTheContract() throws {
        try expectKeys(of: HermesWire.CommandsCatalogParams(profile: "aeri"), equal: HermesWire.Method.commandsCatalog)
        try expectKeys(of: HermesWire.SlashExecParams(sessionID: "s1", command: "status", profile: "aeri"), equal: HermesWire.Method.slashExec)
        try expectKeys(
            of: HermesWire.CommandDispatchParams(name: "arxiv", arg: "transformers", sessionID: "s1", profile: "aeri"),
            equal: HermesWire.Method.commandDispatch
        )
    }

    @Test func subagentList() throws {
        try expectKeys(of: HermesWire.SubagentListParams(sessionID: "s1", profile: "aeri"), equal: HermesWire.Method.subagentList)
    }

    @Test func imageAttachBytes() throws {
        try expectKeys(
            of: HermesWire.ImageAttachBytesParams(sessionID: "s1", contentBase64: "AAAA", filename: "photo.jpg", profile: "aeri"),
            equal: HermesWire.Method.imageAttachBytes
        )
    }

    @Test func promptSubmit() throws {
        try expectKeys(
            of: HermesWire.PromptSubmitParams(sessionID: "s1", text: "hi", profile: "aeri"),
            equal: HermesWire.Method.promptSubmit
        )
    }

    /// Sent only to a bridge that lists the feature (`BridgeWire`), so checked against the
    /// subset's `bridge` part, which the bridge's own contract is checked against.
    @Test func bridgeOnlyCallsStayInsideTheirPartOfTheContract() throws {
        let subset = try Fixtures.json("contract-subset.json")
        let folders = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.foldersList])
        #expect(folders["feature"]?.stringValue == BridgeWire.Feature.folders)
        let allowed = Set(try #require(folders["params"]?.arrayValue).compactMap(\.stringValue))
        let encoded = try #require(try JSONValue(encoding: BridgeWire.FoldersListParams(profile: "claude")).objectValue)
        #expect(Set(encoded.keys) == allowed)
        let adding = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.foldersAdd])
        #expect(adding["feature"]?.stringValue == BridgeWire.Feature.foldersAdd)
        let added = try #require(try JSONValue(encoding: BridgeWire.FoldersAddParams(path: "/Users/dev/notes")).objectValue)
        #expect(Set(added.keys) == Set(try #require(adding["params"]?.arrayValue).compactMap(\.stringValue)))
        // Taking one off again is sent the same way, under the same feature.
        #expect(subset["bridge"]?["methods"]?[BridgeWire.Method.foldersRemove] == adding)
        // None of it is in what Hermes is sent.
        #expect(subset["methods"]?[BridgeWire.Method.foldersList] == nil)
        #expect(subset["methods"]?[BridgeWire.Method.foldersAdd] == nil)
        #expect(subset["methods"]?[BridgeWire.Method.foldersRemove] == nil)
        let features = Set(try #require(subset["bridge"]?["features"]?.arrayValue).compactMap(\.stringValue))
        #expect(features == [
            BridgeWire.Feature.folders, BridgeWire.Feature.modelLevels, BridgeWire.Feature.pushHost, BridgeWire.Feature.deskSessions,
            BridgeWire.Feature.modelNames, BridgeWire.Feature.compaction, BridgeWire.Feature.rename, BridgeWire.Feature.activity,
            BridgeWire.Feature.modelDefaultLevels, BridgeWire.Feature.questionDetails, BridgeWire.Feature.modes,
            BridgeWire.Feature.modelLevelsNone,
            BridgeWire.Feature.pushRelay, BridgeWire.Feature.pushSealed, BridgeWire.Feature.pushMuting, BridgeWire.Feature.foldersAdd,
            BridgeWire.Feature.machine,
            BridgeWire.Feature.threadSync, BridgeWire.Feature.agentKinds, BridgeWire.Feature.queue, BridgeWire.Feature.files,
            BridgeWire.Feature.agentLooks, BridgeWire.Feature.sidebarOrder, BridgeWire.Feature.machineOrder, BridgeWire.Feature.approvalNotes,
            BridgeWire.Feature.threadBranch,
            BridgeWire.Feature.subagents, BridgeWire.Feature.turnMessages, BridgeWire.Feature.subagentsClear,
            BridgeWire.Feature.subagentNames, BridgeWire.Feature.subagentCalls, BridgeWire.Feature.statusHeadline, BridgeWire.Feature.pollNow,
            BridgeWire.Feature.resumeReplay, BridgeWire.Feature.agentThreads, BridgeWire.Feature.recentThreads, BridgeWire.Feature.turnUsage,
            BridgeWire.Feature.sessionLeave, BridgeWire.Feature.worktrees, BridgeWire.Feature.turnDiff,
            BridgeWire.Feature.fileRead, BridgeWire.Feature.sessionResync, BridgeWire.Feature.pushWatcher,
            BridgeWire.Feature.messageIDs, BridgeWire.Feature.senders, BridgeWire.Feature.asyncQuestions,
            BridgeWire.Feature.backgroundCommands, BridgeWire.Feature.leanDeltas, BridgeWire.Feature.threadSearch,
            BridgeWire.Feature.fileSearch, BridgeWire.Feature.fileMentions, BridgeWire.Feature.folderSearch,
            BridgeWire.Feature.answerOwner, BridgeWire.Feature.netRename, BridgeWire.Feature.netRenameDevices,
            BridgeWire.Feature.botChat, BridgeWire.Feature.historyPages, BridgeWire.Feature.updateNotice, BridgeWire.Feature.mcpAuth,
            BridgeWire.Feature.messageReconciliation,
            BridgeWire.Feature.gitStatus, BridgeWire.Feature.usageRead, BridgeWire.Feature.openOnHost,
        ])
        // Searching the folders under the host's home folder: as the subset has it, and never sent to Hermes.
        let folderSearch = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.foldersSearch])
        #expect(folderSearch["feature"]?.stringValue == BridgeWire.Feature.folderSearch)
        let searchingFolders = try #require(try JSONValue(encoding: BridgeWire.FoldersSearchParams(query: "por", limit: 30, profile: "claude")).objectValue)
        #expect(Set(searchingFolders.keys) == Set(try #require(folderSearch["params"]?.arrayValue).compactMap(\.stringValue)))
        #expect(subset["methods"]?[BridgeWire.Method.foldersSearch] == nil)
        // A file on the host for the app to show: as the subset has it, and never sent to Hermes.
        let read = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.fileRead])
        #expect(read["feature"]?.stringValue == BridgeWire.Feature.fileRead)
        let reading = try #require(try JSONValue(encoding: BridgeWire.FileReadParams(sessionID: "s1", path: "/w/a.png", purpose: "image", unless: "1-2-3")).objectValue)
        #expect(Set(reading.keys) == Set(try #require(read["params"]?.arrayValue).compactMap(\.stringValue)))
        #expect(subset["methods"]?[BridgeWire.Method.fileRead] == nil)
        // Searching a folder's files for an @ mention: as the subset has it, every key set, and never sent to Hermes.
        let search = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.filesSearch])
        #expect(search["feature"]?.stringValue == BridgeWire.Feature.fileSearch)
        let allowedSearch = Set(try #require(search["params"]?.arrayValue).compactMap(\.stringValue))
        var searching = BridgeWire.FilesSearchParams(scope: .thread(ThreadRef.ID(rawValue: "s1")), query: "main", limit: 20, profile: "claude")
        searching.folder = "/w"
        #expect(Set(try #require(try JSONValue(encoding: searching).objectValue).keys) == allowedSearch)
        #expect(subset["methods"]?[BridgeWire.Method.filesSearch] == nil)
        // Letting go of a thread: as the subset has it, and never sent to Hermes.
        let leave = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.sessionLeave])
        #expect(leave["feature"]?.stringValue == BridgeWire.Feature.sessionLeave)
        let leaving = try #require(try JSONValue(encoding: BridgeWire.SessionLeaveParams(sessionID: "s1", profile: "aeri")).objectValue)
        #expect(Set(leaving.keys) == Set(try #require(leave["params"]?.arrayValue).compactMap(\.stringValue)))
        #expect(subset["methods"]?[BridgeWire.Method.sessionLeave] == nil)
        // What a message sent mid-turn is to do, the list of those waiting, and files: as
        // the subset lists them, and only for a bridge that offers them.
        let queueCalls: [(String, String, any Encodable)] = [
            (BridgeWire.Method.promptSubmit, BridgeWire.Feature.queue,
             BridgeWire.PromptSubmitParams(sessionID: "s1", text: "hi", profile: "claude", whenBusy: .queue, messageID: "M1", mentions: ["src/main.ts"])),
            (BridgeWire.Method.promptQueueRemove, BridgeWire.Feature.queue, BridgeWire.QueueItemParams(sessionID: "s1", queueID: "2", profile: "claude")),
            (BridgeWire.Method.promptQueueSteer, BridgeWire.Feature.queue, BridgeWire.QueueItemParams(sessionID: "s1", queueID: "2", profile: "claude")),
            (BridgeWire.Method.fileAttachBytes, BridgeWire.Feature.files,
             BridgeWire.FileAttachBytesParams(sessionID: "s1", contentBase64: "aGk=", filename: "notes.txt", id: "F1", profile: "claude")),
            (BridgeWire.Method.subagentStop, BridgeWire.Feature.subagents,
             BridgeWire.SubagentStopParams(sessionID: "s1", subagentID: "wwn9e3l29", profile: "claude")),
            (BridgeWire.Method.sessionInterrupt, BridgeWire.Feature.subagents, BridgeWire.SessionInterruptParams(sessionID: "s1", profile: "claude")),
            (
                BridgeWire.Method.clientCapabilities, BridgeWire.Feature.subagents,
                BridgeWire.ClientCapabilitiesParams(features: [
                    BridgeWire.Feature.subagents, BridgeWire.Feature.pollNow, BridgeWire.Feature.sessionResync,
                    BridgeWire.Feature.asyncQuestions, BridgeWire.Feature.messageReconciliation,
                    BridgeWire.Feature.leanDeltas, BridgeWire.Feature.answerOwner,
                ])
            ),
            (BridgeWire.Method.sessionResume, BridgeWire.Feature.resumeReplay,
             BridgeWire.SessionResumeParams(sessionID: "stored-1", profile: "claude", since: 42, replayEpoch: "8a9e048c70014c77aef21efa5a9a90ee", replayBase: 7, limit: 30)),
            (BridgeWire.Method.sessionHistory, BridgeWire.Feature.historyPages,
             BridgeWire.SessionHistoryParams(sessionID: "s1", profile: "hermes", before: 12, limit: 30,
                                             replayEpoch: "8a9e048c70014c77aef21efa5a9a90ee", replayBase: 7)),
        ]
        for (method, feature, params) in queueCalls {
            let spec = try #require(subset["bridge"]?["methods"]?[method], "\(method)")
            #expect(spec["feature"]?.stringValue == feature, "\(method)")
            let allowed = Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(method)")
        }
        // Hermes is never sent `when_busy` or `keep_background`: its own `prompt.submit` and `session.interrupt` have no such key.
        #expect(subset["methods"]?[HermesWire.Method.promptSubmit]?.arrayValue?.contains("when_busy") == false)
        #expect(subset["methods"]?[HermesWire.Method.sessionInterrupt]?.arrayValue?.contains("keep_background") == false)
        #expect(subset["methods"]?[HermesWire.Method.clientCapabilities]?.arrayValue?.contains("subagent_requests") == false)
        // Nor `since`, `replay_epoch` or `replay_base`: its `session.resume` rejects any key it does not define.
        #expect(subset["methods"]?[HermesWire.Method.sessionResume]?.arrayValue?.contains("since") == false)
        #expect(subset["methods"]?[HermesWire.Method.sessionResume]?.arrayValue?.contains("replay_epoch") == false)
        #expect(subset["methods"]?[HermesWire.Method.sessionResume]?.arrayValue?.contains("replay_base") == false)
        #expect(subset["methods"]?[HermesWire.Method.sessionResume]?.arrayValue?.contains("limit") == false)
        #expect(subset["methods"]?[BridgeWire.Method.sessionHistory] == nil)
        // A resume that is not replayed leaves them out.
        #expect(try JSONValue(encoding: BridgeWire.SessionResumeParams(sessionID: "s", profile: nil, since: nil, replayEpoch: nil, replayBase: nil)).serialized()
            == #"{"inline_images":false,"session_id":"s"}"#)
        // Polling at once: asked for and read only with a bridge that lists it, never with Hermes.
        #expect(subset["methods"]?[HermesWire.Method.clientCapabilities]?.arrayValue?.contains("poll_now") == false)
        #expect(subset["bridge"]?["events"]?[BridgeWire.EventType.pollNow]?["feature"]?.stringValue == BridgeWire.Feature.pollNow)
        #expect(subset["events"]?.arrayValue?.contains(.string(BridgeWire.EventType.pollNow)) == false)
        #expect(subset["methods"]?[HermesWire.Method.clientCapabilities]?.arrayValue?.contains("session_resync") == false)
        #expect(subset["bridge"]?["events"]?[BridgeWire.EventType.sessionInvalidated]?["feature"]?.stringValue == BridgeWire.Feature.sessionResync)
        #expect(subset["events"]?.arrayValue?.contains(.string(BridgeWire.EventType.sessionInvalidated)) == false)
        #expect(subset["bridge"]?["events"]?["queue.changed"]?["feature"]?.stringValue == BridgeWire.Feature.queue)
        // Every message said in a thread, on every device: read only from a bridge that lists it.
        #expect(subset["bridge"]?["events"]?["message.steered"]?["feature"]?.stringValue == BridgeWire.Feature.turnMessages)
        #expect(subset["methods"]?[HermesWire.Method.promptSubmit]?.arrayValue?.contains("message_id") == false)
        // Nor `mentions`, which only a bridge that lists file_mentions reads.
        #expect(subset["methods"]?[HermesWire.Method.promptSubmit]?.arrayValue?.contains("mentions") == false)
        #expect(subset["bridge"]?["events"]?["subagent.cleared"]?["feature"]?.stringValue == BridgeWire.Feature.subagentsClear)
        #expect(subset["events"]?.arrayValue?.contains("subagent.cleared") == false)
        // An event read only from a bridge that lists its feature, and never from Hermes.
        #expect(subset["bridge"]?["events"]?["session.compacted"]?["feature"]?.stringValue == BridgeWire.Feature.compaction)
        #expect(subset["events"]?.arrayValue?.contains("session.compacted") == false)

        let sent: [(String, any Encodable)] = [
            (BridgeWire.Method.deskList, BridgeWire.DeskListParams(profile: "claude", limit: 40)),
            (BridgeWire.Method.sessionAdopt, BridgeWire.SessionAdoptParams(profile: "claude", sessionID: "s1", mode: "fork")),
        ]
        for (method, params) in sent {
            let spec = try #require(subset["bridge"]?["methods"]?[method])
            #expect(spec["feature"]?.stringValue == BridgeWire.Feature.deskSessions)
            let allowed = Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(method)")
            #expect(subset["methods"]?[method] == nil)
        }
        let rename = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.sessionRename])
        #expect(rename["feature"]?.stringValue == BridgeWire.Feature.rename)
        let renameKeys = try #require(try JSONValue(encoding: BridgeWire.SessionRenameParams(sessionID: "s1", title: "t", profile: "claude")).objectValue)
        #expect(Set(renameKeys.keys) == Set(try #require(rename["params"]?.arrayValue).compactMap(\.stringValue)))
        let activity = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.sessionsActivity])
        #expect(activity["feature"]?.stringValue == BridgeWire.Feature.activity)
        #expect(try JSONValue(encoding: BridgeWire.SessionsActivityParams()).objectValue?.isEmpty == true)
        #expect(activity["params"]?.arrayValue?.isEmpty == true)
        let setMode = try #require(subset["bridge"]?["methods"]?[BridgeWire.Method.sessionSetMode])
        #expect(setMode["feature"]?.stringValue == BridgeWire.Feature.modes)
        let setModeKeys = try #require(try JSONValue(encoding: BridgeWire.SessionSetModeParams(sessionID: "s1", mode: "plan", profile: "claude")).objectValue)
        #expect(Set(setModeKeys.keys) == Set(try #require(setMode["params"]?.arrayValue).compactMap(\.stringValue)))
        #expect(subset["bridge"]?["events"]?["session.mode"]?["feature"]?.stringValue == BridgeWire.Feature.modes)

        // The list every device shows: each method with every key set.
        let listing: [(String, any Encodable)] = [
            (BridgeWire.Method.threadsChanges, BridgeWire.ThreadsChangesParams(list: "3f9a1c0e7b2d4a65", since: 812)),
            (
                BridgeWire.Method.threadMark,
                BridgeWire.ThreadMarkParams(
                    thread: "s1", marks: ThreadMarks(
                        pinned: true, archived: false, unseen: false, revision: 812, list: "3f9a1c0e7b2d4a65", turn: 805, preview: "p", shared: true, recent: true
                    )
                )
            ),
            (BridgeWire.Method.threadDelete, BridgeWire.ThreadDeleteParams(thread: "s1")),
        ]
        for (method, params) in listing {
            let spec = try #require(subset["bridge"]?["methods"]?[method], "\(method)")
            #expect(spec["feature"]?.stringValue == BridgeWire.Feature.threadSync)
            let allowed = Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(method)")
            #expect(subset["methods"]?[method] == nil)
        }
        // With no list held, nothing but the method goes.
        #expect(try JSONValue(encoding: BridgeWire.ThreadsChangesParams(since: nil)).objectValue?.isEmpty == true)

        // How the agents look on every device: each method with every key set.
        let looks: [(String, any Encodable)] = [
            (BridgeWire.Method.looksList, BridgeWire.LooksListParams()),
            (
                BridgeWire.Method.lookSet,
                BridgeWire.LookSetParams(
                    profile: "claude", look: HostLook(AgentLook(shape: 1, face: 2, tint: 3, showsLogo: false), origin: .chosen), unless: .chosen
                )
            ),
        ]
        for (method, params) in looks {
            let spec = try #require(subset["bridge"]?["methods"]?[method], "\(method)")
            #expect(spec["feature"]?.stringValue == BridgeWire.Feature.agentLooks)
            let allowed = Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(method)")
            #expect(subset["methods"]?[method] == nil)
        }

        // The sidebar's order on every device: each method with every key set.
        let order: [(String, any Encodable)] = [
            (BridgeWire.Method.orderList, BridgeWire.OrderListParams()),
            (
                BridgeWire.Method.orderSet,
                BridgeWire.OrderSetParams(
                    agents: ["codex", "claude"], folders: ["/Users/dev/app"], machines: MachineOrder(ids: ["aa11aa11aa11aa11"], at: 1_791_940_000_000)
                )
            ),
        ]
        for (method, params) in order {
            let spec = try #require(subset["bridge"]?["methods"]?[method], "\(method)")
            #expect(spec["feature"]?.stringValue == BridgeWire.Feature.sidebarOrder)
            let allowed = Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(method)")
            #expect(subset["methods"]?[method] == nil)
        }
    }

    @Test func unsetOptionalsAreOmittedNotNull() throws {
        let encoded = try JSONValue(encoding: HermesWire.SessionCreateParams(profile: nil, source: "tui"))
        #expect(encoded == ["source": "tui"])
    }
}

@Suite struct AuthenticatorTests {
    @Test func tokenIsReadFromTheHeadlessRootPage() {
        let page = """
            <!doctype html><html><head><script>window.__HERMES_SESSION_TOKEN__="abc-DEF_123";\
            window.__HERMES_AUTH_REQUIRED__=false;</script></head><body>headless</body></html>
            """
        #expect(LoopbackTokenAuthenticator.token(inPage: page) == "abc-DEF_123")
    }

    @Test func escapedTokenIsDecoded() {
        #expect(LoopbackTokenAuthenticator.token(inPage: #"window.__HERMES_SESSION_TOKEN__="a\"bA";"#) == "a\"bA")
    }

    @Test func missingOrEmptyTokenIsNil() {
        #expect(LoopbackTokenAuthenticator.token(inPage: #"{"error":"headless"}"#) == nil)
        #expect(LoopbackTokenAuthenticator.token(inPage: #"window.__HERMES_SESSION_TOKEN__="";"#) == nil)
    }

    @Test func webSocketURLUsesTheMatchingScheme() async throws {
        let loopback = LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "tok en")
        #expect(try await loopback.webSocketRequest().url?.absoluteString == "ws://127.0.0.1:9119/api/ws?token=tok%20en")

        let secure = URL(string: "https://mini.example.ts.net:10008/")!
        // No query at all for none: a net's token goes in a header (`TokenAuthenticator`).
        #expect(try secure.hermesWebSocketURL(query: []).absoluteString == "wss://mini.example.ts.net:10008/api/ws")

        let request = try await loopback.authorized(URLRequest(url: URL(string: "http://127.0.0.1:9119/api/status")!))
        #expect(request.value(forHTTPHeaderField: "X-Hermes-Session-Token") == "tok en")
    }
}

@Suite struct GatewayReadyTests {
    @Test func aBridgeSaysItsVersionAndOneFromBeforeSaysNone() {
        let said = HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "version": "0.2.0", "features": []]])
        #expect(said.bridge?.version == "0.2.0")
        let before = HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "features": []]])
        #expect(before.bridge != nil)
        #expect(before.bridge?.version == nil)
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "version": "", "features": []]]).bridge?.version == nil)
    }

    @Test func aBridgeWhoseRelayIDAnotherBridgeHoldsSaysSo() {
        let said = HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "features": [], "relay_problem": "in_use"]])
        #expect(said.bridge?.relayProblem == .inUse)
        #expect(said.bridge?.relayProblem?.message == "This host's relay id is in use by another bridge. To give it one of its own, run npx portals-host relay reset on it.")
        // None said, or a word this app does not know: nothing shown.
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "features": []]]).bridge?.relayProblem == nil)
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "bridge": ["protocol": 1, "features": [], "relay_problem": "later"]]).bridge?.relayProblem == nil)
    }

    @Test func readsEpochAndHeartbeat() {
        let ready = HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "heartbeat": true, "skin": [:]])
        #expect(ready.replayEpoch == "e1")
        #expect(ready.supportsHeartbeat)
    }

    @Test func heartbeatAbsentOrFalseMeansUnsupported() {
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1"]).supportsHeartbeat == false)
        #expect(HermesWire.GatewayReady(payload: ["heartbeat": false]).supportsHeartbeat == false)
        #expect(HermesWire.GatewayReady(payload: .null).replayEpoch == nil)
    }

    @Test func aBridgeSaysSoAndListsWhatItOffers() {
        let ready = HermesWire.GatewayReady(payload: [
            "replay_epoch": "e1", "heartbeat": true, "bridge": ["protocol": 1, "features": ["push_host", "folders.list", 3]],
        ])
        #expect(ready.bridge?.features == ["push_host", "folders.list"])
        #expect(ready.hostKind == .bridge)
        let bare = HermesWire.GatewayReady(payload: ["bridge": ["protocol": 1, "features": []]])
        #expect(bare.bridge?.features == [])
        #expect(bare.hostKind == .bridge)
    }

    @Test func hermesSendsNoBridgeBlock() {
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "heartbeat": true]).bridge == nil)
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "heartbeat": true]).hostKind == nil)
        #expect(HermesWire.GatewayReady(payload: ["bridge": .null]).bridge == nil)
        #expect(HermesWire.GatewayReady(payload: ["bridge": "yes"]).bridge == nil)
    }
}
