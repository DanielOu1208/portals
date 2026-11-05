import AgentCore
import Foundation

// Settings > Agents (`AgentProgramsProviding`): a bridge's `agent_programs`.

extension BridgeWire.Feature {
    /// `programs.list` says which agents' programs are on the host, `program.update` updates
    /// one, and `usage.read` takes `agent`, for a page with no thread to ask through.
    public static let agentPrograms = "agent_programs"
}

extension BridgeWire.Method {
    public static let programsList = "programs.list"
    public static let programUpdate = "program.update"
}

extension BridgeWire {
    public struct ProgramParams: Encodable, Sendable {
        public var program: String

        public init(program: String) {
            self.program = program
        }
    }

    /// `usage.read` for an agent rather than a thread.
    public struct AgentUsageParams: Encodable, Sendable {
        public var agent: String

        public init(agent: String) {
            self.agent = agent
        }
    }

    public struct Program: Decodable, Sendable {
        public struct Update: Decodable, Sendable {
            public var state: String
            /// Milliseconds since 1970.
            public var startedAt: Double
            public var endedAt: Double?
            public var from: String?
            public var to: String?
            public var timedOut: Bool?
            public var line: String?
            public var tail: String?
            public var unattended: Bool?
            public var cannotTellFile: String?

            enum CodingKeys: String, CodingKey {
                case state, from, to, line, tail, unattended
                case cannotTellFile = "cannot_tell_file"
                case startedAt = "started_at"
                case endedAt = "ended_at"
                case timedOut = "timed_out"
            }

            /// nil for a state this app does not know.
            var update: AgentProgram.Update? {
                AgentProgram.Update.State(rawValue: state).map {
                    AgentProgram.Update(
                        state: $0, startedAt: Date(timeIntervalSince1970: startedAt / 1000), endedAt: endedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                        from: from, to: to, timedOut: timedOut ?? false, line: line, tail: tail, isUnattended: unattended ?? false, cannotTellFile: cannotTellFile
                    )
                }
            }
        }

        public var id: String
        public var name: String
        public var installed: Bool?
        public var version: String?
        public var standing: String?
        public var tested: [String]?
        public var minimum: String?
        public var how: String?
        public var canUpdate: Bool?
        public var command: String?
        public var latest: String?
        public var updateAvailable: Bool?
        public var agents: [String]?
        public var takesEffect: String?
        public var runningVersion: String?
        public var update: Update?

        enum CodingKeys: String, CodingKey {
            case id, name, installed, version, standing, tested, minimum, how, command, latest, agents, update
            case canUpdate = "can_update"
            case updateAvailable = "update_available"
            case takesEffect = "takes_effect"
            case runningVersion = "running_version"
        }

        public var program: AgentProgram {
            AgentProgram(
                id: id, name: name, isInstalled: installed ?? (version != nil), version: version,
                standing: standing.flatMap(AgentProgram.Standing.init(rawValue:)), tested: tested ?? [], minimum: minimum,
                how: how.flatMap(AgentProgram.InstallMethod.init(rawValue:)), canUpdate: canUpdate ?? false, command: command,
                latest: latest, updateAvailable: updateAvailable, agents: agents ?? [],
                takesEffect: takesEffect.flatMap(AgentProgram.TakesEffect.init(rawValue:)) ?? .nextStart, runningVersion: runningVersion,
                update: update?.update
            )
        }
    }

    public struct ProgramsListResult: Decodable, Sendable {
        public var programs: [Program]
    }

    public struct ProgramUpdateResult: Decodable, Sendable {
        public var program: Program
    }
}

extension HermesBackend: AgentProgramsProviding {
    public var listsPrograms: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.agentPrograms) }
    }

    /// A version is read once a minute for all devices, and Hermes's takes a while to say it.
    public func agentPrograms() async throws -> [AgentProgram] {
        guard offers(BridgeWire.Feature.agentPrograms) else { throw ThreadPanelError.unavailable }
        let result: BridgeWire.ProgramsListResult = try await peer().call(BridgeWire.Method.programsList, BridgeWire.NoParams(), timeout: .seconds(60))
        return result.programs.map(\.program)
    }

    public func updateProgram(_ id: AgentProgram.ID) async throws -> AgentProgram {
        guard offers(BridgeWire.Feature.agentPrograms) else { throw ThreadPanelError.unavailable }
        do {
            let result: BridgeWire.ProgramUpdateResult = try await peer().call(BridgeWire.Method.programUpdate, BridgeWire.ProgramParams(program: id), timeout: .seconds(30))
            return result.program.program
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode {
            throw ThreadPanelError.refused(error.message)
        }
    }

    /// As `usage(of:)`, with the time Claude Code may take to be started only to be asked.
    public func usage(ofAgent name: String) async throws -> UsageLimits? {
        guard offers(BridgeWire.Feature.agentPrograms) else { throw ThreadPanelError.unavailable }
        do {
            let result: BridgeWire.UsageReadResult = try await peer().call(BridgeWire.Method.usageRead, BridgeWire.AgentUsageParams(agent: name), timeout: .seconds(60))
            return result.usage
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode || error.code == -32603 {
            throw ThreadPanelError.refused(error.message)
        }
    }
}
