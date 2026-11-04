import AgentCore
import Foundation

/// Turns the stored transcript Hermes returns from `session.resume` into the app's.
///
/// Message shapes, from captures of Hermes 0.21.5:
/// - user: `role`, `text`, `timestamp`, `row_id`. Images sent with the message are
///   stored as `@image:<path on the host>` lines after the text. Not every message in
///   the user's place is the user's: see `HermesHostEvents`.
/// - assistant: `role`, `text`, `timestamp`, `reasoning` when the model reasoned, and
///   `display_metadata.interrupted` when the reply was cut short (stopped, or the server
///   shut down mid-run). `display_kind` `failed_turn` marks Hermes's own closing line
///   for a turn that failed. For a Codex model (from Hermes 0.21.5's source), what it
///   wrote beside its tool calls is in `display_commentary`, a list; `reasoning` then
///   has it run in, and `display_reasoning` is the reasoning without it.
///   `display_content`, when present, is the text to show in place of `text`.
/// - tool: `role`, `name`, `args`, `context`, `tool_call_id`, `timestamp`, and usually
///   `content` (the tool's result as a JSON string) and
///   `display_metadata.tool_result_metadata.inline_diff`
///
/// History has less than a live turn did: no durations, no record of an approval, no
/// notices. A thread followed live keeps its richer cached transcript; this is for a
/// thread the app has no copy of, or one that moved on while the app was away.
///
/// A bridge offering `compaction` (`BridgeWire.Feature`) also stores where the agent
/// summarised the conversation: `role` `compaction`, with `trigger` and `tokens_before`.
/// One offering `turn_usage` puts what a turn spent on its last message (`turn_usage`);
/// one offering `turn_diff`, what it changed (`turn_diff`).
enum HermesHistoryMapper {
    /// - Parameter features: the bridge extensions the host offers; a message of one it
    ///   does not list is not read.
    static func transcript(from messages: [JSONValue], features: Set<String> = []) -> Transcript {
        var turns: [Turn] = []
        var previous: Date?
        var toolItems: [String: (turn: Int, item: Int)] = [:]

        func openTurn(at date: Date) -> Int {
            if turns.isEmpty {
                // History that opens with the agent speaking.
                turns.append(Turn(startedAt: date, endedAt: date, outcome: .completed))
            }
            return turns.count - 1
        }

        let readsSpent = features.contains(BridgeWire.Feature.turnUsage)
        let readsChanges = features.contains(BridgeWire.Feature.turnDiff)
        for message in messages {
            let date = message["timestamp"]?.doubleValue.map(Date.init(timeIntervalSince1970:)) ?? previous ?? .distantPast
            defer {
                previous = date
                // A bridge's: the last message of an ended turn says what it spent, for the
                // turn it is in (one that only opened it, too).
                if readsSpent, let spent = BridgeWire.turnSpent(message["turn_usage"]), let last = turns.indices.last {
                    turns[last].spent = spent
                }
                if readsChanges, message["turn_diff"] != nil, let changed = BridgeWire.turnDiff(message["turn_diff"]), let last = turns.indices.last {
                    turns[last].diff = changed
                }
            }

            switch message["role"]?.stringValue {
            case "user":
                // Whatever is in the user's place starts a turn; what it starts with
                // is their message, a line about what the host did, or nothing.
                turns.append(Turn(startedAt: date, endedAt: date, outcome: .completed, items: opening(message, at: date, features: features)))

            case "assistant":
                let index = openTurn(at: date)
                let reasoning = (message["display_reasoning"] ?? message["reasoning"])?.stringValue?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !reasoning.isEmpty {
                    turns[index].items.append(TurnItem(.reasoning(Reasoning(text: reasoning, startedAt: previous ?? date, endedAt: date))))
                }
                for piece in message["display_commentary"]?.arrayValue ?? [] {
                    if let said = piece.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !said.isEmpty {
                        turns[index].items.append(TurnItem(.text(said)))
                    }
                }
                let text = (message["display_content"] ?? message["text"])?.stringValue?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                turns[index].endedAt = date
                if message["display_kind"]?.stringValue == "failed_turn" {
                    // Hermes closing a turn that failed, not the agent speaking.
                    turns[index].outcome = .failed(TurnFailure(message: text.isEmpty ? "This turn did not complete." : text))
                    if features.contains(BridgeWire.Feature.messageReconciliation) {
                        turns[index].failedRequestID = message["display_metadata"]?["failed_request_id"]?.stringValue
                    }
                    continue
                }
                if !text.isEmpty {
                    turns[index].items.append(TurnItem(.text(text)))
                }
                let wasCutShort = message["display_metadata"]?["interrupted"]?.boolValue ?? false
                turns[index].outcome = wasCutShort ? .interrupted : .completed

            case "tool":
                let index = openTurn(at: date)
                if let item = toolItem(message, features: features, at: date) {
                    let id = message["tool_call_id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
                    if let id, let earlier = toolItems[id], Self.sameCall(item, turns[earlier.turn].items[earlier.item]) {
                        // Older histories can include both a background launch receipt
                        // and a final result. Keep the original row, with the latest result.
                        turns[earlier.turn].items[earlier.item].content = item.content
                        // Its second result came: the id may name another call later.
                        toolItems[id] = nil
                    } else {
                        // Only a call launched to run in the background has a second
                        // result to come. Other calls are a row each, also when their ids
                        // repeat: some models number calls afresh in each answer, and
                        // some send none.
                        if let id, case let .tool(run) = item.content, run.execution?.background == true {
                            toolItems[id] = (index, turns[index].items.count)
                        }
                        turns[index].items.append(item)
                        turns[index].endedAt = date
                    }
                }

            case "compaction" where features.contains(BridgeWire.Feature.compaction):
                let index = openTurn(at: date)
                turns[index].items.append(TurnItem(.compaction(BridgeWire.compaction(from: message))))
                turns[index].endedAt = date

            default:
                continue
            }
        }
        // A wake the agent said nothing to leaves nothing to show.
        return Transcript(turns: turns.filter { !$0.items.isEmpty })
    }

    /// What a turn opens with, for the stored message that started it; who sent it through
    /// the fleet only from a host that says (feature `senders`), and the answers given on a
    /// card it carries likewise (`async_questions`).
    static func opening(_ message: JSONValue, at date: Date, features: Set<String> = []) -> [TurnItem] {
        switch HermesHostEvents.row(message) {
        case let .message(stored, steered):
            let (text, images, files) = userText(stored)
            let from = features.contains(BridgeWire.Feature.senders) ? BridgeWire.sender(message["from"]) : nil
            let cardAnswer = features.contains(BridgeWire.Feature.asyncQuestions) ? message["card_answer"]?.stringValue : nil
            let checkpoint = !steered && features.contains(BridgeWire.Feature.messageFork)
                ? BridgeWire.messageCheckpoint(message["checkpoint"]) : nil
            return [TurnItem(id: message["message_id"]?.stringValue.flatMap(UUID.init(uuidString:)) ?? UUID(),
                             .user(UserMessage(text: text, sentAt: date, delivery: steered ? .steered : .started, images: images, files: files, from: from, cardAnswer: cardAnswer, checkpoint: checkpoint)))]
        case let .event(event):
            return [TurnItem(.event(event))]
        case .hidden:
            return []
        }
    }

    /// A stored user message as what was typed and what was attached. The images are
    /// only named here: the files are on the host, and the app shows its own copies. A
    /// bridge's files (`files`) are named by their paths after a line of their own.
    static func userText(_ stored: String) -> (text: String, images: [AttachedImage], files: [AttachedFile]) {
        let parsed = SentText.parse(stored)
        let files = parsed.files.map { AttachedFile(filename: SentText.name(ofPath: $0), path: $0) }
        guard !parsed.images.isEmpty || !files.isEmpty else { return (stored, [], []) }
        let text = parsed.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = parsed.images.map { reference in
            // The path is quoted when it has spaces in it.
            let path = reference.trimmingCharacters(in: CharacterSet(charactersIn: "`\"' "))
            return AttachedImage(filename: path.split(separator: "/").last.map(String.init) ?? "image")
        }
        return (text, images, files)
    }

    /// A thread as `session.resume` describes it: the stored turns, the turn in progress
    /// with what it has streamed so far, and the requests waiting for an answer.
    /// - Parameter authoritative: the answer was asked for because the host repaired the
    ///   thread (`ThreadSnapshot.authoritative`); an ordinary open is not.
    static func snapshot(
        from resumed: HermesWire.SessionResumeResult, features: Set<String> = [], authoritative: Bool = false, at now: Date = .now
    ) -> ThreadSnapshot {
        var transcript = transcript(from: resumed.messages ?? [], features: features)
        let isRunning = resumed.running ?? false

        if isRunning {
            // What started the turn in progress, read the way a stored message is: it
            // can be the host's doing as well as the user's.
            let inflightOpening: JSONValue? = resumed.inflight?["user"]?.stringValue.map { started in
                var message: [String: JSONValue] = ["role": "user", "text": .string(started)]
                message["display_kind"] = resumed.inflight?["display_kind"]
                message["display_metadata"] = resumed.inflight?["display_metadata"]
                // A bridge's (`message_ids`): the id the message was sent with.
                message["message_id"] = resumed.inflight?["message_id"]
                // A bridge's (`senders`): who sent it through the fleet.
                message["from"] = resumed.inflight?["from"]
                // A bridge's (`async_questions`): the answers given on a card it carries.
                message["card_answer"] = resumed.inflight?["card_answer"]
                return .object(message)
            }
            let opening = inflightOpening.map { Self.opening($0, at: now, features: features) } ?? []
            let streamed = resumed.inflight?["assistant"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            // The turn in progress is the last stored one when it was started by the same
            // thing (Hermes stores the message as soon as it is sent); otherwise it has
            // not been stored at all yet.
            func sameOpening(as items: [TurnItem]) -> Bool {
                let stored = items.first { $0.opensTurn }?.content
                let running = opening.first { $0.opensTurn }?.content
                guard case .user? = stored, case .user? = running else { return stored == running }
                // Parsing attachments creates local UUIDs and reduces image paths
                // to filenames. Compare the original stored references instead.
                guard let message = resumed.messages?.last(where: {
                    $0["role"]?.stringValue == "user" && HermesHostEvents.row($0) != .hidden
                }),
                      let inflightOpening,
                      case let .message(storedText, _) = HermesHostEvents.row(message),
                      case let .message(runningText, _) = HermesHostEvents.row(inflightOpening) else { return false }
                return storedText == runningText
            }
            if let last = transcript.turns.indices.last,
               resumed.inflight?["user"]?.stringValue == nil || sameOpening(as: transcript.turns[last].items) {
                transcript.turns[last].outcome = nil
                transcript.turns[last].endedAt = nil
                transcript.turns[last].spent = nil
                transcript.turns[last].diff = nil
            } else {
                transcript.turns.append(Turn(startedAt: now, items: opening))
            }
            let running = transcript.turns.count - 1
            if let reasoning = resumed.inflight?["reasoning"]?.stringValue, !reasoning.isEmpty {
                transcript.turns[running].items.append(TurnItem(.reasoning(Reasoning(text: reasoning, startedAt: now))))
            }
            for tool in resumed.inflight?["tools"]?.arrayValue ?? [] {
                guard let run = HermesToolDisplay.started(tool, features: features, at: now) else { continue }
                if let index = transcript.turns[running].items.firstIndex(where: {
                    if case let .tool(existing) = $0.content { existing.id == run.id } else { false }
                }) {
                    transcript.turns[running].items[index].content = .tool(run)
                } else {
                    transcript.turns[running].items.append(TurnItem(.tool(run)))
                }
            }
            if features.contains(BridgeWire.Feature.turnUsage) {
                transcript.turns[running].spent = BridgeWire.turnSpent(resumed.inflight?["turn_usage"])
            }
            if !streamed.isEmpty, transcript.turns[running].items.last?.content != .text(streamed) {
                transcript.turns[running].items.append(TurnItem(.text(streamed)))
            }
        }

        let openRequests = (resumed.openRequests ?? []).compactMap { entry -> PendingRequest? in
            guard let id = entry["id"]?.stringValue, let method = entry["method"]?.stringValue else { return nil }
            return HermesEventMapper.pendingRequest(ServerRequest(id: id, method: method, params: entry["params"] ?? .null), features: features)
        }
        // A malformed host snapshot can list one request more than once. Keep the first
        // request still eligible; adopting these maps the IDs into a dictionary.
        let eligibleRequests = isRunning ? openRequests : openRequests.filter(\.outlivesTurn)
        var seenRequests = Set<String>()
        let uniqueRequests = eligibleRequests.filter { seenRequests.insert($0.id).inserted }
        let info = info(from: resumed, features: features)
        return ThreadSnapshot(
            transcript: transcript,
            isRunning: isRunning,
            title: info.title,
            // With no turn running, only what a subagent still at work asks.
            openRequests: uniqueRequests,
            model: info.model,
            context: info.context,
            workingDirectory: info.workingDirectory,
            mode: info.mode,
            queued: queued(in: resumed, features: features),
            canSteerQueued: resumed.canSteer ?? false,
            authoritative: authoritative && features.contains(BridgeWire.Feature.sessionResync),
            hostKeepsMessageIDs: features.contains(BridgeWire.Feature.messageIDs),
            // Read as the line is when it comes live (`thinking.delta`).
            statusLine: isRunning ? resumed.statusLine.flatMap(HermesEventMapper.statusText) : nil,
            hasEarlier: resumed.historyStart == nil ? nil : resumed.hasEarlier ?? ((resumed.historyStart ?? 0) > 0)
        )
    }

    /// What a `session.resume` answer says of the thread besides its conversation.
    static func info(from resumed: HermesWire.SessionResumeResult, features: Set<String> = []) -> ThreadInfo {
        info(from: resumed.info, features: features)
    }

    /// The same info block accompanies creation, adoption and resume.
    static func info(from info: HermesWire.SessionInfo?, features: Set<String> = []) -> ThreadInfo {
        ThreadInfo(
            title: info?.title,
            model: setting(from: info),
            context: HermesEventMapper.contextUsage(info?.usage),
            workingDirectory: info?.cwd.flatMap { $0.isEmpty ? nil : $0 },
            mode: features.contains(BridgeWire.Feature.modes) ? BridgeWire.modeState(mode: info?.mode, default: info?.modeDefault, options: info?.modeOptions) : nil
        )
    }

    /// The messages waiting that a `session.resume` answer lists, from a host that lists them
    /// (`queue`); nil from any other.
    static func queued(in resumed: HermesWire.SessionResumeResult, features: Set<String>) -> [QueuedMessage]? {
        // A bridge that lists its queue leaves it out while nothing waits.
        features.contains(BridgeWire.Feature.queue) ? BridgeWire.queuedMessages(resumed.queued.map(JSONValue.array), features: features) : nil
    }

    /// The normal model a session runs on, as its info block reports it.
    static func setting(from info: HermesWire.SessionInfo?) -> ModelSetting? {
        guard let model = info?.model, !model.isEmpty else { return nil }
        return ModelSetting(
            model: model,
            provider: info?.provider,
            level: info?.reasoningEffort.flatMap(ThinkingLevel.init(rawValue:))
        )
    }

    /// Whether two tool rows with one id are the same call (a background launch's receipt
    /// and its final result): the same tool, given the same input.
    private static func sameCall(_ later: TurnItem, _ earlier: TurnItem) -> Bool {
        guard case let .tool(a) = later.content, case let .tool(b) = earlier.content else { return false }
        return a.name == b.name && a.input == b.input && a.label == b.label
    }

    private static func toolItem(_ message: JSONValue, features: Set<String>, at date: Date) -> TurnItem? {
        guard let name = message["name"]?.stringValue else { return nil }
        let args = message["args"] ?? .null
        // The result is stored as JSON text; a tool that returned plain text stays text.
        let result: JSONValue = message["content"]?.stringValue.map { (try? JSONValue.parse($0)) ?? .string($0) } ?? .null

        if name == "clarify" {
            // A bridge's questions asked without waiting whose card is still open: the card stands for them.
            if result["asking"]?.boolValue == true { return nil }
            let questions = (args["questions"]?.arrayValue ?? []).compactMap { $0["question"]?.stringValue }
            let answers = (result["responses"]?.arrayValue ?? []).compactMap { $0["user_response"]?.stringValue }.filter { !$0.isEmpty }
            // Hermes usually leaves this tool's result out of history, so what was
            // answered is not known: only that the question was asked.
            // A bridge's questions asked without waiting, taken back unanswered (async_questions).
            let answer = if result.isNull { "Answered" } else if answers.isEmpty {
                result["unanswered"]?.boolValue == true ? "Not answered" : "Skipped"
            } else { answers.joined(separator: "\n") }
            return TurnItem(.request(RequestRecord(
                id: message["tool_call_id"]?.stringValue ?? UUID().uuidString,
                kind: .question,
                prompt: questions.joined(separator: "\n"),
                answer: answer,
                // A bridge's questions asked without waiting: they stay in view.
                askedAhead: features.contains(BridgeWire.Feature.asyncQuestions) && args["async"]?.boolValue == true
            )))
        }

        let inlineDiff = message["display_metadata"]?["tool_result_metadata"]?["inline_diff"]?.stringValue
        // Read as the live row was: from the same payload, with the result's keys.
        var payload: [String: JSONValue] = ["tool_id": .string(message["tool_call_id"]?.stringValue ?? UUID().uuidString), "name": .string(name), "args": args, "result": result]
        payload["context"] = message["context"]
        if let inlineDiff { payload["inline_diff"] = .string(inlineDiff) }
        guard let finished = HermesToolDisplay.finished(.object(payload), features: features) else { return nil }
        return TurnItem(.tool(ToolRun(
            id: finished.id,
            name: name,
            label: finished.label,
            input: finished.input,
            output: finished.output,
            diff: finished.diff,
            state: finished.succeeded ? .succeeded : .failed,
            startedAt: date,
            subagentCall: finished.subagentCall,
            path: finished.path,
            startLine: finished.startLine,
            plan: finished.plan,
            execution: finished.execution
        )))
    }
}
