import AgentCore
import Foundation

/// Turns Hermes gateway events into backend-neutral thread events.
///
/// Observed on Hermes 0.21.5 (see the captures under `Tests/…/Fixtures`):
/// - `thinking.delta` is not model reasoning. It carries the one-line status the TUI
///   shows beside its spinner, and an empty text clears it. Most of the time that line
///   is decoration, a face and a random verb ("(◔_◔) pondering..."); now and then it
///   says something ("waiting on provider — retrying in 2s"). `statusText` keeps only
///   the second kind.
/// - `status.update` with kind `warn` is worth keeping; kind `lifecycle` is transient.
/// - A failed turn ends with `message.complete` whose status is `error`, whose `text`
///   is a readable explanation and whose `error` is the raw cause.
/// - `message.interim` closes a piece of text the agent wrote beside its tool calls
///   (Hermes 0.21.5 source; Hermes's desktop app keeps it as a bubble of its own). For
///   most models the piece also streamed as `message.delta` (`already_streamed`); a
///   Codex model's commentary comes only this way.
enum HermesEventMapper {
    /// - Parameter features: the bridge extensions the host offers (`BridgeWire.Feature`);
    ///   an event of one it does not list is not read.
    /// - Parameter isOwn: whether a message id (`turn_messages`) is one this app gave a
    ///   message it sent: such a message is this app's own, which it shows already.
    /// - Parameter device: the id this app gave the host (`answer_owner`), by which a
    ///   `request.cancel` says whether this app's own answer settled the request.
    static func threadEvents(
        for event: GatewayEvent, features: Set<String> = [], isOwn: (String) -> Bool = { _ in false },
        device: String = BridgeWire.thisDevice, at now: Date = .now
    ) -> [ThreadEvent] {
        let payload = event.payload
        /// Who sent a message through the fleet, from a bridge that says (`senders`).
        func sender(_ payload: JSONValue) -> MessageSender? {
            features.contains(BridgeWire.Feature.senders) ? BridgeWire.sender(payload["from"]) : nil
        }
        /// The answers given on a card that a message carries, from a bridge that says (`async_questions`).
        func cardAnswer(_ payload: JSONValue) -> String? {
            features.contains(BridgeWire.Feature.asyncQuestions) ? payload["card_answer"]?.stringValue : nil
        }
        switch event.type {
        case "mcp.auth":
            return features.contains(BridgeWire.Feature.mcpAuth) ? [.mcpAuthChanged] : []

        case "reasoning.delta":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return [] }
            return [.reasoningDelta(text)]

        case "tool.start":
            // The clarify tool shows up as the question it asks, not as a tool row.
            guard payload["name"]?.stringValue != "clarify", let run = HermesToolDisplay.started(payload, features: features, at: now) else { return [] }
            return [.toolStarted(run)]

        case "tool.complete":
            guard payload["name"]?.stringValue != "clarify", let result = HermesToolDisplay.finished(payload, features: features) else { return [] }
            return [.toolFinished(result)]

        case "tool.progress":
            guard let id = payload["tool_id"]?.stringValue, !id.isEmpty else { return [] }
            return [.toolProgress(ToolProgress(
                id: id, output: payload["output"]?.stringValue, progress: payload["progress"]?.stringValue,
                outputTruncated: payload["output_truncated"]?.boolValue
            ))]

        case "request.cancel":
            guard let id = payload["id"]?.stringValue else { return [] }
            // A bridge's that says whose answer settled it: not this app's, an answer given
            // here and not taken yet gives way to how the host settled it.
            let elsewhere: [ThreadEvent] = features.contains(BridgeWire.Feature.answerOwner)
                && payload["answered_by"]?.stringValue != device ? [.requestSettledElsewhere(id: id)] : []
            // A bridge's: answered for you by the agent that started the thread.
            if features.contains(BridgeWire.Feature.agentThreads), payload["reason"]?.stringValue == "resolved",
               let by = payload["by"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !by.isEmpty {
                guard let answer = payload["answer"].flatMap(givenAnswer) else { return elsewhere + [.requestClosed(id: id, reason: "Answered by \(by)")] }
                return elsewhere + [.requestAnswered(id: id, answer: answer, by: by)]
            }
            // A bridge's: questions asked without waiting, answered on another device, with
            // the answer, which their row shows (the message it went as has no bubble).
            if features.contains(BridgeWire.Feature.asyncQuestions), payload["reason"]?.stringValue == "resolved", let given = payload["answer"], given.objectValue != nil {
                return elsewhere + [.requestAnswered(id: id, answer: givenAnswer(given) ?? .cancelled, by: nil)]
            }
            return elsewhere + [.requestClosed(id: id, reason: closureReason(payload["reason"]?.stringValue))]

        case "message.start":
            let queued = features.contains(BridgeWire.Feature.queue) ? payload["queue_id"]?.stringValue : nil
            // A bridge's: the message that opened the run, from whichever device, thread
            // or terminal. This app's own shows already.
            if features.contains(BridgeWire.Feature.turnMessages), let text = payload["text"]?.stringValue,
               !(payload["message_id"]?.stringValue.map(isOwn) ?? false) {
                return [.turnOpened(by: text, queueID: queued, from: sender(payload), cardAnswer: cardAnswer(payload))]
            }
            // A bridge says when a message sent through Portals opened the run.
            if !features.contains(BridgeWire.Feature.turnMessages), payload["opened_by"]?.stringValue == "portals",
               let text = payload["text"]?.stringValue {
                return [.turnOpened(by: text)]
            }
            // This app's own, by the id it gave it (`turn_messages`), whether it waited on the list or not.
            if features.contains(BridgeWire.Feature.turnMessages), let own = payload["message_id"]?.stringValue.flatMap(UUID.init(uuidString:)),
               isOwn(own.uuidString) {
                return [.ownTurnStarted(own, queueID: queued)]
            }
            // A bridge's: the message that waited on its list and opens the turn.
            if let queued {
                return [.queuedTurnStarted(queued)]
            }
            return [.turnStarted]

        case "message.checkpoint":
            guard (features.contains(BridgeWire.Feature.messageFork) || features.contains(BridgeWire.Feature.turnFileUndo)),
                  let checkpoint = BridgeWire.messageCheckpoint(payload["checkpoint"], features: features) else { return [] }
            return [.messageCheckpoint(checkpoint)]

        case "message.steered":
            // A bridge's: a message handed to the running turn, this app's own or another's.
            guard features.contains(BridgeWire.Feature.turnMessages), let text = payload["text"]?.stringValue else { return [] }
            if features.contains(BridgeWire.Feature.messageReconciliation), payload["reconciled"]?.boolValue == true {
                let id = payload["message_id"]?.stringValue.flatMap(UUID.init(uuidString:))
                return [.messageSteered(text, from: sender(payload), cardAnswer: cardAnswer(payload), messageID: id)]
            }
            if let id = payload["message_id"]?.stringValue, isOwn(id) {
                // This app's own: the thread knows it by the id it gave it.
                return UUID(uuidString: id).map { [.ownMessageSteered($0)] } ?? []
            }
            return [.messageSteered(text, from: sender(payload), cardAnswer: cardAnswer(payload))]

        case "message.taken":
            guard features.contains(BridgeWire.Feature.messageReconciliation), let id = payload["request_id"]?.stringValue, !id.isEmpty else { return [] }
            return [.failedRequestTaken(id)]

        case "message.delta":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return [] }
            return [.textDelta(text)]

        case "message.interim":
            guard let text = payload["text"]?.stringValue, !text.isEmpty else { return [] }
            return [.interimText(text, alreadyStreamed: payload["already_streamed"]?.boolValue ?? false)]

        case "thinking.delta":
            return [.status(payload["text"]?.stringValue.flatMap(statusText))]

        case "status.headline":
            // What the agent says it is working on (Claude Code's summary of a run of its
            // calls), from a bridge that offers it.
            guard features.contains(BridgeWire.Feature.statusHeadline), let text = payload["text"]?.stringValue.map(plain),
                  !text.isEmpty else { return [] }
            let calls = (payload["tool_ids"]?.arrayValue ?? []).compactMap(\.stringValue)
            return [.headline(text, toolIDs: calls)]

        case "status.update":
            let text = plain(payload["text"]?.stringValue ?? "")
            // A bridge's: a message steered in that a Stop took back before the agent read
            // it. This app's own goes back to its composer, in place of the notice.
            if features.contains(BridgeWire.Feature.steerWithdrawn), let withdrawn = payload["withdrawn"], let stored = withdrawn["text"]?.stringValue {
                let id = withdrawn["message_id"]?.stringValue
                if let id, isOwn(id), let own = UUID(uuidString: id) { return [.ownMessageWithdrawn(own, text: stored)] }
                let gone = ThreadEvent.messageWithdrawn(stored, messageID: id.flatMap(UUID.init(uuidString:)))
                return text.isEmpty ? [gone] : [gone, .notice(Notice(.warning, text))]
            }
            switch payload["kind"]?.stringValue {
            case "info": return text.isEmpty ? [] : [.notice(Notice(.info, text))]
            case "warn": return text.isEmpty ? [] : [.notice(Notice(.warning, text))]
            case "error": return text.isEmpty ? [] : [.notice(Notice(.error, text))]
            case let kind:
                // The host saying why it is about to start a turn by itself is also
                // what the turn opens with.
                let announced = HermesHostEvents.announced(statusKind: kind, text: text).map { [ThreadEvent.announced($0)] } ?? []
                return announced + [.status(statusText(text))]
            }

        case "error":
            return [.notice(Notice(.error, payload["message"]?.stringValue ?? "Something went wrong."))]

        case "session.title":
            guard let title = payload["title"]?.stringValue else { return [] }
            return [.titleChanged(title)]

        case "subagent.start", "subagent.tool", "subagent.thinking", "subagent.progress", "subagent.complete":
            return subagent(payload, finished: event.type == "subagent.complete").map { [.subagent($0)] } ?? []

        case "subagent.cleared":
            // A bridge's: the ended ones leave the line as a message goes to the agent.
            guard features.contains(BridgeWire.Feature.subagentsClear) else { return [] }
            let ids = (payload["subagent_ids"]?.arrayValue ?? []).compactMap(\.stringValue)
            return ids.isEmpty ? [] : [.subagentsCleared(ids)]

        case "session.usage":
            // Sent every few seconds while a turn runs.
            return contextUsage(payload["usage"]).map { [.contextChanged($0)] } ?? []

        case "session.mode":
            // A bridge's: `/mode`, the mode chip, or Claude leaving plan mode.
            guard features.contains(BridgeWire.Feature.modes),
                  let state = BridgeWire.modeState(mode: payload["mode"]?.stringValue, default: payload["mode_default"]?.stringValue, options: payload["mode_options"]) else { return [] }
            return [.modeChanged(state)]

        case "session.compacted":
            // A bridge's: `/compact`, or the agent compacting by itself.
            guard features.contains(BridgeWire.Feature.compaction) else { return [] }
            return [.compacted(BridgeWire.compaction(from: payload))]

        case "queue.changed":
            // A bridge's: the messages waiting for the running turn, from every device.
            guard features.contains(BridgeWire.Feature.queue) else { return [] }
            return [.queueChanged(
                BridgeWire.queuedMessages(payload["queued"], features: features), canSteer: payload["can_steer"]?.boolValue ?? false,
                steered: payload["steered"]?.stringValue
            )]

        case "message.complete":
            let context = contextUsage(payload["usage"]).map { [ThreadEvent.contextChanged($0)] } ?? []
            // A bridge's: what the turn spent, after its end.
            let spent = features.contains(BridgeWire.Feature.turnUsage) ? BridgeWire.turnSpent(payload["turn_usage"]).map { [ThreadEvent.turnSpent($0)] } ?? [] : []
            // And what it changed.
            let changed = features.contains(BridgeWire.Feature.turnDiff) ? BridgeWire.turnDiff(payload["turn_diff"]).map { [ThreadEvent.turnChanged($0)] } ?? [] : []
            // A bridge's: which turn ended, as its list numbers them (net-20), before the end.
            let listed = payload["turn"]?.intValue.map { [ThreadEvent.turnListed($0)] } ?? []
            let failed = features.contains(BridgeWire.Feature.messageReconciliation)
                ? payload["failed_request_id"]?.stringValue.map { [ThreadEvent.failedRequestMarked($0)] } ?? [] : []
            return context + listed + [completion(payload)] + failed + spent + changed

        case "message.usage":
            guard features.contains(BridgeWire.Feature.turnUsage), let spent = BridgeWire.turnSpent(payload["turn_usage"]) else { return [] }
            return [.turnUsage(spent)]

        default:
            return []
        }
    }

    /// An agent at work for the session, from one of the events about it or from an
    /// entry of `subagent.list`. Every one of them names the agent and its goal; an
    /// event about a tool also says which, and the last one how it ended. A bridge with
    /// `subagents` says all it knows each time: when it started and ended, what it is
    /// doing and what it answered, and a workflow's phases and agents.
    static func subagent(_ entry: JSONValue, finished: Bool = false) -> Subagent? {
        guard let id = entry["subagent_id"]?.stringValue, !id.isEmpty else { return nil }
        let status = entry["status"]?.stringValue
        let state: Subagent.State = if finished || status.map({ $0 != "running" && $0 != "queued" }) == true {
            subagentState(status) ?? .failed
        } else {
            .working
        }
        return Subagent(
            id: id,
            goal: (entry["goal"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
            tool: entry["tool_name"]?.stringValue ?? entry["last_tool"]?.stringValue,
            toolDetail: entry["tool_preview"]?.stringValue,
            state: state,
            kind: subagentKind(entry["kind"]?.stringValue),
            name: nonEmpty(entry["name"]?.stringValue),
            nickname: nonEmpty(entry["nickname"]?.stringValue),
            role: nonEmpty(entry["role"]?.stringValue),
            parentID: nonEmpty(entry["parent_id"]?.stringValue),
            turn: entry["turn"]?.intValue,
            startedAt: entry["started_at"]?.doubleValue.map(Date.init(timeIntervalSince1970:)),
            endedAt: entry["ended_at"]?.doubleValue.map(Date.init(timeIntervalSince1970:)),
            summary: nonEmpty(entry["summary"]?.stringValue),
            result: nonEmpty(entry["result"]?.stringValue),
            output: entry["output"]?.stringValue,
            outputTruncated: entry["output_truncated"]?.boolValue == true,
            canStop: state == .working && entry["can_stop"]?.boolValue == true,
            canRead: entry["can_read"]?.boolValue == true,
            model: nonEmpty(entry["model"]?.stringValue),
            tokens: entry["tokens"]?.intValue,
            toolUses: entry["tool_uses"]?.intValue,
            phases: (entry["phases"]?.arrayValue ?? []).compactMap { phase in
                guard let index = phase["index"]?.intValue else { return nil }
                return WorkflowPhase(index: index, title: phase["title"]?.stringValue ?? "")
            },
            agents: (entry["agents"]?.arrayValue ?? []).compactMap { agent in
                guard let id = agent["id"]?.stringValue else { return nil }
                return WorkflowAgent(
                    id: id,
                    label: agent["label"]?.stringValue ?? id,
                    phase: nonEmpty(agent["phase"]?.stringValue),
                    model: nonEmpty(agent["model"]?.stringValue),
                    state: subagentState(agent["status"]?.stringValue) ?? .working,
                    tokens: agent["tokens"]?.intValue,
                    toolUses: agent["tool_uses"]?.intValue,
                    duration: agent["duration_s"]?.doubleValue,
                    result: nonEmpty(agent["result"]?.stringValue)
                )
            }
        )
    }

    /// What it is, by its `kind`: an agent unless the host says otherwise.
    private static func subagentKind(_ kind: String?) -> Subagent.Kind {
        switch kind {
        case "workflow": .workflow
        // Feature background_commands.
        case "command": .command
        default: .agent
        }
    }

    /// How an agent ended, by its `status`; nil while it works or for a word not known.
    private static func subagentState(_ status: String?) -> Subagent.State? {
        switch status {
        case "running", "queued": .working
        case "completed": .finished
        case "failed": .failed
        case "stopped": .stopped
        default: nil
        }
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    /// How full the context is, from one of Hermes's usage blocks. nil when it does not
    /// say: before a session's first turn, and for one it has just loaded again.
    static func contextUsage(_ usage: JSONValue?) -> ContextUsage? {
        guard let used = usage?["context_used"]?.intValue, let limit = usage?["context_max"]?.intValue, used > 0, limit > 0 else {
            return nil
        }
        return ContextUsage(used: used, limit: limit, estimated: usage?["context_estimated"]?.boolValue ?? false)
    }

    private static func completion(_ payload: JSONValue) -> ThreadEvent {
        let text = payload["text"]?.stringValue
        switch payload["status"]?.stringValue {
        case "error":
            let detail = payload["error"]?.stringValue
            let retryable = payload["error_surface"]?["retryable"]?.boolValue ?? payload["recoverable"]?.boolValue ?? true
            let message = [text, detail].compactMap { $0 }.first { !$0.isEmpty } ?? "The request failed."
            return .turnFinished(.failed(TurnFailure(message: message, detail: detail, retryable: retryable)), finalText: nil)
        case "interrupted":
            return .turnFinished(.interrupted, finalText: nil)
        default:
            // `response_previewed`: the reply already came, as a closed piece of text.
            let previewed = payload["response_previewed"]?.boolValue ?? false
            return .turnFinished(.completed, finalText: previewed ? nil : text)
        }
    }

    /// What a status line from Hermes says, or nil when it says nothing: the terminal
    /// spinner's face followed by one verb, which is picked at random and is not what
    /// the agent is doing. A face in front of real words is dropped and the words kept.
    static func statusText(_ raw: String) -> String? {
        var text = plain(raw)
        guard !text.isEmpty else { return nil }

        // A face is whatever comes before the first real word: symbols, and at most
        // single ASCII letters between them ("(o_o)").
        var lettersInARow = 0
        var faceEnd = text.startIndex
        var foundWord = false
        for index in text.indices {
            let character = text[index]
            if character.isASCII, character.isLetter {
                lettersInARow += 1
                if lettersInARow == 2 {
                    faceEnd = text.index(before: index)
                    foundWord = true
                    break
                }
            } else {
                lettersInARow = 0
            }
        }
        if foundWord {
            let face = text[..<faceEnd].trimmingCharacters(in: .whitespaces)
            if !face.isEmpty, face.count <= 24 {
                text = String(text[faceEnd...])
            }
        } else if text.count <= 24 {
            // Nothing but a face.
            return nil
        }

        // One word and an ellipsis is the spinner's verb.
        let word = text.trimmingCharacters(in: CharacterSet(charactersIn: ".…").union(.whitespaces))
        if text != word, !word.isEmpty, word.allSatisfy(\.isLetter) {
            return nil
        }
        text = text.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text.prefix(1).uppercased() + text.dropFirst()
    }

    /// A request the gateway sent us, as something to show. nil for the kinds this app
    /// does not put in front of the user. `features`: the bridge extensions the host
    /// offers; a question's heading and its choices' descriptions are read only from one
    /// that offers `question_details`, and an approval takes a note with a no only on one
    /// that offers `approval_notes`.
    static func pendingRequest(_ request: ServerRequest, features: Set<String> = []) -> PendingRequest? {
        let params = request.params
        // A bridge with `subagents` names the subagent that asks, which may outlive the turn.
        let subagent = features.contains(BridgeWire.Feature.subagents) ? nonEmpty(params["subagent"]?.stringValue) : nil
        switch request.method {
        case "approval":
            let choices = (params["choices"]?.arrayValue ?? []).compactMap { $0.stringValue.flatMap(ApprovalChoice.init(rawValue:)) }
            let isPlan = features.contains(BridgeWire.Feature.modes) && params["plan"]?.boolValue == true
            return PendingRequest(id: request.id, kind: .approval(ApprovalRequest(
                command: params["command"]?.stringValue ?? "",
                reason: params["description"]?.stringValue,
                choices: choices,
                plan: isPlan ? PlanApproval(startsIn: params["starts_in"]?.stringValue.flatMap(ThreadMode.init(rawValue:))) : nil,
                takesNote: features.contains(BridgeWire.Feature.approvalNotes),
                options: params["options"]?.arrayValue.map { values in
                    values.compactMap { try? $0.decode(ApprovalOption.self) }.filter(\.isSupported)
                },
                planContent: params["plan_content"]?.stringValue,
                details: params["details"]?.arrayValue.map { $0.compactMap { try? $0.decode(ApprovalDetail.self) } }
            )), subagent: subagent)
        case "clarify":
            let questions = (params["questions"]?.arrayValue ?? []).compactMap { question -> ClarifyQuestion? in
                guard let id = question["qid"]?.stringValue, let text = question["question"]?.stringValue else { return nil }
                let details = features.contains(BridgeWire.Feature.questionDetails)
                return ClarifyQuestion(
                    id: id,
                    text: text,
                    choices: (question["choices"]?.arrayValue ?? []).compactMap(\.stringValue),
                    allowsMultiple: question["multi_select"]?.boolValue ?? false,
                    header: details ? question["header"]?.stringValue.flatMap(Self.nonBlank) : nil,
                    descriptions: details ? Self.descriptions(question["descriptions"]) : nil
                )
            }
            return questions.isEmpty ? nil : PendingRequest(
                id: request.id, kind: .clarify(questions), subagent: subagent,
                requiresAllAnswers: params["requires_all_answers"]?.boolValue == true,
                askedAhead: features.contains(BridgeWire.Feature.asyncQuestions) && params["async"]?.boolValue == true
            )
        default:
            return nil
        }
    }

    private static func nonBlank(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// What each choice means, read leniently: an entry that is not text costs only itself.
    private static func descriptions(_ value: JSONValue?) -> [String: String]? {
        guard let entries = value?.objectValue else { return nil }
        var descriptions: [String: String] = [:]
        for (choice, entry) in entries {
            if let text = entry.stringValue.flatMap(nonBlank) { descriptions[choice] = text }
        }
        return descriptions.isEmpty ? nil : descriptions
    }

    /// The result frame for an answer.
    static func result(for answer: RequestAnswer, to request: PendingRequest) -> JSONValue {
        switch (request.kind, answer) {
        case let (.approval, .option(id, editedPlan, note)):
            guard request.offeredOption(id, editedPlan: editedPlan) != nil else { return ["choice": "deny"] }
            var result: [String: JSONValue] = ["option": .string(id)]
            if let editedPlan { result["edited_plan"] = .string(editedPlan) }
            if let note { result["note"] = .string(note) }
            return .object(result)
        case let (.approval, .approval(choice)):
            return ["choice": .string(choice.rawValue)]
        case let (.approval, .declined(note)):
            return ["choice": "deny", "note": .string(note)]
        case (.approval, _):
            return ["choice": "deny"]
        case let (.clarify(questions), .clarify(answers)):
            // Every question gets an entry; null means skipped.
            var entries: [String: JSONValue] = [:]
            for question in questions {
                entries[question.id] = answers[question.id].map(JSONValue.string) ?? .null
            }
            return ["answers": .object(entries)]
        case (.clarify, _):
            // No `answers` at all cancels every question.
            return [:]
        }
    }

    /// A status line without the symbol Hermes's terminal UI opens it with ("⚠ ", "❌ ",
    /// "⏳ "). The app draws its own.
    static func plain(_ text: String) -> String {
        var scalars = Substring(text).unicodeScalars
        while let first = scalars.first,
              first.properties.isEmojiPresentation || first.properties.generalCategory == .otherSymbol
                || first.properties.isVariationSelector || first.properties.isWhitespace {
            scalars.removeFirst()
        }
        return String(Substring(scalars))
    }

    /// The answer a bridge says another agent gave (`request.cancel` `answer`):
    /// `{"choice":"once"}`, `{"choice":"deny","note":"…"}` or `{"answers":{"q0":"Swift"}}`.
    /// nil for anything else.
    private static func givenAnswer(_ value: JSONValue) -> RequestAnswer? {
        if let option = value["option"]?.stringValue {
            return .option(option, editedPlan: value["edited_plan"]?.stringValue, note: value["note"]?.stringValue)
        }
        if let choice = value["choice"]?.stringValue.flatMap(ApprovalChoice.init(rawValue:)) {
            if choice == .deny, let note = value["note"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                return .declined(note: note)
            }
            return .approval(choice)
        }
        guard case let .object(given)? = value["answers"] else { return nil }
        return .clarify(given.compactMapValues(\.stringValue))
    }

    private static func closureReason(_ reason: String?) -> String {
        switch reason {
        case "resolved": "Answered elsewhere"
        // Asked without waiting, and the user's message to the agent answered it.
        case "replied": "Answered in your message"
        case "timeout": "Timed out"
        case "interrupt", "interrupted": "Stopped before it was answered"
        default: "Withdrawn"
        }
    }

    /// What `prompt.submit` did with the message.
    static func sendOutcome(_ status: String?) -> SendOutcome {
        switch status {
        case "queued": .queued
        case "steered": .steered
        case "redirected": .redirected
        default: .started
        }
    }
}
