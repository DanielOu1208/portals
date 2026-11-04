import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The extensions only a Portals bridge offers (`BridgeWire`): used with a host that
/// lists them in `gateway.ready`, never sent to Hermes, and read leniently.
@Suite struct BridgeExtensionTests {
    private static let bridgeReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["folders", "model_levels", "push_host"]],
    ]
    private static let hermesReady: JSONValue = ["replay_epoch": "e1", "heartbeat": false]

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

    private let claude = Agent.ID(host: HostID(rawValue: "mac"), name: "claude")

    // MARK: Agent kinds

    @Test func onlyABridgeThatSaysEachAgentsKindIsBelieved() async throws {
        let rows: JSONValue = ["profiles": [
            ["name": "claude", "kind": "claude", "display_name": "Claude Code", "is_default": true],
            // A Hermes profile called pi, on a bridge that runs no Pi.
            ["name": "pi", "kind": "hermes", "display_name": "Pi"],
            // Read leniently: a kind that is no word costs only itself, and a row may have none.
            ["name": "odd", "kind": 3],
            ["name": "bare"],
        ]]
        let saying: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["agent_kinds"]]]
        let none: [String?] = [nil, nil, nil, nil]
        // A bridge from before the feature, and Hermes, are not read for it.
        for (ready, kinds) in [(saying, ["claude", "hermes", nil, nil]), (Self.bridgeReady, none), (Self.hermesReady, none)] {
            let (backend, transport) = try await connect(ready: ready)
            let listing = Task { try await backend.listAgents() }
            let request = try #require(await transport.nextSentRequest())
            #expect(request["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": rows])
            let agents = try await listing.value
            #expect(agents.map(\.id.name) == ["claude", "pi", "odd", "bare"])
            #expect(agents.map(\.kind) == kinds)
            await backend.disconnect()
        }
    }

    // MARK: Renaming

    @Test func aBridgeThatRenamesIsToldTheTitleAndHermesNever() async throws {
        let renaming: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["rename"]]]
        let (backend, transport) = try await connect(ready: renaming)
        #expect(await backend.renamesThreads == true)
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
        let renaming2 = Task { try await backend.rename(thread, to: "Retry failed pushes") }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.rename")
        #expect(request["params"] == ["session_id": "s1", "title": "Retry failed pushes", "profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [:]])
        try await renaming2.value
        await backend.disconnect()

        let (hermes, hermesTransport) = try await connect(ready: Self.hermesReady)
        #expect(await hermes.renamesThreads == false)
        try await hermes.rename(thread, to: "Ignored")
        // Nothing went out for it: the next thing sent is whatever is asked next.
        let listing = Task { try await hermes.listAgents() }
        let next = try #require(await hermesTransport.nextSentRequest())
        #expect(next["method"] == "profiles.list")
        hermesTransport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
        _ = try await listing.value
        await hermes.disconnect()
    }

    // MARK: Adding a folder

    /// A bridge that offers `worktrees` answers a folder chosen in a worktree with that
    /// folder and `repo`, its repository's, which it added in its place: the folder added
    /// is the repository's, the one chosen its `worktree`.
    @Test func aFolderChosenInAWorktreeSaysSoFromABridgeThatOffersWorktrees() async throws {
        let ready: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["folders", "folders_add", "worktrees"]],
        ]
        let (backend, transport) = try await connect(ready: ready)
        let added = Task { try await backend.addFolder(at: "/Users/dev/coding_projects/notes-night") }
        let request = try #require(await transport.nextSentRequest())
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(request["id"]),
            "result": [
                "path": "/Users/dev/coding_projects/notes-night", "name": "notes-night", "added": true, "repo": "/Users/dev/coding_projects/notes",
            ],
        ])
        let folder = try await added.value
        #expect(folder.path == "/Users/dev/coding_projects/notes")
        #expect(folder.name == "notes")
        #expect(folder.isAdded)
        #expect(folder.worktree == "/Users/dev/coding_projects/notes-night")
        await backend.disconnect()
    }

    @Test func aBridgeThatAddsFoldersIsAskedAndSaysWhichMacItIsOn() async throws {
        let adding: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["folders", "folders_add", "machine"], "machine": ["hostname": "mbp.local", "home": "/Users/dev"]],
        ]
        let (backend, transport) = try await connect(ready: adding)
        #expect(await backend.addsFolders == true)
        #expect(await backend.machine == HostMachine(hostname: "mbp.local", home: "/Users/dev"))

        // By a link to it: the answer is the folder as the bridge lists it.
        let added = Task { try await backend.addFolder(at: "/Users/dev/links/notes") }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "folders.add")
        #expect(request["params"] == ["path": "/Users/dev/links/notes"])
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(request["id"]),
            "result": ["path": "/Users/dev/coding_projects/notes", "name": "notes", "last_used": 1_791_324_000, "added": true],
        ])
        let notes = Folder(path: "/Users/dev/coding_projects/notes", name: "notes", lastUsed: Date(timeIntervalSince1970: 1_791_324_000), isAdded: true)
        #expect(try await added.value == notes)

        // The list marks it, among the folders the agents worked in.
        let listing = Task { try await backend.folders(for: claude) }
        let asked = try #require(await transport.nextSentRequest())
        #expect(asked["method"] == "folders.list")
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(asked["id"]),
            "result": [
                "general": ["path": "/Users/dev/Portals", "name": "General"],
                "folders": [
                    ["path": "/Users/dev/coding_projects/notes", "name": "notes", "last_used": 1_791_324_000, "added": true],
                    ["path": "/Users/dev/coding_projects/aerirc", "name": "aerirc"],
                ],
            ],
        ])
        #expect(try await listing.value.recent == [notes, Folder(path: "/Users/dev/coding_projects/aerirc", name: "aerirc")])

        // And it can be taken off again.
        let removed = Task { try await backend.removeFolder(at: "/Users/dev/coding_projects/notes") }
        let removal = try #require(await transport.nextSentRequest())
        #expect(removal["method"] == "folders.remove")
        #expect(removal["params"] == ["path": "/Users/dev/coding_projects/notes"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(removal["id"]), "result": [:]])
        try await removed.value

        // `repo` is read only from a bridge that offers worktrees: from another, the answer
        // is the folder given, where the new thread starts, as before.
        let inWorktree = Task { try await backend.addFolder(at: "/Users/dev/coding_projects/notes-night") }
        let worktreeRequest = try #require(await transport.nextSentRequest())
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(worktreeRequest["id"]),
            "result": [
                "path": "/Users/dev/coding_projects/notes-night", "name": "notes-night", "last_used": 1_791_324_000, "added": true,
                "repo": "/Users/dev/coding_projects/notes",
            ],
        ])
        #expect(
            try await inWorktree.value
                == Folder(path: "/Users/dev/coding_projects/notes-night", name: "notes-night", lastUsed: Date(timeIntervalSince1970: 1_791_324_000), isAdded: true)
        )

        // A folder the bridge does not take: its sentence is the error.
        let refused = Task { try await backend.addFolder(at: "/Users/dev") }
        let second = try #require(await transport.nextSentRequest())
        let reason = "Threads cannot run in /Users/dev: it is the home folder, a hidden or temporary folder, or one this Mac keeps off the list."
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "error": ["code": -32602, "message": .string(reason)]])
        await #expect(throws: FolderError.refused(reason)) { try await refused.value }
        await backend.disconnect()
    }

    @Test func aBridgeThatDoesNotAddFoldersIsNeverAsked() async throws {
        // An older bridge: folders, and nothing about adding one or where it runs. A
        // `machine` block without the feature is not read.
        let older: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["folders"], "machine": ["hostname": "mbp.local", "home": "/Users/dev"]],
        ]
        let (backend, transport) = try await connect(ready: older)
        #expect(await backend.addsFolders == false)
        #expect(await backend.machine == nil)
        await #expect(throws: FolderError.unavailable) { try await backend.addFolder(at: "/Users/dev/notes") }
        await #expect(throws: FolderError.unavailable) { try await backend.removeFolder(at: "/Users/dev/notes") }
        // Nothing went out for it: the next thing sent is whatever is asked next.
        let listing = Task { try await backend.listAgents() }
        let next = try #require(await transport.nextSentRequest())
        #expect(next["method"] == "profiles.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
        _ = try await listing.value
        await backend.disconnect()
    }

    // MARK: Fleet

    @Test func aTurnAMessageThroughPortalsOpenedSaysSo() {
        let opened = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["opened_by": "portals", "text": "[Portals: from Aeri (thread aeri)]\nCheck the build"])
        #expect(HermesEventMapper.threadEvents(for: opened) == [.turnOpened(by: "[Portals: from Aeri (thread aeri)]\nCheck the build")])
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "message.start", sessionID: "s1", payload: [:])) == [.turnStarted])
    }

    // MARK: Subagents

    /// A bridge with `subagents_clear` names the ended ones that left the line as a
    /// message went to the agent; one with `subagent_names` names a Codex sub-agent.
    @Test func theEndedSubagentsLeaveTheLineAndASubAgentHasItsNickname() {
        let cleared = GatewayEvent(type: "subagent.cleared", sessionID: "s1", payload: ["subagent_ids": ["a", "b"]])
        #expect(HermesEventMapper.threadEvents(for: cleared, features: [BridgeWire.Feature.subagentsClear]) == [.subagentsCleared(["a", "b"])])
        #expect(HermesEventMapper.threadEvents(for: cleared).isEmpty)
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "subagent.cleared", sessionID: "s1", payload: [:]), features: [BridgeWire.Feature.subagentsClear]).isEmpty)

        let started = GatewayEvent(type: "subagent.start", sessionID: "s1", payload: [
            "subagent_id": "t1", "kind": "agent", "goal": "pear reply", "nickname": "Darwin", "role": "worker", "status": "running", "turn": 1, "started_at": 10,
        ])
        guard case let .subagent(agent)? = HermesEventMapper.threadEvents(for: started).first else {
            Issue.record("no news")
            return
        }
        #expect(agent.nickname == "Darwin")
        #expect(agent.role == "worker")
        #expect(agent.title == "Darwin · worker")
        #expect(agent.goal == "pear reply")
        #expect(agent.parentID == nil)
        let nested = GatewayEvent(type: "subagent.start", sessionID: "s1", payload: ["subagent_id": "t2", "goal": "fig check", "parent_id": "t1", "status": "running"])
        guard case let .subagent(inner)? = HermesEventMapper.threadEvents(for: nested).first else {
            Issue.record("no news")
            return
        }
        #expect(inner.parentID == "t1")
    }

    // MARK: Modes

    @Test func aThreadsModeAndAPlanAreReadOnlyFromABridgeThatOffersModes() throws {
        let modes: Set<String> = ["modes"]
        let changed = GatewayEvent(type: "session.mode", sessionID: "s1", payload: ["mode": "plan", "mode_default": "full"])
        #expect(HermesEventMapper.threadEvents(for: changed, features: modes) == [.modeChanged(ModeState(mode: .plan, defaultsTo: .full))])
        #expect(HermesEventMapper.threadEvents(for: changed).isEmpty)
        #expect(ModeState(mode: .settings, defaultsTo: .full).effective == .full)

        let plan = ServerRequest(id: "r1", method: "approval", params: [
            "command": "# Plan\n1. Do it", "description": "Claude has a plan", "choices": ["once", "deny"], "plan": true, "starts_in": "full",
        ])
        guard case let .approval(approval)? = HermesEventMapper.pendingRequest(plan, features: modes)?.kind else {
            Issue.record("expected an approval")
            return
        }
        #expect(approval.plan == PlanApproval(startsIn: .full))
        guard case let .approval(plain)? = HermesEventMapper.pendingRequest(plan)?.kind else {
            Issue.record("expected an approval")
            return
        }
        #expect(plain.plan == nil)
        // Keep planning, with what to change.
        let pending = PendingRequest(id: "r1", kind: .approval(approval))
        #expect(HermesEventMapper.result(for: .declined(note: "Use SQLite"), to: pending) == ["choice": "deny", "note": "Use SQLite"])
        #expect(RequestAnswer.declined(note: "Use SQLite").summary(for: pending) == "Kept planning: Use SQLite")
        #expect(RequestAnswer.approval(.once).summary(for: pending) == "Started")
    }

    @Test func anyApprovalTakesANoteWithANoOnlyFromABridgeThatOffersApprovalNotes() throws {
        let command = ServerRequest(id: "r2", method: "approval", params: [
            "command": "rm -rf build", "description": "Codex wants to run a command", "choices": ["once", "session", "deny"],
        ])
        guard case let .approval(noted)? = HermesEventMapper.pendingRequest(command, features: ["approval_notes"])?.kind,
              case let .approval(plain)? = HermesEventMapper.pendingRequest(command, features: ["modes"])?.kind else {
            Issue.record("expected approvals")
            return
        }
        #expect(noted.takesNote == true)
        #expect(noted.plan == nil)
        #expect(plain.takesNote == nil)
        #expect(plain == ApprovalRequest(command: "rm -rf build", reason: "Codex wants to run a command", choices: [.once, .session, .deny]))
        let pending = PendingRequest(id: "r2", kind: .approval(noted))
        #expect(HermesEventMapper.result(for: .declined(note: "Delete dist instead"), to: pending) == ["choice": "deny", "note": "Delete dist instead"])
        #expect(HermesEventMapper.result(for: .approval(.deny), to: pending) == ["choice": "deny"])
        #expect(RequestAnswer.declined(note: "Delete dist instead").summary(for: pending) == "Denied: Delete dist instead")
        // A request saved before the key is read as one without it.
        let saved = try JSONEncoder().encode(plain)
        #expect(!String(decoding: saved, as: UTF8.self).contains("takesNote"))
        #expect(try JSONDecoder().decode(ApprovalRequest.self, from: saved) == plain)
        #expect(try JSONDecoder().decode(ApprovalRequest.self, from: JSONEncoder().encode(noted)).takesNote == true)
    }

    @Test func aModeIsChangedOnTheThreadsSession() async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["modes"]]]
        let (backend, transport) = try await connect(ready: ready)
        #expect(await backend.offersModes == true)
        let creating = Task { try await backend.createThread(with: claude, options: ThreadOptions()) }
        let create = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(create["id"]), "result": ["session_id": "s1", "stored_session_id": "s1"]])
        let thread = try await creating.value
        let changing = Task { try await backend.setMode(.plan, in: thread.id) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.set_mode")
        #expect(request["params"] == ["session_id": "s1", "mode": "plan", "profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": ["mode": "plan", "mode_default": "full"]])
        #expect(try await changing.value == ModeState(mode: .plan, defaultsTo: .full))
        await backend.disconnect()
    }

    // MARK: Question details

    @Test func aQuestionsHeadingAndWhatItsChoicesMeanAreReadOnlyFromABridgeThatOffersThem() throws {
        let params: JSONValue = ["questions": [[
            "qid": "q0", "question": "How should users sign in?", "choices": ["Passkeys", "Password"], "multi_select": false,
            "header": " Auth method ", "descriptions": ["Passkeys": "No passwords; Face ID", "Password": 3],
        ]]]
        let request = ServerRequest(id: "r1", method: "clarify", params: params)
        guard case let .clarify(detailed)? = HermesEventMapper.pendingRequest(request, features: ["question_details"])?.kind else {
            Issue.record("expected a question card")
            return
        }
        #expect(detailed[0].header == "Auth method")
        // An entry that is not text costs only itself.
        #expect(detailed[0].descriptions == ["Passkeys": "No passwords; Face ID"])
        guard case let .clarify(plain)? = HermesEventMapper.pendingRequest(request)?.kind else {
            Issue.record("expected a question card")
            return
        }
        #expect(plain[0].header == nil && plain[0].descriptions == nil)
        #expect(plain[0].choices == ["Passkeys", "Password"])
    }

    // MARK: Default levels

    @Test func eachModelRunsAtItsOwnLevelWhenAThreadChoosesNone() async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["model_default_levels"]]]
        let (backend, transport) = try await connect(ready: ready)
        let asking = Task { try await backend.modelCatalog(for: claude) }
        let options = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(options["id"]), "result": [
            "providers": [["slug": "anthropic", "name": "Claude", "models": ["default", "sonnet", "haiku"]]],
            "model": "default", "provider": "anthropic",
            "model_default_levels": ["default": "xhigh", "sonnet": "medium", "haiku": "dreaming"],
        ]])
        let reasoning = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(reasoning["id"]), "result": ["value": "xhigh"]])
        let catalog = try await asking.value
        #expect(catalog.defaultLevelsByModel == ["default": .extraHigh, "sonnet": .medium])
        // The agent's own, a model with a level of its own, one chosen, and one that says none.
        #expect(catalog.setting(for: nil).level == .extraHigh)
        #expect(catalog.setting(for: ModelSetting(model: "sonnet", provider: "anthropic")).level == .medium)
        #expect(catalog.setting(for: ModelSetting(model: "sonnet", provider: "anthropic", level: .high)).level == .high)
        #expect(catalog.setting(for: ModelSetting(model: "haiku", provider: "anthropic")).level == .extraHigh)
        await backend.disconnect()
    }

    // MARK: Activity

    @Test func aBridgeSaysWhichThreadsAreAtWorkAndHermesIsNeverAsked() async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity"]]]
        let (backend, transport) = try await connect(ready: ready)
        #expect(await backend.reportsActivity == true)
        let asking = Task { try await backend.threadActivity() }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "sessions.activity")
        #expect(request["params"] == [:])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": ["sessions": [
            ["session_id": "a", "state": "running"],
            ["session_id": "b", "state": "waiting"],
            ["session_id": "c", "state": "dreaming"],
        ]]])
        #expect(try await asking.value == ThreadActivityReport(threads: [ThreadRef.ID(rawValue: "a"): .running, ThreadRef.ID(rawValue: "b"): .waiting]))
        await backend.disconnect()

        let (hermes, _) = try await connect(ready: Self.hermesReady)
        #expect(await hermes.reportsActivity == false)
        #expect(try await hermes.threadActivity() == ThreadActivityReport())
        await hermes.disconnect()
    }

    // MARK: Folders

    @Test func aBridgeListsItsFolders() async throws {
        let (backend, transport) = try await connect(ready: Self.bridgeReady)
        #expect(await backend.offersFolders == true)
        #expect(await backend.hostFeatures == ["folders", "model_levels", "push_host"])
        let listing = Task { try await backend.folders(for: claude) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "folders.list")
        #expect(request["params"] == ["profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "general": ["path": "/Users/dev/coding_projects", "name": "General"],
            "folders": [
                ["path": "/Users/dev/coding_projects/aerirc", "name": "aerirc", "last_used": 1_791_324_000],
                ["path": "/Users/dev/coding_projects/old"],
            ],
        ]])
        let list = try await listing.value
        #expect(list.general == Folder(path: "/Users/dev/coding_projects", name: "No project", isGeneral: true))
        #expect(list.recent == [
            Folder(path: "/Users/dev/coding_projects/aerirc", name: "aerirc", lastUsed: Date(timeIntervalSince1970: 1_791_324_000)),
            Folder(path: "/Users/dev/coding_projects/old", name: "old"),
        ])
        await backend.disconnect()
    }

    @Test func hermesIsNeverAskedForFolders() async throws {
        let (backend, transport) = try await connect(ready: Self.hermesReady)
        #expect(await backend.offersFolders == false)
        #expect(await backend.hostFeatures.isEmpty)
        await #expect(throws: FolderError.unavailable) { try await backend.folders(for: claude) }
        // The next thing sent is whatever is asked next: nothing went out for the folders.
        let listing = Task { try await backend.listAgents() }
        let next = try #require(await transport.nextSentRequest())
        #expect(next["method"] == "profiles.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
        _ = try await listing.value
        await backend.disconnect()
    }

    @Test func beforeConnectingNobodyKnowsAboutFolders() async {
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t")
        )
        #expect(await backend.offersFolders == nil)
    }

    @Test func aThreadKnowsTheFolderTheHostPutItIn() async throws {
        let (backend, transport) = try await connect(ready: Self.bridgeReady)
        let creating = Task {
            try await backend.createThread(with: claude, options: ThreadOptions(workingDirectory: "/Users/dev/coding_projects/aerirc-link"))
        }
        let create = try #require(await transport.nextSentRequest())
        #expect(create["params"]?["cwd"] == "/Users/dev/coding_projects/aerirc-link")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(create["id"]), "result": [
            "session_id": "s1", "stored_session_id": "s1", "info": ["cwd": "/Users/dev/coding_projects/aerirc"],
        ]])
        // The host's word for it: its real path.
        #expect(try await creating.value.workingDirectory == "/Users/dev/coding_projects/aerirc")

        // A host that does not say keeps the folder asked for.
        let other = Task { try await backend.createThread(with: claude, options: ThreadOptions(workingDirectory: "/Users/dev/notes")) }
        let second = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "result": ["session_id": "s2"]])
        #expect(try await other.value.workingDirectory == "/Users/dev/notes")

        // Reopened, a thread hears it again.
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s0"), agent: claude)
        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": [
            "session_id": "s0", "messages": [], "info": ["cwd": "/Users/dev/coding_projects"],
        ]])
        #expect(try await opening.value.workingDirectory == "/Users/dev/coding_projects")
        await backend.disconnect()
    }

    /// A Droid thread whose bridge, from before 2026-10-23, still has a Spec model of its
    /// own, set from the menu the app no longer has, is put back to follow the thread's
    /// model as it is opened; one that follows it already, or a newer bridge, is left alone.
    @Test func anOlderBridgesOwnSpecModelIsResetAsTheThreadOpens() async throws {
        let (backend, transport) = try await connect(ready: Self.bridgeReady)
        let droid = Agent.ID(host: HostID(rawValue: "mac"), name: "droid")
        for (spec, effort, resets) in [("large", "high", true), ("default", "high", true), ("default", "", false), (nil, nil, false)] as [(String?, String?, Bool)] {
            let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s0"), agent: droid)
            let opening = Task { try await backend.openThread(ref) }
            let resume = try #require(await transport.nextSentRequest())
            var info: [String: JSONValue] = ["model": "small"]
            if let spec { info["spec_model"] = .string(spec) }
            if let effort { info["spec_reasoning_effort"] = .string(effort) }
            transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": [
                "session_id": "s0", "messages": [], "info": .object(info),
            ]])
            if resets {
                let reset = try #require(await transport.nextSentRequest())
                #expect(reset["method"] == "session.set_spec_model")
                #expect(reset["params"]?["session_id"] == "s0")
                #expect(reset["params"]?["model"] == "default")
                #expect(reset["params"]?["reasoning_effort"] == "default")
                transport.deliver(["jsonrpc": "2.0", "id": try #require(reset["id"]), "result": [
                    "spec_model": "default", "spec_reasoning_effort": "", "deferred": false,
                ]])
            }
            // Opened once the reset is answered: a message sent at once is not planned with it.
            _ = try await opening.value
        }
        // Nothing else was asked: the next request is the one made here.
        let ping = Task { try await backend.openThread(ThreadRef(id: ThreadRef.ID(rawValue: "s9"), agent: droid)) }
        let next = try #require(await transport.nextSentRequest())
        #expect(next["params"]?["session_id"] == "s9")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["session_id": "s9", "messages": []]])
        _ = try await ping.value
        await backend.disconnect()
    }

    // MARK: Thinking levels

    private func catalog(ready: JSONValue, levels: JSONValue, names: JSONValue = .null) async throws -> ModelCatalog {
        let (backend, transport) = try await connect(ready: ready)
        let loading = Task { try await backend.modelCatalog(for: claude) }
        let options = try #require(await transport.nextSentRequest())
        #expect(options["params"] == ["profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(options["id"]), "result": [
            "model": "default", "provider": "anthropic",
            "providers": [["slug": "anthropic", "name": "Claude", "authenticated": true, "models": ["default", "sonnet", "haiku"]]],
            "model_levels": levels,
            "model_names": names,
        ]])
        let reasoning = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(reasoning["id"]), "result": ["value": "high"]])
        let catalog = try await loading.value
        await backend.disconnect()
        return catalog
    }

    @Test func aBridgeSaysWhichLevelsEachModelTakes() async throws {
        let catalog = try await catalog(ready: Self.bridgeReady, levels: [
            "default": ["low", "medium", "high", "xhigh", "max"],
            // Out of order, with a level the app does not know and a non-string: read leniently.
            "sonnet": ["high", "low", "turbo", 3],
            "haiku": "all of them",
            "gone": [],
        ])
        #expect(catalog.levelsByModel == ["default": [.low, .medium, .high, .extraHigh, .max], "sonnet": [.low, .high]])
        #expect(catalog.levels(for: "sonnet") == [.low, .high])
        #expect(catalog.levels(for: "haiku") == ThinkingLevel.allCases)
        #expect(catalog.agentDefault.level == .high)
    }

    @Test func anEmptyListIsAModelWithNoLevelsFromABridgeThatSaysSo() async throws {
        let ready: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["model_levels", "model_levels_none"]],
        ]
        let catalog = try await catalog(ready: ready, levels: [
            "default": [],
            "sonnet": ["high", "low"],
            // Names the app does not know are not "none": the model takes any level.
            "haiku": ["turbo"],
        ])
        #expect(catalog.levelsByModel == ["default": [], "sonnet": [.low, .high]])
        #expect(catalog.levels(for: "default").isEmpty)
        #expect(!catalog.takesLevels("default"))
        #expect(catalog.takesLevels("sonnet"))
        #expect(catalog.levels(for: "haiku") == ThinkingLevel.allCases)
    }

    @Test func levelsFromAHostThatDoesNotOfferThemAreIgnored() async throws {
        let catalog = try await catalog(ready: Self.hermesReady, levels: ["default": ["low"]])
        #expect(catalog.levelsByModel == nil)
        #expect(catalog.levels(for: "default") == ThinkingLevel.allCases)
    }

    // MARK: Model names

    private static let namesReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": ["protocol": 1, "features": ["folders", "model_levels", "push_host", "desk_sessions", "model_names"]],
    ]

    @Test func aBridgeSaysWhatToCallEachModel() async throws {
        let catalog = try await catalog(ready: Self.namesReady, levels: [:], names: [
            "default": "Opus 5.5", "opus": "Opus 5.5", "sonnet": " Sonnet 5.5 ",
            // Not names: read leniently, each costs only itself.
            "haiku": 4.5, "gone": "",
        ])
        #expect(catalog.namesByModel == ["default": "Opus 5.5", "opus": "Opus 5.5", "sonnet": "Sonnet 5.5"])
        #expect(catalog.shortName(of: catalog.agentDefault) == "Opus 5.5")
        #expect(catalog.name(of: "haiku") == "haiku")
        #expect(catalog.marksAsDefault("default", at: "anthropic"))
    }

    @Test func namesFromAHostThatDoesNotOfferThemAreIgnored() async throws {
        // An older bridge, and Hermes.
        for ready in [Self.bridgeReady, Self.hermesReady] {
            let catalog = try await catalog(ready: ready, levels: [:], names: ["default": "Opus 5.5"])
            #expect(catalog.namesByModel == nil)
            #expect(catalog.shortName(of: catalog.agentDefault) == "default")
            #expect(!catalog.marksAsDefault("default", at: "anthropic"))
        }
    }

    // MARK: Message-level forks

    @Test(arguments: [false, true])
    func messageForkUsesProviderPositionAndFollowsTheNewStoredThread(before: Bool) async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["message_fork"]]]
        let (backend, transport) = try await connect(ready: ready)
        #expect(await backend.offersMessageFork == true)
        let source = ThreadRef(id: .init(rawValue: "stored-source"), agent: claude, workingDirectory: "/project")
        let checkpoint = MessageCheckpoint(id: "provider/opaque:turn-4", canFork: true, canEdit: true)
        let forking = Task { try await backend.fork(source, at: checkpoint, before: before) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.fork")
        #expect(request["params"] == ["session_id": "stored-source", "checkpoint_id": "provider/opaque:turn-4", "before": .bool(before)])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "session_id": "runtime-fork", "stored_session_id": "stored-fork", "info": ["cwd": "/project", "title": "Forked request"],
        ]])
        let fork = try await forking.value
        #expect(fork.id.rawValue == "stored-fork")
        #expect(fork.agent == source.agent)
        #expect(fork.workingDirectory == "/project")
        #expect(!fork.isReadOnly)
        let events = await backend.events(for: fork.id)
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .caughtUp(ThreadInfo(title: "Forked request", workingDirectory: "/project")))
        await backend.disconnect()
    }

    @Test func messageForkRejectsOldHostsAndDeniedActionsWithoutSendingAnRPC() async throws {
        let cases: [(JSONValue, MessageCheckpoint)] = [
            (Self.bridgeReady, MessageCheckpoint(id: "position", canFork: true, canEdit: true)),
            (["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["message_fork"]]],
             MessageCheckpoint(id: "position", canFork: false, canEdit: false)),
        ]
        for (ready, checkpoint) in cases {
            let (backend, transport) = try await connect(ready: ready)
            let source = ThreadRef(id: .init(rawValue: "stored-source"), agent: claude)
            for before in [false, true] {
                await #expect(throws: MessageForkError.unavailable) { try await backend.fork(source, at: checkpoint, before: before) }
            }
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    // MARK: Latest-turn file undo

    private static let fileUndoReady: JSONValue = ["replay_epoch": "e1", "heartbeat": false,
                                                  "bridge": ["protocol": 1, "features": ["turn_file_undo"]]]

    private func fileUndoPreview(on backend: HermesBackend, transport: ScriptedTransport, thread: ThreadRef, files: JSONValue = ["src/app.swift"]) async throws -> TurnFileUndoPreview {
        let checkpoint = MessageCheckpoint(id: "native-turn", canFork: true, canEdit: true, canUndoFiles: true)
        let fetching = Task { try await backend.previewFileUndo(thread, checkpoint: checkpoint) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.files.preview")
        #expect(request["params"] == ["session_id": .string(thread.id.rawValue), "checkpoint_id": "native-turn"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "preview_id": "review-1", "files": files, "insertions": 3, "deletions": 1,
            "expires_at": .number(Date.now.addingTimeInterval(60).timeIntervalSince1970),
        ]])
        return try await fetching.value
    }

    @Test(arguments: [TurnFileUndoResult(restored: true, skippedLinks: 0), TurnFileUndoResult(restored: true, skippedLinks: 2), TurnFileUndoResult(restored: false, skippedLinks: 0)])
    func fileUndoUsesOneReviewedPreviewAndPreservesPartialResults(expected: TurnFileUndoResult) async throws {
        let (backend, transport) = try await connect(ready: Self.fileUndoReady)
        #expect(await backend.offersTurnFileUndo == true)
        let thread = ThreadRef(id: .init(rawValue: "stored"), agent: claude)
        let preview = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        let applying = Task { try await backend.undoFiles(thread, preview: preview) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.files.undo")
        #expect(request["params"] == ["session_id": "stored", "preview_id": "review-1", "confirmed": true])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "restored": .bool(expected.restored), "skipped_links": .number(Double(expected.skippedLinks)),
        ]])
        #expect(try await applying.value == expected)
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: preview) }
        await backend.disconnect()
    }

    @Test func fileUndoRefusesOldHostsEmptyPreviewsWrongThreadsAndRefreshedPermits() async throws {
        let thread = ThreadRef(id: .init(rawValue: "stored"), agent: claude)
        let checkpoint = MessageCheckpoint(id: "native-turn", canFork: true, canEdit: true, canUndoFiles: true)
        let (older, oldTransport) = try await connect(ready: Self.bridgeReady)
        #expect(await older.offersTurnFileUndo == false)
        await #expect(throws: TurnFileUndoError.unavailable) { try await older.previewFileUndo(thread, checkpoint: checkpoint) }
        let fabricated = TurnFileUndoPreview(previewID: "review", files: ["src/app.swift"], expiresAt: .now.addingTimeInterval(60))
        await #expect(throws: TurnFileUndoError.unavailable) { try await older.undoFiles(thread, preview: fabricated) }
        let listing = Task { try await older.listAgents() }
        let next = try #require(await oldTransport.nextSentRequest())
        #expect(next["method"] == "profiles.list")
        oldTransport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
        _ = try await listing.value
        await older.disconnect()

        let (backend, transport) = try await connect(ready: Self.fileUndoReady)
        let denied = MessageCheckpoint(id: "native-turn", canFork: true, canEdit: true)
        await #expect(throws: TurnFileUndoError.unavailable) { try await backend.previewFileUndo(thread, checkpoint: denied) }
        let readOnly = ThreadRef(id: .init(rawValue: "read-only"), agent: claude, readOnly: true)
        await #expect(throws: TurnFileUndoError.unavailable) { try await backend.previewFileUndo(readOnly, checkpoint: checkpoint) }
        let empty = try await fileUndoPreview(on: backend, transport: transport, thread: thread, files: [])
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: empty) }
        let first = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        _ = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: first) }
        let other = ThreadRef(id: .init(rawValue: "other"), agent: claude)
        let latest = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(other, preview: latest) }
        let beforeDisconnect = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        await backend.disconnect()
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: beforeDisconnect) }
    }

    @Test func onlyTypedPreRestoreFileChangesCanRequestANewPreview() async throws {
        let (backend, transport) = try await connect(ready: Self.fileUndoReady)
        let thread = ThreadRef(id: .init(rawValue: "stored"), agent: claude)
        let cases: [(Int, JSONValue?, Bool)] = [
            (JSONRPCError.invalidParamsCode, ["reason": "files_changed"], true),
            (JSONRPCError.invalidParamsCode, nil, false),
            (-32603, ["reason": "files_changed"], false),
            (JSONRPCError.invalidParamsCode, ["reason": "other"], false),
        ]
        for (code, data, mayRefresh) in cases {
            let preview = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
            let applying = Task { try await backend.undoFiles(thread, preview: preview) }
            let request = try #require(await transport.nextSentRequest())
            var error: [String: JSONValue] = ["code": .number(Double(code)), "message": "Files changed after this preview."]
            if let data { error["data"] = data }
            transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "error": .object(error)])
            do {
                _ = try await applying.value
                Issue.record("Expected a refused restore")
            } catch {
                if mayRefresh { #expect(error as? TurnFileUndoError == .filesChangedBeforeRestore) }
                else { #expect((error as? JSONRPCError)?.code == code) }
            }
            await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: preview) }
        }
        await backend.disconnect()
    }

    @Test func aRejectedRestoreConsumesThePreviewAndRequiresFreshReview() async throws {
        let (backend, transport) = try await connect(ready: Self.fileUndoReady)
        let thread = ThreadRef(id: .init(rawValue: "stored"), agent: claude)
        let preview = try await fileUndoPreview(on: backend, transport: transport, thread: thread)
        let applying = Task { try await backend.undoFiles(thread, preview: preview) }
        let request = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "error": ["code": -32602, "message": "Files changed. Refresh the preview."]])
        await #expect { try await applying.value } throws: { $0.localizedDescription.contains("Files changed") }
        await #expect(throws: TurnFileUndoError.stalePreview) { try await backend.undoFiles(thread, preview: preview) }
        await backend.disconnect()
    }

    // MARK: Sessions from the desk

    private static let deskReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": ["protocol": 1, "features": ["folders", "model_levels", "push_host", "desk_sessions"]],
    ]

    @Test func aBridgeListsTheSessionsStartedOnIt() async throws {
        let (backend, transport) = try await connect(ready: Self.deskReady)
        #expect(await backend.offersDeskSessions == true)
        let listing = Task { try await backend.deskSessions(for: claude) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "desk.list")
        #expect(request["params"] == ["profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": ["sessions": [
            ["id": "s1", "title": "Fix the login", "folder": "/Users/dev/coding_projects/app", "updated": 1_791_324_000, "state": "open"],
            ["id": "s2", "title": "Count to ten", "folder": "/Users/dev/coding_projects/app", "updated": 1_791_323_000, "state": "waiting"],
            // Only forked (a chat of Cursor's terminal); modes the app does not know say nothing.
            ["id": "c1", "title": "From the terminal", "folder": "/Users/dev/notes", "state": "closed", "adopt_modes": ["fork"]],
            ["id": "c2", "title": "From later", "folder": "/Users/dev/notes", "state": "closed", "adopt_modes": ["teleport"]],
            // Read leniently: an unknown state, a missing title and time, rows without an id or folder.
            ["id": "s3", "folder": "/Users/dev/notes", "state": "hibernating"],
            ["title": "No id", "folder": "/Users/dev/notes", "state": "closed"],
            ["id": "s5", "title": "No folder", "state": "closed"],
            "not a row",
        ]]])
        let sessions = try await listing.value
        #expect(sessions == [
            DeskSession(id: "s1", agent: claude, title: "Fix the login", folder: "/Users/dev/coding_projects/app", updated: Date(timeIntervalSince1970: 1_791_324_000), state: .open),
            DeskSession(id: "s2", agent: claude, title: "Count to ten", folder: "/Users/dev/coding_projects/app", updated: Date(timeIntervalSince1970: 1_791_323_000), state: .waiting),
            DeskSession(id: "c1", agent: claude, title: "From the terminal", folder: "/Users/dev/notes", state: .closed, adoptModes: [.fork]),
            DeskSession(id: "c2", agent: claude, title: "From later", folder: "/Users/dev/notes", state: .closed),
            DeskSession(id: "s3", agent: claude, title: nil, folder: "/Users/dev/notes", state: .idle),
        ])
        await backend.disconnect()
    }

    @Test func aDeskSessionTakenUpIsAThreadLikeANewOne() async throws {
        let (backend, transport) = try await connect(ready: Self.deskReady)
        let session = DeskSession(id: "s1", agent: claude, title: "Fix the login", folder: "/Users/dev/coding_projects/app", state: .closed)
        let adopting = Task { try await backend.adopt(session, as: .continue) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "session.adopt")
        #expect(request["params"] == ["profile": "claude", "session_id": "s1", "mode": "continue"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "session_id": "s1", "stored_session_id": "s1",
            "info": ["cwd": "/Users/dev/coding_projects/app", "title": "Fix the login", "model": "default", "running": false],
        ]])
        let thread = try await adopting.value
        #expect(thread == ThreadRef(
            id: ThreadRef.ID(rawValue: "s1"), agent: claude, title: "Fix the login", createdAt: thread.createdAt,
            workingDirectory: "/Users/dev/coding_projects/app"
        ))
        #expect(!thread.isReadOnly)

        // Its settings are buffered before what happens in it, as in a new thread.
        let events = await backend.events(for: thread.id)
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.start", "session_id": "s1", "seq": 1, "payload": [:]]])
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .caughtUp(ThreadInfo(
            title: "Fix the login", model: ModelSetting(model: "default"), workingDirectory: "/Users/dev/coding_projects/app"
        )))
        #expect(await iterator.next() == .turnStarted)

        // Only read: the thread says so; a fork is another thread.
        let reading = Task { try await backend.adopt(session, as: .read) }
        let read = try #require(await transport.nextSentRequest())
        #expect(read["params"]?["mode"] == "read")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(read["id"]), "result": ["session_id": "s1", "stored_session_id": "s1", "info": ["title": "Fix the login"]]])
        #expect(try await reading.value.isReadOnly)
        let forking = Task { try await backend.adopt(session, as: .fork) }
        let fork = try #require(await transport.nextSentRequest())
        #expect(fork["params"]?["mode"] == "fork")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(fork["id"]), "result": [
            "session_id": "f1", "stored_session_id": "f1", "info": ["cwd": "/Users/dev/coding_projects/app", "title": "Fix the login (fork)"],
        ]])
        let forked = try await forking.value
        #expect(forked.id.rawValue == "f1")
        #expect(forked.title == "Fix the login (fork)")
        #expect(!forked.isReadOnly)
        await backend.disconnect()
    }

    @Test func aRefusalIsTheHostsSentence() async throws {
        let (backend, transport) = try await connect(ready: Self.deskReady)
        let session = DeskSession(id: "s1", agent: claude, folder: "/Users/dev/app", state: .closed)
        let adopting = Task { try await backend.adopt(session, as: .continue) }
        let request = try #require(await transport.nextSentRequest())
        let sentence = "This session is open in a terminal on the Mac. Close it there, or fork it, to continue it here."
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "error": ["code": -32602, "message": .string(sentence)]])
        await #expect { try await adopting.value } throws: { $0.localizedDescription == sentence }
        await backend.disconnect()
    }

    // MARK: Compaction

    private static let compactionReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": ["protocol": 1, "features": ["folders", "model_levels", "push_host", "desk_sessions", "compaction"]],
    ]

    /// Where a thread's conversation was compacted, live and read back, from a host that
    /// lists `compaction`; nothing of it from one that does not.
    @Test func aCompactionIsReadOnlyFromAHostThatOffersIt() async throws {
        for (ready, offers) in [(Self.compactionReady, true), (Self.deskReady, false), (Self.hermesReady, false)] {
            let (backend, transport) = try await connect(ready: ready)
            let creating = Task { try await backend.createThread(with: claude, options: ThreadOptions()) }
            let create = try #require(await transport.nextSentRequest())
            transport.deliver(["jsonrpc": "2.0", "id": try #require(create["id"]), "result": ["session_id": "s1", "stored_session_id": "s1"]])
            let thread = try await creating.value

            let events = await backend.events(for: thread.id)
            transport.deliver(["jsonrpc": "2.0", "method": "event", "params": [
                "type": "session.compacted", "session_id": "s1", "seq": 1, "payload": ["trigger": "manual", "tokens_before": 24_063],
            ]])
            transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.complete", "session_id": "s1", "seq": 2, "payload": ["status": "complete"]]])
            var iterator = events.makeAsyncIterator()
            if offers {
                #expect(await iterator.next() == .compacted(Compaction(.manual, tokensBefore: 24_063)))
            }
            #expect(await iterator.next() == .turnFinished(.completed, finalText: nil))

            let opening = Task { try await backend.openThread(thread) }
            let resume = try #require(await transport.nextSentRequest())
            transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": [
                "session_id": "s1", "messages": [
                    ["role": "user", "text": "/compact", "timestamp": 10],
                    ["role": "compaction", "trigger": "manual", "tokens_before": 24_063, "timestamp": 21],
                ],
            ]])
            let items = try await opening.value.transcript.turns.flatMap(\.items).map(\.content)
            #expect(items.contains(.compaction(Compaction(.manual, tokensBefore: 24_063))) == offers)
            await backend.disconnect()
        }
    }

    /// Read leniently: what is not `auto` was asked for, and a count that is not a
    /// whole number above nothing is not one.
    @Test func aCompactionIsReadLeniently() {
        #expect(BridgeWire.compaction(from: ["trigger": "auto", "tokens_before": 180_000]) == Compaction(.auto, tokensBefore: 180_000))
        #expect(BridgeWire.compaction(from: ["trigger": "manual", "tokens_before": 0]) == Compaction(.manual))
        #expect(BridgeWire.compaction(from: ["tokens_before": "lots"]) == Compaction(.manual))
        #expect(BridgeWire.compaction(from: .null) == Compaction(.manual))
    }

    @Test func noHostWithoutTheFeatureIsAskedForDeskSessions() async throws {
        for ready in [Self.hermesReady, Self.bridgeReady] {
            let (backend, transport) = try await connect(ready: ready)
            #expect(await backend.offersDeskSessions == false)
            await #expect(throws: DeskSessionError.unavailable) { try await backend.deskSessions(for: claude) }
            let session = DeskSession(id: "s1", agent: claude, folder: "/x", state: .closed)
            await #expect(throws: DeskSessionError.unavailable) { try await backend.adopt(session, as: .continue) }
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    private static let queueReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["queue", "files"]],
    ]

    private func createThread(on backend: HermesBackend, _ transport: ScriptedTransport) async throws -> ThreadRef {
        let creating = Task { try await backend.createThread(with: claude, options: ThreadOptions()) }
        let create = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(create["id"]), "result": ["session_id": "s1", "stored_session_id": "s1"]])
        return try await creating.value
    }

    /// A bridge that lists `queue` and `files` is told what a message sent mid-turn is to
    /// do, takes the message's files before it, lists the messages waiting, and acts on
    /// one; Hermes is sent none of it, and a file is refused before anything is sent.
    @Test func aMessageSaysWhatToDoWhenBusyAndItsFilesGoOnlyToABridgeThatTakesThem() async throws {
        let (backend, transport) = try await connect(ready: Self.queueReady)
        let thread = try await createThread(on: backend, transport)
        let notes = FileAttachment(data: Data("hi".utf8), filename: "notes.txt")
        let sending = Task { try await backend.send("read", images: [], files: [notes], whenBusy: .queue, to: thread.id) }
        let attach = try #require(await transport.nextSentRequest())
        #expect(attach["method"]?.stringValue == "file.attach_bytes")
        #expect(attach["params"]?["content_base64"]?.stringValue == "aGk=")
        #expect(attach["params"]?["filename"]?.stringValue == "notes.txt")
        // Its own id goes with it, so a Mac that has it already does not take it twice.
        #expect(attach["params"]?["id"]?.stringValue == notes.id.uuidString)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(attach["id"]), "result": ["attached": true, "name": "notes.txt", "path": "/w/.portals/files/s1/notes.txt"]])
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["method"]?.stringValue == "prompt.submit")
        #expect(submit["params"]?["when_busy"]?.stringValue == "queue")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "queued", "queue_id": "3"]])
        #expect(try await sending.value == SendReceipt(.queued, queueID: "3"))

        let events = await backend.events(for: thread.id)
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": [
            "type": "queue.changed", "session_id": "s1", "seq": 1, "payload": ["queued": [["id": "3", "text": "read"], ["id": "4", "text": "hi", "fleet": true]], "can_steer": true],
        ]])
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.start", "session_id": "s1", "seq": 2, "payload": ["queue_id": "3"]]])
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .queueChanged([QueuedMessage(id: "3", text: "read"), QueuedMessage(id: "4", text: "hi", fromFleet: true)], canSteer: true, steered: nil))
        #expect(await iterator.next() == .queuedTurnStarted("3"))

        let steering = Task { try await backend.steerQueued("4", in: thread.id) }
        let steer = try #require(await transport.nextSentRequest())
        #expect(steer["method"]?.stringValue == "prompt.queue.steer")
        #expect(steer["params"]?["queue_id"]?.stringValue == "4")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(steer["id"]), "result": ["status": "steered"]])
        #expect(try await steering.value == .steered)
        let removing = Task { try await backend.removeQueued("4", in: thread.id) }
        let remove = try #require(await transport.nextSentRequest())
        #expect(remove["method"]?.stringValue == "prompt.queue.remove")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(remove["id"]), "result": ["removed": false]])
        #expect(try await removing.value == false)
        #expect(await backend.listsQueue == true)
        #expect(await backend.attachesFiles == true)
        await backend.disconnect()

        let (hermes, hermesTransport) = try await connect(ready: Self.hermesReady)
        let onHermes = try await createThread(on: hermes, hermesTransport)
        await #expect(throws: HermesBackendError.fileNotAccepted(nil)) {
            try await hermes.send("read", images: [], files: [notes], whenBusy: .queue, to: onHermes.id)
        }
        let plain = Task { try await hermes.send("read", images: [], files: [], whenBusy: .queue, to: onHermes.id) }
        let hermesSubmit = try #require(await hermesTransport.nextSentRequest())
        #expect(hermesSubmit["method"]?.stringValue == "prompt.submit")
        #expect(hermesSubmit["params"]?["when_busy"] == nil)
        // A place on a list is not taken from a host that does not list it.
        hermesTransport.deliver(["jsonrpc": "2.0", "id": try #require(hermesSubmit["id"]), "result": ["status": "queued", "queue_id": "7"]])
        #expect(try await plain.value == SendReceipt(.queued))
        #expect(await hermes.listsQueue == false)
        await hermes.disconnect()
    }

    // MARK: Every message, on every device

    /// A message sent at rest while the bridge catches up with Codex waits on its list; when
    /// Codex still cannot be reached about 15 seconds on, the bridge opens its turn and fails
    /// it at once (the frames below are what a scratch bridge sent). Every device shows a
    /// failed turn that can be tried again: this one with its own message, another with the
    /// message as the bridge listed it. Nothing is left waiting.
    @Test func aMessageTheBridgeQueuedAtRestAndFailedIsAFailedTurnWithTryAgainOnEveryDevice() {
        let features: Set<String> = ["queue", "turn_messages"]
        let why = "Codex is not reachable right now. The message was not sent."
        let frames: [GatewayEvent] = [
            GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "Sent while Codex is away.", "sender": "user", "message_id": "M1", "queue_id": "1"]),
            GatewayEvent(type: "message.complete", sessionID: "s1", payload: ["status": "error", "text": .string(why), "error_surface": ["retryable": true]]),
            GatewayEvent(type: "queue.changed", sessionID: "s1", payload: ["queued": [], "can_steer": true]),
        ]
        let listed = GatewayEvent(type: "queue.changed", sessionID: "s1", payload: ["queued": [["id": "1", "text": "Sent while Codex is away."]], "can_steer": true])
        let t0 = Date(timeIntervalSince1970: 1_000)

        // This device sent it: it opened a turn here, and the bridge's answer queued it.
        var mine = ThreadState()
        mine.messageDelivered(mine.messageSent("First.", at: t0), outcome: .started, at: t0)
        mine.apply(.turnFinished(.completed, finalText: "The first answer."), at: t0)
        let sent = mine.messageSent("Sent while Codex is away.", at: t0)
        for event in HermesEventMapper.threadEvents(for: listed, features: features) { mine.apply(event, at: t0) }
        mine.messageDelivered(sent, outcome: .queued, queueID: "1", at: t0)
        #expect(mine.pending.map(\.queueID) == ["1"])
        for frame in frames {
            for event in HermesEventMapper.threadEvents(for: frame, features: features, isOwn: { $0 == "M1" }) { mine.apply(event, at: t0) }
        }
        #expect(mine.pending.isEmpty)
        #expect(mine.queued.isEmpty)
        #expect(!mine.isRunning)
        #expect(mine.transcript.turns.count == 2)
        #expect(mine.transcript.turns[1].items.map(\.id) == [sent])
        #expect(mine.transcript.turns[1].outcome == .failed(TurnFailure(message: why, retryable: true)))

        // Another device that follows the thread.
        var other = ThreadState()
        other.messageDelivered(other.messageSent("First.", at: t0), outcome: .started, at: t0)
        other.apply(.turnFinished(.completed, finalText: "The first answer."), at: t0)
        for frame in [listed] + frames {
            for event in HermesEventMapper.threadEvents(for: frame, features: features, isOwn: { _ in false }) { other.apply(event, at: t0) }
        }
        #expect(other.queued.isEmpty)
        #expect(!other.isRunning)
        #expect(other.transcript.turns.count == 2)
        #expect(other.transcript.turns[1].items.map(\.content) == [.user(UserMessage(text: "Sent while Codex is away.", sentAt: t0, delivery: .started))])
        #expect(other.transcript.turns[1].outcome == .failed(TurnFailure(message: why, retryable: true)))
    }

    /// A bridge that lists `turn_messages` says what opened each turn and what was handed
    /// to it, from whichever device; this app's own (by the id it gave it) shows already.
    @Test func aBridgeThatListsTurnMessagesTellsOfEveryMessageButThisAppsOwn() {
        let features: Set<String> = ["queue", "turn_messages"]
        let mine: (String) -> Bool = { $0 == "M1" }
        let theirs = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "Fix it\n@image:photo.png", "sender": "user", "message_id": "T1"])
        #expect(HermesEventMapper.threadEvents(for: theirs, features: features, isOwn: mine) == [.turnOpened(by: "Fix it\n@image:photo.png")])
        let waited = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "next", "sender": "user", "queue_id": "3"])
        #expect(HermesEventMapper.threadEvents(for: waited, features: features, isOwn: mine) == [.turnOpened(by: "next", queueID: "3")])
        let own = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "mine", "sender": "user", "message_id": "M1"])
        #expect(HermesEventMapper.threadEvents(for: own, features: features, isOwn: mine) == [.turnStarted])
        let ownWaited = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "mine", "sender": "user", "message_id": "M1", "queue_id": "4"])
        #expect(HermesEventMapper.threadEvents(for: ownWaited, features: features, isOwn: mine) == [.queuedTurnStarted("4")])
        // This app's own by the id it gave it, a UUID: known as its own, waited on the list or not.
        let ownByID = UUID()
        let byID = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "mine", "sender": "user", "message_id": .string(ownByID.uuidString)])
        #expect(HermesEventMapper.threadEvents(for: byID, features: features, isOwn: { $0 == ownByID.uuidString }) == [.ownTurnStarted(ownByID, queueID: nil)])
        let byIDWaited = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["text": "mine", "sender": "user", "message_id": .string(ownByID.uuidString), "queue_id": "5"])
        #expect(HermesEventMapper.threadEvents(for: byIDWaited, features: features, isOwn: { $0 == ownByID.uuidString }) == [.ownTurnStarted(ownByID, queueID: "5")])
        // One through Portals is another's like any other, and not read twice.
        let fleet = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["opened_by": "portals", "text": "[Portals: from the command line]\nhi", "sender": "portals"])
        #expect(HermesEventMapper.threadEvents(for: fleet, features: features, isOwn: mine) == [.turnOpened(by: "[Portals: from the command line]\nhi")])
        // A turn opened by nothing said.
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "message.start", sessionID: "s1", payload: [:]), features: features) == [.turnStarted])

        let steered = GatewayEvent(type: "message.steered", sessionID: "s1", payload: ["text": "and tabs", "sender": "user", "message_id": "T2"])
        #expect(HermesEventMapper.threadEvents(for: steered, features: features, isOwn: mine) == [.messageSteered("and tabs")])
        let ownID = UUID()
        let ownSteered = GatewayEvent(type: "message.steered", sessionID: "s1", payload: ["text": "and tabs", "sender": "user", "message_id": .string(ownID.uuidString)])
        // This app's own says where the host handed it over, for a message still waiting for its answer.
        #expect(HermesEventMapper.threadEvents(for: ownSteered, features: features, isOwn: { $0 == ownID.uuidString }) == [.ownMessageSteered(ownID)])

        // From a host without the feature: as before.
        #expect(HermesEventMapper.threadEvents(for: theirs, features: ["queue"], isOwn: mine) == [.turnStarted])
        #expect(HermesEventMapper.threadEvents(for: waited, features: ["queue"]) == [.queuedTurnStarted("3")])
        #expect(HermesEventMapper.threadEvents(for: steered, features: ["queue"]).isEmpty)
    }

    private static let turnMessagesReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["queue", "turn_messages"]],
    ]

    /// The id this app gives a message goes with it to a bridge that lists `turn_messages`,
    /// and the turn's start naming it is this app's own; another's opens the turn with it.
    @Test func aMessageGoesWithItsOwnIdAndItsTurnIsKnownAsThisAppsOwn() async throws {
        let (backend, transport) = try await connect(ready: Self.turnMessagesReady)
        let thread = try await createThread(on: backend, transport)
        let events = await backend.events(for: thread.id)
        let sending = Task { try await backend.send("hello", images: [], files: [], whenBusy: .steer, to: thread.id) }
        let submit = try #require(await transport.nextSentRequest())
        let id = try #require(submit["params"]?["message_id"]?.stringValue)
        #expect(UUID(uuidString: id) != nil)
        // The turn's start can come before the answer.
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.start", "session_id": "s1", "seq": 1, "payload": ["text": "hello", "sender": "user", "message_id": .string(id)]]])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "streaming"]])
        #expect(try await sending.value == SendReceipt(.started))
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.complete", "session_id": "s1", "seq": 2, "payload": ["status": "complete", "text": "hi"]]])
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.start", "session_id": "s1", "seq": 3, "payload": ["text": "from the phone", "sender": "user", "message_id": "PHONE-1"]]])
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .ownTurnStarted(try #require(UUID(uuidString: id)), queueID: nil))
        #expect(await iterator.next() == .turnFinished(.completed, finalText: "hi"))
        #expect(await iterator.next() == .turnOpened(by: "from the phone"))
        await backend.disconnect()

        // A bridge without the feature is sent no id.
        let (older, olderTransport) = try await connect(ready: Self.queueReady)
        let onOlder = try await createThread(on: older, olderTransport)
        let plain = Task { try await older.send("hello", images: [], files: [], whenBusy: .steer, to: onOlder.id) }
        let olderSubmit = try #require(await olderTransport.nextSentRequest())
        #expect(olderSubmit["params"]?["message_id"] == nil)
        olderTransport.deliver(["jsonrpc": "2.0", "id": try #require(olderSubmit["id"]), "result": ["status": "streaming"]])
        _ = try await plain.value
        await older.disconnect()
    }

    private static let mentionsReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["queue", "file_search", "file_mentions"]],
    ]

    /// `files.search` goes to a bridge that lists `file_search`, for a thread or a folder,
    /// and its answer is read; a bridge without it, or Hermes, is asked nothing.
    @Test func filesAreSearchedOnlyOnABridgeThatSearchesThem() async throws {
        let (backend, transport) = try await connect(ready: Self.mentionsReady)
        #expect(await backend.searchesFiles == true)
        #expect(await backend.takesFileMentions == true)
        let thread = try await createThread(on: backend, transport)
        let searching = Task { try await backend.searchFiles("fileread", in: .thread(thread.id), limit: 20) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"]?.stringValue == "files.search")
        #expect(request["params"] == ["session_id": "s1", "query": "fileread", "limit": 20])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": [
            "folder": "/Users/dev/portals", "total": 1638, "matched": 3, "source": "git",
            "files": [["path": "bridge/src/sessions/fileRead.ts", "name": "fileRead.ts", "kind": "file", "score": 350, "ranges": [[20, 28]]]],
        ]])
        let results = try await searching.value
        #expect(results.hits.map(\.path) == ["bridge/src/sessions/fileRead.ts"])
        #expect(results.hits.first.map { hit in hit.matchedRanges.map { String(hit.path[$0]) } } == ["fileRead"])

        // A folder the bridge will not search: its sentence.
        let refusing = Task { try await backend.searchFiles("", in: .folder("/etc"), limit: 20) }
        let refused = try #require(await transport.nextSentRequest())
        #expect(refused["params"] == ["folder": "/etc", "query": "", "limit": 20])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(refused["id"]), "error": ["code": -32602, "message": "New threads can only start in General or a folder from the list."]])
        await #expect(throws: FileSearchError.refused("New threads can only start in General or a folder from the list.")) { try await refusing.value }

        // The new-thread screen: the chosen folder, naming the agent the thread will run,
        // whose limit for a mentioned file comes back with the sizes.
        let beforeThread = Task { try await backend.searchFiles("big", in: .folder("/Users/dev/portals"), limit: 20, agent: "claude") }
        let newThread = try #require(await transport.nextSentRequest())
        #expect(newThread["params"] == ["folder": "/Users/dev/portals", "query": "big", "limit": 20, "profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(newThread["id"]), "result": [
            "folder": "/Users/dev/portals", "total": 2, "matched": 1, "source": "git",
            "files": [["path": "big.txt", "name": "big.txt", "kind": "file", "score": 90, "ranges": [[0, 3]], "size": 70000]],
            "mention_limit": ["max_bytes": 262_144, "max_tokens": 25000, "note_bytes": 60000],
        ]])
        let found = try await beforeThread.value
        #expect(found.hits.first?.size == 70000)
        #expect(found.hits.first.map(found.fit(of:)) == .maybe)
        await backend.disconnect()

        let (older, _) = try await connect(ready: Self.queueReady)
        #expect(await older.searchesFiles == false)
        await #expect(throws: FileSearchError.unavailable) { try await older.searchFiles("a", in: .folder("/w"), limit: 5) }
        await older.disconnect()
    }

    /// A message's mentions go beside its text only to a bridge that lists `file_mentions`.
    @Test func mentionsGoOnlyToABridgeThatTakesThem() async throws {
        let (backend, transport) = try await connect(ready: Self.mentionsReady)
        let thread = try await createThread(on: backend, transport)
        let sending = Task {
            try await backend.send("Read @src/main.ts", images: [], files: [], mentions: ["src/main.ts"], whenBusy: .steer, messageID: UUID(), to: thread.id)
        }
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["method"]?.stringValue == "prompt.submit")
        #expect(submit["params"]?["mentions"] == ["src/main.ts"])
        #expect(submit["params"]?["text"]?.stringValue == "Read @src/main.ts")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": [
            "status": "streaming", "large_mentions": [["path": "src/main.ts", "size": 300_000, "fit": "unread"]],
        ]])
        // The mentions its agent may not read in, for the note on the sent message.
        #expect(try await sending.value.largeMentions == [LargeFileMention(path: "src/main.ts", size: 300_000, fit: .unread)])
        // None: no key.
        let plain = Task { try await backend.send("hi", images: [], files: [], mentions: [], whenBusy: .steer, messageID: UUID(), to: thread.id) }
        let plainSubmit = try #require(await transport.nextSentRequest())
        #expect(plainSubmit["params"]?["mentions"] == nil)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(plainSubmit["id"]), "result": ["status": "queued", "queue_id": "2"]])
        _ = try await plain.value
        await backend.disconnect()

        // A bridge without the feature is sent the text alone.
        let (older, olderTransport) = try await connect(ready: Self.queueReady)
        let onOlder = try await createThread(on: older, olderTransport)
        let toOlder = Task {
            try await older.send("Read @src/main.ts", images: [], files: [], mentions: ["src/main.ts"], whenBusy: .steer, messageID: UUID(), to: onOlder.id)
        }
        let olderSubmit = try #require(await olderTransport.nextSentRequest())
        #expect(olderSubmit["params"]?["mentions"] == nil)
        #expect(olderSubmit["params"]?["text"]?.stringValue == "Read @src/main.ts")
        olderTransport.deliver(["jsonrpc": "2.0", "id": try #require(olderSubmit["id"]), "result": ["status": "streaming"]])
        _ = try await toOlder.value
        await older.disconnect()
    }

    private static let subagentsReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents"]],
    ]

    /// A bridge with `subagents` says all it knows of each subagent and workflow; its list
    /// gives the ended ones of the latest batch too, and one is stopped by itself.
    @Test func aBridgeKeepsSubagentsAndWorkflowsAfterTheyEndAndStopsOneByItself() async throws {
        let (backend, transport) = try await connect(ready: Self.subagentsReady)
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest(includingRoster: true))
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "s1", "messages": []]])
        _ = try await opening.value
        let roster = try #require(await transport.nextSentRequest(includingRoster: true))
        #expect(roster["method"] == "subagent.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(roster["id"]), "result": [
            "subagents": [
                // An earlier turn's, over: not shown.
                ["subagent_id": "old", "kind": "agent", "goal": "Earlier", "status": "completed", "turn": 1, "started_at": 100, "ended_at": 110],
                [
                    "subagent_id": "a1", "kind": "agent", "goal": "Count the files", "status": "completed", "turn": 2, "started_at": 200, "ended_at": 211.5,
                    "background": true, "can_stop": false, "result": "0 entries.", "tokens": 18631,
                ],
                [
                    "subagent_id": "w1", "kind": "workflow", "goal": "Two agents", "name": "tiny-check", "status": "running", "turn": 2, "started_at": 212,
                    "background": true, "can_stop": true, "phases": [["index": 1, "title": "Check"]],
                    "agents": [
                        ["id": "1", "label": "apple", "phase": "Check", "model": "claude-haiku-5-5", "status": "completed", "tokens": 15824, "duration_s": 3.2, "result": "apple"],
                        ["id": "2", "label": "pear", "phase": "Check", "status": "running"],
                    ],
                ],
            ],
        ]])
        var events = await backend.events(for: ref.id).makeAsyncIterator()
        guard case let .subagentsListed(listed)? = await events.next() else {
            Issue.record("no list")
            return
        }
        #expect(listed.map(\.id) == ["a1", "w1"])
        // The two of one turn, though the first had ended before the second began.
        #expect(listed[0] == Subagent(
            id: "a1", goal: "Count the files", state: .finished, turn: 2, startedAt: Date(timeIntervalSince1970: 200), endedAt: Date(timeIntervalSince1970: 211.5),
            result: "0 entries.", tokens: 18631
        ))
        let workflow = listed[1]
        #expect(workflow.kind == .workflow)
        #expect(workflow.name == "tiny-check")
        #expect(workflow.canStop)
        #expect(workflow.phases == [WorkflowPhase(index: 1, title: "Check")])
        #expect(workflow.agents == [
            WorkflowAgent(id: "1", label: "apple", phase: "Check", model: "claude-haiku-5-5", state: .finished, tokens: 15824, duration: 3.2, result: "apple"),
            WorkflowAgent(id: "2", label: "pear", phase: "Check", state: .working),
        ])
        #expect(workflow.currentPhase == "Check")

        let stopping = Task { try await backend.stopSubagent("w1", in: ref.id) }
        let stop = try #require(await transport.nextSentRequest())
        #expect(stop["method"] == "subagent.stop")
        #expect(stop["params"] == ["session_id": "s1", "subagent_id": "w1", "profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(stop["id"]), "result": ["status": "stopped"]])
        #expect(try await stopping.value)
        #expect(await backend.stopsSubagents == true)
        // Its end is news like any other, and says it was stopped.
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": [
            "type": "subagent.complete", "session_id": "s1", "seq": 1,
            "payload": ["subagent_id": "w1", "kind": "workflow", "goal": "Two agents", "status": "stopped", "turn": 2, "started_at": 212, "ended_at": 215, "can_stop": false],
        ]])
        guard case let .subagent(stopped)? = await events.next() else {
            Issue.record("no news")
            return
        }
        #expect(stopped.state == .stopped)
        #expect(!stopped.canStop)
        await backend.disconnect()

        // Hermes is asked for none of it, and lists only those at work.
        let (hermes, _) = try await connect(ready: Self.hermesReady)
        #expect(try await hermes.stopSubagent("w1", in: ref.id) == false)
        #expect(await hermes.stopsSubagents == false)
        await hermes.disconnect()
    }

    /// A bridge with `subagent_read` says which subagents can be read, and gives what one
    /// did as its own messages, which come as turns as a thread's history does.
    @Test func aBridgeGivesWhatASubagentDidAsTurns() async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents", "subagent_read"]]]
        let (backend, transport) = try await connect(ready: ready)
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest(includingRoster: true))
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "s1", "messages": []]])
        _ = try await opening.value
        let roster = try #require(await transport.nextSentRequest(includingRoster: true))
        transport.deliver(["jsonrpc": "2.0", "id": try #require(roster["id"]), "result": [
            "subagents": [
                ["subagent_id": "a1", "kind": "agent", "goal": "Count the files", "status": "completed", "turn": 1, "started_at": 200, "ended_at": 211, "can_read": true],
                ["subagent_id": "w1", "kind": "workflow", "goal": "Two agents", "status": "completed", "turn": 1, "started_at": 212, "ended_at": 220],
            ],
        ]])
        var events = await backend.events(for: ref.id).makeAsyncIterator()
        guard case let .subagentsListed(listed)? = await events.next() else {
            Issue.record("no list")
            return
        }
        #expect(listed.map(\.canRead) == [true, false])

        let reading = Task { try await backend.subagentTranscript("a1", in: ref.id) }
        let read = try #require(await transport.nextSentRequest())
        #expect(read["method"] == "subagent.read")
        #expect(read["params"] == ["session_id": "s1", "subagent_id": "a1", "profile": "claude"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(read["id"]), "result": ["available": true, "messages": [
            ["role": "user", "text": "Count the files in this folder.", "timestamp": 201],
            ["role": "tool", "name": "terminal", "args": ["command": "ls | wc -l"], "content": "{\"output\":\"0\"}", "tool_call_id": "t1", "timestamp": 203],
            ["role": "assistant", "text": "0 entries.", "timestamp": 205],
        ]]])
        let transcript = try #require(try await reading.value)
        #expect(transcript.turns.count == 1)
        let items = try #require(transcript.turns.first?.items)
        guard items.count == 3, case let .user(asked) = items[0].content, case let .tool(call) = items[1].content, case let .text(answer) = items[2].content else {
            Issue.record("not its messages: \(items)")
            return
        }
        #expect(asked.text == "Count the files in this folder.")
        #expect(call.name == "terminal")
        #expect(answer == "0 entries.")

        // One that cannot be read is nil.
        let refusing = Task { try await backend.subagentTranscript("w1", in: ref.id) }
        let refused = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(refused["id"]), "result": ["available": false]])
        #expect(try await refusing.value == nil)
        await backend.disconnect()

        // A host without the feature is not asked.
        let (older, _) = try await connect(ready: Self.subagentsReady)
        #expect(try await older.subagentTranscript("a1", in: ref.id) == nil)
        await older.disconnect()
    }

    /// A subagent at work is read again as the line hears more of it, and each read maps
    /// its messages afresh. Read again, its turns and items keep the ids they had, so the
    /// steps and rows the reader opened (kept by those ids) stay open; also for a Codex
    /// subagent, whose messages begin with the agent speaking.
    @Test(arguments: [false, true]) func aSubagentReadAgainKeepsItsTurnsAndItems(beginsWithTheAgent: Bool) throws {
        let asked: [JSONValue] = beginsWithTheAgent ? [] : [["role": "user", "text": "Count the files in this folder.", "timestamp": 201]]
        let first: [JSONValue] = asked + [
            ["role": "assistant", "text": "", "reasoning": "Look at the folder first.", "timestamp": 202],
            ["role": "tool", "name": "terminal", "args": ["command": "ls"], "content": "{\"output\":\"a b\"}", "tool_call_id": "t1", "timestamp": 203],
            ["role": "assistant", "text": "Two so far.", "timestamp": 204],
            ["role": "tool", "name": "terminal", "args": ["command": "ls -a"], "content": "{\"output\":\". .. a b\"}", "tool_call_id": "t2", "timestamp": 205],
        ]
        let more: [JSONValue] = [
            ["role": "tool", "name": "read_file", "args": ["path": "a"], "content": "{\"content\":\"\"}", "tool_call_id": "t3", "timestamp": 206],
            ["role": "assistant", "text": "2 entries.", "timestamp": 207],
            ["role": "user", "text": "And hidden ones?", "timestamp": 208],
            ["role": "assistant", "text": "None.", "timestamp": 209],
        ]
        let earlier = HermesHistoryMapper.transcript(from: first)
        let read = HermesHistoryMapper.transcript(from: first + more)
        #expect(earlier.turns.count == 1)
        #expect(read.turns.count == 2)

        let refreshed = read.keepingIdentities(of: earlier)
        // What was there keeps its ids; what is new is told apart from it.
        #expect(refreshed.turns.first?.id == earlier.turns.first?.id)
        let before = try #require(earlier.turns.first?.items)
        let after = try #require(refreshed.turns.first?.items)
        #expect(Array(after.prefix(before.count).map(\.id)) == before.map(\.id))
        let ids = refreshed.turns.map(\.id) + refreshed.turns.flatMap(\.items).map(\.id)
        #expect(Set(ids).count == ids.count)
        // The fold the reader opened, named for its first step, is the same fold.
        let opened = TurnLayout.pieces(for: try #require(earlier.turns.first)).compactMap { piece -> UUID? in
            if case let .steps(steps) = piece { steps.id } else { nil }
        }
        let shown = TurnLayout.pieces(for: try #require(refreshed.turns.first)).compactMap { piece -> UUID? in
            if case let .steps(steps) = piece { steps.id } else { nil }
        }
        #expect(!opened.isEmpty)
        #expect(Array(shown.prefix(opened.count)) == opened)
        // Its contents are the newer read's.
        #expect(refreshed.turns.map { $0.items.map(\.content) } == read.turns.map { $0.items.map(\.content) })

        // Read with nothing new, it is the very same.
        #expect(HermesHistoryMapper.transcript(from: first).keepingIdentities(of: earlier) == earlier)
    }

    /// The list of who is at work, answered just before the bridge cleared an ended one
    /// from the line (`subagent.cleared` comes after the answer on the socket), does not
    /// bring that one back however the two reach the thread (recent-20). The answer and
    /// the events reach the backend by separate ways, so the list can come second.
    @Test(.timeLimit(.minutes(1))) func aListAnsweredBeforeAClearingDoesNotBringTheClearedOneBack() async throws {
        let ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents", "subagents_clear"]]]
        for round in 0..<20 {
            let (backend, transport) = try await connect(ready: ready)
            let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
            let opening = Task { try await backend.openThread(ref) }
            let resume = try #require(await transport.nextSentRequest(includingRoster: true))
            transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "s1", "messages": []]])
            _ = try await opening.value
            let roster = try #require(await transport.nextSentRequest(includingRoster: true))
            #expect(roster["method"] == "subagent.list")
            // The answer, then, on the same socket, the bridge clearing that one from the line.
            transport.deliver(["jsonrpc": "2.0", "id": try #require(roster["id"]), "result": ["subagents": [
                ["subagent_id": "a1", "kind": "agent", "goal": "Count the files", "status": "completed", "turn": 2, "started_at": 200, "ended_at": 211.5],
            ]]])
            transport.deliver(["jsonrpc": "2.0", "method": "event", "params": [
                "type": "subagent.cleared", "session_id": "s1", "seq": 1, "payload": ["subagent_ids": ["a1"]],
            ]])
            // Asked again, should the backend ask: the bridge lists nobody now.
            let answering = Task { _ = await transport.nextSentRequest() }
            var state = ThreadState()
            var events = await backend.events(for: ref.id).makeAsyncIterator()
            var cleared = false
            var listed = false
            while !(cleared && listed), let event = await events.next() {
                state.apply(event)
                if case .subagentsCleared = event { cleared = true }
                if case .subagentsListed = event { listed = true }
            }
            #expect(state.subagents.isEmpty, "round \(round)")
            answering.cancel()
            await backend.disconnect()
        }
    }

    /// A bridge with `subagents` is told this app keeps a subagent's question after the
    /// turn; Hermes, and a bridge without the feature, are sent only `server_requests`.
    @Test func onlyABridgeWithSubagentsIsToldTheAppKeepsASubagentsQuestion() async throws {
        let plainBridge: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["queue"]]]
        for (ready, keeps) in [(Self.subagentsReady, true), (Self.hermesReady, false), (plainBridge, false)] {
            let transport = ScriptedTransport()
            let backend = HermesBackend(
                host: HostID(rawValue: "mac"),
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
                makeTransport: { _ in transport }
            )
            transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
            let connecting = Task { try await backend.connect() }
            let capabilities = try #require(await transport.nextSentRequest())
            #expect(capabilities["method"] == "client.capabilities")
            let params: JSONValue = keeps ? ["server_requests": true, "subagent_requests": true] : ["server_requests": true]
            #expect(capabilities["params"] == params)
            transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
            try await connecting.value
            await backend.disconnect()
        }
    }

    /// Stop on the turn tells a bridge with `subagents` to leave the background work
    /// running, which has a Stop of its own; Hermes is sent its own `session.interrupt`.
    @Test func stopOnTheTurnKeepsBackgroundWorkOnlyWithABridgeThatHasAStopForEach() async throws {
        for (ready, keeps) in [(Self.subagentsReady, true), (Self.hermesReady, false)] {
            let (backend, transport) = try await connect(ready: ready)
            let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
            let opening = Task { try await backend.openThread(ref) }
            let resume = try #require(await transport.nextSentRequest())
            transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "s1", "running": true, "messages": []]])
            _ = try await opening.value
            let stopping = Task { try await backend.interrupt(ref.id) }
            let stop = try #require(await transport.nextSentRequest())
            #expect(stop["method"] == "session.interrupt")
            let params: JSONValue = keeps
                ? ["session_id": "s1", "profile": "claude", "keep_background": true]
                : ["session_id": "s1", "profile": "claude"]
            #expect(stop["params"] == params)
            transport.deliver(["jsonrpc": "2.0", "id": try #require(stop["id"]), "result": ["status": "interrupted"]])
            #expect(try await stopping.value)
            await backend.disconnect()
        }
    }

    /// What a subagent asks says so (`subagent`), from a bridge with `subagents`: it is
    /// still open with no turn running, and can be answered then.
    @Test func aSubagentsQuestionIsKeptWithNoTurnRunning() async throws {
        let approval: JSONValue = ["session_id": "s1", "command": "ls -la", "choices": ["once", "deny"], "subagent": "a17"]
        #expect(HermesEventMapper.pendingRequest(ServerRequest(id: "r1", method: "approval", params: approval), features: ["subagents"])?.subagent == "a17")
        #expect(HermesEventMapper.pendingRequest(ServerRequest(id: "r1", method: "approval", params: approval))?.subagent == nil)
        let clarify: JSONValue = ["session_id": "s1", "questions": [["qid": "q0", "question": "Which?"]], "subagent": "a17"]
        #expect(HermesEventMapper.pendingRequest(ServerRequest(id: "r2", method: "clarify", params: clarify), features: ["subagents"])?.subagent == "a17")

        let (backend, transport) = try await connect(ready: Self.subagentsReady)
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: claude)
        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest(includingRoster: true))
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": [
            "session_id": "s1", "running": false, "messages": [],
            "open_requests": [["id": "srq-7", "method": "approval", "params": approval]],
        ]])
        let snapshot = try await opening.value
        #expect(snapshot.openRequests.map(\.id) == ["srq-7"])
        try await backend.respond(to: "srq-7", in: ref.id, with: .approval(.once))
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-7", "result": ["choice": "once"]])
        await backend.disconnect()
    }

    /// A stored message's files are found again after the line the bridge writes, and
    /// shown as files; the words stay as they were typed.
    @Test func aStoredMessageShowsItsFilesAsFiles() {
        let stored = "Summarise these\n\nFiles attached in Portals (saved on this Mac):\n- /w/.portals/files/s1/a.pdf\n- /w/.portals/files/s1/b c.txt\n@image:photo.jpg"
        let (text, images, files) = HermesHistoryMapper.userText(stored)
        #expect(text == "Summarise these")
        #expect(images.map(\.filename) == ["photo.jpg"])
        #expect(files.map(\.filename) == ["a.pdf", "b c.txt"])
        #expect(files.map(\.path) == ["/w/.portals/files/s1/a.pdf", "/w/.portals/files/s1/b c.txt"])
    }
}

/// `folders.list` and `model.options` recorded from portals-bridge running Claude Code
/// and Codex on Dana's Mac (`scripts/capture-frames.sh` with `portals-probe --user`
/// against 127.0.0.1:9120, or a bridge of the same code on another port), played through
/// the client. Also in `CapturedFrameTests.captures`, which checks every frame is
/// recognized and that `folders.list` went only to a host that lists `folders`.
@Suite struct BridgeFolderFrameTests {
    static let captures = ["bridge-folders-list.jsonl", "bridge-model-levels.jsonl", "bridge-model-names.jsonl"]

    private let claude = Agent.ID(host: HostID(rawValue: "mac"), name: "claude")

    @Test func theRecordedFoldersAreGeneralThenTheRecentNewestFirst() async throws {
        let server = try RecordedServer(capture: "bridge-folders-list.jsonl")
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        #expect(await backend.offersFolders == true)
        let list = try await backend.folders(for: claude)
        await backend.disconnect()

        #expect(list.general == Folder(path: "/Users/dev/coding_projects", name: "No project", isGeneral: true))
        #expect(!list.recent.isEmpty && list.recent.count <= 30)
        #expect(list.recent.allSatisfy { $0.path.hasPrefix("/Users/dev/") && $0.path != list.general.path })
        #expect(list.recent.allSatisfy { $0.name == ($0.path as NSString).lastPathComponent })
        #expect(Set(list.recent.map(\.path)).count == list.recent.count)
        // Newest first, every one with a time (Claude Code's and Codex's history give one).
        let times = list.recent.compactMap(\.lastUsed)
        #expect(times.count == list.recent.count)
        #expect(times == times.sorted(by: >))
        // Nothing hidden, temporary or the home folder itself.
        #expect(!list.recent.contains { $0.path.split(separator: "/").contains { $0.hasPrefix(".") } })
        #expect(!list.recent.contains { $0.path == "/Users/dev" || $0.path.hasPrefix("/private/tmp") || $0.path.hasPrefix("/tmp") })
    }

    /// The model catalog the client makes of a recorded `model.options`.
    private func recordedCatalog(_ capture: String) async throws -> ModelCatalog {
        let recorded = try #require(try Fixtures.frames(capture, direction: "in").first { $0["id"] == "r2" }?["result"])
        let ready = try #require(try Fixtures.frames(capture, direction: "in").first)["params"]?["payload"]
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": try #require(ready)]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value

        let loading = Task { try await backend.modelCatalog(for: claude) }
        let options = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(options["id"]), "result": recorded])
        let reasoning = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(reasoning["id"]), "result": ["value": "high"]])
        let catalog = try await loading.value
        await backend.disconnect()
        return catalog
    }

    @Test func theRecordedLevelsLimitEachModel() async throws {
        let catalog = try await recordedCatalog("bridge-model-levels.jsonl")
        let models = try #require(catalog.providers.first?.models)
        #expect(models.contains("haiku") && models.contains("claude-opus-4-6"))
        // A bridge from before `model_names`: its models go by their ids, as they did.
        #expect(catalog.namesByModel == nil)
        #expect(catalog.shortName(of: catalog.agentDefault) == "default")
        // Every model the bridge offers says its levels.
        #expect(Set(catalog.levelsByModel?.keys.map { $0 } ?? []) == Set(models))
        #expect(catalog.levels(for: "default") == [.low, .medium, .high, .extraHigh, .max])
        // An older model without the extra-high level.
        #expect(catalog.levels(for: "claude-opus-4-6") == [.low, .medium, .high, .max])
        // Haiku lists none of its own; the bridge offers Claude's five as thinking budgets.
        #expect(catalog.levels(for: "haiku") == [.low, .medium, .high, .extraHigh, .max])
    }

    /// From a bridge with `model_names`, on Claude Code 2.1.293 whose `model` setting is `opus`.
    @Test func theRecordedNamesHaveVersionsAndTheDefaultIsListedOnce() async throws {
        let catalog = try await recordedCatalog("bridge-model-names.jsonl")
        let models = try #require(catalog.providers.first?.models)
        let names = models.map(catalog.name(of:))
        #expect(names.prefix(4) == ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"])
        // One row per model: `opus` runs what the default does.
        #expect(!models.contains("opus"))
        #expect(Set(names).count == names.count)
        #expect(names.allSatisfy { $0.contains(where: \.isNumber) })
        // The default is marked, and a thread that never picked a model shows its name.
        #expect(models.filter { catalog.marksAsDefault($0, at: "anthropic") } == ["default"])
        #expect(catalog.shortName(of: catalog.setting(for: nil)) == "Opus 5.5")
        // A thread put on `opus` before still shows it, checked on the default's row, with its levels.
        let opus = ModelSetting(model: "opus", provider: "anthropic")
        #expect(catalog.shortName(of: opus) == "Opus 5.5")
        #expect(models.filter { catalog.isCurrent($0, at: "anthropic", for: opus) } == ["default"])
        #expect(catalog.levels(for: "opus") == [.low, .medium, .high, .extraHigh, .max])
        #expect(catalog.levels(for: "claude-opus-4-6") == [.low, .medium, .high, .max])
    }
}

/// `desk.list` and `session.adopt` recorded from portals-bridge on Dana's Mac, with
/// Claude Code and Codex sessions started in tmux in scratch folders
/// (`portals-probe desk` and `adopt`, cleaned by `scripts/capture-frames.sh`; the
/// sessions that were not the test's own have placeholder ids, titles and folders).
/// Also in `CapturedFrameTests.captures`, which checks every frame is recognized and that
/// the methods went only to a host that lists `desk_sessions`.
@Suite struct BridgeDeskFrameTests {
    static let captures = ["bridge-desk-list.jsonl", "bridge-desk-codex-list.jsonl", "bridge-desk-adopt.jsonl", "bridge-desk-refused.jsonl"]

    private let claude = Agent.ID(host: HostID(rawValue: "mac"), name: "claude")
    private let codex = Agent.ID(host: HostID(rawValue: "mac"), name: "codex")

    private func connected(_ capture: String) async throws -> (HermesBackend, Task<Void, Never>) {
        let server = try RecordedServer(capture: capture)
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
        let serving = Task { await server.run() }
        try await backend.connect()
        return (backend, serving)
    }

    private func listed(_ capture: String, for agent: Agent.ID) async throws -> [DeskSession] {
        let (backend, serving) = try await connected(capture)
        defer { serving.cancel() }
        #expect(await backend.offersDeskSessions == true)
        let sessions = try await backend.deskSessions(for: agent)
        await backend.disconnect()
        #expect(!sessions.isEmpty && sessions.count <= 40)
        #expect(Set(sessions.map(\.id)).count == sessions.count)
        #expect(sessions.allSatisfy { $0.agent == agent && !$0.title.isEmpty && $0.folder.hasPrefix("/") })
        let times = sessions.compactMap(\.updated)
        #expect(times.count == sessions.count)
        #expect(times == times.sorted(by: >))
        return sessions
    }

    @Test func claudeCodesSessionsAreOpenOrClosedNewestFirst() async throws {
        let sessions = try await listed("bridge-desk-list.jsonl", for: claude)
        #expect(Set(sessions.map(\.state)).isSubset(of: [.open, .closed]))
        // The one the test left open in tmux.
        let open = try #require(sessions.first { $0.folder == "/tmp/aeriportal-cwd/desk-b" })
        #expect(open.title == "Desk turn b")
        #expect(open.state == .open && open.isOpenInTerminal && open.defaultMode == nil)
    }

    @Test func codexsThreadsSayWhetherTheyNeedYou() async throws {
        let sessions = try await listed("bridge-desk-codex-list.jsonl", for: codex)
        #expect(Set(sessions.map(\.state)).isSubset(of: [.running, .waiting, .idle, .closed]))
        // Waiting on the approval the terminal asked for.
        let waiting = try #require(sessions.first { $0.folder == "/tmp/aeriportal-cwd/desk-codex" })
        #expect(waiting.title == "Create hello.txt")
        #expect(waiting.state == .waiting && waiting.defaultMode == .continue)
    }

    @Test func aForkIsANewThreadThatOpensWithTheHistory() async throws {
        let (backend, serving) = try await connected("bridge-desk-adopt.jsonl")
        defer { serving.cancel() }
        let session = DeskSession(id: "f874f512-03a9-4664-a082-acf2163c5997", agent: claude, title: "Desk turn one", folder: "/tmp/aeriportal-cwd", state: .closed)
        let thread = try await backend.adopt(session, as: .fork)
        #expect(thread.id.rawValue == "5041184d-81d5-409b-8df9-c2cbaaaca6ea")
        #expect(thread.title == "Desk turn one (fork)")
        #expect(thread.workingDirectory == "/tmp/aeriportal-cwd")
        #expect(!thread.isReadOnly)
        let snapshot = try await backend.openThread(thread)
        await backend.disconnect()
        // The terminal's turn, then the one sent from the phone after it was continued.
        let said = snapshot.transcript.turns.compactMap { turn -> String? in
            guard case let .user(message)? = turn.items.first?.content else { return nil }
            return message.text
        }
        #expect(said == [
            "Reply with exactly these words and nothing else: desk turn one",
            "Reply with exactly these words and nothing else: phone turn two",
        ])
        #expect(!snapshot.isRunning)
        #expect(snapshot.workingDirectory == "/tmp/aeriportal-cwd")
    }

    /// Refused with the bridge's sentence, as one the app can offer a fork or a read for
    /// instead: the list said nobody had it open, so a tap asked to continue it.
    @Test func aSessionOpenInATerminalIsNotContinued() async throws {
        let (backend, serving) = try await connected("bridge-desk-refused.jsonl")
        defer { serving.cancel() }
        let session = DeskSession(id: "875d4f5a-697f-4a50-a249-bfccd78280fb", agent: claude, folder: "/tmp/aeriportal-cwd/desk-b", state: .closed)
        let sentence = "This session is open in a terminal on the Mac. Close it there, or fork it, to continue it here."
        await #expect(throws: DeskSessionError.continueRefused(sentence)) { try await backend.adopt(session, as: .continue) }
        #expect(DeskSessionError.continueRefused(sentence).localizedDescription == sentence)
        await backend.disconnect()
    }
}
