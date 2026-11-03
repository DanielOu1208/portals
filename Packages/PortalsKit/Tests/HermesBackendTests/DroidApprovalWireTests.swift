import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct DroidApprovalWireTests {
    private static let options: JSONValue = [
        ["id": "proceed_once", "label": "Allow once", "description": "Run this action only.",
         "effects": [["scope": "once", "text": "This action only."]]],
        ["id": "proceed_always_file", "label": "Allow this file", "description": "Save a rule for this exact file.",
         "effects": [["scope": "settings", "text": "Persists permission for /project/file.swift, not its parent directory."]],
         "requires_confirmation": true],
        ["id": "proceed_report_false_positive", "label": "Allow and report", "description": "Allow once and send a report.",
         "effects": [["scope": "once", "text": "This action only."], ["scope": "external", "text": "Sends a false-positive report externally."]],
         "requires_confirmation": true],
        ["id": "proceed_edit", "label": "Edit plan", "description": "Return the edited plan without starting.",
         "effects": [["scope": "once", "text": "Return the Markdown to Droid."]], "requires_edited_plan": true],
        ["id": "cancel", "label": "Keep planning", "description": "Do not start.",
         "effects": [["scope": "once", "text": "Stay in planning."]]],
    ]

    private static func request(options: JSONValue? = Self.options) throws -> PendingRequest {
        var params: [String: JSONValue] = [
            "command": "# Plan\n\nImplement the change.", "plan_content": "# Full plan\n\n- Preserve compatibility",
            "choices": ["once", "deny"], "plan": true, "starts_in": "medium",
            "details": [
                ["tool_id": "edit-1", "name": "Edit", "type": "edit", "path": "/project/file.swift",
                 "diff": "--- a/file.swift\n+++ b/file.swift\n@@ -1 +1 @@\n-old\n+new"],
                ["tool_id": "mcp-1", "name": "MCP", "type": "mcp_tool", "server": "docs", "tool": "read", "impact": "Reads documentation"],
                ["name": "Sandbox", "type": "sandbox_violation", "violation_type": "network", "reason": "Domain needs permission",
                 "operation": "connect", "target": "example.test", "command": "fetch example.test"],
                ["name": "Shield", "type": "droid_shield_violation",
                 "findings": [["title": "Suspicious instruction", "message": "Review this command.", "severity": "high"]]],
            ],
        ]
        params["options"] = options
        return try #require(HermesEventMapper.pendingRequest(
            ServerRequest(id: "approval-1", method: "approval", params: .object(params)),
            features: [BridgeWire.Feature.modes, BridgeWire.Feature.approvalNotes]
        ))
    }

    @Test func richApprovalKeepsExactOfferedEffectsAndSafeDetails() throws {
        let request = try Self.request()
        guard case let .approval(approval) = request.kind else { Issue.record("Expected approval"); return }
        #expect(approval.plan?.startsIn == .medium)
        #expect(approval.planContent == "# Full plan\n\n- Preserve compatibility")
        #expect(approval.options?.map(\.id) == ["proceed_once", "proceed_always_file", "proceed_report_false_positive", "proceed_edit", "cancel"])
        #expect(approval.options?[1].effects == [
            ApprovalEffect(scope: "settings", text: "Persists permission for /project/file.swift, not its parent directory."),
        ])
        #expect(approval.options?[1].requiresConfirmation == true)
        #expect(approval.options?[2].effects.map(\.scope) == ["once", "external"])
        #expect(approval.details?.count == 4)
        #expect(approval.details?[0].toolID == "edit-1" && approval.details?[0].diff?.contains("+new") == true)
        #expect(approval.details?[1].server == "docs" && approval.details?[1].tool == "read")
        #expect(approval.details?[2].violationType == "network" && approval.details?[2].target == "example.test")
        #expect(approval.details?[3].findings?.first?.severity == "high")
        let restored = try JSONDecoder().decode(PendingRequest.self, from: JSONEncoder().encode(request))
        #expect(restored == request)
    }

    @Test func richAnswersUseOnlyTheExactOptionAndPreserveEditedMarkdown() throws {
        let request = try Self.request()
        let edited = "# Edited plan\n\n- Keep both the bridge and the app compatible.\n"
        let result = HermesEventMapper.result(for: .option("proceed_edit", editedPlan: edited), to: request)
        #expect(result == ["option": "proceed_edit", "edited_plan": .string(edited)])
        #expect(result["choice"] == nil)
        #expect(HermesEventMapper.result(for: .option("proceed_once"), to: request) == ["option": "proceed_once"])
        #expect(HermesEventMapper.result(for: .option("cancel", note: "Use a smaller change."), to: request)
            == ["option": "cancel", "note": "Use a smaller change."])
        #expect(RequestAnswer.option("proceed_always_file").summary(for: request) == "Allow this file")
    }

    @Test func unknownUnofferedAndEmptyEditedPlansCannotBecomeApproval() throws {
        let request = try Self.request()
        for id in ["proceed_unknown", "proceed_always", "always", "proceed_new_session_high"] {
            #expect(request.offeredOption(id) == nil)
            #expect(HermesEventMapper.result(for: .option(id), to: request) == ["choice": "deny"])
        }
        for text in [nil, "", " \n\t"] as [String?] {
            #expect(request.offeredOption("proceed_edit", editedPlan: text) == nil)
            #expect(HermesEventMapper.result(for: .option("proceed_edit", editedPlan: text), to: request) == ["choice": "deny"])
        }
        #expect(request.offeredOption("proceed_edit", editedPlan: "# A plan")?.editsPlan == true)
    }

    @Test func unsupportedAndMalformedOptionsDoNotInventALegacyGrant() throws {
        let request = try Self.request(options: [
            ["id": "unknown", "label": "Unknown", "description": "Not supported", "effects": []],
            ["id": "proceed_once", "label": "Missing description and effects"],
        ])
        guard case let .approval(approval) = request.kind else { Issue.record("Expected approval"); return }
        #expect(approval.options == [])
        #expect(request.offeredOption("proceed_once") == nil)
        // An older provider/request keeps its original choice-based response path.
        let legacy = try Self.request(options: nil)
        guard case let .approval(legacyApproval) = legacy.kind else { Issue.record("Expected approval"); return }
        #expect(legacyApproval.options == nil)
        #expect(HermesEventMapper.result(for: .approval(.once), to: legacy) == ["choice": "once"])
        #expect(HermesEventMapper.result(for: .declined(note: "Try again"), to: legacy) == ["choice": "deny", "note": "Try again"])
    }

    @Test func savedLegacyApprovalsStillDecodeWithoutAdditiveFields() throws {
        let legacy: JSONValue = ["command": "swift test", "choices": ["once", "deny"]]
        let restored = try legacy.decode(ApprovalRequest.self)
        #expect(restored.options == nil && restored.details == nil && restored.planContent == nil)
        #expect(restored.choices == [.once, .deny])
    }

    @Test func planFooterUsesProviderMeaningAndResolvesTheInheritedMode() {
        let mode = ModeState(mode: .plan, defaultsTo: .medium, options: [
            ModeOption(id: .medium, label: "Medium", description: "Reversible work may run without asking."),
        ])
        #expect(PlanApproval(startsIn: .medium).startDescription(agentName: "Droid", mode: mode)
            == "Then: Reversible work may run without asking.")
        #expect(PlanApproval(startsIn: .settings).startDescription(agentName: "Droid", mode: mode)
            == "Then: Reversible work may run without asking.")
        #expect(PlanApproval().startDescription(agentName: "Droid", mode: mode) == nil)
    }

    @Test func backendRejectsInvalidAndAlreadySettledOptionsBeforeWritingAResponse() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "test"),
            makeTransport: { _ in transport }
        )
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1", features: [BridgeWire.Feature.modes])
        try await connecting.value
        let creating = Task { try await backend.createThread(with: Agent.ID(host: backend.host, name: "droid"), options: ThreadOptions()) }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1", "stored_session_id": "stored-1"])
        let thread = try await creating.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        for id in ["approval-1", "approval-2"] {
            transport.deliver([
                "jsonrpc": "2.0", "id": .string(id), "method": "approval",
                "params": ["session_id": "run-1", "command": "swift test", "choices": ["once", "deny"], "options": Self.options],
            ])
            guard case .requestOpened? = await events.next() else { Issue.record("Expected approval"); return }
            if id == "approval-1" {
                await #expect(throws: ApprovalAnswerError.self) { try await backend.respond(to: id, in: thread.id, with: .option("proceed_always")) }
                await #expect(throws: ApprovalAnswerError.self) { try await backend.respond(to: id, in: thread.id, with: .option("proceed_edit", editedPlan: " \n")) }
                try await backend.respond(to: id, in: thread.id, with: .option("proceed_once"))
                #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": .string(id), "result": ["option": "proceed_once"]])
            } else {
                transport.event("request.cancel", ["id": .string(id), "reason": "resolved"])
                #expect(await events.next() == .requestClosed(id: id, reason: "Answered elsewhere"))
            }
            await #expect(throws: AgentBackendError.unknownRequest) { try await backend.respond(to: id, in: thread.id, with: .option("proceed_once")) }
        }
        await backend.disconnect()
    }

    @Test func crossDeviceResolutionClosesOnlyTheMatchingCardAndLateAnswersDoNothing() throws {
        let request = try Self.request()
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.requestOpened(request))
        var other = request
        other.id = "approval-2"
        state.apply(.requestOpened(other))
        let resolved = GatewayEvent(type: "request.cancel", payload: ["id": "approval-1", "reason": "resolved"])
        for event in HermesEventMapper.threadEvents(for: resolved) { state.apply(event) }
        #expect(state.openRequests.map(\.id) == ["approval-2"])
        let transcript = state.transcript
        state.requestAnswered("approval-1", with: .option("proceed_once"))
        #expect(state.transcript == transcript)
        let answered = GatewayEvent(type: "request.cancel", payload: [
            "id": "approval-2", "reason": "resolved", "by": "Droid", "answer": ["option": "cancel", "note": "Revise first."],
        ])
        let events = HermesEventMapper.threadEvents(for: answered, features: [BridgeWire.Feature.agentThreads])
        #expect(events == [.requestAnswered(id: "approval-2", answer: .option("cancel", note: "Revise first."), by: "Droid")])
        events.forEach { state.apply($0) }
        #expect(state.openRequests.isEmpty)
    }
}
