import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct MCPAuthBackendTests {
    private let agent = Agent(id: Agent.ID(host: HostID(rawValue: "mac"), name: "custom-droid"), kind: "droid")

    private func connect(features: [String]) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: agent.id.host,
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        transport.deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": ["type": "gateway.ready", "payload": [
                "heartbeat": false, "replay_epoch": "epoch",
                "bridge": ["protocol": 1, "features": .array(features.map(JSONValue.string))],
            ]],
        ])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        reply(capabilities, ["server_requests": []], on: transport)
        try await connecting.value
        return (backend, transport)
    }

    private func reply(_ request: JSONValue, _ result: JSONValue, on transport: ScriptedTransport) {
        transport.deliver(["jsonrpc": "2.0", "id": request["id"]!, "result": result])
    }

    private func create(on backend: HermesBackend, transport: ScriptedTransport) async throws -> ThreadRef {
        let creating = Task { try await backend.createThread(with: agent.id, options: ThreadOptions()) }
        let request = try #require(await transport.nextSentRequest())
        reply(request, ["session_id": "runtime", "stored_session_id": "stored"], on: transport)
        return try await creating.value
    }

    @Test func oldBridgesOtherProvidersAndReadOnlyThreadsSendNoMCPMethod() async throws {
        for features in [[], ["mcp_auth"]] {
            let (backend, transport) = try await connect(features: features)
            let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored"), agent: agent.id, readOnly: features.isEmpty ? nil : true)
            #expect(try await backend.mcpAuth(.list, in: thread, agent: agent).isEmpty)
            await #expect(throws: MCPAuthError.self) {
                try await backend.mcpAuth(.start(server: "Example"), in: thread, agent: agent)
            }
            let other = Agent(id: agent.id, kind: "hermes")
            #expect(try await backend.mcpAuth(.list, in: thread, agent: other).isEmpty)
            // A known harmless call is next, not an auth call.
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            reply(next, ["profiles": []], on: transport)
            _ = try await listing.value
            await backend.disconnect()
        }
    }

    @Test func allFourActionsUseTheRuntimeSessionAndOnlySubmitCarriesTheCode() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        let actions: [(MCPAuthAction, JSONValue)] = [
            (.list, ["action": "list"]),
            (.start(server: "Example"), ["action": "start", "server_name": "Example"]),
            (.submit(server: "Example", authID: "a1", code: "sample-code"),
             ["action": "submit", "server_name": "Example", "auth_id": "a1", "code": "sample-code"]),
            (.cancel(server: "Example", authID: "a1"), ["action": "cancel", "server_name": "Example", "auth_id": "a1"]),
        ]
        for (action, expected) in actions {
            let calling = Task { try await backend.mcpAuth(action, in: thread, agent: agent) }
            let request = try #require(await transport.nextSentRequest())
            #expect(request["method"] == "mcp.auth")
            var params = try #require(expected.objectValue)
            params["session_id"] = "runtime"
            params["profile"] = .string(agent.id.name)
            #expect(request["params"] == .object(params))
            reply(request, ["servers": [["auth_id": "a1", "server_name": "Example", "status": "waiting",
                                          "url": "https://signin.example.test/?state=private"]]], on: transport)
            let cards = try await calling.value
            #expect(cards.count == 1)
            #expect(cards.first?.url?.host == "signin.example.test")
        }
        await backend.disconnect()
    }

    @Test func rawErrorsAreReplacedWithGenericTextAndAnInvalidationHasNoPayload() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        let calling = Task { try await backend.mcpAuth(.start(server: "Example"), in: thread, agent: agent) }
        let request = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": request["id"]!,
                           "error": ["code": -32603, "message": "private-code https://private.example.test"]])
        do {
            _ = try await calling.value
            Issue.record("Expected a generic failure")
        } catch {
            #expect(error is MCPAuthError)
            #expect(error.localizedDescription == "Sign-in did not finish. Try again.")
        }
        transport.deliver(["jsonrpc": "2.0", "method": "event",
                           "params": ["type": "mcp.auth", "session_id": "runtime", "seq": 1, "payload": [:]]])
        #expect(await events.nextLeavingOutRoster() == .mcpAuthChanged)
        await backend.disconnect()
        #expect(await events.nextLeavingOutRoster() == .mcpAuthCleared)
    }

    @Test func anUnloadedSessionIsResumedAndRetriedWithItsNewRuntimeID() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        let calling = Task { try await backend.mcpAuth(.start(server: "Example"), in: thread, agent: agent) }
        let first = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": first["id"]!,
                           "error": ["code": 4001, "message": "Thread is not loaded."]])
        let resume = try #require(await transport.nextSentRequest())
        #expect(resume["method"] == "session.resume")
        #expect(resume["params"]?["session_id"] == "stored")
        reply(resume, ["session_id": "new-runtime", "messages": [], "running": false], on: transport)
        let retry = try #require(await transport.nextSentRequest())
        #expect(retry["method"] == "mcp.auth")
        #expect(retry["params"]?["session_id"] == "new-runtime")
        reply(retry, ["servers": [["auth_id": "new", "server_name": "Example", "status": "starting"]]], on: transport)
        #expect(try await calling.value.first?.status == .starting)
        await backend.disconnect()
    }

    @Test func onlyThePinnedSettlingReasonGetsTheQuietRetryState() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        for reason in ["settling", "unknown_server"] {
            let calling = Task { try await backend.mcpAuth(.start(server: "Example"), in: thread, agent: agent) }
            let request = try #require(await transport.nextSentRequest())
            transport.deliver(["jsonrpc": "2.0", "id": request["id"]!,
                               "error": ["code": -32602, "message": "Never show this.", "data": ["reason": .string(reason)]]])
            do {
                _ = try await calling.value
                Issue.record("Expected a sign-in error")
            } catch MCPAuthError.settling {
                #expect(reason == "settling")
            } catch MCPAuthError.failed {
                #expect(reason != "settling")
            }
        }
        await backend.disconnect()
    }

    /// A paste the bridge would not take (from another attempt, not a code) is told apart
    /// from a sign-in that failed, by its -32602 with no reason; its sentence is never shown.
    @Test func aRefusedPasteIsToldApartFromAFailure() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        let actions: [(MCPAuthAction, MCPAuthError)] = [
            (.submit(server: "Example", authID: "a1", code: "other-state"), .rejected),
            (.start(server: "Example"), .failed),
        ]
        for (action, expected) in actions {
            let calling = Task { try await backend.mcpAuth(action, in: thread, agent: agent) }
            let request = try #require(await transport.nextSentRequest())
            transport.deliver(["jsonrpc": "2.0", "id": request["id"]!,
                               "error": ["code": -32602, "message": "That redirect URL does not contain a valid sign-in code for this attempt."]])
            await #expect(throws: expected) { try await calling.value }
        }
        #expect(MCPAuthError.rejected.localizedDescription == "That code or address was not accepted for this attempt. Paste it again.")
        await backend.disconnect()
    }

    @Test func aResponseFromADisconnectedSocketCannotRestoreItsURL() async throws {
        let (backend, transport) = try await connect(features: ["mcp_auth"])
        let thread = try await create(on: backend, transport: transport)
        let calling = Task { try await backend.mcpAuth(.list, in: thread, agent: agent) }
        _ = try #require(await transport.nextSentRequest())
        await backend.disconnect()
        await #expect(throws: MCPAuthError.self) { try await calling.value }
    }

    @Test func wireDropsURLsFromTerminalCardsAndRejectsMalformedLists() throws {
        let completed = try MCPAuthWire.cards(["servers": [
            ["auth_id": "a1", "server_name": "Example", "status": "completed", "url": "https://private.example.test"],
        ]])
        #expect(completed.first?.url == nil)
        #expect(throws: MCPAuthError.self) { try MCPAuthWire.cards(["cards": []]) }
        let event = GatewayEvent(type: "mcp.auth", sessionID: "runtime", seq: 1,
                                 payload: ["url": "https://private.example.test", "code": "private-code"])
        #expect(HermesEventMapper.threadEvents(for: event).isEmpty)
        #expect(HermesEventMapper.threadEvents(for: event, features: ["mcp_auth"]) == [.mcpAuthChanged])
    }

    /// A row it cannot read (a status from a later bridge, no id, a second row for one
    /// server) is left out; the rows it can read are still shown.
    @Test func wireSkipsRowsItCannotReadAndKeepsTheRest() throws {
        let cards = try MCPAuthWire.cards(["servers": [
            ["auth_id": "a1", "server_name": "Example", "status": "required"],
            ["auth_id": "a2", "server_name": "Later", "status": "expired"],
            ["auth_id": "", "server_name": "Empty", "status": "required"],
            ["server_name": "Missing", "status": "required"],
            ["auth_id": "a3", "server_name": "Example", "status": "completed"],
            ["auth_id": "a4", "server_name": "Other", "status": "cancelled"],
        ]])
        #expect(cards.map(\.id) == ["a1", "a4"])
        #expect(cards.first?.status == .required)
        #expect(try MCPAuthWire.cards(["servers": [["status": "waiting"]]]).isEmpty)
    }

    @Test func contractPinsTheFeatureMethodEventAndEveryActionKey() throws {
        let subset = try Fixtures.json("contract-subset.json")
        let method = try #require(subset["bridge"]?["methods"]?["mcp.auth"])
        #expect(method["feature"] == "mcp_auth")
        let allowed = Set(try #require(method["params"]?.arrayValue).compactMap(\.stringValue))
        var sent: Set<String> = []
        for action in [MCPAuthAction.list, .start(server: "Example"),
                       .submit(server: "Example", authID: "a1", code: "sample-code"),
                       .cancel(server: "Example", authID: "a1")] {
            sent.formUnion(try #require(MCPAuthWire.params(action, sessionID: "runtime", profile: "droid").objectValue).keys)
        }
        #expect(sent == allowed)
        #expect(subset["bridge"]?["events"]?["mcp.auth"]?["feature"] == "mcp_auth")
        #expect(subset["methods"]?["mcp.auth"] == nil)
    }
}
