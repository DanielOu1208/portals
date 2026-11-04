import AgentCore
import Foundation

/// The part of the Hermes gateway contract Portals speaks, written by hand.
///
/// The full contract is `apps/shared/src/gateway-contract.openrpc.json` in a Hermes
/// install (about 250 methods). Two rules keep this subset safe across Hermes versions:
///
/// - **Params** carry only keys the contract defines. Hermes rejects an unknown key
///   with error 4000, so `Tests/…/Fixtures/contract-subset.json` lists every key these
///   types can send and `scripts/check-contract.sh` checks that list against a host.
/// - **Results** decode leniently: everything except ids is optional and unknown fields
///   are ignored.
public enum HermesWire {
    /// Methods Portals calls.
    public enum Method {
        public static let clientCapabilities = "client.capabilities"
        public static let profilesList = "profiles.list"
        public static let sessionCreate = "session.create"
        public static let sessionResume = "session.resume"
        public static let sessionEventsSince = "session.events.since"
        public static let sessionInterrupt = "session.interrupt"
        public static let promptSubmit = "prompt.submit"
        public static let imageAttachBytes = "image.attach_bytes"
        public static let modelOptions = "model.options"
        public static let configGet = "config.get"
        public static let configSet = "config.set"
        public static let commandsCatalog = "commands.catalog"
        public static let slashExec = "slash.exec"
        public static let commandDispatch = "command.dispatch"
        public static let subagentList = "subagent.list"
    }

    /// Event types Portals reads.
    public enum EventType {
        public static let gatewayReady = "gateway.ready"
        public static let messageStart = "message.start"
        public static let messageDelta = "message.delta"
        public static let messageComplete = "message.complete"
        public static let error = "error"
    }

    // MARK: gateway.ready

    /// Payload of the first frame on every connection.
    public struct GatewayReady: Sendable, Hashable {
        /// Changes when the backend restarts: every live session and replay log is gone.
        public var replayEpoch: String?
        /// Whether the backend answers `gateway.ping`.
        public var supportsHeartbeat: Bool
        /// What `portals-bridge` says about itself; nil from `hermes serve`, which
        /// sends no such block.
        public var bridge: Bridge?

        /// The bridge's `{protocol, features}` block (docs/gateway-protocol.md, section 11).
        public struct Bridge: Sendable, Hashable {
            /// The bridge's own version (its package.json), for Settings' About; nil from a
            /// bridge from before it said.
            public var version: String?
            /// The extensions this bridge offers, such as `push_host`. Each is used only
            /// when listed here.
            public var features: Set<String>
            /// The Mac the bridge runs on (feature `machine`); nil from a bridge that
            /// does not say.
            public var machine: HostMachine?
            /// Where the bridge's copy of its net's list is (feature `net`); nil from a
            /// bridge without it.
            public var net: NetRevision?
            /// What keeps devices from reaching the Mac through the relay that the person
            /// can mend (`relay_problem`); nil when nothing does, for a word this app does
            /// not know, and from a bridge from before it said.
            public var relayProblem: RelayProblem? = nil
            /// A later version of portals-host that is out (feature `update_notice`'s
            /// `latest`); nil when there is none, and from a bridge without the feature.
            public var latest: String? = nil
            /// The free space on the bridge's disk (feature `disk_space`'s `disk`); nil
            /// before the bridge has read it, and from a bridge without the feature.
            public var disk: HostDisk? = nil
        }

        /// A bridge's `relay_problem` (docs/gateway-protocol.md, section 11, "The net").
        public enum RelayProblem: String, Sendable, Hashable {
            /// Another bridge with this Mac's relay id (a copy of its folder) holds the
            /// relay's standby socket.
            case inUse = "in_use"

            /// The line Settings shows with the host.
            public var message: String {
                switch self {
                case .inUse: "This host's relay id is in use by another bridge. To give it one of its own, run npx portals-host relay reset on it."
                }
            }
        }

        public init(payload: JSONValue) {
            replayEpoch = payload["replay_epoch"]?.stringValue
            if let heartbeat = payload["heartbeat"] {
                supportsHeartbeat = !(heartbeat.isNull || heartbeat == .bool(false))
            } else {
                supportsHeartbeat = false
            }
            if let block = payload["bridge"], block.objectValue != nil {
                let features = Set((block["features"]?.arrayValue ?? []).compactMap(\.stringValue))
                var machine: HostMachine?
                if features.contains(BridgeWire.Feature.machine),
                   let hostname = block["machine"]?["hostname"]?.stringValue, let home = block["machine"]?["home"]?.stringValue {
                    // Its id only from a bridge that says it keeps one for good.
                    let id = features.contains(BridgeWire.Feature.machineOrder) ? block["machine"]?["id"]?.stringValue : nil
                    // Its system, from a bridge that says (one from before Linux runs on a Mac).
                    let os = block["machine"]?["os"]?.stringValue.flatMap { $0.isEmpty ? nil : String($0.prefix(20)) }
                    machine = HostMachine(hostname: hostname, home: home, id: id.flatMap { $0.isEmpty ? nil : $0 }, os: os)
                }
                let net = features.contains(BridgeWire.Feature.net) ? BridgeWire.netRevision(block["net"]) : nil
                let version = block["version"]?.stringValue.flatMap { $0.isEmpty ? nil : String($0.prefix(40)) }
                let relayProblem = block["relay_problem"]?.stringValue.flatMap(RelayProblem.init(rawValue:))
                let latest = features.contains(BridgeWire.Feature.updateNotice) ? BridgeWire.laterVersion(block["latest"]) : nil
                let disk = features.contains(BridgeWire.Feature.diskSpace) ? BridgeWire.hostDisk(block["disk"]) : nil
                bridge = Bridge(version: version, features: features, machine: machine, net: net, relayProblem: relayProblem, latest: latest, disk: disk)
            }
        }

        /// What answered, as the app records it.
        public var hostKind: HostKind? { bridge == nil ? nil : .bridge }
    }

    // MARK: client.capabilities

    public struct ClientCapabilitiesParams: Encodable, Sendable {
        /// Declares that this client answers approval, clarify and the other
        /// server→client requests. Without it Hermes withdraws them immediately.
        public var serverRequests: Bool

        public init(serverRequests: Bool) {
            self.serverRequests = serverRequests
        }

        enum CodingKeys: String, CodingKey {
            case serverRequests = "server_requests"
        }
    }

    public struct ClientCapabilitiesResult: Decodable, Sendable, Hashable {
        /// The request methods this backend may send.
        public var serverRequests: [String]?

        enum CodingKeys: String, CodingKey {
            case serverRequests = "server_requests"
        }
    }

    // MARK: profiles.list

    public struct ProfilesListParams: Encodable, Sendable {
        public init() {}
    }

    public struct ProfilesListResult: Decodable, Sendable, Hashable {
        public var profiles: [ProfileRow]?
    }

    /// One Hermes profile: a persistent agent with its own memory, personality and config.
    public struct ProfileRow: Decodable, Sendable, Hashable {
        /// The name to pass as `profile` on other calls.
        public var name: String
        public var isDefault: Bool?
        public var displayName: String?
        public var description: String?
        public var model: String?
        public var provider: String?
        public var skillCount: Int?
        /// From a Portals bridge that lists `agent_kinds`: which agent runs it
        /// (`BridgeWire.Feature.agentKinds`). Kept as it came, so that a `kind` of
        /// another shape, from a host that means something else by it, costs nothing.
        public var kind: JSONValue?
        public var modeOptions: JSONValue?
        public var adoptModes: JSONValue?

        enum CodingKeys: String, CodingKey {
            case name
            case isDefault = "is_default"
            case displayName = "display_name"
            case description
            case model
            case provider
            case skillCount = "skill_count"
            case kind
            case modeOptions = "mode_options"
            case adoptModes = "adopt_modes"
        }
    }

    // MARK: session.create

    public struct SessionCreateParams: Encodable, Sendable {
        public var profile: String?
        /// Becomes the agent's platform. Portals sends `"tui"`: it keeps the coding brief
        /// and adds no desktop-only tools.
        public var source: String?
        public var title: String?
        public var cwd: String?
        /// Per-session model override. Hermes refuses a model its provider cannot serve
        /// with error -32602 instead of creating a session that fails on its first turn.
        public var model: String?
        public var provider: String?
        /// Per-session thinking level ("high").
        public var reasoningEffort: String?

        public init(
            profile: String? = nil,
            source: String? = "tui",
            title: String? = nil,
            cwd: String? = nil,
            model: String? = nil,
            provider: String? = nil,
            reasoningEffort: String? = nil
        ) {
            self.profile = profile
            self.source = source
            self.title = title
            self.cwd = cwd
            self.model = model
            self.provider = provider
            self.reasoningEffort = reasoningEffort
        }

        enum CodingKeys: String, CodingKey {
            case profile, source, title, cwd, model, provider
            case reasoningEffort = "reasoning_effort"
        }
    }

    public struct SessionCreateResult: Decodable, Sendable, Hashable {
        /// The runtime id. Changes whenever the session is reloaded.
        public var sessionID: String
        /// The durable id the transcript is stored under.
        public var storedSessionID: String?
        public var info: SessionInfo?
        /// A bridge's (`bot_chat`): the session is the agent's one ongoing conversation,
        /// which may hold what was said before.
        public var ongoing: Bool?

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case storedSessionID = "stored_session_id"
            case info, ongoing
        }
    }

    public struct SessionInfo: Decodable, Sendable, Hashable {
        public var model: String?
        /// An older bridge's own Spec model for a Droid thread, set from a menu the app has
        /// no more since 2026-10-23: read only to reset it (`HermesBackend.resetLegacySpecModel`).
        var specModel: String?
        var specReasoningEffort: String?
        public var provider: String?
        /// The thinking level in effect ("high"); empty or missing when the host
        /// leaves it to the provider.
        public var reasoningEffort: String?
        public var cwd: String?
        public var title: String?
        public var running: Bool?
        public var profileName: String?
        /// The Hermes version of the host.
        public var version: String?
        /// Token counts. Kept as raw JSON: only two of its numbers are read, and a
        /// count in a new shape must not cost the whole session.
        public var usage: JSONValue?
        /// A Portals bridge's mode for the thread and what following the agent's
        /// settings comes to (feature modes). Hermes sends neither.
        public var mode: String?
        public var modeDefault: String?
        public var modeOptions: JSONValue?

        enum CodingKeys: String, CodingKey {
            case model, provider, cwd, title, running, version, usage, mode
            case reasoningEffort = "reasoning_effort"
            case specModel = "spec_model"
            case specReasoningEffort = "spec_reasoning_effort"
            case profileName = "profile_name"
            case modeDefault = "mode_default"
            case modeOptions = "mode_options"
        }
    }

    // MARK: session.resume

    public struct SessionResumeParams: Encodable, Sendable {
        /// The durable id. Hermes follows it to the newest session if the thread was
        /// compressed since.
        public var sessionID: String
        public var profile: String?
        /// false returns `[image]` in place of each image's data, which can be megabytes.
        public var inlineImages: Bool?

        public init(sessionID: String, profile: String? = nil, inlineImages: Bool? = false) {
            self.sessionID = sessionID
            self.profile = profile
            self.inlineImages = inlineImages
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case profile
            case inlineImages = "inline_images"
        }
    }

    public struct SessionResumeResult: Decodable, Sendable, Hashable {
        /// Local socket receipt, deliberately not decoded from the host.
        public var receivedAtFrame: Int? = nil
        /// The runtime id events now arrive under.
        public var sessionID: String
        /// The durable id the transcript is stored under now.
        public var sessionKey: String?
        public var running: Bool?
        /// `idle`, `working`, or `waiting` while a request is open.
        public var status: String?
        /// The stored transcript: user, assistant and tool messages. See
        /// `HermesHistoryMapper` for their shapes.
        public var messages: [JSONValue]?
        public var info: SessionInfo?
        /// The turn in progress, which the stored messages do not hold yet: `user`,
        /// `assistant` (the text streamed so far) and `streaming`.
        public var inflight: JSONValue?
        /// Requests still waiting for an answer, as `{id, method, params}`. They are
        /// answered by a response frame with the same id.
        public var openRequests: [JSONValue]?
        /// A bridge's (`queue`): the messages waiting for the running turn to end, left
        /// out while none wait, and whether the agent can take one in.
        public var queued: [JSONValue]?
        public var canSteer: Bool?
        /// A bridge's: the number of the last event the answer holds. One that came on a
        /// connection that already followed the session, numbered up to it, is in it already.
        public var latestSeq: Int?
        /// A bridge's (`resume_replay`), asked with the last event the app applied: true when
        /// the answer brings the events after it (`events`, each as `session.events.since`
        /// lists them) in place of the conversation (`messages`, `inflight`).
        public var replayed: Bool?
        public var events: [JSONValue]?
        /// A bridge's (`resume_replay`), asked with this run's epoch: where the replay of the
        /// conversation the answer holds begins, which a resume from it sends back. It moves on
        /// whenever the conversation changes with no event.
        public var replayBase: Int?
        /// A bridge's: what the status line of the run going on says, while one is up.
        public var statusLine: String?
        /// A bridge's (`history_pages`), asked with `limit`: where in the conversation
        /// `messages` begin, and whether it has more before them.
        public var historyStart: Int?
        public var hasEarlier: Bool?

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case sessionKey = "session_key"
            case statusLine = "status_line"
            case historyStart = "history_start"
            case hasEarlier = "has_earlier"
            case running, status, messages, info, inflight, queued, replayed, events
            case openRequests = "open_requests"
            case canSteer = "can_steer"
            case latestSeq = "latest_seq"
            case replayBase = "replay_base"
        }
    }

    // MARK: session.events.since

    public struct SessionEventsSinceParams: Encodable, Sendable {
        /// The runtime id.
        public var sessionID: String
        /// The highest sequence number already applied.
        public var lastSeen: Int
        public var profile: String?

        public init(sessionID: String, lastSeen: Int, profile: String? = nil) {
            self.sessionID = sessionID
            self.lastSeen = lastSeen
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case lastSeen = "last_seen"
            case profile
        }
    }

    public struct SessionEventsSinceResult: Decodable, Sendable, Hashable {
        /// The missed events, each `{type, session_id, seq, payload}`, oldest first.
        public var events: [JSONValue]?
        public var latestSeq: Int?
        /// The replay log no longer reaches back to `last_seen`: some events are gone.
        public var truncated: Bool?
        public var openRequests: [JSONValue]?

        enum CodingKeys: String, CodingKey {
            case events
            case latestSeq = "latest_seq"
            case truncated
            case openRequests = "open_requests"
        }
    }

    // MARK: commands.catalog, slash.exec, command.dispatch
    //
    // Their results are read as raw JSON (`HermesCommands`): the catalog is large and
    // grows with every Hermes release, and one field in a new shape must not cost the
    // whole list.

    public struct CommandsCatalogParams: Encodable, Sendable {
        public var profile: String?

        public init(profile: String? = nil) {
            self.profile = profile
        }
    }

    /// Runs a command the way a terminal would, in a helper process beside the session.
    public struct SlashExecParams: Encodable, Sendable {
        public var sessionID: String
        /// The command without its slash: "status", "undo 2".
        public var command: String
        public var profile: String?

        public init(sessionID: String, command: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.command = command
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case command, profile
            case sessionID = "session_id"
        }
    }

    /// Asks what a command stands for, for the ones `slash.exec` will not run: skills,
    /// and commands that turn into a message.
    public struct CommandDispatchParams: Encodable, Sendable {
        public var name: String
        public var arg: String?
        public var sessionID: String
        public var profile: String?

        public init(name: String, arg: String? = nil, sessionID: String, profile: String? = nil) {
            self.name = name
            self.arg = arg
            self.sessionID = sessionID
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case name, arg, profile
            case sessionID = "session_id"
        }
    }

    // MARK: subagent.list

    /// The agents at work for a session. The result is read as raw JSON, entry by
    /// entry, the way the events about them are (`HermesEventMapper.subagent`).
    public struct SubagentListParams: Encodable, Sendable {
        public var sessionID: String
        public var profile: String?

        public init(sessionID: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case profile
            case sessionID = "session_id"
        }
    }

    // MARK: model.options, config.get, config.set

    public struct ModelOptionsParams: Encodable, Sendable {
        public var profile: String?

        public init(profile: String? = nil) {
            self.profile = profile
        }
    }

    public struct ModelOptionsResult: Decodable, Sendable, Hashable {
        public struct Provider: Decodable, Sendable, Hashable {
            public var slug: String
            public var name: String?
            public var models: [String]?
            /// Signed in on the host, so its models can be used.
            public var authenticated: Bool?
        }

        public var providers: [Provider]?
        /// What the agent runs on when nothing else is chosen.
        public var model: String?
        public var provider: String?
        /// A Portals bridge's thinking levels per model (`BridgeWire.levels`), kept
        /// raw so an odd entry costs only itself. Hermes sends none.
        public var modelLevels: JSONValue?
        /// A Portals bridge's names for its models (`BridgeWire.names`), kept raw for
        /// the same reason. Hermes sends none.
        public var modelNames: JSONValue?
        /// A Portals bridge's level per model when a thread chooses none
        /// (`BridgeWire.defaultLevels`), kept raw for the same reason. Hermes sends none.
        public var modelDefaultLevels: JSONValue?
        /// A Portals bridge's `{"default":"full"}` for an agent whose threads take a
        /// mode (feature modes), kept raw. Hermes sends none.
        public var modes: JSONValue?
        public var modeOptions: JSONValue?

        enum CodingKeys: String, CodingKey {
            case providers, model, provider, modes
            case modeOptions = "mode_options"
            case modelLevels = "model_levels"
            case modelNames = "model_names"
            case modelDefaultLevels = "model_default_levels"
        }
    }

    public struct ConfigGetParams: Encodable, Sendable {
        public var key: String
        public var profile: String?

        public init(key: String, profile: String? = nil) {
            self.key = key
            self.profile = profile
        }
    }

    public struct ConfigGetResult: Decodable, Sendable, Hashable {
        public var value: String?
    }

    /// A change that applies to one live session. Without `session_id` Hermes would
    /// write the profile's own configuration, so it is not optional here.
    public struct ConfigSetParams: Encodable, Sendable {
        public var key: String
        public var value: String
        public var sessionID: String
        public var profile: String?
        public var confirmExpensiveModel: Bool?

        public init(key: String, value: String, sessionID: String, profile: String? = nil, confirmExpensiveModel: Bool? = nil) {
            self.key = key
            self.value = value
            self.sessionID = sessionID
            self.profile = profile
            self.confirmExpensiveModel = confirmExpensiveModel
        }

        enum CodingKeys: String, CodingKey {
            case key, value, profile
            case sessionID = "session_id"
            case confirmExpensiveModel = "confirm_expensive_model"
        }
    }

    public struct ConfigSetResult: Decodable, Sendable, Hashable {
        public var warning: String?
        /// Hermes wants a yes before using an expensive model.
        public var confirmRequired: Bool?
        public var confirmMessage: String?
        /// The run in progress keeps its model; the change applies from the next turn.
        public var deferred: Bool?

        enum CodingKeys: String, CodingKey {
            case warning, deferred
            case confirmRequired = "confirm_required"
            case confirmMessage = "confirm_message"
        }
    }

    // MARK: image.attach_bytes

    /// Queues an image on the session; the next `prompt.submit` takes it along.
    public struct ImageAttachBytesParams: Encodable, Sendable {
        public var sessionID: String
        public var contentBase64: String
        /// Tells Hermes the image type by its extension.
        public var filename: String?
        public var profile: String?

        public init(sessionID: String, contentBase64: String, filename: String? = nil, profile: String? = nil) {
            self.sessionID = sessionID
            self.contentBase64 = contentBase64
            self.filename = filename
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case contentBase64 = "content_base64"
            case filename
            case profile
        }
    }

    public struct ImageAttachResult: Decodable, Sendable, Hashable {
        public var attached: Bool?
        /// Why it was not attached, when it was not.
        public var message: String?
        public var name: String?
    }

    // MARK: prompt.submit

    public struct PromptSubmitParams: Encodable, Sendable {
        public var sessionID: String
        public var text: String
        public var profile: String?

        public init(sessionID: String, text: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.text = text
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case text
            case profile
        }
    }

    public struct PromptSubmitResult: Decodable, Sendable, Hashable {
        /// `streaming`, or what Hermes did with a message sent mid-turn: `queued`,
        /// `steered` or `redirected`.
        public var status: String?
        public var userRowID: Int?
        /// A bridge's (`queue`): the message's id on the list of messages waiting.
        public var queueID: String?
        /// A bridge's (`file_mentions`): the files the message mentions that its agent may not read in.
        public var largeMentions: BridgeWire.LargeMentions?

        enum CodingKeys: String, CodingKey {
            case status
            case userRowID = "user_row_id"
            case queueID = "queue_id"
            case largeMentions = "large_mentions"
        }
    }

    // MARK: session.interrupt

    public struct SessionInterruptParams: Encodable, Sendable {
        public var sessionID: String
        public var profile: String?

        public init(sessionID: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case profile
        }
    }

    public struct SessionInterruptResult: Decodable, Sendable, Hashable {
        /// `interrupted` or `not_interrupted`.
        public var status: String?
    }
}

/// `session.set_spec_model` as a bridge from before 2026-10-23 takes it, to follow the
/// thread's model again (`HermesBackend.resetLegacySpecModel`).
struct LegacySpecModelReset: Encodable, Sendable {
    static let method = "session.set_spec_model"
    var sessionID: String
    var model = "default"
    var reasoningEffort = "default"

    enum CodingKeys: String, CodingKey {
        case model
        case sessionID = "session_id"
        case reasoningEffort = "reasoning_effort"
    }
}
