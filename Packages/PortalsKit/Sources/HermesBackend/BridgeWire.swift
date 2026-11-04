import AgentCore
import Foundation

/// The extensions a Portals bridge (`portals-bridge`) adds to the gateway
/// protocol (docs/gateway-protocol.md, section 11). Each is used only with a host whose
/// `gateway.ready` lists its feature: Hermes rejects keys it does not know, so it is
/// never sent any of this.
///
/// The keys sent are in the `bridge` part of `Tests/…/Fixtures/contract-subset.json`,
/// which `scripts/check-contract.sh` checks against the bridge's `bridge/contract.json`.
public enum BridgeWire {
    /// The names in `bridge.features`.
    public enum Feature {
        /// Live Droid MCP sign-in, outside the conversation.
        public static let mcpAuth = "mcp_auth"
        /// `folders.list`, and `session.create` takes a `cwd` from it.
        public static let folders = "folders"
        /// `model.options` carries `model_levels`.
        public static let modelLevels = "model_levels"
        /// The push registration may carry the app's id for the host.
        public static let pushHost = "push_host"
        /// `desk.list` and `session.adopt`: sessions started in a terminal on the host.
        public static let deskSessions = "desk_sessions"
        /// Message-level forks with provider-native positions.
        public static let messageFork = "message_fork"
        /// `model.options` carries `model_names`.
        public static let modelNames = "model_names"
        /// The `session.compacted` event and the stored `compaction` message: where the
        /// agent summarised the conversation to free its context.
        public static let compaction = "compaction"
        /// `session.rename`: the host keeps a title the user gives a thread.
        public static let rename = "rename"
        /// `sessions.activity`: the threads running or waiting on an answer now.
        public static let activity = "activity"
        /// `model.options` carries `model_default_levels`.
        public static let modelDefaultLevels = "model_default_levels"
        /// A `clarify` question may carry `header` and `descriptions`.
        public static let questionDetails = "question_details"
        /// Threads say their mode (`info.mode`, `session.mode`), `session.set_mode`
        /// changes it, and an approval may be a plan whose answer may carry a note.
        public static let modes = "modes"
        /// The push registration may carry the relay token the app got for its device,
        /// which a bridge without an APNs key sends through (docs/pairing-and-relay.md).
        public static let pushRelay = "push_relay"
        /// The push registration may carry a key for this host, and notifications then
        /// carry their words sealed to it under `aeriportal.sealed`.
        public static let pushSealed = "push_sealed"
        /// The push registration may carry `muted`, the kinds of notification this device
        /// wants none of (Settings, Notifications).
        public static let pushMuting = "push_muting"
        /// `folders.add`: the host puts a folder the user chose on it on its list.
        public static let foldersAdd = "folders_add"
        /// `gateway.ready` says which Mac the bridge is on (`bridge.machine`).
        public static let machine = "machine"
        /// `folders.search` ranks the folders under the bridge's home folder against a
        /// fuzzy query, or completes a typed path, for the new-thread folder picker.
        public static let folderSearch = "folder_search"
        /// `threads.changes`, `thread.mark` and `thread.delete`, and `thread_list` in the
        /// `sessions.activity` result: the bridge keeps the list of its threads for every
        /// device.
        public static let threadSync = "thread_sync"
        /// Each agent in `profiles.list` says its `kind`: which agent runs it, whatever
        /// it is called.
        public static let agentKinds = "agent_kinds"
        /// `prompt.submit` takes `when_busy`; the messages waiting for a running turn are
        /// listed (`queue.changed`, the snapshot's `queued`), and `prompt.queue.remove` and
        /// `prompt.queue.steer` act on one.
        public static let queue = "queue"
        /// `file.attach_bytes`: a file of any kind for the next message, saved in the
        /// thread's folder and named in the message by its path.
        public static let files = "files"
        /// `looks.list` and `look.set`, and `looks` in the `sessions.activity` result:
        /// the bridge keeps how its agents look for every device.
        public static let agentLooks = "agent_looks"
        /// `order.list` and `order.set`, and `order` in the `sessions.activity` result:
        /// the bridge keeps the order the user gave its agents and folders in the
        /// sidebar for every device.
        public static let sidebarOrder = "sidebar_order"
        /// `gateway.ready`'s `machine` carries the bridge's own `id`, and the order
        /// keeps `machines`, the user's Macs by those ids, with `machines_at`, when
        /// they were arranged; `order.set` takes both.
        public static let machineOrder = "machine_order"
        /// The answer to any approval may carry a `note` with a no, what to do instead,
        /// which the agent is told.
        public static let approvalNotes = "approval_notes"
        /// A thread in `threads.changes` may carry `branch`, the git branch checked out
        /// in its folder.
        public static let threadBranch = "thread_branch"
        /// The `subagent.*` events and `subagent.list` carry the bridge's keys (times,
        /// summary, result, `can_stop`, a workflow's phases and agents) and list the
        /// ended ones too; `subagent.stop` stops one by itself.
        public static let subagents = "subagents"
        /// `message.start` carries the message that opened the turn (`text`, `sender`,
        /// `message_id`), `message.steered` one handed to the running turn, and
        /// `prompt.submit` takes `message_id`, this device's own id for its message, which
        /// both name: every device shows every message said in the thread, and the one that
        /// sent it knows it as its own.
        public static let turnMessages = "turn_messages"
        /// The `subagent.cleared` event: the ended ones left the line as a message went
        /// to the agent, from any device.
        public static let subagentsClear = "subagents_clear"
        /// A subagent may carry `nickname` (a Codex sub-agent's, "Darwin") and `role`
        /// ("worker"; a Claude subagent's type, "Explore").
        public static let subagentNames = "subagent_names"
        /// The row of a Codex call about its sub-agents other than a spawn (`delegate_task`
        /// with `context` `wait`, `closeAgent`, …) names those it was about, `args.agents`,
        /// as the subagents line calls them.
        public static let subagentCalls = "subagent_calls"
        /// The `status.headline` event says what the agent is working on, in its own words
        /// (Claude Code's summary of a run of its calls), for the status line in place of
        /// "Thinking…" (`StatusHeadline`), with the calls it sums up (`tool_ids`).
        public static let statusHeadline = "status_headline"
        /// `client.capabilities` takes `poll_now`, and the bridge then sends `poll.now`, an
        /// event with no session, when something the poll reads moved: the device polls
        /// at once.
        public static let pollNow = "poll_now"
        /// `session.resume` takes `since` and `replay_epoch`, the last event the app applied
        /// to the thread and the run it was numbered in, and answers with only the events
        /// after it (`replayed`, `events`) when it can replay from there.
        public static let resumeReplay = "resume_replay"
        /// A canonical history repair invalidates the old streamed view. Followed
        /// sessions refresh with a full resume, bounded by its RPC receipt.
        public static let sessionResync = "session_resync"
        /// Exact failed-request replacement without rebuilding the running transcript.
        public static let messageReconciliation = "message_reconciliation"
        /// A thread an agent started from another thread is listed under it, not in the
        /// sidebar, unless `thread.mark` `shared` put it there too (the listing's
        /// `shared`); `request.cancel` says who answered one of its questions for the
        /// user (`by`, `answer`).
        public static let agentThreads = "agent_threads"
        /// The threads under Recent are the bridge's to keep for every device: `thread.mark`
        /// takes `recent` and a listed thread says it, as for a pin (`RecentThreadKeeping`).
        public static let recentThreads = "recent_threads"
        /// `message.complete` and an ended turn's last stored message say what the turn
        /// spent (`turn_usage`: `seconds`, `tokens`), which the turn's footer shows.
        public static let turnUsage = "turn_usage"
        /// `session.leave` makes the connection stop following a thread, which the app sends
        /// for a thread it let go of.
        public static let sessionLeave = "session_leave"
        /// A git worktree is never a folder of its own: `folders.list` lists its
        /// repository's folder in its place, a thread in `threads.changes` whose folder is
        /// in one carries `repo`, the repository's folder it is listed under, and
        /// `folders.add` of a folder in one adds its repository's and names it (`repo`).
        public static let worktrees = "worktrees"
        /// `message.complete` and an ended turn's last stored message say what the turn
        /// changed (`turn_diff`: its files with their diffs and counts), which a line under
        /// the turn opens.
        public static let turnDiff = "turn_diff"
        /// `file.read` gives the app a file from anywhere on the host's Mac: an image a reply
        /// names, or a file a tool row names.
        public static let fileRead = "file_read"
        /// `files.search` ranks the files and folders of a thread's folder, or of a folder a
        /// new thread may start in, against a fuzzy query, for an `@` mention.
        public static let fileSearch = "file_search"
        /// `prompt.submit` takes `mentions`, the files and folders a message mentions
        /// (relative to the thread's folder), each in its text as `@path`.
        public static let fileMentions = "file_mentions"
        /// The push route `DELETE threads/{id}/watcher` stops notifying one device about a
        /// thread. Without it there is only `DELETE threads/{id}`, which stops notifying
        /// every device. The plugin and a bridge also say so in `GET status` (`features`
        /// `watcher`), for a host that lists no features.
        public static let pushWatcher = "push_watcher"
        /// In a `session.resume` answer, a stored user message and `inflight` carry the
        /// `message_id` the message was sent with, while the bridge has kept the session
        /// loaded: a send whose answer was lost is matched to the host's turn by it.
        public static let messageIDs = "message_ids"
        /// Who a message sent through the fleet is from, and who started a thread through
        /// it, as facts (`from`, `started_by.from`; `MessageSender`): the agent, its thread
        /// and title, and the Mac by its stable id and name when that is another.
        public static let senders = "senders"
        /// Questions an agent asks without waiting (Codex's): a `clarify` with `async`,
        /// whose card stays open past the turn's end, for an app that says it keeps it
        /// (`client.capabilities` `async_questions`).
        public static let asyncQuestions = "async_questions"
        /// A command an agent left running in the background is a subagents-line entry of
        /// `kind` `command`, with its `output` so far (`Subagent.Kind.command`).
        public static let backgroundCommands = "background_commands"
        /// Live text and reasoning may arrive as `d`/`t` tuples, decoded into ordinary events.
        public static let leanDeltas = "lean_deltas"
        /// `client.capabilities` takes `device` (`thisDevice`), and `request.cancel` says
        /// `answered_by`, the `device` of the connection whose answer settled the request:
        /// an answer of this app's the host has not taken yet gives way to the one that won.
        public static let answerOwner = "answer_owner"
        /// A Hermes profile keeps one ongoing conversation (`ThreadRef.ongoing`), its bot
        /// chat: `session.create` for it gives that one (`ongoing: true`), which the list
        /// says (`ongoing: true` on its row), and its other threads are off the list.
        public static let botChat = "bot_chat"
        /// `session.resume` takes `limit`, a number of turns, and answers with the
        /// conversation's last ones only (`history_start`, `has_earlier`);
        /// `session.history` gives the ones before them (`HistoryPaging`).
        public static let historyPages = "history_pages"
        /// `gateway.ready`'s `bridge` block and the `sessions.activity` answer carry `latest`,
        /// a later version of portals-host that is out, only while there is one
        /// (`HostUpdate`): nothing updates a bridge by itself.
        public static let updateNotice = "update_notice"
        /// An empty list in `model_levels` says the model takes no thinking level (Cursor's
        /// Auto, a Droid model without reasoning), and none is offered for it.
        public static let modelLevelsNone = "model_levels_none"
    }

    /// A later version of portals-host, as a bridge with `update_notice` says it
    /// (`latest`): a version's characters only, at most 40 of them, beginning with a digit,
    /// so what Settings shows and the command beside it are only ever that. nil otherwise.
    public static func laterVersion(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue?.trimmingCharacters(in: .whitespaces), (1 ... 40).contains(text.count),
              text.first?.isASCII == true, text.first?.isNumber == true,
              text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".+-".contains($0)) }) else { return nil }
        return text
    }

    /// The id this app gives itself on every connection to a bridge with `answer_owner`,
    /// one for each launch: a `request.cancel` that names it settled the request with this
    /// app's own answer.
    public static let thisDevice = UUID().uuidString

    public enum EventType {
        public static let sessionInvalidated = "session.invalidated"
        /// Feature `poll_now`: something `sessions.activity` reads moved; no session, no seq.
        public static let pollNow = "poll.now"
    }

    public enum Method {
        public static let foldersList = "folders.list"
        public static let foldersAdd = "folders.add"
        public static let foldersRemove = "folders.remove"
        public static let foldersSearch = "folders.search"
        public static let deskList = "desk.list"
        public static let sessionAdopt = "session.adopt"
        public static let sessionFork = "session.fork"
        public static let sessionRename = "session.rename"
        public static let sessionLeave = "session.leave"
        public static let sessionsActivity = "sessions.activity"
        public static let sessionSetMode = "session.set_mode"
        public static let threadsChanges = "threads.changes"
        public static let threadMark = "thread.mark"
        public static let threadDelete = "thread.delete"
        /// Sent in place of Hermes's own only to a bridge that lists `queue`, with `when_busy`.
        public static let promptSubmit = "prompt.submit"
        public static let promptQueueRemove = "prompt.queue.remove"
        public static let promptQueueSteer = "prompt.queue.steer"
        public static let promptQueuePlace = "prompt.queue.place"
        /// Sent in place of Hermes's own only to a bridge that lists `subagents`, with `keep_background`.
        public static let sessionInterrupt = "session.interrupt"
        /// Sent to a bridge in place of Hermes's own, with the keys of the features it lists
        /// (`subagent_requests`, `poll_now`).
        public static let clientCapabilities = "client.capabilities"
        /// Sent in place of Hermes's own only to a bridge that lists `resume_replay`, with `since` and `replay_epoch`.
        public static let sessionResume = "session.resume"
        /// Feature `history_pages`: the turns of a thread before the first it holds.
        public static let sessionHistory = "session.history"
        public static let subagentStop = "subagent.stop"
        public static let fileAttachBytes = "file.attach_bytes"
        public static let fileRead = "file.read"
        public static let filesSearch = "files.search"
        public static let looksList = "looks.list"
        public static let lookSet = "look.set"
        public static let orderList = "order.list"
        public static let orderSet = "order.set"
    }

    // MARK: Queue

    /// `prompt.submit` with what a message sent while a turn runs is to do.
    public struct PromptSubmitParams: Encodable, Sendable {
        public var sessionID: String
        public var text: String
        public var profile: String?
        public var whenBusy: String
        /// This device's own id for the message, sent only to a bridge that lists
        /// `turn_messages`: the event that tells of the message names it.
        public var messageID: String?
        /// The files and folders the message mentions, relative to the thread's folder,
        /// sent only to a bridge that lists `file_mentions` (left out when nil).
        public var mentions: [String]?

        public init(sessionID: String, text: String, profile: String?, whenBusy: WhenBusy, messageID: String? = nil, mentions: [String]? = nil) {
            self.sessionID = sessionID
            self.text = text
            self.profile = profile
            self.whenBusy = whenBusy.rawValue
            self.messageID = messageID
            self.mentions = mentions
        }

        enum CodingKeys: String, CodingKey {
            case text, profile, mentions
            case sessionID = "session_id"
            case whenBusy = "when_busy"
            case messageID = "message_id"
        }
    }

    /// One message on a thread's list of messages waiting.
    public struct QueueItemParams: Encodable, Sendable {
        public var sessionID: String
        public var queueID: String
        public var profile: String?
        public var placement: String?

        public init(sessionID: String, queueID: String, profile: String?, placement: WhenBusy? = nil) {
            self.sessionID = sessionID
            self.queueID = queueID
            self.profile = profile
            self.placement = placement?.rawValue
        }

        enum CodingKeys: String, CodingKey {
            case profile, placement
            case sessionID = "session_id"
            case queueID = "queue_id"
        }
    }

    /// `client.capabilities` to a bridge: this app answers questions, and says it takes
    /// what the bridge offers of the rest. To one without either feature it is Hermes's,
    /// `{"server_requests":true}`.
    public struct ClientCapabilitiesParams: Encodable, Sendable {
        public var serverRequests = true
        /// With `subagents`: this app keeps the card of a question a subagent asks after
        /// the turn is over, so the bridge leaves such a question open when the turn ends.
        public var subagentRequests: Bool?
        /// With `poll_now`: this app polls at once when told by `poll.now` that something
        /// it polls for moved.
        public var pollNow: Bool?
        public var sessionResync: Bool?
        public var messageReconciliation: Bool?
        /// With `async_questions`: this app keeps the card of a question an agent asked
        /// without waiting after the turn is over, so the bridge puts such questions to it
        /// as a card rather than as the reply's text.
        public var asyncQuestions: Bool?
        public var leanDeltas: Bool?
        /// With `answer_owner`: this app's id (`thisDevice`), which a `request.cancel` its
        /// answer settled names.
        public var device: String?

        /// What a bridge listing `features` is told.
        public init(features: Set<String>) {
            device = features.contains(Feature.answerOwner) ? BridgeWire.thisDevice : nil
            subagentRequests = features.contains(Feature.subagents) ? true : nil
            asyncQuestions = features.contains(Feature.asyncQuestions) ? true : nil
            pollNow = features.contains(Feature.pollNow) ? true : nil
            sessionResync = features.contains(Feature.sessionResync) ? true : nil
            messageReconciliation = features.contains(Feature.messageReconciliation) ? true : nil
            leanDeltas = features.contains(Feature.leanDeltas) ? true : nil
        }

        enum CodingKeys: String, CodingKey {
            case serverRequests = "server_requests"
            case subagentRequests = "subagent_requests"
            case pollNow = "poll_now"
            case sessionResync = "session_resync"
            case messageReconciliation = "message_reconciliation"
            case asyncQuestions = "async_questions"
            case leanDeltas = "lean_deltas"
            case device
        }
    }

    /// `session.interrupt` to a bridge with `subagents`: Stop on the turn leaves the
    /// subagents and workflows in the background running, since the app has a Stop for each.
    public struct SessionInterruptParams: Encodable, Sendable {
        public var sessionID: String
        public var profile: String?
        public var keepBackground = true

        public init(sessionID: String, profile: String?) {
            self.sessionID = sessionID
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case profile
            case sessionID = "session_id"
            case keepBackground = "keep_background"
        }
    }

    /// `session.resume` to a bridge with `resume_replay`: with the last event the app applied
    /// to the thread, the epoch it was numbered in and where the replay of the conversation
    /// the thread took began (`replay_base`), for a thread it holds as of that event, so that
    /// the bridge can answer with the events after it in place of the conversation. nil
    /// leaves any of them out, and the answer is the whole thread; with this run's epoch, it
    /// says where the replay of what it gives begins.
    public struct SessionResumeParams: Encodable, Sendable {
        public var sessionID: String
        public var profile: String?
        public var inlineImages: Bool?
        public var since: Int?
        public var replayEpoch: String?
        public var replayBase: Int?
        /// Feature `history_pages`: only the conversation's last turns, this many.
        public var limit: Int?

        public init(
            sessionID: String, profile: String?, inlineImages: Bool? = false, since: Int?, replayEpoch: String?, replayBase: Int?,
            limit: Int? = nil
        ) {
            self.sessionID = sessionID
            self.profile = profile
            self.inlineImages = inlineImages
            self.since = since
            self.replayEpoch = replayEpoch
            self.replayBase = replayBase
            self.limit = limit
        }

        enum CodingKeys: String, CodingKey {
            case profile, since, limit
            case sessionID = "session_id"
            case inlineImages = "inline_images"
            case replayEpoch = "replay_epoch"
            case replayBase = "replay_base"
        }
    }

    /// `subagent.stop`: one subagent or workflow of the session's, stopped by itself.
    public struct SubagentStopParams: Encodable, Sendable {
        public var sessionID: String
        public var subagentID: String
        public var profile: String?

        public init(sessionID: String, subagentID: String, profile: String?) {
            self.sessionID = sessionID
            self.subagentID = subagentID
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case profile
            case sessionID = "session_id"
            case subagentID = "subagent_id"
        }
    }

    /// `stopped`, or `not_running` when it was not one that could be stopped any more.
    public struct SubagentStopResult: Decodable, Sendable {
        public var status: String?
    }

    public struct QueueRemoveResult: Decodable, Sendable {
        public var removed: Bool?
    }

    public struct QueueSteerResult: Decodable, Sendable {
        public var status: String?
    }

    /// The messages waiting, as `queue.changed` and the snapshot list them; who sent one
    /// through the fleet only from a host that says (feature `senders`), and the answers
    /// given on a card one carries likewise (`async_questions`), and the id its device gave
    /// it likewise (`message_ids`).
    public static func queuedMessages(_ value: JSONValue?, features: Set<String> = []) -> [QueuedMessage] {
        let readsSenders = features.contains(Feature.senders)
        let readsCardAnswers = features.contains(Feature.asyncQuestions)
        let readsMessageIDs = features.contains(Feature.messageIDs)
        return (value?.arrayValue ?? []).compactMap { entry in
            guard let id = entry["id"]?.stringValue, let text = entry["text"]?.stringValue else { return nil }
            return QueuedMessage(
                id: id, text: text, fromFleet: entry["fleet"]?.boolValue ?? false,
                placement: entry["placement"]?.stringValue.flatMap(WhenBusy.init(rawValue:)),
                from: readsSenders ? sender(entry["from"]) : nil,
                cardAnswer: readsCardAnswers ? entry["card_answer"]?.stringValue : nil,
                messageID: readsMessageIDs ? entry["message_id"]?.stringValue.flatMap(UUID.init(uuidString:)) : nil
            )
        }
    }

    /// Who sent a message through the fleet, or started a thread through it, as a bridge
    /// that offers `senders` says (`from`): its facts, each a line of text; nil when it
    /// gives none.
    public static func sender(_ value: JSONValue?) -> MessageSender? {
        guard let object = value?.objectValue else { return nil }
        return MessageSender(fields: object.compactMapValues(\.stringValue))
    }

    // MARK: Files

    public struct FileAttachBytesParams: Encodable, Sendable {
        public var sessionID: String
        public var contentBase64: String
        public var filename: String
        /// The app's own id for the file: attached again with it while it still waits on
        /// the bridge (a send tried again after it failed half way), it is not taken twice.
        /// A bridge that does not read it takes the file again.
        public var id: String?
        public var profile: String?

        public init(sessionID: String, contentBase64: String, filename: String, id: String? = nil, profile: String?) {
            self.sessionID = sessionID
            self.contentBase64 = contentBase64
            self.filename = filename
            self.id = id
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case filename, id, profile
            case sessionID = "session_id"
            case contentBase64 = "content_base64"
        }
    }

    public struct FileAttachResult: Decodable, Sendable {
        public var attached: Bool?
        public var name: String?
        public var path: String?
        public var message: String?
    }

    /// The bridge's error for a thread it does not know (or no longer has).
    public static let unknownThreadCode = 4007

    // MARK: Modes

    public struct SessionSetModeParams: Encodable, Sendable {
        public var sessionID: String
        public var mode: String
        public var profile: String?

        public init(sessionID: String, mode: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.mode = mode
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case mode, profile
            case sessionID = "session_id"
        }
    }

    public struct SessionSetModeResult: Decodable, Sendable {
        public var mode: String?
        public var modeDefault: String?
        public var modeOptions: JSONValue?

        enum CodingKeys: String, CodingKey {
            case mode
            case modeDefault = "mode_default"
            case modeOptions = "mode_options"
        }
    }

    /// A mode as the bridge says it; nil for one the app does not know.
    public static func modeState(mode: String?, default fallback: String?, options: JSONValue? = nil) -> ModeState? {
        guard let mode = mode.flatMap(ThreadMode.init(rawValue:)) else { return nil }
        return ModeState(mode: mode, defaultsTo: fallback.flatMap(ThreadMode.init(rawValue:)), options: modeOptions(options))
    }

    public static func modeOptions(_ value: JSONValue?) -> [ModeOption]? {
        var seen: Set<ThreadMode> = []
        let options = (value?.arrayValue ?? []).compactMap { entry -> ModeOption? in
            guard let raw = entry["id"]?.stringValue, let id = ThreadMode(rawValue: raw),
                  let label = entry["label"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty,
                  let description = entry["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty,
                  seen.insert(id).inserted else { return nil }
            return ModeOption(id: id, label: label, description: description)
        }
        return options.isEmpty ? nil : options
    }

    // MARK: sessions.activity

    /// Nothing: the answer is about every thread on the host.
    public struct SessionsActivityParams: Encodable, Sendable {
        public init() {}
    }

    public struct SessionsActivityResult: Decodable, Sendable {
        public struct Entry: Decodable, Sendable {
            public var sessionID: String
            /// `running` or `waiting`; anything else is skipped.
            public var state: String
            /// Running only for the threads started from it at work (feature agent_threads).
            public var inherited: Bool?
            /// False while it runs no turn of its own, for its subagents or workflows or
            /// `inherited`.
            public var turn: Bool?

            enum CodingKeys: String, CodingKey {
                case state, inherited, turn
                case sessionID = "session_id"
            }
        }

        public var sessions: [Entry]
        /// Feature `thread_sync`: the bridge's list and its revision now. Kept as raw
        /// JSON, so an odd one costs only itself.
        public var threadList: JSONValue?
        /// Feature `agent_looks`: the id and revision of the bridge's looks now. Kept
        /// as raw JSON, so an odd one costs only itself.
        public var looks: JSONValue?
        /// Feature `sidebar_order`: the id and revision of the sidebar's order now. Kept
        /// as raw JSON, so an odd one costs only itself.
        public var order: JSONValue?
        /// Feature `update_notice`: a later version of portals-host that is out, only while
        /// there is one. Kept as raw JSON, so an odd one costs only itself.
        public var latest: JSONValue?

        enum CodingKeys: String, CodingKey {
            case sessions, looks, order, latest
            case threadList = "thread_list"
        }

        /// Read leniently: an entry with a state the app does not know costs only itself.
        public var activity: [ThreadRef.ID: ThreadActivity] {
            var activity: [ThreadRef.ID: ThreadActivity] = [:]
            for entry in sessions {
                if let state = ThreadActivity(rawValue: entry.state) { activity[ThreadRef.ID(rawValue: entry.sessionID)] = state }
            }
            return activity
        }

        /// The threads listed only for the threads started from them at work, of those
        /// `activity` has.
        public var inherited: Set<ThreadRef.ID> {
            Set(sessions.filter { $0.inherited == true && ThreadActivity(rawValue: $0.state) != nil }.map { ThreadRef.ID(rawValue: $0.sessionID) })
        }

        /// The threads running with no turn of their own (`turn: false`, or `inherited`),
        /// of those `activity` has.
        public var withoutTurn: Set<ThreadRef.ID> {
            Set(sessions.filter { ($0.turn == false || $0.inherited == true) && ThreadActivity(rawValue: $0.state) != nil }
                .map { ThreadRef.ID(rawValue: $0.sessionID) })
        }

        /// The list's id and revision, when the answer has them; nil otherwise.
        public var list: ThreadListRevision? {
            threadList.flatMap(BridgeWire.listRevision(from:))
        }

        /// Where the bridge's looks are, when the answer says; nil otherwise.
        public var lookList: LookListRevision? {
            looks.flatMap(BridgeWire.lookRevision(from:))
        }

        /// Where the sidebar's order is, when the answer says; nil otherwise.
        public var orderList: SidebarOrderRevision? {
            order.flatMap(BridgeWire.orderRevision(from:))
        }

        /// The later version that is out, when the answer says one; nil otherwise.
        public var laterVersion: String? {
            BridgeWire.laterVersion(latest)
        }
    }

    // MARK: Looks (feature agent_looks)

    /// Nothing: `looks.list` answers with every look the bridge keeps.
    public struct LooksListParams: Encodable, Sendable {
        public init() {}
    }

    public struct LooksListResult: Decodable, Sendable {
        public var list: JSONValue?
        /// Kept as raw JSON, so one odd look costs only itself.
        public var looks: [JSONValue]?

        /// The answer as the app takes it. A look the app cannot read is left out, and
        /// that agent is drawn as before. Throws when the answer does not say where the
        /// list is: the device could not tell a later change from it.
        public func hostLooks() throws -> HostLooks {
            guard let list = list.flatMap(BridgeWire.lookRevision(from:)) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "looks.list answered without its list"))
            }
            var listed: [String: HostLook] = [:]
            for row in looks ?? [] {
                if let agent = row["agent"]?.stringValue, !agent.isEmpty, let look = BridgeWire.hostLook(from: row) { listed[agent] = look }
            }
            return HostLooks(list: list, looks: listed)
        }
    }

    /// `look.set`: a look for one of the bridge's agents. `showsLogo` is left out when
    /// nobody chose, as is `unless` when the look is to replace whatever the bridge has.
    public struct LookSetParams: Encodable, Sendable {
        public var profile: String
        public var shape: Int
        public var face: Int
        public var tint: Int
        public var showsLogo: Bool?
        /// `chosen` or `assigned` (`LookOrigin`).
        public var origin: String
        /// `any` or `chosen` (`LookCondition`).
        public var unless: String?

        public init(profile: String, look: HostLook, unless: LookCondition?) {
            self.profile = profile
            shape = look.look.shape
            face = look.look.face
            tint = look.look.tint
            showsLogo = look.look.showsLogo
            origin = look.origin.rawValue
            self.unless = unless?.rawValue
        }

        enum CodingKeys: String, CodingKey {
            case profile, shape, face, tint, origin, unless
            case showsLogo = "shows_logo"
        }
    }

    public struct LookSetResult: Decodable, Sendable {
        /// The look the agent has now, which is not the one sent when the bridge kept its own.
        public var look: JSONValue?

        public func hostLook() throws -> HostLook {
            guard let look = look.flatMap(BridgeWire.hostLook(from:)) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "look.set answered without the look"))
            }
            return look
        }
    }

    /// `{"id":"9c1e04b7a2d35f68","revision":14}`; nil for anything else.
    static func lookRevision(from value: JSONValue) -> LookListRevision? {
        guard let id = value["id"]?.stringValue, !id.isEmpty, let revision = value["revision"]?.intValue, revision >= 0 else { return nil }
        return LookListRevision(id: id, revision: revision)
    }

    /// A look as the bridge gives it. nil without its three numbers, with one below
    /// zero, or with who decided it missing or unknown; a logo setting that is neither
    /// true nor false counts as no choice.
    static func hostLook(from row: JSONValue) -> HostLook? {
        guard let shape = row["shape"]?.intValue, let face = row["face"]?.intValue, let tint = row["tint"]?.intValue,
              shape >= 0, face >= 0, tint >= 0,
              let origin = row["origin"]?.stringValue.flatMap(LookOrigin.init(rawValue:)) else { return nil }
        return HostLook(AgentLook(shape: shape, face: face, tint: tint, showsLogo: row["shows_logo"]?.boolValue), origin: origin)
    }

    // MARK: The sidebar's order (feature sidebar_order)

    /// Nothing: `order.list` answers with both lists the bridge keeps.
    public struct OrderListParams: Encodable, Sendable {
        public init() {}
    }

    /// `order.set`: the agents' names, the folders' paths or both, each list whole. One
    /// left out stays as the bridge has it. `machines` and `machinesAt` go together, to
    /// a bridge that lists `machine_order` only: the user's Macs and when they were
    /// arranged.
    public struct OrderSetParams: Encodable, Sendable {
        public var agents: [String]?
        public var folders: [String]?
        public var machines: [String]?
        public var machinesAt: Int?

        public init(agents: [String]?, folders: [String]?, machines: MachineOrder? = nil) {
            self.agents = agents
            self.folders = folders
            self.machines = machines?.ids
            machinesAt = machines?.at
        }

        enum CodingKeys: String, CodingKey {
            case agents, folders, machines
            case machinesAt = "machines_at"
        }
    }

    /// What `order.list` and `order.set` answer: the bridge's order as it is now.
    public struct OrderResult: Decodable, Sendable {
        public var list: JSONValue?
        /// Kept as raw JSON, so one odd name costs only itself.
        public var agents: [JSONValue]?
        public var folders: [JSONValue]?
        public var machines: [JSONValue]?
        public var machinesAt: JSONValue?

        enum CodingKeys: String, CodingKey {
            case list, agents, folders, machines
            case machinesAt = "machines_at"
        }

        /// The answer as the app takes it. A name that is no text, or empty, is left
        /// out; without the order's id and revision the answer is no order at all.
        /// `withMachines`: whether the bridge keeps the order of the user's Macs, which
        /// is read only then, and only with the moment it was arranged.
        public func hostOrder(withMachines: Bool = false) throws -> HostSidebarOrder {
            guard let list = list.flatMap(BridgeWire.orderRevision(from:)) else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "the bridge answered without its order's list"))
            }
            func names(_ values: [JSONValue]?) -> [String] {
                (values ?? []).compactMap { value in value.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
            }
            var arranged: MachineOrder?
            if withMachines, let at = machinesAt?.intValue, at > 0 { arranged = MachineOrder(ids: names(machines), at: at) }
            return HostSidebarOrder(list: list, order: SidebarOrder(agents: names(agents), folders: names(folders)), machines: arranged)
        }
    }

    /// `{"id":"4be07c1d9a2f6e35","revision":3}`; nil for anything else.
    static func orderRevision(from value: JSONValue) -> SidebarOrderRevision? {
        guard let id = value["id"]?.stringValue, !id.isEmpty, let revision = value["revision"]?.intValue, revision >= 0 else { return nil }
        return SidebarOrderRevision(id: id, revision: revision)
    }

    // MARK: Thread list (feature thread_sync)

    /// `threads.changes`: what changed in the bridge's list since a revision of it, or
    /// everything, with neither key.
    public struct ThreadsChangesParams: Encodable, Sendable {
        /// The id of the list the device merged last.
        public var list: String?
        /// The revision of it the device merged last.
        public var since: Int?

        public init(list: String?, since: Int?) {
            self.list = list
            self.since = since
        }

        /// Everything when `revision` is nil.
        public init(since revision: ThreadListRevision?) {
            self.init(list: revision?.id, since: revision?.revision)
        }
    }

    public struct ThreadsChangesResult: Decodable, Sendable {
        public var list: JSONValue?
        /// Kept as raw JSON, so one odd thread costs only itself.
        public var threads: [JSONValue]?
        public var removed: [JSONValue]?
        public var full: Bool?

        /// The answer taken from the frame as it was parsed, with nothing decoded a
        /// second time: the threads stay raw JSON either way, and an answer with every
        /// thread is the largest frame the app is sent. Throws for what decoding it
        /// throws for: an answer that is not an object, `threads` or `removed` that is
        /// not a list, `full` that is neither true nor false.
        public init(reading result: JSONValue) throws {
            guard let answer = result.objectValue else {
                throw Self.incomplete("threads.changes did not answer with an object")
            }
            func given<Value>(_ key: String, _ read: (JSONValue) -> Value?) throws -> Value? {
                guard let value = answer[key], !value.isNull else { return nil }
                guard let value = read(value) else {
                    throw Self.incomplete("threads.changes answered with \(key) of another kind")
                }
                return value
            }
            list = try given("list") { $0 }
            threads = try given("threads", \.arrayValue)
            removed = try given("removed", \.arrayValue)
            full = try given("full", \.boolValue)
        }

        /// The answer as the app merges it. A thread the app cannot read is listed as
        /// unreadable by its id, so it is neither changed nor forgotten. Throws when the
        /// answer does not say which list it is about, and when a full answer has no
        /// threads, or one without an id: every thread a full answer leaves out is
        /// forgotten, so it is taken only whole.
        public func changes(readsBranch: Bool = false, readsRepo: Bool = false, readsSenders: Bool = false, readsOngoing: Bool = false) throws -> ThreadListChanges {
            guard let list = list.flatMap(BridgeWire.listRevision(from:)) else {
                throw Self.incomplete("threads.changes answered without its list")
            }
            if full == true, threads == nil {
                throw Self.incomplete("threads.changes answered every thread without the threads")
            }
            var listed: [ListedThread] = []
            var unreadable: [ThreadRef.ID] = []
            for row in threads ?? [] {
                if let thread = BridgeWire.listedThread(
                    from: row, readsBranch: readsBranch, readsRepo: readsRepo, readsSenders: readsSenders, readsOngoing: readsOngoing
                ) {
                    listed.append(thread)
                } else if let id = row["id"]?.stringValue, !id.isEmpty {
                    unreadable.append(ThreadRef.ID(rawValue: id))
                } else if full == true {
                    throw Self.incomplete("threads.changes answered every thread with one that has no id")
                }
            }
            let removed = (removed ?? []).compactMap { $0.stringValue.flatMap { $0.isEmpty ? nil : ThreadRef.ID(rawValue: $0) } }
            return ThreadListChanges(list: list, threads: listed, removed: removed, isFull: full == true, unreadable: unreadable)
        }

        private static func incomplete(_ reason: String) -> DecodingError {
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: reason))
        }
    }

    /// `thread.mark`: only the keys given are marks to set.
    public struct ThreadMarkParams: Encodable, Sendable {
        public var thread: String
        public var pinned: Bool?
        public var archived: Bool?
        public var unseen: Bool?
        public var revision: Int?
        public var list: String?
        public var turn: Int?
        public var preview: String?
        /// Feature `agent_threads`.
        public var shared: Bool?
        /// Feature `recent_threads`.
        public var recent: Bool?

        public init(thread: String, marks: ThreadMarks) {
            turn = marks.turn
            self.thread = thread
            pinned = marks.pinned
            archived = marks.archived
            unseen = marks.unseen
            revision = marks.revision
            list = marks.list
            preview = marks.preview
            shared = marks.shared
            recent = marks.recent
        }
    }

    /// `thread.delete`; answered with nothing.
    public struct ThreadDeleteParams: Encodable, Sendable {
        public var thread: String

        public init(thread: String) {
            self.thread = thread
        }
    }

    /// `{"id":"3f9a1c0e7b2d4a65","revision":812}`; nil for anything else.
    static func listRevision(from value: JSONValue) -> ThreadListRevision? {
        guard let id = value["id"]?.stringValue, !id.isEmpty, let revision = value["revision"]?.intValue, revision >= 0 else { return nil }
        return ThreadListRevision(id: id, revision: revision)
    }

    /// A thread as the bridge's list gives it. nil for an entry without an id, an agent,
    /// a time or a revision; anything else odd costs only itself. `branch` is read only
    /// from a bridge that offers `thread_branch`, `repo` from one that offers `worktrees`,
    /// `ongoing` from one that offers `bot_chat` (a bridge from before 2026-10-21 said it of
    /// Aeri's thread, which is a thread like any other here).
    static func listedThread(
        from row: JSONValue, readsBranch: Bool = false, readsRepo: Bool = false, readsSenders: Bool = false, readsOngoing: Bool = false
    ) -> ListedThread? {
        guard let id = row["id"]?.stringValue, !id.isEmpty,
              let agent = row["agent"]?.stringValue, !agent.isEmpty,
              let updated = row["updated"]?.doubleValue,
              let revision = row["revision"]?.intValue else { return nil }
        let text = { (key: String) -> String? in
            guard let value = row[key]?.stringValue, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return value
        }
        var startedBy: ThreadStarter?
        if let name = row["started_by"]?["name"]?.stringValue, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let thread = row["started_by"]?["thread"]?.stringValue.flatMap { $0.isEmpty ? nil : ThreadRef.ID(rawValue: $0) }
            startedBy = ThreadStarter(name: name, thread: thread)
            // Who as facts (`senders`): a thread of another Mac is named by that Mac's id and its own id there.
            if readsSenders, let from = sender(row["started_by"]?["from"]) {
                startedBy = ThreadStarter(name: name, from: from, thread: thread)
            }
        }
        return ListedThread(
            id: ThreadRef.ID(rawValue: id),
            agent: agent,
            title: text("title"),
            folder: text("folder"),
            readOnly: row["read_only"]?.boolValue == true,
            ongoing: readsOngoing && row["ongoing"]?.boolValue == true,
            created: row["created"]?.doubleValue.map { Date(timeIntervalSince1970: $0) },
            updated: Date(timeIntervalSince1970: updated),
            revision: revision,
            preview: text("preview"),
            pinned: row["pinned"]?.boolValue == true,
            archived: row["archived"]?.boolValue == true,
            unseen: row["unseen"]?.boolValue == true,
            startedBy: startedBy,
            shared: row["shared"]?.boolValue == true,
            branch: readsBranch ? text("branch") : nil,
            repo: readsRepo ? text("repo") : nil,
            turn: row["turn"]?.intValue,
            recent: row["recent"]?.boolValue == true
        )
    }

    // MARK: session.rename

    public struct SessionRenameParams: Encodable, Sendable {
        public var sessionID: String
        public var title: String
        public var profile: String?

        public init(sessionID: String, title: String, profile: String? = nil) {
            self.sessionID = sessionID
            self.title = title
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case title, profile
            case sessionID = "session_id"
        }
    }

    // MARK: session.history

    /// Feature `history_pages`: the `limit` turns of a thread before message `before` of
    /// its conversation, for a thread that took it from there in the run `replayEpoch`,
    /// where the bridge's replay of it began at `replayBase`.
    public struct SessionHistoryParams: Encodable, Sendable {
        public var sessionID: String
        public var profile: String?
        public var before: Int
        public var limit: Int
        public var replayEpoch: String
        public var replayBase: Int

        public init(sessionID: String, profile: String?, before: Int, limit: Int, replayEpoch: String, replayBase: Int) {
            self.sessionID = sessionID
            self.profile = profile
            self.before = before
            self.limit = limit
            self.replayEpoch = replayEpoch
            self.replayBase = replayBase
        }

        enum CodingKeys: String, CodingKey {
            case profile, before, limit
            case sessionID = "session_id"
            case replayEpoch = "replay_epoch"
            case replayBase = "replay_base"
        }
    }

    /// The turns asked for, where they start in the conversation and whether it has more
    /// before them; or `moved`, when the conversation is not the one the thread took.
    public struct SessionHistoryResult: Decodable, Sendable {
        public var messages: [JSONValue]?
        public var start: Int?
        public var hasEarlier: Bool?
        public var moved: Bool?

        enum CodingKeys: String, CodingKey {
            case messages, start, moved
            case hasEarlier = "has_earlier"
        }
    }

    // MARK: session.leave

    public struct SessionLeaveParams: Encodable, Sendable {
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

    // MARK: file.read

    public struct FileReadParams: Encodable, Sendable {
        public var sessionID: String
        public var path: String
        /// `image` or `text`.
        public var purpose: String
        /// The etag of the copy the app holds.
        public var unless: String?
        public var profile: String?

        public init(sessionID: String, path: String, purpose: String, unless: String? = nil, profile: String? = nil) {
            self.sessionID = sessionID
            self.path = path
            self.purpose = purpose
            self.unless = unless
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case path, purpose, unless, profile
            case sessionID = "session_id"
        }
    }

    /// `file.read`'s answer: the file, or why the bridge would not give it.
    static func hostFile(from answer: JSONValue) throws -> HostFile {
        if let refused = answer["refused"]?.stringValue {
            throw FileReadError.refused(reason: refused, message: answer["message"]?.stringValue ?? "The host would not show this file.")
        }
        guard let name = answer["name"]?.stringValue, let path = answer["path"]?.stringValue,
              let etag = answer["etag"]?.stringValue, let kind = answer["kind"]?.stringValue else {
            throw FileReadError.refused(reason: "unreadable", message: "The host's answer could not be read.")
        }
        let size = answer["size"]?.intValue ?? 0
        let content: HostFile.Content
        if answer["unchanged"]?.boolValue == true {
            content = .unchanged
        } else if kind == "image", let base64 = answer["data"]?.stringValue, let data = Data(base64Encoded: base64) {
            content = .image(data, type: answer["type"]?.stringValue ?? "image")
        } else if kind == "text", let text = answer["text"]?.stringValue {
            content = .text(text)
        } else {
            throw FileReadError.refused(reason: "unreadable", message: "The host's answer could not be read.")
        }
        return HostFile(name: name, path: path, size: size, etag: etag, content: content)
    }

    // MARK: files.search

    public struct FilesSearchParams: Encodable, Sendable {
        /// The thread whose folder is searched; or
        public var sessionID: String?
        /// a folder from the host's list.
        public var folder: String?
        public var query: String
        public var limit: Int?
        public var profile: String?

        public init(scope: FileSearchScope, query: String, limit: Int? = nil, profile: String? = nil) {
            switch scope {
            case let .thread(id): sessionID = id.rawValue
            case let .folder(path): folder = path
            }
            self.query = query
            self.limit = limit
            self.profile = profile
        }

        enum CodingKeys: String, CodingKey {
            case folder, query, limit, profile
            case sessionID = "session_id"
        }
    }

    /// `files.search`'s answer. A hit the app cannot read (no path, an unknown kind) is left out.
    static func fileSearchResults(from answer: JSONValue) throws -> FileSearchResults {
        guard let folder = answer["folder"]?.stringValue, let files = answer["files"]?.arrayValue else {
            throw FileSearchError.refused("The host's answer could not be read.")
        }
        let hits = files.compactMap { file -> FileSearchHit? in
            guard let path = file["path"]?.stringValue, !path.isEmpty,
                  let kind = file["kind"]?.stringValue.flatMap(FileSearchHit.Kind.init(rawValue:)) else { return nil }
            let ranges = (file["ranges"]?.arrayValue ?? []).compactMap { range -> Range<Int>? in
                guard let pair = range.arrayValue, pair.count == 2, let start = pair[0].intValue, let end = pair[1].intValue, start < end else { return nil }
                return start ..< end
            }
            let name = file["name"]?.stringValue ?? (path as NSString).lastPathComponent
            return FileSearchHit(
                path: path, name: name, kind: kind, score: file["score"]?.intValue ?? 0, ranges: ranges,
                size: file["size"]?.intValue.flatMap { $0 >= 0 ? $0 : nil }
            )
        }
        // The agent's limit, only when whole: a part missing would say a wrong note.
        let limit = answer["mention_limit"]
        // A token limit past what an Int holds is as good as none.
        let tokens = limit?["max_tokens"].flatMap { $0.intValue ?? $0.doubleValue.flatMap { $0 > 0 ? Int.max : nil } }
        let mentionLimit = limit?["max_bytes"]?.intValue.flatMap { maxBytes in
            tokens.flatMap { maxTokens in
                limit?["note_bytes"]?.intValue.map { FileMentionLimit(maxBytes: maxBytes, maxTokens: maxTokens, noteBytes: $0) }
            }
        }
        return FileSearchResults(
            folder: folder,
            hits: hits,
            total: answer["total"]?.intValue ?? hits.count,
            matched: answer["matched"]?.intValue ?? hits.count,
            source: answer["source"]?.stringValue ?? "",
            truncated: answer["truncated"]?.boolValue ?? false,
            refreshing: answer["refreshing"]?.boolValue ?? false,
            mentionLimit: mentionLimit
        )
    }

    /// `prompt.submit`'s `large_mentions` (feature `file_mentions`). Read leniently: the
    /// message is sent by then, so nothing in this list may fail the answer; a row the app
    /// cannot read is left out.
    public struct LargeMentions: Decodable, Sendable, Hashable {
        public var mentions: [LargeFileMention]

        public init(from decoder: Decoder) throws {
            let rows = (try? JSONValue(from: decoder))?.arrayValue ?? []
            mentions = rows.compactMap { row in
                guard let path = row["path"]?.stringValue, let size = row["size"]?.intValue, size >= 0,
                      let fit = row["fit"]?.stringValue.flatMap(FileMentionFit.init(rawValue:)), fit != .whole else { return nil }
                return LargeFileMention(path: path, size: size, fit: fit)
            }
        }
    }

    /// An answer whose content is not read.
    public struct Done: Decodable, Sendable {}

    // MARK: folders.list

    public struct FoldersListParams: Encodable, Sendable {
        public var profile: String?

        public init(profile: String? = nil) {
            self.profile = profile
        }
    }

    public struct FoldersListResult: Decodable, Sendable, Hashable {
        public var general: FolderRow
        public var folders: [FolderRow]?

        /// The list as the app shows it.
        public var folderList: FolderList {
            FolderList(
                general: Folder(path: general.path, name: Folder.generalName),
                recent: (folders ?? []).map(\.folder)
            )
        }
    }

    public struct FolderRow: Decodable, Sendable, Hashable {
        /// The folder's real path on the host: what `session.create` takes as `cwd`.
        public var path: String
        public var name: String?
        /// Unix seconds.
        public var lastUsed: Double?
        /// The user added it (feature `folders_add`); absent otherwise.
        public var added: Bool?
        /// In the answer to `folders.add` of a folder in a git worktree (feature
        /// `worktrees`): the folder added in its place, its repository's, while `path` is
        /// the folder chosen, where an app from before the feature starts the new thread.
        public var repo: String?

        enum CodingKeys: String, CodingKey {
            case path, name, added, repo
            case lastUsed = "last_used"
        }

        /// The folder as listed: for one chosen in a worktree, its repository's, with the
        /// folder chosen as its `worktree`.
        var folder: Folder {
            let lastUsed = lastUsed.map { Date(timeIntervalSince1970: $0) }
            if let repo, !repo.isEmpty {
                return Folder(path: repo, lastUsed: lastUsed, isAdded: added ?? false, worktree: path)
            }
            return Folder(path: path, name: name, lastUsed: lastUsed, isAdded: added ?? false)
        }
    }

    // MARK: folders.add, folders.remove

    /// For both. `folders.add` answers with the folder as listed, a `FolderRow`;
    /// `folders.remove` with nothing.
    public struct FoldersAddParams: Encodable, Sendable {
        /// The folder's path on the host.
        public var path: String

        public init(path: String) {
            self.path = path
        }
    }

    // MARK: folders.search

    public struct FoldersSearchParams: Encodable, Sendable {
        public var query: String
        public var limit: Int?
        public var profile: String?

        public init(query: String, limit: Int? = nil, profile: String? = nil) {
            self.query = query
            self.limit = limit
            self.profile = profile
        }
    }

    /// `folders.search`'s answer. A hit the app cannot read (no path or no relative path)
    /// is left out; a range that is not a pair of offsets too.
    static func folderSearchResults(from answer: JSONValue) throws -> FolderSearchResults {
        guard let home = answer["home"]?.stringValue, let folders = answer["folders"]?.arrayValue else {
            throw FolderError.refused("The host's answer could not be read.")
        }
        let hits = folders.compactMap { folder -> FolderSearchHit? in
            guard let path = folder["path"]?.stringValue, !path.isEmpty,
                  let relative = folder["relative"]?.stringValue, !relative.isEmpty else { return nil }
            let ranges = (folder["ranges"]?.arrayValue ?? []).compactMap { range -> Range<Int>? in
                guard let pair = range.arrayValue, pair.count == 2, let start = pair[0].intValue, let end = pair[1].intValue, start < end else { return nil }
                return start ..< end
            }
            let repo = folder["repo"]?.stringValue
            return FolderSearchHit(
                path: path, name: folder["name"]?.stringValue, relative: relative, ranges: ranges, score: folder["score"]?.intValue ?? 0,
                isRepository: folder["git"]?.boolValue ?? false,
                lastUsed: folder["last_used"]?.doubleValue.map { Date(timeIntervalSince1970: $0) },
                isAdded: folder["added"]?.boolValue ?? false, repo: repo?.isEmpty == false ? repo : nil
            )
        }
        return FolderSearchResults(
            home: home,
            hits: hits,
            total: answer["total"]?.intValue ?? hits.count,
            matched: answer["matched"]?.intValue ?? hits.count,
            mode: answer["mode"]?.stringValue.flatMap(FolderSearchResults.Mode.init(rawValue:)) ?? .fuzzy,
            truncated: answer["truncated"]?.boolValue ?? false,
            refreshing: answer["refreshing"]?.boolValue ?? false,
            superseded: answer["superseded"]?.boolValue ?? false
        )
    }

    // MARK: desk.list

    public struct DeskListParams: Encodable, Sendable {
        public var profile: String?
        /// How many at most; the host's own default (40) when nil.
        public var limit: Int?

        public init(profile: String? = nil, limit: Int? = nil) {
            self.profile = profile
            self.limit = limit
        }
    }

    public struct DeskListResult: Decodable, Sendable, Hashable {
        /// Kept as raw JSON, so one odd row costs only itself.
        public var sessions: [JSONValue]?

        /// The sessions as the app lists them, for `agent`. A row without an id or a
        /// folder is left out; a state the app does not know is taken as idle.
        public func deskSessions(for agent: Agent.ID) -> [DeskSession] {
            (sessions ?? []).compactMap { row in
                guard let id = row["id"]?.stringValue, !id.isEmpty, let folder = row["folder"]?.stringValue, !folder.isEmpty else { return nil }
                return DeskSession(
                    id: id, agent: agent, title: row["title"]?.stringValue, folder: folder,
                    updated: row["updated"]?.doubleValue.map { Date(timeIntervalSince1970: $0) },
                    state: row["state"]?.stringValue.flatMap(DeskSession.State.init(rawValue:)) ?? .idle
                )
            }
        }
    }

    // MARK: session.adopt

    /// Answered like `session.create` (`HermesWire.SessionCreateResult`).
    public struct SessionAdoptParams: Encodable, Sendable {
        public var profile: String?
        public var sessionID: String
        /// `continue`, `fork` or `read` (`AdoptMode`).
        public var mode: String

        public init(profile: String? = nil, sessionID: String, mode: String) {
            self.profile = profile
            self.sessionID = sessionID
            self.mode = mode
        }

        enum CodingKeys: String, CodingKey {
            case profile, mode
            case sessionID = "session_id"
        }
    }

    /// Forks a stored thread at a provider-native checkpoint, not a client message id.
    public struct SessionForkParams: Encodable, Sendable {
        public var sessionID: String
        public var checkpointID: String
        public var before: Bool

        public init(sessionID: String, checkpointID: String, before: Bool) {
            self.sessionID = sessionID
            self.checkpointID = checkpointID
            self.before = before
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case checkpointID = "checkpoint_id"
            case before
        }
    }

    static func messageCheckpoint(_ value: JSONValue?) -> MessageCheckpoint? {
        guard let value, let id = value["id"]?.stringValue, !id.isEmpty,
              let canFork = value["can_fork"]?.boolValue,
              let canEdit = value["can_edit"]?.boolValue else { return nil }
        return MessageCheckpoint(id: id, canFork: canFork, canEdit: canEdit)
    }

    // MARK: Compaction

    /// A compaction as `session.compacted` and a stored `compaction` message describe it:
    /// `trigger` (`auto` when the agent did it by itself, otherwise it was asked for) and
    /// `tokens_before` when the agent said.
    /// What a turn spent, as `message.complete` and an ended turn's last stored message say
    /// it (feature `turn_usage`): nil when it says nothing that can be shown.
    static func turnSpent(_ value: JSONValue?) -> TurnSpent? {
        guard let value else { return nil }
        let seconds = value["seconds"]?.doubleValue.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        let tokens = value["tokens"]?.doubleValue.flatMap { $0.isFinite && $0 > 0 && $0 < 1e15 ? Int($0.rounded()) : nil }
        let spent = TurnSpent(seconds: seconds, tokens: tokens)
        return spent.isEmpty ? nil : spent
    }

    /// What a turn changed, as `message.complete` and an ended turn's last stored message
    /// say it (feature `turn_diff`): nil when it names no file. A file without a path is
    /// left out; counts that cannot be read are counted from its diff.
    static func turnDiff(_ value: JSONValue?) -> TurnDiff? {
        guard let entries = value?["files"]?.arrayValue else { return nil }
        let files = entries.compactMap { entry -> TurnDiff.File? in
            guard let path = entry["path"]?.stringValue, !path.isEmpty else { return nil }
            let diff = entry["diff"]?.stringValue ?? ""
            func count(_ key: String, _ fallback: () -> Int) -> Int {
                entry[key]?.doubleValue.flatMap { $0.isFinite && $0 >= 0 && $0 < 1e9 ? Int($0) : nil } ?? fallback()
            }
            let added = count("added") { DiffText(diff).added }
            let removed = count("removed") { DiffText(diff).removed }
            let status = entry["status"]?.stringValue.flatMap(TurnDiff.File.Status.init(rawValue:)) ?? .modified
            return TurnDiff.File(path: path, status: status, added: added, removed: removed, diff: diff, cut: entry["cut"]?.boolValue ?? false)
        }
        guard !files.isEmpty else { return nil }
        return TurnDiff(files: files, cut: (value?["cut"]?.boolValue ?? false) || files.contains(where: \.cut))
    }

    static func compaction(from value: JSONValue) -> Compaction {
        let before = value["tokens_before"]?.intValue.flatMap { $0 > 0 ? $0 : nil }
        return Compaction(value["trigger"]?.stringValue == "auto" ? .auto : .manual, tokensBefore: before)
    }

    // MARK: model.options

    /// `model_levels`: the thinking levels each model takes. Read leniently: a level the
    /// app does not know is left out, and a model whose entry is not a list of names is
    /// left out too (it then takes every level), so an odd entry costs nothing else.
    /// `emptyMeansNone` (feature `model_levels_none`): an empty list is kept, as a model
    /// that takes no level; without it, or for a list of names the app does not know, the
    /// model is left out.
    public static func levels(from value: JSONValue?, emptyMeansNone: Bool = false) -> [String: [ThinkingLevel]]? {
        guard let entries = value?.objectValue else { return nil }
        var levels: [String: [ThinkingLevel]] = [:]
        for (model, list) in entries {
            guard let names = list.arrayValue else { continue }
            if names.isEmpty {
                if emptyMeansNone { levels[model] = [] }
                continue
            }
            let known = names.compactMap { $0.stringValue.flatMap(ThinkingLevel.init(rawValue:)) }
            if !known.isEmpty { levels[model] = ThinkingLevel.allCases.filter(known.contains) }
        }
        return levels
    }

    /// `model_default_levels`: the level each model runs at when a thread chooses none.
    /// Read leniently: an entry that is not a level the app knows is left out, and that
    /// model runs at the agent's own level.
    public static func defaultLevels(from value: JSONValue?) -> [String: ThinkingLevel]? {
        guard let entries = value?.objectValue else { return nil }
        var levels: [String: ThinkingLevel] = [:]
        for (model, entry) in entries {
            if let level = entry.stringValue.flatMap(ThinkingLevel.init(rawValue:)) { levels[model] = level }
        }
        return levels
    }

    /// `model_names`: what to call each model ("Opus 5.5" for Claude Code's `default`).
    /// Read leniently: an entry that is not a name (not a string, or blank) is left out,
    /// and that model goes by its id.
    public static func names(from value: JSONValue?) -> [String: String]? {
        guard let entries = value?.objectValue else { return nil }
        var names: [String: String] = [:]
        for (model, entry) in entries {
            guard let name = entry.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { continue }
            names[model] = name
        }
        return names
    }
}
