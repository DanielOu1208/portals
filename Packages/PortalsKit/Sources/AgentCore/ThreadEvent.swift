import Foundation

/// Something that happened in a thread, in backend-neutral terms. A backend turns its
/// own wire events into these; `ThreadState` turns these into a transcript.
public enum ThreadEvent: Hashable, Sendable {
    /// The agent began a run.
    case turnStarted
    /// The agent began a run for a message this app sent (the thread's id for it), as a
    /// bridge with `turn_messages` says: as `turnStarted`, and a send of it that failed here
    /// (its answer lost as the connection went) did reach the host, which runs it.
    /// `queueID`: its id on the host's list, when it waited there (`queuedTurnStarted`).
    case ownTurnStarted(UUID, queueID: String? = nil)
    /// The agent began a run that a message from elsewhere opened: one sent from another
    /// device, typed at the desk, or sent through Portals by another agent, as stored
    /// (its images and files named in it). That message opens the turn, and this app's own
    /// messages still waiting go on waiting. `queueID`: its id on the host's list, when it
    /// waited there; one of this app's own with that id opens the turn as its own.
    /// `from`: who sent it through Portals, as the host says (`senders`). `cardAnswer`:
    /// the answers given on a card, which its row shows (`UserMessage.cardAnswer`).
    case turnOpened(by: String, queueID: String? = nil, from: MessageSender? = nil, cardAnswer: String? = nil)
    /// The provider-native position of the current turn's opening user message.
    case messageCheckpoint(MessageCheckpoint)
    /// A message from elsewhere (another device, or another agent through Portals), as
    /// stored, joined the running turn; `from` and `cardAnswer` as for `turnOpened`.
    case messageSteered(String, from: MessageSender? = nil, cardAnswer: String? = nil, messageID: UUID? = nil)
    /// The host names a failed turn, then later accepts that exact request after all.
    case failedRequestMarked(String)
    case failedRequestTaken(String)
    /// A message this app sent (the thread's id for it) joined the running turn: told where
    /// the host handed it over, among the run's events, so it joins the run it went into
    /// whichever comes first here, this or the answer to the send. `shownAlready`: the
    /// thread was opened again since, and the host's copy shows it there.
    case ownMessageSteered(UUID, shownAlready: Bool = false)
    /// The agent began a run for a message that waited on the host's list (`queue`): the
    /// one with this id, which opens the turn.
    case queuedTurnStarted(String)
    /// The messages waiting on the host for the running turn to end, as they are now, and
    /// whether the agent can take one in; `steered`, the one that just left the list for
    /// the running turn.
    case queueChanged([QueuedMessage], canSteer: Bool, steered: String?)
    /// More reply text.
    case textDelta(String)
    /// A piece of text the agent wrote beside its tool calls, closed: what follows it
    /// is a new piece. It is the whole piece, and its word stands over what streamed.
    /// `alreadyStreamed` when it also came as `textDelta`s; when not, this is the only
    /// place it comes (Hermes sends a Codex model's commentary this way).
    case interimText(String, alreadyStreamed: Bool)
    /// More of the model's reasoning.
    case reasoningDelta(String)
    /// The agent called a tool.
    case toolStarted(ToolRun)
    case toolFinished(ToolResult)
    case toolProgress(ToolProgress)
    /// The agent is blocked until the user answers.
    case requestOpened(PendingRequest)
    /// A request ended without this app answering it: withdrawn, or answered from
    /// another client. `reason` is shown in the transcript.
    case requestClosed(id: String, reason: String)
    /// A request the agent that started the thread answered for you (a bridge's
    /// `agent_threads`): shown in the transcript with its answer and who gave it. `by`
    /// nil: you answered it on another device (questions asked without waiting, whose
    /// answer is shown in their row, `async_questions`).
    case requestAnswered(id: String, answer: RequestAnswer, by: String?)
    /// The host settled the request with another answer than this app's, or took it back
    /// (a bridge's `answer_owner`): an answer given here that the host has not taken yet
    /// gives way to what the `requestClosed` or `requestAnswered` that follows says.
    case requestSettledElsewhere(id: String)
    /// The thread as the host has it now, after a gap the app could not fill event by
    /// event (a long time away, or the host restarted).
    case snapshot(ThreadSnapshot)
    /// The connection the thread was followed on is gone and it had nothing running, so
    /// the backend did not reattach it. Open it again (`openThread`) before relying on
    /// what is shown; sending still works without.
    case detached
    /// Harmless invalidation of live MCP sign-in cards; contains no sign-in URL or code.
    case mcpAuthChanged
    /// The connection went away. Drop live sign-in cards at once.
    case mcpAuthCleared
    /// A transient line about what the agent is doing ("Waiting on provider…"). nil or
    /// empty clears it. Never stored in the transcript.
    case status(String?)
    /// What the agent says it is working on, from the host (a bridge's `status_headline`:
    /// Claude Code's summary of a run of its calls), with the calls it sums up: the status
    /// line's headline while one of them is in the work under way (`StatusHeadline`).
    case headline(String, toolIDs: [String] = [])
    case notice(Notice)
    case titleChanged(String)
    /// What the thread missed in a gap comes next, all of it before `.caughtUp`, at once:
    /// what shows the thread takes it in as one change (`CatchUpHold`), never half done.
    case catchUpBegan
    /// The thread was brought up to date after a gap with the events it missed, which came
    /// before this, and is followed again (`ThreadCatchingUp`). With what the host says of
    /// it besides its conversation now, taken as a snapshot's is, as some of it changes
    /// with no event (a model chosen on another device).
    case caughtUp(ThreadInfo)
    /// How much the thread asks before acting changed (a coding agent on a bridge).
    case modeChanged(ModeState)
    /// How full the model's context is now.
    case contextChanged(ContextUsage)
    /// The agent summarised the conversation so far to free its context: `/compact`
    /// was run, or the context filled up.
    case compacted(Compaction)
    /// The host is about to start a turn by itself, and this is why.
    case announced(HostEvent)
    /// News of an agent the thread's agent set to work: it started, used a tool, or
    /// is done.
    case subagent(Subagent)
    /// Everyone at work for the thread right now, as the host lists them after a gap
    /// in which news of them may have been missed.
    case subagentsListed([Subagent])
    /// These had ended and left the list as a message went to the agent (a host that
    /// keeps the ended ones says so for every device).
    case subagentsCleared([Subagent.ID])
    /// Which turn of the thread's is ending, as the host's list numbers its turns
    /// (`ThreadRecord.turn`): told just before its `turnFinished`, by a bridge that says it
    /// with the turn's end (net-20).
    case turnListed(Int)
    /// The run ended. `finalText` is the whole reply when the backend sends it, for a
    /// reply that was not streamed.
    case turnFinished(TurnOutcome, finalText: String?)
    /// What the turn that just ended spent, as the host tells it right after its end.
    case turnSpent(TurnSpent)
    /// Cumulative usage for the turn still in progress.
    case turnUsage(TurnSpent)
    /// What the turn that just ended changed, as the host tells it right after its end.
    case turnChanged(TurnDiff)
}

extension ThreadEvent {
    /// The host saying a run begins: a bridge's `message.start`, whichever message opened it.
    var beginsRun: Bool {
        switch self {
        case .turnStarted, .ownTurnStarted, .turnOpened, .queuedTurnStarted: true
        default: false
        }
    }
}
