import Foundation

/// A message sent while the agent was busy, before it has joined a turn.
public struct PendingMessage: Identifiable, Hashable, Sendable {
    public var id: UUID
    /// `delivery` is nil until the backend answers, then `.queued` while it waits.
    public var message: UserMessage
    /// Its id on the host's list of messages waiting (`queue`), once the host has said:
    /// the list shows it from then on, and the turn it opens names it.
    public var queueID: String?

    public init(id: UUID = UUID(), message: UserMessage, queueID: String? = nil) {
        self.id = id
        self.message = message
        self.queueID = queueID
    }
}

/// What the agent is doing right now, for the one line that says so.
public enum RunStatus: Hashable, Sendable {
    /// Nothing more specific is known: the model is working on its next move.
    case thinking
    /// A tool call in progress; `others` more are running beside it.
    case tool(ToolRun, others: Int)
    /// Something the backend said about the run ("Waiting on provider — retrying in 2s").
    case note(String)
    /// What the agent says it is working on, in its own words, in place of "Thinking…"
    /// (`StatusHeadline`; 2026-10-26.
    case headline(String)
    /// Paused on an approval or a question.
    case waitingForUser
}

/// Everything the app knows about one thread, built by applying `ThreadEvent`s in
/// order. A value type with no side effects, so the same events always give the same
/// transcript.
public struct ThreadState: Hashable, Sendable {
    public enum Phase: Hashable, Sendable {
        case idle
        case running
    }

    public var transcript: Transcript
    public var phase: Phase
    /// What the agent is doing right now, when the backend says. Not stored.
    public var statusLine: String?
    public var title: String?
    /// Messages sent during a run that are not part of a turn yet: either the backend
    /// has not answered, or it queued them for after the run.
    public var pending: [PendingMessage]
    /// What the agent is blocked on until the user answers, oldest first.
    public var openRequests: [PendingRequest]
    /// How full the model's context was when the host last said. nil until it has.
    public var context: ContextUsage?
    /// The latest successful TodoWrite, independent of token-by-token transcript changes.
    public private(set) var currentPlan: TodoPlan?
    private var currentPlanTurnID: UUID?
    /// The agents the thread's agent set to work, as far as the host has said: the
    /// batch at work now, or the last one. They can outlast the turn that started them.
    /// Not stored.
    public var subagents: [Subagent] = []

    /// What the host last said it was about to start a turn for, and when. The turn it
    /// starts next opens with it. Not stored.
    public var announced: Announcement?

    public struct Announcement: Hashable, Sendable {
        public var event: HostEvent
        public var at: Date
        /// How long an announcement waits for its turn. One that comes while the agent
        /// is busy is acted on later, by which time it is no longer known to be the
        /// reason for whatever starts.
        public static let life: TimeInterval = 30
    }

    /// What the thread runs on, or will start on once it exists on the host: what was
    /// chosen for it, then what the host says. nil is the agent's own setting.
    public var model: ModelSetting?
    /// How much the thread asks before acting, for an agent with modes, as the host last
    /// said or as chosen for a thread not on the host yet.
    public var mode: ModeState?
    /// The messages waiting on the host for the running turn to end, from every device,
    /// for a host that lists them (`QueueControlling`). Not stored.
    public var queued: [QueuedMessage] = []
    /// The agent can take a waiting message into the running turn. Not stored.
    public var canSteerQueued = false
    /// A thread on the host with nothing of it on the device yet, its history on its way
    /// (`awaitHistory`): the screen shows that rather than the start of a new thread. Over
    /// once the host's copy is taken in (`adopt`), once its stream says it is caught up
    /// (an empty thread followed again brings nothing else), or when it cannot come
    /// (`historyNotComing`). Not stored.
    public private(set) var isLoadingHistory = false
    /// The thread holds only the host's last turns of its conversation, which has more
    /// before them (`HistoryPaging`), taken as the chat is scrolled up to its top. Not
    /// stored: a thread opened again takes its last turns again.
    public private(set) var hasEarlierHistory = false
    /// Where the first turn the thread holds stands in a count that turns put before it,
    /// or taken off its front, do not move (`TranscriptBlocks`): earlier turns taken in
    /// bring it down, a page of the last turns that leaves the first ones out takes it up.
    /// Not stored.
    public private(set) var turnOrigin = 0
    /// The messages that left the host's list lately, newest last, and what became of each:
    /// this device's own answer to sending one can come after the events that took it off
    /// (`messageDelivered`). Not stored.
    private var departed: [Departed] = []

    /// A message that left the host's list, what became of it, and when this device heard.
    private struct Departed: Hashable, Sendable {
        var queueID: String
        var departure: Departure
        var at: Date
    }

    private enum Departure: Hashable, Sendable {
        /// Taken off it: it is never sent.
        case removed
        /// It joined a turn, shown there as the host listed it, as this item.
        case shown(UUID)
        /// Gone while this device was away, as a snapshot says: taken off it, or its
        /// turn began, which the snapshot's transcript then shows.
        case away
    }

    /// How long a departure is kept: far longer than an answer to sending a message can
    /// take to come, which the call's own time limit bounds. At most `departuresKept`.
    private static let departureLife: TimeInterval = 300
    private static let departuresKept = 512

    /// What the agent last said it is working on, and the stretch of work it said it in
    /// (`StatusHeadline`); `headline` is it while that stretch is under way. Not stored.
    var spokenHeadline: SpokenHeadline?
    /// The wording of the to-do in progress last taken as the headline: a list written
    /// again with the same one in progress says nothing newer. Not stored.
    var takenWording: String?

    /// The pieces of text the host closed in this run (`interimText`): what the agent
    /// said on the way, not its answer. Text that streams after one starts a piece of
    /// its own. Not stored.
    private var closedTexts: Set<UUID> = []

    /// The turn running now, when this app opened it for a message of its own (sent at
    /// rest, or answered as handed to a run this app had not seen begin): until the host
    /// says it began a turn for that message, another's message may be what opened the
    /// host's. Not stored.
    private var openedHere: UUID?

    /// The turn opened here (`openedHere`) that the host's word of a run begun by its place
    /// on the list alone (`queuedTurnStarted`: a bridge without `turn_messages`, whose list
    /// has no `message_ids`) kept as that run: its message, whose place this device never
    /// heard, is the one the host began, as far as can be told. A send of it whose answer
    /// is lost then does not end the run (`messageFailed`); an answer that comes still says
    /// where it went. Not stored.
    private var begunByPlace: UUID?

    /// The turn opened here (`openedHere`) that the host's word of a run begun with no message
    /// named (`turnStarted`) kept as that run. Should the answer then say the host queued this
    /// device's message, the run is another's, which goes on: the turn stays, without the
    /// message. Not stored.
    private var hostRun: UUID?

    /// The host's run (`hostRun`) that this device's message left to wait on the host's list:
    /// an answer that says the message was queued does not take that run for its own, though
    /// it began after the message was sent. Not stored.
    private var othersRun: UUID?

    /// The turn each open question asked without waiting (`askedAhead`) was asked in: how it
    /// ended is recorded there, also when the person's message that answered it has opened
    /// a turn of its own here first. Not stored.
    private var askedIn: [String: UUID] = [:]

    /// The requests the host said were settled (taken back, answered elsewhere) when none
    /// was open here any more: answered here already, an answer whose send fails after it
    /// (`answerNotSent`) opens no card nobody can answer. The latest few. Not stored.
    private var settledByHost: [String] = []

    /// The requests answered here (`requestAnswered`) whose answer the host may not have
    /// taken yet, the latest few: a host that says another answer settled one, or took it
    /// back (`requestSettledElsewhere`, a bridge's `answer_owner`), or, from an older bridge,
    /// gives an answer that is not this app's or names the agent that gave it
    /// (`requestAnswered`), has the record of this app's answer give way to its own. Not stored.
    private var answeredHere: [PendingRequest] = []

    public init(transcript: Transcript = Transcript(), title: String? = nil, context: ContextUsage? = nil) {
        self.transcript = transcript
        self.phase = .idle
        self.title = title
        self.pending = []
        self.openRequests = []
        self.context = context
        let latestPlan = transcript.latestPlan
        self.currentPlan = latestPlan?.plan
        self.currentPlanTurnID = latestPlan?.turn
    }

    public var isRunning: Bool { phase == .running }
    /// Unfinished checklists can continue across turns; a completed one belongs only to
    /// the running turn that wrote it. Keep its source cached, not scanned per token.
    public var runningPlan: TodoPlan? {
        guard isRunning, let currentPlan, !currentPlan.items.isEmpty else { return nil }
        let runningTurn = transcript.turns.last.flatMap { $0.isRunning ? $0.id : nil }
        guard currentPlan.current != nil || currentPlanTurnID == runningTurn else { return nil }
        return currentPlan
    }

    /// A run is going on, or an agent or workflow it set to work is still at it (they can
    /// outlast the turn): what a bridge calls running when asked which threads are at work
    /// (`sessions.activity`). A command left running in the background is not
    /// (`Subagent.keepsThreadAtWork`).
    public var isAtWork: Bool { isRunning || subagents.contains(where: \.keepsThreadAtWork) }
    /// The run is paused on an approval or a question.
    public var isWaitingOnUser: Bool { !openRequests.isEmpty }

    /// The agent waits for the user and for nothing else: something it asked is open
    /// (an approval, a question, a plan to approve) and no subagent or workflow is at
    /// work but the ones that asked, so nothing moves on until the user answers. A
    /// workflow one of whose agents asked still counts as at work: which of its agents
    /// asked is not known, and the others may run on. A command running in the background
    /// does not (`Subagent.keepsThreadAtWork`).
    public var waitsOnlyOnUser: Bool {
        guard !openRequests.isEmpty else { return false }
        let asking = Set(openRequests.compactMap(\.subagent))
        return !subagents.contains { $0.keepsThreadAtWork && !asking.contains($0.id) }
    }

    /// What to say the agent is doing. nil at rest, and while the reply is being
    /// written (`replyIsArriving`), when the text itself shows that it is at work.
    ///
    /// In this order: waiting for the user; the call running; a note from the backend; the
    /// visual being planned; what the agent says it is working on (`headline`); "Thinking…".
    /// The headline takes "Thinking…"'s place and no other (2026-10-26): a note says
    /// something about the run itself that holds for a moment ("trying again (attempt 2 of
    /// 10)…", "Compacting the conversation…") and goes as the agent goes on, the headline
    /// coming back then; only an agent's own words for its state that say no more than
    /// "Thinking…" does (Droid's "Thinking", "Running tool") give way to a headline.
    /// `headlines` false says "Thinking…" as before (`PORTALS_DEBUG_STATUS_HEADLINE=before`).
    public func runStatus(replyIsArriving: Bool, headlines: Bool = true) -> RunStatus? {
        guard isRunning else { return nil }
        if isWaitingOnUser { return .waitingForUser }
        let turn = transcript.turns.last.flatMap { $0.isRunning ? $0 : nil }
        let running = (turn?.items ?? []).compactMap { item -> ToolRun? in
            if case let .tool(run) = item.content, run.state == .running { run } else { nil }
        }
        if let latest = running.last {
            return latest.readsWidgetGuide ? .note(Self.planningWidget) : .tool(latest, others: running.count - 1)
        }
        let headline = headlines ? headline : nil
        if let statusLine, headline == nil || !Self.workingWords.contains(statusLine) { return .note(statusLine) }
        if replyIsArriving, case .text? = turn?.items.last?.content { return nil }
        if turn?.isPlanningWidget == true { return .note(Self.planningWidget) }
        if let headline { return .headline(headline) }
        return .thinking
    }

    /// The words agents send for their state that say no more than "Thinking…" (Droid's
    /// working states, bridge/src/providers/droid/activity.ts, and the scripted agent's):
    /// a headline stands over them.
    static let workingWords: Set<String> = ["Thinking", "Working", "Replying", "Running tool", "Running command"]

    /// What the line says between the agent reading how to write a widget and starting
    /// to write one: the minutes that can take are not plain thinking.
    public static let planningWidget = "Planning a visual…"

    // MARK: What the user did

    /// Records a message the moment it is sent, before the backend answers, and returns
    /// its id for `messageDelivered` / `messageFailed`.
    ///
    /// With no run in progress it opens a new turn. During a run it waits in `pending`
    /// until the backend says what it did with it. So does a message that is `held`:
    /// one sent before the thread is in step with the host, which could replace the
    /// transcript under a turn opened now.
    @discardableResult
    public mutating func messageSent(
        _ text: String, images: [AttachedImage] = [], files: [AttachedFile] = [], held: Bool = false, at now: Date = .now
    ) -> UUID {
        let id = UUID()
        let message = UserMessage(text: text, sentAt: now, images: images, files: files)
        if openTurnIndex == nil, !held {
            let turn = Turn(startedAt: now, items: [TurnItem(id: id, .user(message))])
            beginRun(turn)
            openedHere = turn.id
            phase = .running
        } else {
            pending.append(PendingMessage(id: id, message: message))
        }
        return id
    }

    /// The backend accepted the message and said what it did with it; `queueID`, its id on
    /// the host's list when it waits there.
    public mutating func messageDelivered(_ id: UUID, outcome: SendOutcome, queueID: String? = nil, at now: Date = .now) {
        // Queued on the host's list though it opened a turn here: the host was at work on
        // another's (whose start may come after this answer). It waits for its own turn.
        if outcome == .queued, queueID != nil, !pending.contains(where: { $0.id == id }), let open = openTurnIndex,
           isOpenedHere(transcript.turns[open]) || transcript.turns[open].id == hostRun,
           let at = transcript.turns[open].items.firstIndex(where: { $0.id == id }),
           case let .user(message) = transcript.turns[open].items[at].content {
            transcript.turns[open].items.remove(at: at)
            if !keepAsHostRun(open) { settleOpenedHere(open, at: now) }
            pending.append(PendingMessage(id: id, message: message))
            phase = .running
        }
        if let queueID, let index = pending.firstIndex(where: { $0.id == id }) {
            // It left the list before this answer came: taken off it, so it is never sent,
            // or shown in a turn as the host listed it, where this device's own copy (with
            // its images and files) takes that place. One listed now is waiting, whatever
            // an id like it did before.
            // Only a departure after it was sent is its own: the host may give an id again.
            if !queued.contains(where: { $0.id == queueID }),
               let departure = departed.first(where: { $0.queueID == queueID && $0.at >= pending[index].message.sentAt })?.departure {
                departed.removeAll { $0.queueID == queueID }
                let waiting = pending.remove(at: index)
                // Shown in a turn: there, or, once a snapshot has made the transcript afresh,
                // as the host has it. Taken off the list, or gone while this device was away
                // (taken off, or shown as the host has it), it is dropped and nothing else.
                if case let .shown(item) = departure, !replace(item, with: waiting) { replaceAlike(with: waiting) }
                return
            }
            pending[index].queueID = queueID
        }
        guard let index = pending.firstIndex(where: { $0.id == id }) else {
            // It opened its own turn.
            update(id) { content in
                guard case var .user(message) = content else { return }
                message.delivery = outcome
                content = .user(message)
            }
            return
        }

        var message = pending[index].message
        message.delivery = outcome
        switch outcome {
        case .steered, .redirected:
            // It went into the run that is going on.
            pending.remove(at: index)
            let opens = openTurnIndex == nil
            let turn = openOrStartTurn(now)
            // A run this app has not seen begin: whose message opened it is still to come.
            if opens { openedHere = transcript.turns[turn].id }
            append(TurnItem(id: id, .user(message)), to: turn, at: now)
            phase = .running

        case .queued, .started:
            // It runs as its own turn. That turn may already have begun, if its first
            // event overtook this answer; otherwise it waits for it.
            if let turn = openTurnIndex, transcript.turns[turn].id != othersRun,
               transcript.turns[turn].startedAt >= message.sentAt,
               !transcript.turns[turn].items.contains(where: { if case .user = $0.content { true } else { false } }) {
                pending.remove(at: index)
                transcript.turns[turn].items.insert(TurnItem(id: id, .user(message)), at: 0)
            } else if outcome == .started, openTurnIndex == nil {
                pending.remove(at: index)
                beginRun(Turn(startedAt: now, items: [TurnItem(id: id, .user(message))]))
                phase = .running
            } else {
                pending[index].message = message
            }
        }
    }

    /// The message never reached the agent.
    public mutating func messageFailed(_ id: UUID, _ failure: TurnFailure, at now: Date = .now) {
        if let index = pending.firstIndex(where: { $0.id == id }) {
            // The host's list says it waits there (`claimListed`): the host has it.
            if pending[index].message.delivery != nil { return }
            let failed = pending.remove(at: index)
            let turn = Turn(startedAt: failed.message.sentAt, endedAt: now, outcome: .failed(failure),
                            items: [TurnItem(id: failed.id, .user(failed.message))])
            // Its failure belongs to this submission, not to the unrelated live run.
            transcript.turns.insert(turn, at: openTurnIndex ?? transcript.turns.endIndex)
            return
        }
        // It opened a turn, which ends here.
        guard let turn = openTurnIndex, let item = transcript.turns[turn].items.first(where: { $0.id == id }) else { return }
        // The host said it handed it to the run going on, or began the run for it (its
        // answer was lost, the connection went): the host has it, and the run is not this
        // send's to end.
        if case let .user(message) = item.content, message.delivery == .steered || message.delivery == .started { return }
        // Its run the host began by its place on the list alone (`begunByPlace`), the answer
        // lost after: started, as the answer would have said, and the run goes on.
        if transcript.turns[turn].id == begunByPlace, case let .user(message) = item.content, message.delivery == nil {
            update(id) { content in
                guard case var .user(message) = content else { return }
                message.delivery = .started
                content = .user(message)
            }
            return
        }
        finishTurn(at: turn, .failed(failure), now)
    }

    /// The user answered a request. The answer joins the transcript where it was given.
    public mutating func requestAnswered(_ id: String, with answer: RequestAnswer, at now: Date = .now) {
        guard let index = openRequests.firstIndex(where: { $0.id == id }) else { return }
        let request = openRequests.remove(at: index)
        append(TurnItem(.request(RequestRecord(request, answer: answer.summary(for: request)))), to: recordTurn(for: request, now), at: now)
        answeredHere.removeAll { $0.id == id }
        answeredHere.append(request)
        if answeredHere.count > 32 { answeredHere.removeFirst(answeredHere.count - 32) }
    }

    /// The answer given here (`requestAnswered`) could not be sent: the connection was down.
    /// The host still asks, so the card is open again and the answer shown for it goes;
    /// once the device is back, the host says what became of the request (still open, or
    /// settled elsewhere meanwhile), which is what the transcript then records. Nothing for
    /// a request asked in a run that has ended since, which nobody can answer.
    public mutating func answerNotSent(_ request: PendingRequest, at now: Date = .now) {
        guard !openRequests.contains(where: { $0.id == request.id }), !settledByHost.contains(request.id),
              openTurnIndex != nil || request.outlivesTurn else { return }
        answeredHere.removeAll { $0.id == request.id }
        let answeredIn = takeBackRecord(of: request.id)
        openRequests.append(request)
        if request.askedAhead == true, let turn = answeredIn ?? (openTurnIndex ?? lastTurnIndex).map({ transcript.turns[$0].id }) {
            askedIn[request.id] = turn
        }
    }

    /// The host answered a slash command. Only this device keeps it, where it arrived.
    public mutating func commandAnswered(_ command: String, output: String, at now: Date = .now) {
        addCommandTurn(CommandRun(command: command, output: output), at: now)
    }

    /// A slash command did not run: the host refused it or did not know it, or the app
    /// could not ask. Said where an answer would have been.
    public mutating func commandFailed(_ command: String, reason: String, at now: Date = .now) {
        addCommandTurn(CommandRun(command: command, output: "", failure: reason), at: now)
    }

    private mutating func addCommandTurn(_ run: CommandRun, at now: Date) {
        let item = TurnItem(.command(run))
        if let index = openTurnIndex {
            append(item, to: index, at: now)
        } else {
            transcript.turns.append(Turn(startedAt: now, endedAt: now, outcome: .completed, items: [item]))
        }
    }

    /// Removes only this device's command box, without changing the agent's run.
    @discardableResult
    public mutating func dismissCommand(_ id: UUID) -> Bool {
        for index in transcript.turns.indices {
            guard let item = transcript.turns[index].items.firstIndex(where: { $0.id == id }),
                  case .command = transcript.turns[index].items[item].content else { continue }
            let local = transcript.turns[index].isLocal
            transcript.turns[index].items.remove(at: item)
            if local, transcript.turns[index].items.isEmpty { transcript.turns.remove(at: index) }
            return true
        }
        return false
    }

    /// The host's copy of a thread is asked for: shown as on its way while nothing of the
    /// thread is here (`isLoadingHistory`).
    public mutating func awaitHistory() {
        if transcript.isEmpty { isLoadingHistory = true }
    }

    /// The host's copy could not be had: the thread is shown as it is here.
    public mutating func historyNotComing() {
        isLoadingHistory = false
    }

    /// Brings the thread in line with the host: the transcript (keeping the detail of
    /// turns both agree on), whether a run is going on, and what it is waiting for.
    public mutating func adopt(_ snapshot: ThreadSnapshot, at now: Date = .now) {
        isLoadingHistory = false
        let wasOn = openTurnIndex.map { transcript.turns[$0].id }
        let before = transcript.turns.map(\.id)
        // Only the host's last turns: what this copy has from before them is not the host's.
        if snapshot.hasEarlier != nil { transcript = transcript.lastTurns(snapshot.transcript.turns.count) }
        hasEarlierHistory = snapshot.hasEarlier == true
        transcript = transcript.merged(
            withHost: snapshot.transcript, authoritative: snapshot.authoritative, hostKeepsMessageIDs: snapshot.hostKeepsMessageIDs
        )
        keepTurnOrigin(from: before)
        if snapshot.authoritative {
            closedTexts = []
            openedHere = nil
            begunByPlace = nil
            hostRun = nil
            othersRun = nil
        }
        // A message still on its way, which the host has not started on.
        var sending = transcript.turns.last.flatMap { $0.isBeingSent ? $0 : nil }
        if let turn = sending, snapshot.isRunning {
            // The host is busy with a run of its own: the message waits its turn, like
            // any other sent during a run, and the run stays the last turn.
            transcript.turns.removeLast()
            pending.append(contentsOf: turn.items.compactMap { item in
                if case let .user(message) = item.content { PendingMessage(id: item.id, message: message) } else { nil }
            })
            sending = nil
        }
        if !snapshot.isRunning {
            // The host has nothing in progress. A turn still open ended while the app
            // was away, and the one that was running here, if it left no reply on the
            // host, was cut off.
            for index in transcript.turns.indices {
                let turn = transcript.turns[index]
                let wasCutOff = turn.id == wasOn && turn.items.allSatisfy(\.isUserMessage)
                guard turn.id != sending?.id, turn.isRunning || wasCutOff else { continue }
                transcript.turns[index].outcome = .interrupted
                transcript.turns[index].endedAt = turn.endedAt ?? turn.startedAt
            }
            // Nothing is waiting its turn any more, but what the host lists as waiting (an
            // agent catching up keeps messages so at rest); what has not been answered yet
            // is still on its way.
            let listed = Set(snapshot.queued?.map(\.id) ?? [])
            pending.removeAll { $0.message.delivery != nil && !($0.queueID.map(listed.contains) ?? false) }
        }
        phase = snapshot.isRunning || sending != nil ? .running : .idle
        openRequests = snapshot.isRunning ? snapshot.openRequests : snapshot.openRequests.filter(\.outlivesTurn)
        // Open on the host: an answer recorded here never took (sent as the connection went),
        // and the merge may have kept it, in a turn as it was here.
        var recordedIn: [String: UUID] = [:]
        for request in openRequests {
            if let turn = takeBackRecord(of: request.id) { recordedIn[request.id] = turn }
            settledByHost.removeAll { $0 == request.id }
        }
        // Asked in the host's last turn, unless known here to be in one it still has.
        let askedLast = transcript.turns.last(where: { !$0.isLocal })?.id
        askedIn = Dictionary(uniqueKeysWithValues: openRequests.filter { $0.askedAhead == true }.compactMap { request in
            let known = (askedIn[request.id] ?? recordedIn[request.id]).flatMap { id in transcript.turns.contains(where: { $0.id == id }) ? id : nil }
            return (known ?? askedLast).map { (request.id, $0) }
        })
        // The line of the run going on as the host holds it, not what was shown before.
        statusLine = snapshot.isRunning ? snapshot.statusLine : nil
        let latestPlan = transcript.latestPlan
        currentPlan = latestPlan?.plan
        currentPlanTurnID = latestPlan?.turn
        readHeadline()
        take(snapshot.info)
        // The messages waiting as the host lists them; this device's own that are not on
        // the list any more were taken off it elsewhere.
        if let list = snapshot.queued {
            let waiting = Set(list.map(\.id))
            // What left the list meanwhile was taken off it or opened its turn, which the
            // transcript taken now shows: an answer still to come for one of them is
            // settled by dropping its message. One listed is waiting.
            departed.removeAll { waiting.contains($0.queueID) }
            for gone in queued where !waiting.contains(gone.id) && !departed.contains(where: { $0.queueID == gone.id }) {
                depart(gone.id, .away, at: now)
            }
            queued = list
            canSteerQueued = snapshot.canSteerQueued
            claimListed(list, at: now)
            pending.removeAll { $0.queueID.map { !waiting.contains($0) } ?? false }
        }
    }

    /// The host's turns from before the first the thread holds (`HistoryPaging`), put
    /// before it.
    public mutating func takeEarlier(_ earlier: EarlierTurns) {
        transcript.turns.insert(contentsOf: earlier.transcript.turns, at: 0)
        turnOrigin -= earlier.transcript.turns.count
        hasEarlierHistory = earlier.hasEarlier
    }

    /// The turns before `before`, the turns' ids before a change, as they are now: where
    /// the first of them went, or where the first now was (`turnOrigin`). Neither found,
    /// the count is left as it was.
    private mutating func keepTurnOrigin(from before: [Turn.ID]) {
        guard let first = before.first, transcript.turns.first?.id != first else { return }
        if let moved = transcript.turns.firstIndex(where: { $0.id == first }) {
            turnOrigin -= moved
        } else if let now = transcript.turns.first?.id, let was = before.firstIndex(of: now) {
            turnOrigin += was
        }
    }

    /// What the host says of the thread besides its conversation.
    private mutating func take(_ info: ThreadInfo) {
        if let newTitle = info.title?.trimmingCharacters(in: .whitespacesAndNewlines), !newTitle.isEmpty {
            title = newTitle
        }
        // A host that does not know right now leaves what was known before.
        if let known = info.context { context = known }
        // The same for a thinking level the host leaves out.
        if let running = info.model {
            model = ModelSetting(model: running.model, provider: running.provider, level: running.level ?? model?.level)
        }
        if let known = info.mode { mode = known }
    }

    // MARK: What the agent did

    public mutating func apply(_ event: ThreadEvent, at now: Date = .now) {
        // The host saying a run begins (a bridge's `message.start`) takes the status line
        // down, as the host does with the line it tells a device that opens the thread
        // whole: also when this app opened the turn already, for a message of its own,
        // and a line came between ("trying again" from between runs).
        if event.beginsRun { statusLine = nil }
        switch event {
        case .turnStarted:
            // A turn opened here for a message of this device's, kept as the run the host
            // began: whose run it is, the answer still to come says (`hostRun`).
            let kept = openTurnIndex.map { isOpenedHere(transcript.turns[$0]) } ?? false
            let turn = openOrStartTurn(now)
            if kept { hostRun = transcript.turns[turn].id }
            phase = .running

        case let .ownTurnStarted(id, queueID):
            // A turn this app opened for other messages of its own, which the host has not
            // begun (sent as this one's run was about to begin): they wait for their answers,
            // as when another's message opens the turn (`turnOpened`); one handed to the run
            // joins it.
            var steeredIn: [TurnItem] = []
            if let open = openTurnIndex, isOpenedHere(transcript.turns[open]), !transcript.turns[open].items.contains(where: { $0.id == id }) {
                steeredIn = setAsideOpenedHere(open, at: now)
            }
            // Its send failed here, the connection gone before the answer, and the host runs
            // it all the same: it opens the run again, not left failed to be sent twice. One
            // the host listed as waiting (this device never heard its place on the list) left
            // the list as this one.
            if openTurnIndex == nil, let item = takeBackFailedSend(id) {
                beginRun(Turn(startedAt: now, items: [item]))
                if let queueID, queued.contains(where: { $0.id == queueID }) { depart(queueID, .shown(item.id), at: now) }
            } else if openTurnIndex == nil, let waiting = pending.firstIndex(where: { $0.id == id }) {
                // Still waiting here for its answer (sent as a run was ending): this is its
                // run, by the host's word, whether the answer comes or is lost.
                let message = pending.remove(at: waiting)
                beginRun(Turn(startedAt: now, items: [TurnItem(id: message.id, .user(message.message))]))
                if let queueID, queued.contains(where: { $0.id == queueID }) { depart(queueID, .shown(message.id), at: now) }
            } else {
                _ = openOrStartTurn(now, queueID: queueID)
            }
            if let open = openTurnIndex { for item in steeredIn { append(item, to: open, at: now) } }
            // Started by the host, as its answer would say: a send of it that fails now
            // (the answer lost) does not end the run (`messageFailed`). One the list said
            // waited there has begun now too.
            update(id) { content in
                guard case var .user(message) = content, message.delivery == nil || message.delivery == .queued else { return }
                message.delivery = .started
                content = .user(message)
            }
            phase = .running

        case let .turnOpened(by: text, queueID, from, cardAnswer):
            // One of this app's own that waited on the host's list: it opens its turn as such.
            if let queueID, pending.contains(where: { $0.queueID == queueID }) {
                _ = openOrStartTurn(now, queueID: queueID)
                phase = .running
                return
            }
            // A turn this app opened for messages of its own that the host did not start a turn
            // for: the host opened its turn with another's. One not answered for yet waits for
            // the answer, which says where it went; one the host said it handed to the running
            // turn (an answer that came before this) joins this one, after its opener.
            var steeredIn: [TurnItem] = []
            if let open = openTurnIndex, isOpenedHere(transcript.turns[open]) { steeredIn = setAsideOpenedHere(open, at: now) }
            // Opened by a message that is not this app's, which it shows as the opener.
            if openTurnIndex == nil {
                let item = TurnItem(.user(Self.message(text, delivery: .started, at: now, from: from, cardAnswer: cardAnswer)))
                beginRun(Turn(startedAt: now, items: [item] + steeredIn))
                // Another device's that waited on the list: what left the list is shown here.
                if let queueID, queued.contains(where: { $0.id == queueID }) { depart(queueID, .shown(item.id), at: now) }
            }
            phase = .running

        case let .failedRequestMarked(id):
            if let index = transcript.turns.indices.last, case .failed = transcript.turns[index].outcome {
                transcript.turns[index].failedRequestID = id
            }

        case let .failedRequestTaken(id):
            let before = transcript.turns.map(\.id)
            transcript.turns.removeAll { turn in
                guard case .failed = turn.outcome else { return false }
                return turn.failedRequestID == id
            }
            // This removal keeps the live end in its block, even for an interior failure.
            if let last = transcript.turns.last?.id, let was = before.firstIndex(of: last) {
                turnOrigin += was - (transcript.turns.count - 1)
            }

        case let .messageSteered(text, from, cardAnswer, messageID):
            // Handed to the running turn from elsewhere: it shows there.
            append(TurnItem(id: messageID ?? UUID(), .user(Self.message(text, delivery: .steered, at: now, from: from, cardAnswer: cardAnswer))), to: openOrStartTurn(now), at: now)
            phase = .running

        case let .ownMessageSteered(id, shownAlready):
            // One of this app's own, still waiting for its answer, handed to the run going on
            // now: it joins this run, even when the run's end, or another's start, comes here
            // before the answer. One placed already (its answer came first) stays where it is.
            guard let index = pending.firstIndex(where: { $0.id == id && $0.message.delivery == nil }) else {
                if !shownAlready { steerFailedSend(id, at: now) }
                return
            }
            if shownAlready {
                // The thread was opened again with the host's copy of it: that one shows it.
                pending.remove(at: index)
                return
            }
            guard let open = openTurnIndex else { return }
            let waiting = pending.remove(at: index)
            var message = waiting.message
            message.delivery = .steered
            append(TurnItem(id: waiting.id, .user(message)), to: open, at: now)

        case let .messageWithdrawn(text, messageID):
            // Taken back by a Stop before the agent read it: it leaves the turn it shows in.
            let words = SentText.parse(text).text
            withdraw(messageID) { $0.text == words }

        case let .ownMessageWithdrawn(id, _):
            withdraw(id) { _ in false }

        case let .queuedTurnStarted(queueID):
            // A turn opened here, kept as the run (no message of this device's waits under
            // that place): the host has begun it (`begunByPlace`).
            // Only where the host listed that place as this message: its words, and as many
            // images and files (as `replaceAlike` tells a message as the host stores it). A run
            // of another's message begun by its place is not this one's, whose own failure (an
            // attachment that could not be sent) stays a failure.
            let listed = queued.first(where: { $0.id == queueID }).map { SentText.parse($0.text) }
            let keeps = openTurnIndex.map { open in
                isOpenedHere(transcript.turns[open]) && !pending.contains(where: { $0.queueID == queueID })
                    && transcript.turns[open].items.contains { item in
                        guard let listed, case let .user(message) = item.content else { return false }
                        return message.text == listed.text && message.images.count == listed.images.count
                            && message.files.count == listed.files.count
                    }
            } ?? false
            let turn = openOrStartTurn(now, queueID: queueID)
            if keeps { begunByPlace = transcript.turns[turn].id }
            phase = .running

        case let .queueChanged(list, canSteer, steered):
            if let steered {
                // Handed to the running turn, from this device or another: it shows there.
                if let mine = pending.firstIndex(where: { $0.queueID == steered }) {
                    let waiting = pending.remove(at: mine)
                    var message = waiting.message
                    message.delivery = .steered
                    append(TurnItem(id: waiting.id, .user(message)), to: openOrStartTurn(now), at: now)
                } else if let theirs = queued.first(where: { $0.id == steered }) {
                    let item = TurnItem(.user(Self.message(theirs, delivery: .steered, at: now)))
                    append(item, to: openOrStartTurn(now), at: now)
                    depart(steered, .shown(item.id), at: now)
                }
            }
            // Gone from the list without joining a turn: taken off it. One listed is waiting.
            let listed = Set(list.map(\.id))
            departed.removeAll { listed.contains($0.queueID) }
            for gone in queued where !listed.contains(gone.id) && !departed.contains(where: { $0.queueID == gone.id }) {
                depart(gone.id, .removed, at: now)
            }
            queued = list
            canSteerQueued = canSteer
            claimListed(list, at: now)
            // One of this device's taken off the list, here or elsewhere: it is never sent.
            let waiting = Set(list.map(\.id))
            pending.removeAll { $0.queueID.map { !waiting.contains($0) } ?? false }

        case let .textDelta(delta):
            guard !delta.isEmpty else { return }
            let index = openOrStartTurn(now)
            phase = .running
            // The agent at work again says more than a line from before: "Claude's API did
            // not answer; trying again (attempt 6 of 10)…" is over once a reply comes, and
            // a host does not always say so (2026-10-25). The same as a thought, a
            // tool call or a closed piece of text arrives.
            statusLine = nil
            if continueBlock(acrossCommand: delta, in: index, at: now) { return }
            if let last = transcript.turns[index].items.last, case let .text(existing) = last.content, !closedTexts.contains(last.id) {
                transcript.turns[index].items[transcript.turns[index].items.count - 1].content = .text(existing + delta)
            } else {
                // Models open a reply with blank lines after a tool call. They mean
                // nothing at the start of a piece of text, and alone they are not text.
                let previous = transcript.turns[index].items.last { if case .command = $0.content { false } else { true } }
                let continuesText = previous.map { item in
                    if case .text = item.content { !closedTexts.contains(item.id) } else { false }
                } ?? false
                let opening = continuesText ? delta : String(delta.drop(while: \.isWhitespace))
                if !opening.isEmpty {
                    append(TurnItem(.text(opening)), to: index, at: now)
                }
            }

        case let .interimText(text, alreadyStreamed):
            let piece = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !piece.isEmpty else { return }
            let index = openOrStartTurn(now)
            phase = .running
            statusLine = nil
            let items = transcript.turns[index].items
            let tailIndex = items.lastIndex { if case .command = $0.content { false } else { true } }
            if let tailIndex, case let .text(tail) = items[tailIndex].content, !closedTexts.contains(items[tailIndex].id) {
                let last = items[tailIndex]
                if alreadyStreamed, let parts = splitParts(of: Array(items[...tailIndex]), closedBy: piece, tail: tail) {
                    // Messages steered in split the piece as it streamed: its parts stay
                    // where they are, as the host's history has them, each as the host's copy
                    // says it (its spacing too), and the whole piece is not said again after
                    // the last message.
                    for part in parts {
                        guard let at = transcript.turns[index].items.firstIndex(where: { $0.id == part.id }) else { continue }
                        transcript.turns[index].items[at].content = .text(part.text)
                        closedTexts.insert(part.id)
                    }
                } else {
                    // The piece that was streaming: the host's copy of it is the one kept.
                    transcript.turns[index].items[tailIndex].content = .text(piece)
                }
                closedTexts.insert(last.id)
            } else if !alreadyStreamed, !Self.isShown(piece, in: items) {
                let item = TurnItem(.text(piece))
                append(item, to: index, at: now)
                closedTexts.insert(item.id)
            }

        case let .reasoningDelta(delta):
            guard !delta.isEmpty else { return }
            let index = openOrStartTurn(now)
            phase = .running
            statusLine = nil
            if let last = transcript.turns[index].items.last, case var .reasoning(reasoning) = last.content, reasoning.endedAt == nil {
                // A title whose line this closes is what the agent is working on now.
                let title = StatusHeadline.title(closedBy: delta, after: reasoning.text)
                reasoning.text += delta
                transcript.turns[index].items[transcript.turns[index].items.count - 1].content = .reasoning(reasoning)
                takeHeadline(title)
            } else {
                append(TurnItem(.reasoning(Reasoning(text: delta, startedAt: now))), to: index, at: now)
                takeHeadline(StatusHeadline.title(closedBy: delta, after: ""))
            }

        case let .toolStarted(run):
            let index = openOrStartTurn(now)
            phase = .running
            statusLine = nil
            // The same call told again (a replay) is its row; a finished call with this id
            // is another call (some models number calls afresh in each answer, also within
            // one turn), which keeps its row, unless it is this very call (the same tool,
            // given the same input) in this turn.
            let isReplay = { (row: ToolRun, turn: Int) in
                turn == index && row.name == run.name && row.input == run.input && row.label == run.label
            }
            if !updateTool(run.id, where: { $0.state == .running || isReplay($0, $1) }, { $0 = run }) {
                append(TurnItem(.tool(run)), to: index, at: now)
            }

        case let .toolFinished(result):
            var completedPlan = result.plan
            let updated = updateTool(result.id) { run in
                run.state = result.succeeded ? .succeeded : .failed
                run.duration = result.duration ?? now.timeIntervalSince(run.startedAt)
                run.output = result.output
                run.outputTruncated = nil
                run.progress = nil
                if let diff = result.diff { run.diff = diff }
                if let call = result.subagentCall { run.subagentCall = call }
                if let path = result.path { run.path = path }
                if let line = result.startLine { run.startLine = line }
                if let plan = result.plan { run.plan = plan }
                if let execution = result.execution { run.execution = execution }
                completedPlan = run.plan
            }
            if !updated {
                // Its start was missed (a reconnect): show the result on its own.
                let run = ToolRun(
                    id: result.id, name: result.name, label: result.label, input: result.input,
                    output: result.output, diff: result.diff,
                    state: result.succeeded ? .succeeded : .failed, startedAt: now, duration: result.duration,
                    subagentCall: result.subagentCall, path: result.path, startLine: result.startLine, plan: result.plan, execution: result.execution
                )
                // A turn it opens is no run's start (the host's start, `beginsRun`, takes the
                // line down here as the host does): the host keeps its line over a tool's end,
                // and so does this app.
                let line = statusLine
                let turn = openOrStartTurn(now)
                statusLine = line
                append(TurnItem(.tool(run)), to: turn, at: now)
            }
            if result.succeeded, let plan = completedPlan {
                // A list written that took: its item in progress, worded as it runs (not at
                // the call's start: one that fails says nothing of what is under way).
                takeWording(of: plan)
                currentPlan = plan
                currentPlanTurnID = transcript.turns.last { turn in
                    turn.items.contains { item in
                        if case let .tool(run) = item.content { run.id == result.id } else { false }
                    }
                }?.id
            }

        case let .toolProgress(progress):
            _ = updateTool(progress.id) { run in
                // The final result wins over progress delivered late or replayed.
                guard run.state == .running else { return }
                if let output = progress.output { run.output = output }
                if let text = progress.progress { run.progress = text.isEmpty ? nil : text }
                if let clipped = progress.outputTruncated { run.outputTruncated = clipped ? true : nil }
            }

        case let .requestOpened(request):
            // Answered here, and the host asks still (shown again on reconnecting): that
            // answer never took, sent as the connection went, and what it recorded goes.
            let answeredIn = openRequests.contains(where: { $0.id == request.id }) ? nil : takeBackRecord(of: request.id)
            // A subagent at work after its turn asks with no turn running: nothing starts.
            if !request.outlivesTurn || openTurnIndex != nil {
                _ = openOrStartTurn(now)
                phase = .running
            }
            settledByHost.removeAll { $0 == request.id }
            answeredHere.removeAll { $0.id == request.id }
            if !openRequests.contains(where: { $0.id == request.id }) {
                openRequests.append(request)
                if request.askedAhead == true, let turn = answeredIn ?? (openTurnIndex ?? lastTurnIndex).map({ transcript.turns[$0].id }) {
                    askedIn[request.id] = turn
                }
            }

        case let .requestClosed(id, reason):
            // Settled by the host, open here or not: an answer of this device's whose send
            // fails after it (`answerNotSent`) reopens nothing, also where the catch-up that
            // send waited for had shown the card again.
            noteSettledByHost(id)
            guard let index = openRequests.firstIndex(where: { $0.id == id }) else { return }
            let request = openRequests.remove(at: index)
            append(TurnItem(.request(RequestRecord(request, answer: reason))), to: recordTurn(for: request, now), at: now)

        case let .requestSettledElsewhere(id):
            // Answered here, the host not having taken that answer yet: the card is open
            // again for a moment, where its record was, and the closing that follows
            // records how the host settled it in place of this app's answer.
            guard !openRequests.contains(where: { $0.id == id }),
                  let index = answeredHere.firstIndex(where: { $0.id == id }) else { return }
            let request = answeredHere.remove(at: index)
            if let turn = takeBackRecord(of: id) { askedIn[id] = turn }
            openRequests.append(request)

        case let .requestAnswered(id, answer, by):
            noteSettledByHost(id)
            guard let index = openRequests.firstIndex(where: { $0.id == id }) else {
                // Answered here, the host not having taken that answer: from a bridge that does
                // not say whose answer it was (before `answer_owner`), the answer it gives, or
                // the agent that gave it, says whether another won. Its own told back is the same.
                guard let mine = answeredHere.firstIndex(where: { $0.id == id }) else { return }
                let request = answeredHere[mine]
                if replaceRecord(of: id, with: RequestRecord(request, answer: answer.summary(for: request), answeredBy: by)) {
                    answeredHere.remove(at: mine)
                }
                return
            }
            let request = openRequests.remove(at: index)
            let record = RequestRecord(request, answer: answer.summary(for: request), answeredBy: by)
            append(TurnItem(.request(record)), to: recordTurn(for: request, now), at: now)

        case let .snapshot(snapshot):
            adopt(snapshot)

        case .detached, .catchUpBegan, .mcpAuthChanged, .mcpAuthCleared:
            // About the connection, not the conversation.
            break

        case let .status(line):
            let trimmed = line?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            statusLine = trimmed.isEmpty ? nil : trimmed

        case let .headline(text, toolIDs):
            takeSummary(text, of: toolIDs)

        case let .notice(notice):
            let index = openTurnIndex ?? lastTurnIndex ?? startClosedTurn(now)
            // The same line twice in a row says nothing new.
            if case let .notice(previous)? = transcript.turns[index].items.last?.content, previous == notice { return }
            append(TurnItem(.notice(notice)), to: index, at: now)

        case let .titleChanged(newTitle):
            let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { title = trimmed }

        case let .caughtUp(info):
            take(info)
            isLoadingHistory = false

        case let .modeChanged(state):
            mode = state

        case let .contextChanged(usage):
            context = usage

        case let .compacted(compaction):
            // Where it happened in the run; one reported outside a run goes with the
            // last turn, as a notice does.
            let index = openTurnIndex ?? lastTurnIndex ?? startClosedTurn(now)
            append(TurnItem(.compaction(compaction)), to: index, at: now)

        case let .announced(event):
            announced = Announcement(event: event, at: now)

        case let .subagent(news):
            subagents.take(news)

        case let .subagentsListed(working):
            subagents = working

        case let .subagentsCleared(ids):
            subagents.clear(ids)

        case .turnListed:
            // For the host's list (the device's read marks), not the transcript.
            break

        case let .turnFinished(outcome, finalText):
            let index = openOrStartTurn(now)
            // The whole reply, for one that did not stream: it is the answer unless text
            // streamed after the agent's last step. Text from before then, and pieces the
            // host closed, were said on the way.
            let items = transcript.turns[index].items
            let answer = items.suffix(from: (items.lastIndex(where: \.isWork) ?? -1) + 1)
            let hasAnswer = answer.contains { item in
                if case .text = item.content { !closedTexts.contains(item.id) } else { false }
            }
            if case .completed = outcome, !hasAnswer, let finalText = finalText?.trimmingCharacters(in: .whitespacesAndNewlines),
               !finalText.isEmpty, !Self.isShown(finalText, in: items) {
                append(TurnItem(.text(finalText)), to: index, at: now)
            }
            finishTurn(at: index, outcome, now)

        case let .turnSpent(spent):
            // Told right after the end of the turn it is about: the last of the agent's, not
            // a command's answer that waited beside it and followed it as it ended.
            guard let index = transcript.turns.lastIndex(where: { !$0.isLocal }), !transcript.turns[index].isRunning, !spent.isEmpty else { return }
            transcript.turns[index].spent = spent

        case let .turnUsage(spent):
            guard let index = openTurnIndex, !spent.isEmpty else { return }
            transcript.turns[index].spent = spent

        case let .turnChanged(diff):
            // As what it spent: the last of the agent's turns, once it has ended.
            guard let index = transcript.turns.lastIndex(where: { !$0.isLocal }), !transcript.turns[index].isRunning, !diff.files.isEmpty else { return }
            transcript.turns[index].diff = diff
        }
    }

    // MARK: Internals

    private var lastTurnIndex: Int? {
        transcript.turns.isEmpty ? nil : transcript.turns.count - 1
    }

    /// The turn still running, if the last one is.
    private var openTurnIndex: Int? {
        guard let index = lastTurnIndex, transcript.turns[index].isRunning else { return nil }
        return index
    }

    /// Where a question's answer is recorded: the turn running, else, for one a subagent
    /// asked after its turn, the last turn, else a new one.
    private mutating func recordTurn(for request: PendingRequest, _ now: Date) -> Int {
        // One asked without waiting: where it was asked, not in the turn its answer opened.
        if let id = askedIn.removeValue(forKey: request.id), let index = transcript.turns.firstIndex(where: { $0.id == id }) { return index }
        if let index = openTurnIndex { return index }
        if request.outlivesTurn, let index = lastTurnIndex { return index }
        return openOrStartTurn(now)
    }

    /// The running turn, or a new one. A new turn opens with the oldest message that is
    /// waiting to run, since that is what the agent has just started on.
    /// The turn running now, or one opened for what starts it: the waiting message with
    /// `queueID` (this device's own, or as the host listed it), else the oldest of this
    /// device's messages waiting with no place on the host's list, else what the host
    /// announced.
    private mutating func openOrStartTurn(_ now: Date, queueID: String? = nil) -> Int {
        var steeredIn: [TurnItem] = []
        if let index = openTurnIndex {
            // The host begins the run of a message of this device's that waited on its list:
            // a turn this app opened for other messages of its own the host has not begun
            // (sent as that run began) is not it. They wait for their answers, which say where
            // they went (`turnOpened`). One listed under a place this device does not know
            // as its own may be the very message that opened the turn (listed before its
            // answer came): the turn stays.
            guard let queueID, isOpenedHere(transcript.turns[index]), pending.contains(where: { $0.queueID == queueID }) else { return index }
            steeredIn = setAsideOpenedHere(index, at: now)
        }
        defer { if !steeredIn.isEmpty, let open = openTurnIndex { for item in steeredIn { append(item, to: open, at: now) } } }
        var items: [TurnItem] = []
        if let queueID, let mine = pending.firstIndex(where: { $0.queueID == queueID }) {
            let waiting = pending.remove(at: mine)
            items.append(TurnItem(id: waiting.id, .user(waiting.message)))
        } else if let queueID, let theirs = queued.first(where: { $0.id == queueID }) {
            let item = TurnItem(.user(Self.message(theirs, delivery: .queued, at: now)))
            items.append(item)
            depart(queueID, .shown(item.id), at: now)
        } else if let next = pending.firstIndex(where: { ($0.message.delivery == .queued || $0.message.delivery == .started) && $0.queueID == nil }) {
            let waiting = pending.remove(at: next)
            items.append(TurnItem(id: waiting.id, .user(waiting.message)))
        } else if let reason = announced, now.timeIntervalSince(reason.at) <= Announcement.life {
            // No message of the user's started this: the host did, and said why.
            items.append(TurnItem(.event(reason.event)))
            announced = nil
        }
        beginRun(Turn(startedAt: now, items: items))
        return transcript.turns.count - 1
    }

    /// A running turn this app opened for a message of its own (`openedHere`) that holds
    /// nothing but its own messages, none of which the host started a turn for.
    private func isOpenedHere(_ turn: Turn) -> Bool {
        guard turn.isRunning, turn.id == openedHere, turn.items.contains(where: \.isUserMessage) else { return false }
        return turn.items.allSatisfy { item in
            switch item.content {
            case let .user(message): message.delivery != .started
            // The answer to a command run meanwhile, or a notice (a Try again refused): said
            // here, by no run of the host's.
            case .command, .notice: true
            default: false
            }
        }
    }

    /// A turn opened here (`isOpenedHere`) whose messages went elsewhere: it goes, or, with
    /// the answers to commands run meanwhile or notices left in it, stays for them, over.
    private mutating func settleOpenedHere(_ index: Int, at now: Date) {
        guard !transcript.turns[index].items.contains(where: \.isUserMessage) else { return }
        if transcript.turns[index].items.isEmpty {
            transcript.turns.remove(at: index)
        } else {
            transcript.turns[index].outcome = .completed
            transcript.turns[index].endedAt = now
        }
    }

    /// Notes what became of a message that left the host's list, for an answer still to come.
    private mutating func depart(_ queueID: String, _ departure: Departure, at now: Date) {
        departed.removeAll { $0.queueID == queueID || now.timeIntervalSince($0.at) > Self.departureLife }
        departed.append(Departed(queueID: queueID, departure: departure, at: now))
        if departed.count > Self.departuresKept { departed.removeFirst(departed.count - Self.departuresKept) }
    }

    /// Puts this device's own copy of a message in place of the item that showed it as the
    /// host listed it, keeping how it was delivered.
    @discardableResult
    private mutating func replace(_ itemID: UUID, with waiting: PendingMessage) -> Bool {
        for turnIndex in transcript.turns.indices.reversed() {
            guard let itemIndex = transcript.turns[turnIndex].items.firstIndex(where: { $0.id == itemID }) else { continue }
            return replace(at: turnIndex, itemIndex, with: waiting)
        }
        return false
    }

    /// A message shown in a turn, once a snapshot has made the transcript afresh: the one
    /// message like it in a turn that began after it was sent, give or take the two
    /// clocks, is it, and takes this device's own copy. Like it: the same words and as
    /// many files and images (the host may have renamed a file). Two or more, and which is
    /// it cannot be told: nothing changes, and the transcript keeps the host's copy.
    private mutating func replaceAlike(with waiting: PendingMessage) {
        let mine = waiting.message
        let since = mine.sentAt.addingTimeInterval(-Self.clockSlack)
        var alike: [(turn: Int, item: Int)] = []
        for turnIndex in transcript.turns.indices where transcript.turns[turnIndex].startedAt >= since {
            for (itemIndex, item) in transcript.turns[turnIndex].items.enumerated() {
                guard case let .user(shown) = item.content, shown.text == mine.text, shown.images.count == mine.images.count,
                      shown.files.count == mine.files.count else { continue }
                alike.append((turnIndex, itemIndex))
            }
        }
        guard alike.count == 1, let only = alike.first else { return }
        replace(at: only.turn, only.item, with: waiting)
    }

    /// How far this device's clock and the host's may be apart.
    private static let clockSlack: TimeInterval = 5

    /// Puts this device's own copy of a message in place of the item showing it, keeping
    /// how it was delivered.
    @discardableResult
    private mutating func replace(at turnIndex: Int, _ itemIndex: Int, with waiting: PendingMessage) -> Bool {
        guard case let .user(shown) = transcript.turns[turnIndex].items[itemIndex].content else { return false }
        var message = waiting.message
        message.delivery = shown.delivery
        transcript.turns[turnIndex].items[itemIndex] = TurnItem(id: waiting.id, .user(message))
        return true
    }

    /// A message another device left on the host's list, as the transcript shows it.
    private static func message(_ queued: QueuedMessage, delivery: SendOutcome, at now: Date) -> UserMessage {
        message(queued.text, delivery: delivery, at: now, from: queued.from, cardAnswer: queued.cardAnswer)
    }

    /// A message from elsewhere, as the host stores it (its images and files named in it),
    /// as the transcript shows it; `from`, who sent it through the fleet as the host says;
    /// `cardAnswer`, the answers given on a card it carries (`UserMessage.cardAnswer`).
    private static func message(_ stored: String, delivery: SendOutcome, at now: Date, from: MessageSender? = nil, cardAnswer: String? = nil) -> UserMessage {
        let parsed = SentText.parse(stored)
        return UserMessage(
            text: parsed.text, sentAt: now, delivery: delivery,
            images: parsed.images.map { AttachedImage(filename: $0) },
            files: parsed.files.map { AttachedFile(filename: SentText.name(ofPath: $0), path: $0) },
            from: from,
            cardAnswer: cardAnswer
        )
    }

    /// A run begins in a new turn. A status line still up is not its own: the host put it
    /// up between runs (Claude Code's heartbeat while a background agent waits out a usage
    /// limit comes after the turn's end), and the run begins thinking, not under it.
    private mutating func beginRun(_ turn: Turn) {
        transcript.turns.append(turn)
        statusLine = nil
    }

    /// Takes out the turn at `open`, which this app opened for messages of its own that the
    /// host did not start a turn for (`isOpenedHere`): one not answered for yet waits for the
    /// answer, which says where it went; those the host said it handed to the running turn
    /// are returned, to join the turn the host began.
    private mutating func setAsideOpenedHere(_ open: Int, at now: Date) -> [TurnItem] {
        var steeredIn: [TurnItem] = []
        for item in transcript.turns[open].items {
            guard case let .user(message) = item.content else { continue }
            if message.delivery == .steered { steeredIn.append(item) } else { pending.append(PendingMessage(id: item.id, message: message)) }
        }
        transcript.turns[open].items.removeAll(where: \.isUserMessage)
        settleOpenedHere(open, at: now)
        return steeredIn
    }

    /// This device's own messages the host lists as waiting, by the id it gave them
    /// (`message_ids`), whose answer has not said so: still to come, or lost as the
    /// connection went (the send failed here). Each waits as one the host queued, under its
    /// place on the list, as the answer would have had it: not failed, to be sent twice.
    private mutating func claimListed(_ list: [QueuedMessage], at now: Date) {
        for entry in list {
            guard let id = entry.messageID else { continue }
            if let index = pending.firstIndex(where: { $0.id == id && $0.queueID == nil }) {
                pending[index].queueID = entry.id
                if pending[index].message.delivery == nil { pending[index].message.delivery = .queued }
            } else if !pending.contains(where: { $0.id == id }), let item = takeBackFailedSend(id) ?? takeBackOpenedHere(id, at: now),
                      case var .user(message) = item.content {
                message.delivery = .queued
                pending.append(PendingMessage(id: id, message: message, queueID: entry.id))
                phase = .running
            }
        }
    }

    private mutating func noteSettledByHost(_ id: String) {
        settledByHost.removeAll { $0 == id }
        settledByHost.append(id)
        if settledByHost.count > 32 { settledByHost.removeFirst(settledByHost.count - 32) }
    }

    /// Takes out the record of how the request with `id` was settled (`requestAnswered`,
    /// `requestClosed`), the latest; the id of the turn that held it, nil when none did.
    private mutating func takeBackRecord(of id: String) -> Turn.ID? {
        for turnIndex in transcript.turns.indices.reversed() {
            guard let itemIndex = transcript.turns[turnIndex].items.lastIndex(where: { item in
                if case let .request(record) = item.content { record.id == id } else { false }
            }) else { continue }
            transcript.turns[turnIndex].items.remove(at: itemIndex)
            return transcript.turns[turnIndex].id
        }
        return nil
    }

    /// Puts `record` in place of the latest record of how the request with its id was
    /// settled, when it says otherwise. Whether it did.
    private mutating func replaceRecord(of id: String, with record: RequestRecord) -> Bool {
        for turnIndex in transcript.turns.indices.reversed() {
            guard let itemIndex = transcript.turns[turnIndex].items.lastIndex(where: { item in
                if case let .request(shown) = item.content { shown.id == id } else { false }
            }) else { continue }
            guard transcript.turns[turnIndex].items[itemIndex].content != .request(record) else { return false }
            transcript.turns[turnIndex].items[itemIndex].content = .request(record)
            return true
        }
        return false
    }

    /// A turn that is already over, to hold a line that arrived outside any run.
    private mutating func startClosedTurn(_ now: Date) -> Int {
        transcript.turns.append(Turn(startedAt: now, endedAt: now, outcome: .completed))
        return transcript.turns.count - 1
    }

    /// A message of this device's whose send failed here (`messageFailed`: its answer was
    /// lost as the connection went) that the host says it handed to the run going on: its
    /// failed turn of its own goes, and it joins the run as steered, as it would have had
    /// the word come first. Nothing for any other message, or with no run open.
    private mutating func steerFailedSend(_ id: UUID, at now: Date) {
        guard openTurnIndex != nil, let item = takeBackFailedSend(id), case var .user(message) = item.content,
              let open = openTurnIndex else { return }
        message.delivery = .steered
        append(TurnItem(id: id, .user(message)), to: open, at: now)
    }

    /// The message of this device's whose send failed here, taken out of the failed turn it
    /// opened (`messageFailed`), which goes; nil when there is none. Answers to commands run
    /// meanwhile, and notices, which that turn may hold besides, stay, in a turn of their own.
    private mutating func takeBackFailedSend(_ id: UUID) -> TurnItem? {
        guard let failed = transcript.turns.firstIndex(where: { turn in
            guard case .failed = turn.outcome, let first = turn.items.first, first.id == id, case .user = first.content else { return false }
            return turn.items.dropFirst().allSatisfy { item in
                switch item.content {
                case .command, .notice: true
                default: false
                }
            }
        }) else { return nil }
        let item = transcript.turns[failed].items.removeFirst()
        if transcript.turns[failed].items.isEmpty {
            transcript.turns.remove(at: failed)
        } else {
            transcript.turns[failed].outcome = .completed
        }
        return item
    }

    /// The message of this device's that opened a turn here the host has not begun
    /// (`isOpenedHere`), taken out of it; the turn goes once nothing is left in it.
    private mutating func takeBackOpenedHere(_ id: UUID, at now: Date) -> TurnItem? {
        guard let open = openTurnIndex, isOpenedHere(transcript.turns[open]) || transcript.turns[open].id == hostRun,
              let at = transcript.turns[open].items.firstIndex(where: { $0.id == id }) else { return nil }
        let item = transcript.turns[open].items.remove(at: at)
        if !keepAsHostRun(open) { settleOpenedHere(open, at: now) }
        return item
    }

    /// The turn at `index`, which a start of the host's naming no message kept as its run
    /// (`hostRun`), once this device's message that opened it here went to wait on the
    /// host's list: that run is another's, and goes on, opened by none of this device's.
    /// True then; false for any other turn, which is this device's to settle.
    private mutating func keepAsHostRun(_ index: Int) -> Bool {
        guard transcript.turns[index].id == hostRun else { return false }
        openedHere = nil
        hostRun = nil
        othersRun = transcript.turns[index].id
        return true
    }

    private mutating func finishTurn(at index: Int, _ outcome: TurnOutcome, _ now: Date) {
        if case .failed = outcome {
            // The failure says what went wrong; error lines from the same turn repeat it.
            transcript.turns[index].items.removeAll {
                if case let .notice(notice) = $0.content { notice.level == .error } else { false }
            }
        }
        endReasoning(in: index, at: now)
        // A tool still marked running ended with the turn.
        for itemIndex in transcript.turns[index].items.indices {
            guard case var .tool(run) = transcript.turns[index].items[itemIndex].content, run.state == .running else { continue }
            run.state = outcome == .completed ? .succeeded : .failed
            run.duration = run.duration ?? now.timeIntervalSince(run.startedAt)
            transcript.turns[index].items[itemIndex].content = .tool(run)
        }
        // Nothing can be answered once the run is over, but what a subagent that runs on asked.
        openRequests.removeAll { !$0.outlivesTurn }
        closedTexts = []
        transcript.turns[index].outcome = outcome
        transcript.turns[index].endedAt = now
        phase = .idle
        statusLine = nil
    }

    /// The parts of a piece split by steered messages or command answers, whose last part
    /// is the last item (`tail`): the open pieces of text before it, each followed by such
    /// separators, that with it say `piece`, give or take spacing, each with what `piece`
    /// says of it (`cut`). Nil when none do.
    private func splitParts(of items: [TurnItem], closedBy piece: String, tail: String) -> [(id: UUID, text: String)]? {
        var parts: [(item: TurnItem, text: String)] = []
        var index = items.count - 2
        while true {
            while index >= 0 {
                let isSeparator: Bool
                switch items[index].content {
                case .command: isSeparator = true
                case let .user(message): isSeparator = message.delivery == .steered
                default: isSeparator = false
                }
                guard isSeparator else { break }
                index -= 1
            }
            // Dismissing a command leaves its open text fragments adjacent. They
            // still form one piece when the host's whole-piece receipt confirms it.
            guard index >= 0, case let .text(text) = items[index].content, !closedTexts.contains(items[index].id) else { break }
            parts.insert((items[index], text), at: 0)
            index -= 1
        }
        guard let last = items.last else { return nil }
        // The most parts first: the piece may have begun before an earlier message too.
        for count in stride(from: parts.count, to: 0, by: -1) {
            let said = parts.suffix(count)
            if let texts = Self.cut(piece, into: said.map(\.text) + [tail]) {
                return zip(said.map(\.item.id) + [last.id], texts).map { (id: $0, text: $1) }
            }
        }
        return nil
    }

    /// `piece` cut into the parts that streamed (`texts`), when they say it, give or take
    /// spacing: each part as `piece` has it, from its first character to its last but
    /// spacing, where one that begins a line keeps its indentation (which a piece of text
    /// streamed after a message lost: it never opens with spacing). Nil when they do not.
    private static func cut(_ piece: String, into texts: [String]) -> [String]? {
        var cuts: [String] = []
        var position = piece.startIndex
        for text in texts {
            // The spacing before the part: it begins after the last line break in it, else at its first character.
            var lineStart: String.Index?
            while position < piece.endIndex, piece[position].isWhitespace {
                if piece[position].isNewline { lineStart = piece.index(after: position) }
                position = piece.index(after: position)
            }
            let start = lineStart ?? position
            var end = position
            for character in text where !character.isWhitespace {
                while position < piece.endIndex, piece[position].isWhitespace { position = piece.index(after: position) }
                guard position < piece.endIndex, piece[position] == character else { return nil }
                position = piece.index(after: position)
                end = position
            }
            cuts.append(String(piece[start..<end]))
            position = end
        }
        return piece[position...].allSatisfy(\.isWhitespace) ? cuts : nil
    }

    /// Whether the last piece of text in `items` already says `text`, give or take
    /// spacing: a piece the host sends again (the desktop app sees the same) is not
    /// shown twice.
    private static func isShown(_ text: String, in items: [TurnItem]) -> Bool {
        let words = { (text: String) in text.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        var parts: [String] = []
        latest: for item in items.reversed() {
            switch item.content {
            case let .text(piece):
                parts.insert(piece, at: 0)
            case .command:
                continue
            default:
                break latest
            }
        }
        if let last = parts.last, words(last) == words(text) { return true }
        return parts.count > 1 && parts.joined().filter { !$0.isWhitespace } == text.filter { !$0.isWhitespace }
    }

    /// Takes a message steered into a turn out of it, the latest first: the one with `id`
    /// where there is one, else the last steered in that `matches`. A thread opened since
    /// shows such a message as opening a turn of its own (`HermesHistoryMapper`), which goes
    /// with it when nothing else is left in it.
    private mutating func withdraw(_ id: UUID?, matching matches: (UserMessage) -> Bool) {
        let byID = id.map { id in transcript.turns.contains { $0.items.contains { $0.id == id } } } ?? false
        for turn in transcript.turns.indices.reversed() {
            let items = transcript.turns[turn].items
            guard let index = items.indices.last(where: { at in
                guard case let .user(message) = items[at].content else { return false }
                return byID ? items[at].id == id : message.delivery == .steered && matches(message)
            }) else { continue }
            transcript.turns[turn].items.remove(at: index)
            if transcript.turns[turn].items.isEmpty, turn != transcript.turns.indices.last {
                transcript.turns.remove(at: turn)
                // As for a failed turn taken back: the live end keeps its block.
                turnOrigin += 1
            }
            return
        }
    }

    /// Adds an item to a turn. Whatever comes after a stretch of reasoning ends it.
    private mutating func append(_ item: TurnItem, to index: Int, at now: Date) {
        endReasoning(in: index, at: now)
        transcript.turns[index].items.append(item)
    }

    /// An answer can arrive while a visual, a code block or a paragraph is being written.
    /// Finish that block above the answer: splitting a visual's source would break it, and
    /// a sentence split around the box reads as two (2026-10-21, the answer "should
    /// scroll up": it stays where it was asked, after the words it came in). Anything after
    /// the block's end goes below the answer as usual.
    private mutating func continueBlock(acrossCommand delta: String, in turn: Int, at now: Date) -> Bool {
        let items = transcript.turns[turn].items
        guard case .command? = items.last?.content,
              let index = items.lastIndex(where: { if case .command = $0.content { false } else { true } }),
              case let .text(text) = items[index].content, !closedTexts.contains(items[index].id) else { return false }
        let continued = text + delta
        // Where `text` ends in it, by its bytes: a character the delta begins with may join the last one.
        let said = continued.utf8.index(continued.utf8.startIndex, offsetBy: text.utf8.count)
        let end = Turn.endOfBlock(in: continued, from: said)
        guard end != said else { return false }
        let rest = continued[end...].drop(while: \.isWhitespace)
        // The spacing that ended the block stays with it while nothing follows yet, so the
        // next piece is known to begin a block of its own (Codex's review of n14).
        transcript.turns[turn].items[index].content = .text(rest.isEmpty ? continued : String(continued[..<end]))
        if !rest.isEmpty { append(TurnItem(.text(String(rest))), to: turn, at: now) }
        return true
    }

    private mutating func endReasoning(in index: Int, at now: Date) {
        guard let last = transcript.turns[index].items.indices.last,
              case var .reasoning(reasoning) = transcript.turns[index].items[last].content,
              reasoning.endedAt == nil else { return }
        reasoning.endedAt = now
        transcript.turns[index].items[last].content = .reasoning(reasoning)
        // A title on the thought's last line, closed by its end.
        takeHeadline(StatusHeadline.title(ending: reasoning.text))
    }

    /// Changes the tool run with this id, newest first, among those `matching` takes (the
    /// run and its turn's index). Returns false when there is none.
    private mutating func updateTool(
        _ id: String, where matching: (ToolRun, Int) -> Bool = { _, _ in true }, _ change: (inout ToolRun) -> Void
    ) -> Bool {
        for turnIndex in transcript.turns.indices.reversed() {
            for itemIndex in transcript.turns[turnIndex].items.indices.reversed() {
                guard case var .tool(run) = transcript.turns[turnIndex].items[itemIndex].content, run.id == id else { continue }
                guard matching(run, turnIndex) else { return false }
                change(&run)
                transcript.turns[turnIndex].items[itemIndex].content = .tool(run)
                return true
            }
        }
        return false
    }

    private mutating func update(_ itemID: UUID, _ change: (inout TurnItem.Content) -> Void) {
        for turnIndex in transcript.turns.indices.reversed() {
            if let itemIndex = transcript.turns[turnIndex].items.firstIndex(where: { $0.id == itemID }) {
                change(&transcript.turns[turnIndex].items[itemIndex].content)
                return
            }
        }
    }
}
