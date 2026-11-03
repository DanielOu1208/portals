import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Tests against frames recorded from a real `hermes serve` (Hermes 0.21.5) with
/// `scripts/capture-frames.sh`, and the checks that hold for every capture also against
/// those recorded from `portals-bridge` (`BridgeFrameTests`, `BridgeClaudeFrameTests`, `BridgeCodexFrameTests`).
@Suite struct CapturedFrameTests {
    static let captures = [
        "handshake-profiles.jsonl",
        "chat-text-complete.jsonl",
        "chat-provider-error.jsonl",
        "chat-no-provider.jsonl",
        "chat-tools.jsonl",
        "chat-approval-denied.jsonl",
        "chat-clarify.jsonl",
        "chat-interrupt.jsonl",
        "chat-redirected.jsonl",
        "reattach-running.jsonl",
        "reattach-midtext.jsonl",
        "reattach-approval.jsonl",
        "chat-image.jsonl",
        "chat-delegation.jsonl",
    ] + BridgeFrameTests.captures + BridgeClaudeFrameTests.captures + BridgeCodexFrameTests.captures + BridgeFolderFrameTests.captures + BridgeDeskFrameTests.captures
        + ThreadSyncWireTests.captures

    private func inbound(_ capture: String) throws -> [InboundFrame] {
        try Fixtures.frames(capture, direction: "in").map { try InboundFrame.parse(try $0.serialized()) }
    }

    private func result(of requestID: String, in capture: String) throws -> JSONValue {
        for case let .response(id, .success(value)) in try inbound(capture) where id == requestID {
            return value
        }
        throw Fixtures.Missing(name: "\(capture) response \(requestID)")
    }

    private func events(_ capture: String) throws -> [GatewayEvent] {
        try inbound(capture).compactMap { if case let .event(event) = $0 { event } else { nil } }
    }

    @Test(arguments: captures)
    func everyInboundFrameIsRecognized(capture: String) throws {
        let frames = try inbound(capture)
        #expect(!frames.isEmpty)
        #expect(!frames.contains(.unrecognized))
    }

    @Test(arguments: captures)
    func everyConnectionStartsWithGatewayReady(capture: String) throws {
        let first = try #require(try events(capture).first)
        #expect(first.type == HermesWire.EventType.gatewayReady)
        #expect(first.sessionID == nil)
        let ready = HermesWire.GatewayReady(payload: first.payload)
        #expect(ready.replayEpoch?.isEmpty == false)
        #expect(ready.supportsHeartbeat)
        // Only the bridge says what it is.
        #expect(ready.hostKind == (capture.hasPrefix("bridge-") ? .bridge : nil))
    }

    /// What the probe really sent must stay inside the contract subset. A bridge-only
    /// method goes only to a bridge that listed its feature.
    @Test(arguments: captures)
    func sentParamsStayInsideTheContractSubset(capture: String) throws {
        let subset = try Fixtures.json("contract-subset.json")
        let methods = try #require(subset["methods"]?.objectValue)
        let bridgeMethods = subset["bridge"]?["methods"]?.objectValue ?? [:]
        let ready = try #require(try events(capture).first).payload
        let features = HermesWire.GatewayReady(payload: ready).bridge?.features ?? []
        for frame in try Fixtures.frames(capture, direction: "out") {
            // Answers to the gateway's questions have no method; pings are not in the contract.
            guard let method = frame["method"]?.stringValue, method != "gateway.ping" else { continue }
            if let extra = bridgeMethods[method] {
                let sent = Set(try #require(frame["params"]?.objectValue).keys)
                // A method Hermes has too, sent as Hermes takes it, needs no feature
                // (`prompt.submit` without `when_busy`).
                if let shared = methods[method]?.arrayValue, sent.isSubset(of: Set(shared.compactMap(\.stringValue))) { continue }
                let feature = try #require(extra["feature"]?.stringValue)
                #expect(features.contains(feature), "\(method) sent to a host that does not list \(feature)")
                #expect(sent.isSubset(of: Set((extra["params"]?.arrayValue ?? []).compactMap(\.stringValue))), "\(method) sent \(sent)")
                continue
            }
            let allowed = try #require(methods[method]?.arrayValue, "\(method) is not in contract-subset.json")
            let sent = Set(try #require(frame["params"]?.objectValue).keys)
            #expect(sent.isSubset(of: Set(allowed.compactMap(\.stringValue))), "\(method) sent \(sent)")
        }
    }

    @Test func profilesListDecodes() throws {
        let decoded = try result(of: "r2", in: "handshake-profiles.jsonl").decode(HermesWire.ProfilesListResult.self)
        let profiles = try #require(decoded.profiles)
        #expect(profiles.map(\.name) == ["default", "aeri"])
        #expect(profiles[0].isDefault == true)
        #expect(profiles[1].isDefault != true)
        // Hermes sends an empty display name, not a missing one, for an unnamed profile.
        #expect(profiles[0].displayName == "")
    }

    /// From a real upload: Hermes stores the image and says under which name.
    @Test func anAttachedImageIsConfirmed() throws {
        let sent = try Fixtures.frames("chat-image.jsonl", direction: "out")
        let upload = try #require(sent.first { $0["method"]?.stringValue == HermesWire.Method.imageAttachBytes })
        #expect(upload["params"]?["filename"]?.stringValue?.hasSuffix(".jpg") == true)
        let decoded = try result(of: try #require(upload["id"]?.stringValue), in: "chat-image.jsonl")
            .decode(HermesWire.ImageAttachResult.self)
        #expect(decoded.attached == true)
        #expect(decoded.name?.hasSuffix(".jpg") == true)
        #expect(decoded.message == nil)
    }

    @Test func capabilitiesDecode() throws {
        let decoded = try result(of: "r1", in: "handshake-profiles.jsonl").decode(HermesWire.ClientCapabilitiesResult.self)
        #expect(decoded.serverRequests?.contains("approval") == true)
        #expect(decoded.serverRequests?.contains("clarify") == true)
    }

    @Test func sessionCreateAndSubmitDecode() throws {
        let capture = "chat-text-complete.jsonl"
        let session = try result(of: "r2", in: capture).decode(HermesWire.SessionCreateResult.self)
        #expect(session.sessionID == "458dacdd")
        #expect(session.storedSessionID == "20261004_220740_1c0433")
        #expect(session.info?.model == "google/gemini-3.8-flash")
        #expect(session.info?.profileName == "default")

        let submitted = try result(of: "r3", in: capture).decode(HermesWire.PromptSubmitResult.self)
        #expect(submitted.status == "streaming")
        #expect(submitted.userRowID != nil)
    }

    @Test func completedTurnStreamsTextThenCompletes() throws {
        let turn = try events("chat-text-complete.jsonl").filter { $0.sessionID == "458dacdd" }
        let text = turn.filter { $0.type == HermesWire.EventType.messageDelta }
            .compactMap { $0.payload["text"]?.stringValue }
            .joined()
        #expect(text == "Hello from Hermes!")

        let last = try #require(turn.last)
        #expect(last.type == HermesWire.EventType.messageComplete)
        #expect(last.payload["status"] == "complete")
        #expect(last.payload["text"] == "Hello from Hermes!")

        // Sequence numbers rise by one within a session: the replay log depends on it.
        let sequence = turn.compactMap(\.seq)
        #expect(sequence == Array(sequence[0]...(sequence[0] + sequence.count - 1)))
    }

    @Test func providerFailureEndsTheTurnWithErrorStatus() throws {
        let turn = try events("chat-provider-error.jsonl")
        let last = try #require(turn.last)
        #expect(last.type == HermesWire.EventType.messageComplete)
        #expect(last.payload["status"] == "error")
        #expect(turn.contains { $0.type == HermesWire.EventType.messageDelta } == false)
    }

    @Test func missingProviderSendsErrorEvents() throws {
        let turn = try events("chat-no-provider.jsonl")
        let errors = turn.filter { $0.type == HermesWire.EventType.error }
        #expect(!errors.isEmpty)
        #expect(errors[0].payload["message"]?.stringValue?.contains("not connected to any AI provider") == true)
        #expect(turn.last?.payload["status"] == "error")
    }

    @Test func howFullTheContextIsComesDuringTheRunAndAtItsEnd() throws {
        let mapped = try events("chat-tools.jsonl").flatMap { HermesEventMapper.threadEvents(for: $0) }
        let usages = mapped.compactMap { event -> ContextUsage? in
            if case let .contextChanged(usage) = event { usage } else { nil }
        }
        // Three samples while the turn ran, then the turn's own count.
        #expect(usages.count == 4)
        #expect(usages.allSatisfy { $0.limit == 1_048_576 && $0.used > 0 })
        #expect(usages.last == ContextUsage(used: 13_167, limit: 1_048_576))
        // The last count arrives before the turn is said to be over, so it is saved with it.
        let last = try #require(mapped.lastIndex { if case .contextChanged = $0 { true } else { false } })
        if case .turnFinished = mapped[last + 1] {} else { Issue.record("the turn's end should follow its usage") }
    }

    /// A turn that hands two tasks to agents, which work on after it ends and then
    /// report back, starting a turn of the host's own.
    @Test func agentsSetToWorkAreFollowedPastTheTurnThatStartedThem() throws {
        var state = ThreadState()
        var workingWhenTheTurnEnded: [Subagent]?
        for event in try events("chat-delegation.jsonl").flatMap({ HermesEventMapper.threadEvents(for: $0) }) {
            state.apply(event, at: Date(timeIntervalSince1970: 0))
            if case .turnFinished = event, workingWhenTheTurnEnded == nil {
                workingWhenTheTurnEnded = state.subagents.filter(\.isWorking)
            }
        }
        // Both were still at work, each on a terminal command, when the agent's own turn ended.
        let stillWorking = try #require(workingWhenTheTurnEnded)
        #expect(stillWorking.count == 2)
        #expect(Set(stillWorking.map(\.tool)) == ["terminal"])
        #expect(stillWorking.contains { $0.goal.contains("echo alpha") && $0.toolDetail?.contains("sleep 6") == true })

        // By the end both have reported, and the report opened a turn of the host's own.
        #expect(state.subagents.map(\.state) == [.finished, .finished])
        #expect(state.transcript.turns.count == 2)
        guard case let .event(report)? = state.transcript.turns[1].items.first?.content else {
            Issue.record("the second turn should open with why the host started it")
            return
        }
        #expect(report.kind == .backgroundAgents)
        #expect(report.text.hasPrefix("Subagent Tasks Completed"))
    }

    @Test func anAgentAtWorkReadsTheSameFromAnEventAndFromTheHostsList() {
        let listed: JSONValue = [
            "subagent_id": "sa-1-ac781d0b", "goal": "Run the command and report", "last_tool": "terminal",
            "status": "running", "tool_count": 1, "delegation_id": "deleg_da403bd4",
        ]
        #expect(HermesEventMapper.subagent(listed) == Subagent(id: "sa-1-ac781d0b", goal: "Run the command and report", tool: "terminal"))
        #expect(HermesEventMapper.subagent(["subagent_id": "sa-1", "goal": "g", "status": "completed"], finished: true)?.state == .finished)
        #expect(HermesEventMapper.subagent(["subagent_id": "sa-1", "goal": "g", "status": "interrupted"], finished: true)?.state == .failed)
        #expect(HermesEventMapper.subagent(["subagent_id": "sa-1", "goal": "g", "status": "failed"])?.state == .failed)
        // Without its id there is nothing to keep track of.
        #expect(HermesEventMapper.subagent(["goal": "g"]) == nil)
    }

    @Test func aUsageBlockThatDoesNotSayHowFullTheContextIsGivesNothing() {
        #expect(HermesEventMapper.contextUsage(["total": 0, "calls": 0]) == nil)
        #expect(HermesEventMapper.contextUsage(["context_used": 0, "context_max": 400_000]) == nil)
        #expect(HermesEventMapper.contextUsage(["context_used": "many", "context_max": 400_000]) == nil)
        #expect(HermesEventMapper.contextUsage(nil) == nil)
        #expect(HermesEventMapper.contextUsage(["context_used": 48_000, "context_max": 400_000]) == ContextUsage(used: 48_000, limit: 400_000))
    }

    @Test func everyRecordedEventTypeIsInTheContractSubsetOrKnowinglyIgnored() throws {
        let subset = try Fixtures.json("contract-subset.json")
        let read = Set((subset["events"]?.arrayValue ?? []).compactMap(\.stringValue))
        // Seen on the wire and deliberately not mapped to anything.
        let ignored: Set = [
            "session.info", "sessions.changed", "session.reclaimed",
            "tool.generating", "reasoning.available",
        ]
        var seen: Set<String> = []
        for capture in Self.captures {
            seen.formUnion(try events(capture).map(\.type))
        }
        #expect(seen.subtracting(read).subtracting(ignored).isEmpty, "unmapped: \(seen.subtracting(read).subtracting(ignored).sorted())")
    }

    @Test func recordedApprovalRequestCarriesTheCommandAndChoices() throws {
        let request = try #require(try inbound("chat-approval-denied.jsonl").compactMap { frame -> ServerRequest? in
            if case let .serverRequest(request) = frame { request } else { nil }
        }.first)
        #expect(request.method == "approval")
        #expect(request.id.hasPrefix("srq-"))
        #expect(request.params["command"]?.stringValue?.hasPrefix("rm -rf /nonexistent-aeriportal-approval-test") == true)
        #expect(request.params["description"] == "delete in root path")
        #expect(request.params["choices"] == ["once", "session", "always", "deny"])
    }

    /// Replays the recorded handshake through the real connection code.
    @Test func handshakeAgainstRecordedFrames() async throws {
        let recorded = try Fixtures.frames("handshake-profiles.jsonl", direction: "in")
        let transport = ScriptedTransport()
        transport.deliver(recorded[0]) // gateway.ready

        let opening = Task {
            try await HermesConnection.open(
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
                makeTransport: { _ in transport }
            )
        }
        let capabilities = try #require(await transport.nextSentRequest())
        #expect(capabilities["method"] == "client.capabilities")
        #expect(capabilities["params"] == ["server_requests": true])
        transport.deliver(recorded[1]) // the recorded answer to r1

        let connection = try await opening.value
        #expect(connection.ready.replayEpoch?.isEmpty == false)
        #expect(connection.serverRequestMethods?.count == 13)

        let listing = Task {
            try await connection.peer.call(
                HermesWire.Method.profilesList, HermesWire.ProfilesListParams(),
                returning: HermesWire.ProfilesListResult.self
            )
        }
        #expect(try #require(await transport.nextSentRequest())["method"] == "profiles.list")
        transport.deliver(recorded[2]) // the recorded answer to r2
        #expect(try await listing.value.profiles?.count == 2)
        await connection.peer.close()
    }

    @Test func handshakeFailsWhenTheSocketClosesFirst() async throws {
        let transport = ScriptedTransport()
        transport.drop()
        await #expect(throws: (any Error).self) {
            _ = try await HermesConnection.open(
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
                makeTransport: { _ in transport }
            )
        }
        #expect(transport.isClosed)
    }

    @Test func handshakeTimesOutWithoutGatewayReady() async throws {
        let transport = ScriptedTransport()
        await #expect(throws: HermesConnectionError.notReady) {
            _ = try await HermesConnection.open(
                authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
                readyTimeout: .milliseconds(50),
                makeTransport: { _ in transport }
            )
        }
        #expect(transport.isClosed)
    }
}
