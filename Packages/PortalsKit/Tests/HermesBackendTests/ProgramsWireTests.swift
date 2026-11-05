import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Settings > Agents (`AgentProgramsProviding`): what a bridge's `programs.list` and
/// `program.update` answer, as the app reads it; and that a host without the feature is
/// asked nothing, and is no error.
@Suite struct ProgramsWireTests {
    private static func ready(_ features: [JSONValue]) -> JSONValue {
        ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": JSONValue.array(features)]]
    }

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

    private func decode<Output: Decodable>(_ json: String, as type: Output.Type) throws -> Output {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func aProgramReadsWhateverTheHostSaysOfIt() throws {
        let json = #"""
        {"programs":[
         {"id":"codex","name":"Codex","installed":true,"version":"0.170.0","standing":"newer","tested":["0.166.0"],"how":"npm","can_update":true,
          "command":"npm install -g @openai/codex@latest","latest":"0.170.0","update_available":false,"agents":["codex"],"takes_effect":"service_restart","running_version":"0.166.0",
          "update":{"state":"done","started_at":1800000000000,"ended_at":1800000060000,"from":"0.166.0","to":"0.170.0"}},
         {"id":"pi","name":"Pi","installed":true,"version":"0.9.0","standing":"too old","tested":["1.5.0"],"minimum":"1.1.0","how":"other","can_update":false,"command":"pi update","agents":[],"takes_effect":"next_start"},
         {"id":"droid","name":"Droid","installed":false,"version":null,"standing":"missing","tested":["1.3.0"],"how":null,"can_update":false,"agents":["droid"],"takes_effect":"next_start",
          "update":{"state":"failed","started_at":1800000000000,"timed_out":true,"tail":"npm ERR! code E404"}},
         {"id":"hermes","name":"Hermes","installed":true,"version":"0.22.5","standing":"tested","tested":["0.22.5"],"how":"own","can_update":true,"command":"hermes update","agents":["atlas","juno"],"takes_effect":"gateway_restart",
          "update":{"state":"running","started_at":1800000000000,"line":"restarting","unattended":true,"cannot_tell_file":"/x/hermes.3.json"}}
        ]}
        """#
        let programs = try decode(json, as: BridgeWire.ProgramsListResult.self).programs.map(\.program)
        #expect(programs[0].how == .npm)
        #expect(programs[0].updateAvailable == false)
        #expect(programs[0].state == .upToDate)
        #expect(programs[0].takesEffect == .serviceRestart)
        #expect(programs[0].runningVersion == "0.166.0")
        #expect(programs[0].update?.state == .done)
        #expect(programs[0].update?.endedAt == Date(timeIntervalSince1970: 1_800_000_060))
        #expect(programs[1].standing == .tooOld)
        #expect(programs[1].state == .tooOld(needs: "1.1.0"))
        #expect(!programs[1].canUpdate)
        #expect(programs[1].command == "pi update")
        #expect(!programs[2].isInstalled)
        #expect(programs[2].how == nil)
        #expect(programs[2].update?.timedOut == true)
        #expect(programs[2].update?.tail == "npm ERR! code E404")
        #expect(programs[3].takesEffect == .botsRestart)
        #expect(programs[3].state == .updating)
        #expect(programs[3].update?.line == "restarting")
        #expect(programs[3].update?.isUnattended == true)
        #expect(programs[0].update?.isUnattended == false)
        #expect(programs[3].update?.cannotTellFile == "/x/hermes.3.json")
        #expect(programs[0].update?.cannotTellFile == nil)
        #expect(programs[3].agents == ["atlas", "juno"])
    }

    /// Read leniently: a later host's new words, or fewer keys, cost only themselves.
    @Test func wordsItDoesNotKnowCostOnlyThemselves() throws {
        let program = try decode(
            #"{"id":"gemini","name":"Gemini","version":"1.0.0","standing":"sideways","how":"nix","takes_effect":"soon","update":{"state":"paused","started_at":1800000000000}}"#,
            as: BridgeWire.Program.self
        ).program
        #expect(program.standing == nil)
        #expect(program.how == nil)
        #expect(program.takesEffect == .nextStart)
        #expect(program.update == nil)
        #expect(program.isInstalled)
        #expect(!program.canUpdate)
        #expect(program.agents.isEmpty)
    }

    @Test func aHostWithTheFeatureIsAskedByTheContractsKeys() async throws {
        let (backend, transport) = try await connect(ready: Self.ready(["usage_read", "agent_programs"]))
        #expect(await backend.listsPrograms == true)

        let listing = Task { try await backend.agentPrograms() }
        let list = try #require(await transport.nextSentRequest())
        #expect(list["method"] == "programs.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(list["id"]), "result": ["programs": [["id": "claude", "name": "Claude Code", "version": "2.1.318", "installed": true]]]])
        #expect(try await listing.value.map(\.id) == ["claude"])

        let updating = Task { try await backend.updateProgram("claude") }
        let update = try #require(await transport.nextSentRequest())
        #expect(update["method"] == "program.update")
        #expect(update["params"]?["program"] == "claude")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(update["id"]), "result": ["program": ["id": "claude", "name": "Claude Code", "update": ["state": "running", "started_at": 1_800_000_000_000]]]])
        #expect(try await updating.value.isUpdating)

        let asking = Task { try await backend.usage(ofAgent: "claude") }
        let usage = try #require(await transport.nextSentRequest())
        #expect(usage["method"] == "usage.read")
        #expect(usage["params"]?["agent"] == "claude")
        #expect(usage["params"]?["session_id"] == nil)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(usage["id"]), "result": ["available": false]])
        #expect(try await asking.value == nil)
        await backend.disconnect()
    }

    @Test func aRefusalIsTheHostsSentence() async throws {
        let (backend, transport) = try await connect(ready: Self.ready(["agent_programs"]))
        let updating = Task { try await backend.updateProgram("pi") }
        let update = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(update["id"]), "error": ["code": -32602, "message": "Portals cannot update Pi here: to update it, run pi update on this host."]])
        await #expect(throws: ThreadPanelError.refused("Portals cannot update Pi here: to update it, run pi update on this host.")) { try await updating.value }
        await backend.disconnect()
    }

    /// An older host, and Hermes on its own: nothing is sent, and it says so without an error on screen.
    @Test func aHostWithoutTheFeatureIsAskedNothing() async throws {
        for ready in [Self.ready(["usage_read"]), ["replay_epoch": "e1", "heartbeat": false] as JSONValue] {
            let (backend, transport) = try await connect(ready: ready)
            #expect(await backend.listsPrograms == false)
            await #expect(throws: ThreadPanelError.unavailable) { try await backend.agentPrograms() }
            await #expect(throws: ThreadPanelError.unavailable) { try await backend.updateProgram("claude") }
            await #expect(throws: ThreadPanelError.unavailable) { try await backend.usage(ofAgent: "claude") }
            // The next thing sent is the next thing asked for: none of those went out.
            let listing = Task { try await backend.listAgents() }
            let next = try #require(await transport.nextSentRequest())
            #expect(next["method"] == "profiles.list")
            transport.deliver(["jsonrpc": "2.0", "id": try #require(next["id"]), "result": ["profiles": []]])
            _ = try await listing.value
            await backend.disconnect()
        }
    }
}
