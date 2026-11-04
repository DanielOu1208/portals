import AgentCore
import Foundation
import Observation
import os

/// The files the messages sent from this device mentioned, by message, in every thread
/// while the app runs (`SentMentions`): sent again with one on "Try again", and the note on
/// a chip of a file its agent may not have read in whole. Not a thread's controller's own,
/// which is let go of and made again as threads are opened.
@MainActor
@Observable
final class SentMentionsMemory {
    static let shared = SentMentionsMemory()

    var sent = SentMentions()
}

/// One thread with one agent: sends messages, applies what the backend reports to a
/// `ThreadState`, and stops or retries a run.
///
/// A new thread is created on the host with its first message, so opening one and
/// leaving it empty costs nothing. A saved thread shows its on-device copy at once and
/// is reconnected to the host when it comes on screen. The same happens again after the
/// connection was lost with nothing running in the thread: the backend says so
/// (`.detached`), and the thread is reopened when it is next on screen or used.
@Observable
final class ThreadController: Identifiable {
    /// The agent, as the host last described it (its name can change there).
    private(set) var agent: Agent
    private(set) var thread: ThreadRef? {
        didSet {
            if oldValue?.id != thread?.id {
                draftKeyChanged(from: ComposerDrafts.key(thread: oldValue, agent: agent.id, folder: folder))
            }
        }
    }
    /// What is typed in the composer and not sent yet. Its words are kept on this device
    /// as they change (`ComposerDrafts`); its images and files for as long as the
    /// controller is.
    var composer = ComposerDraft() {
        didSet {
            if composer.text != oldValue.text { ComposerDrafts.shared.set(composer.text, for: draftKey) }
        }
    }
    let localID: UUID
    @ObservationIgnored let transcriptHeights = TranscriptHeights()
    /// What a command's answer box in the chat calls to close itself (`CommandAnswerCloser`).
    @ObservationIgnored let commandAnswers = CommandAnswerCloser()
    @ObservationIgnored private(set) var savedConversation: SavedConversation?
    private(set) var state = ThreadState() {
        didSet { noteRunChanges() }
    }
    /// Whether a run is going on. Kept apart from `state`, and set only when it changes:
    /// what asks only this (the sidebar, the list's marks) is then not drawn again with
    /// every word of a reply, as whatever reads `state` is.
    private(set) var isRunning = false
    /// A run is going on, or an agent or workflow it set to work is still at it, not a
    /// command left running in the background (`ThreadState.isAtWork`): what the sidebar
    /// calls running, as the host does. Kept apart from `state` like `isRunning`.
    private(set) var isAtWork = false
    /// What the agent is blocked on until you answer; the oldest first. Kept apart from
    /// `state` like `isRunning`.
    private(set) var pendingRequest: PendingRequest?
    let mcpAuth = MCPAuthState()
    /// The agent waits for your answer and for nothing else (`ThreadState.waitsOnlyOnUser`):
    /// the thread's wash holds still. Kept apart from `state` like `isRunning`.
    private(set) var waitsOnlyOnUser = false
    /// When something last happened in the thread, for ordering the list.
    private(set) var lastActivity: Date
    /// A thread on the host with nothing of it on the device yet: its history is on its
    /// way, and the screen shows that rather than the start of a new thread.
    var isLoadingHistory: Bool { state.isLoadingHistory }
    /// The turns before the first the thread holds of an ongoing conversation are being
    /// asked for (`loadEarlier`).
    private(set) var isLoadingEarlier = false
    /// This thread started it on the host (its first message created it there).
    @ObservationIgnored private(set) var startedHere = false

    /// Answers a request on the user's behalf, for unattended runs. Development only.
    @ObservationIgnored var autoAnswer: ((PendingRequest) -> RequestAnswer?)?
    /// Called when the thread has something worth saving: it was created, a turn
    /// ended, its title changed, it was brought in line with the host.
    @ObservationIgnored var onPersist: ((ThreadController) -> Void)?
    /// A local message (including a skill or retry) entered the conversation and its
    /// new activity was saved. Deferred submissions announce this when ready to deliver.
    @ObservationIgnored var onSend: ((ThreadController) -> Void)?
    /// A turn of the thread's ended (the host's, whoever began it).
    @ObservationIgnored var onTurnFinished: ((ThreadController) -> Void)?
    /// The turn ending, as the host's list numbers it, when the host named it with its end
    /// (`ThreadEvent.turnListed`, net-20), for `onTurnFinished`; nil from a host that does
    /// not, and once that has been told, so that a later turn's end that names none (one
    /// that ended while the connection was away, told by a snapshot) never takes it.
    @ObservationIgnored private(set) var endedTurn: Int?
    /// The host gave the thread a title (its agent's, or one given on another device).
    @ObservationIgnored var onTitleChanged: ((ThreadController) -> Void)?
    /// Called when the host stopped following the thread, so whoever shows it can
    /// have it reopened (`prepare`).
    @ObservationIgnored var onDetached: ((ThreadController) -> Void)?

    @ObservationIgnored private let backend: any AgentBackend
    @ObservationIgnored private let options: ThreadOptions
    /// Where a new thread works, chosen when it was opened, or the host's General folder;
    /// nil on a host whose agents do not work in folders, and for a thread opened from
    /// the list.
    private(set) var folder: Folder? {
        didSet {
            if thread == nil, oldValue?.path != folder?.path {
                draftKeyChanged(from: ComposerDrafts.key(thread: nil, agent: agent.id, folder: oldValue))
            }
        }
    }
    /// Where the app's copies of sent images go.
    @ObservationIgnored private let imageStore: ThreadStore
    @ObservationIgnored private let submissionStore: SubmissionStore
    /// The files sent lately, for "Try again": the Mac has them from the first time, and
    /// the app keeps no copies on disk.
    @ObservationIgnored private var sentFiles = SentFileBytes()
    /// The host takes files of any kind with a message (a bridge's `files`), as far as it
    /// has said (`checkHost`).
    private(set) var takesFiles = false
    /// The host reads a file on its Mac for the app (a bridge's `file_read`): an image a
    /// reply shows, a file a tool row names. As far as it has said (`checkHost`).
    private(set) var readsFiles = false
    /// The host searches a folder's files for the composer's `@` menu (a bridge's
    /// `file_search`), as far as it has said (`checkHost`).
    private(set) var searchesFiles = false
    /// The host takes the files a message mentions beside its text (a bridge's
    /// `file_mentions`), as far as it has said (`checkHost`).
    private(set) var takesFileMentions = false
    /// Message-level forks are offered only by a host that explicitly lists them.
    private(set) var offersMessageFork = false
    var canForkMessage: Bool { isAtRest && !isSending && !isLoadingHistory && !isClosed }
    /// Counts what was sent from here (a message, a command, a retry): the chat keeps to its
    /// end from each, to show what it becomes (`ChatScreen`).
    private(set) var sentHere = 0
    /// Shared models and personal-only commands. Project commands stay with this thread.
    let offerings: AgentOfferings
    private let threadCommands = ThreadCommandCatalog()
    var commands: CommandCatalog { threadCommands.catalog ?? offerings.commands }
    /// The host wants a yes before it switches to an expensive model.
    var modelConfirmation: ModelConfirmation?
    /// A command the host is running, for the line that says so.
    private(set) var commandInProgress: String?
    /// Something a command asks of the screen, which does it and clears this.
    var screenRequest: ScreenRequest?

    /// Reply text arrived within the last moment.
    private var replyIsArriving = false
    /// When reply text last arrived in the run going on: on a clock that only goes forward,
    /// as the time of day set back during a reply held it "arriving" until the old time came
    /// round, its status line and the chat's mood with it, its watch waking for nothing.
    @ObservationIgnored private var lastTextAt: ContinuousClock.Instant?
    @ObservationIgnored private var replyWatch: Task<Void, Never>?
    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    /// What a catch-up has replayed so far, held until it ends (`CatchUpHold`).
    @ObservationIgnored private var catchUp = CatchUpHold()
    /// Creating or reopening the thread, shared by everything that needs it.
    @ObservationIgnored private var connecting: Task<ThreadRef, any Error>?
    /// The last thing sent, on its way to the host. What is sent next waits for it, so
    /// that things reach the host in the order they were sent.
    @ObservationIgnored private var sending: Task<Void, Never>?
    /// Kept in memory until their independent disk writes finish, never published
    /// as durable references by another submission's persistence callback.
    @ObservationIgnored private var unstagedPayloads: [UUID: (images: [ImageAttachment], files: [FileAttachment])] = [:]
    /// Messages handed to `deliver` that the host has not answered for yet, nor failed.
    private var sendsInFlight = 0
    /// A message is on its way: the conversation is not an unsent draft, and is not to
    /// be discarded under a host that may be running it.
    var isSending: Bool { sendsInFlight > 0 }
    /// "Try again" was tapped and the thread is being brought in line with the host
    /// first.
    private var isRetrying = false
    /// The thread exists on the host but this connection does not follow it: a saved
    /// thread not reopened since launch, or one the backend detached.
    @ObservationIgnored private var needsOpening = false
    /// The backend detached the thread on the stream it follows, every event of which it
    /// has applied: a host that can replay what it missed since brings it up to date on
    /// that stream (`ThreadCatchingUp`), where opening it again sends it whole.
    @ObservationIgnored private var canCatchUp = false
    /// Closed for good (`close()`). It never opens the thread on the host again: a newer
    /// one may follow the thread there now, and reopening hands the host's events to a
    /// new stream and ends the one before, which would leave that newer one deaf (a Stop
    /// answered after the thread was let go reopens it, say).
    @ObservationIgnored private(set) var isClosed = false
    /// Calls to the host whose answer lands in this thread (a change of model, level or
    /// mode, an answer to a request, a Stop, a subagent or a queued message dealt with):
    /// the thread is not let go while one is out, or what it brings back would land in a
    /// copy no longer shown.
    @ObservationIgnored private var callsOut = 0

    /// - Parameters:
    ///   - existing: a thread that is already on the host; nil starts a new one.
    ///   - offerings: what the agent offers its threads, as far as it is known.
    ///   - cached: the saved copy of `existing`, shown until the host answers.
    ///   - context: how full the context was when the thread was last saved.
    ///   - lastActivity: when something last happened in it; now, for a new thread.
    ///   - folder: where a new thread works, for its intro to say.
    init(
        agent: Agent,
        backend: any AgentBackend,
        options: ThreadOptions = ThreadOptions(),
        folder: Folder? = nil,
        imageStore: ThreadStore = .standard,
        offerings: AgentOfferings = AgentOfferings(),
        existing: ThreadRef? = nil,
        cached: Transcript? = nil,
        context: ContextUsage? = nil,
        lastActivity: Date = .now,
        recovery: SavedConversation? = nil
    ) {
        localID = recovery?.id ?? UUID()
        savedConversation = recovery
        self.lastActivity = lastActivity
        self.agent = agent
        self.backend = backend
        self.options = options
        self.folder = folder
        self.imageStore = imageStore
        submissionStore = SubmissionStore(threads: imageStore)
        self.offerings = offerings
        if let existing {
            thread = existing
            state = ThreadState(transcript: cached ?? Transcript(), title: existing.title, context: context)
            needsOpening = true
            state.awaitHistory()
        }
        if let recovery {
            // The saved copy, then what never reached the host after it, where it was
            // sent; what the host accepted is the host's, and what waits on its list waits
            // here too until the host says what became of it.
            state.transcript = recovery.recoveredTranscript(onto: cached)
            state.pending += recovery.queuedOnHost(besides: state.transcript)
            if existing == nil, let bound = recovery.thread {
                thread = bound
                needsOpening = true
            }
        }
        if let model = options.model {
            state.model = ModelSetting(model: model.model, provider: model.provider, level: options.thinkingLevel)
        }
        composer.text = ComposerDrafts.shared.text(for: draftKey)
        closesCommandAnswers(with: commandAnswers)
        noteRunChanges()
    }

    /// Where its composer's words are kept (`ComposerDrafts.key`).
    private var draftKey: String {
        ComposerDrafts.key(thread: thread, agent: agent.id, folder: folder)
    }

    /// The thread was made on the host, or a new one learnt its folder: what is typed
    /// goes with it, so it is the thread's after a relaunch (a follow-up typed while the
    /// first message was on its way was left under the new thread's key, and came back
    /// in the next new thread instead). An empty composer takes what was kept there.
    private func draftKeyChanged(from old: String) {
        let new = draftKey
        guard new != old else { return }
        if composer.text.isEmpty {
            composer.text = ComposerDrafts.shared.text(for: new)
        } else {
            // Another new thread with the same agent and folder may have written there
            // since: its words stay.
            if ComposerDrafts.shared.text(for: old) == composer.text { ComposerDrafts.shared.set("", for: old) }
            ComposerDrafts.shared.set(composer.text, for: new)
        }
    }

    /// A session from the host's desk taken up only to read: it takes no messages.
    var isReadOnly: Bool { thread?.isReadOnly ?? false }

    var turns: [Turn] { state.transcript.turns }
    var isEmpty: Bool { state.transcript.isEmpty }
    /// Whether what the thread shows of a run is the host's as of now: it is followed
    /// there, or being reopened. One not reopened since launch, or detached, can still
    /// show a run that has ended since.
    var followsHost: Bool { !needsOpening || connecting != nil }
    var title: String? { state.title }

    /// A title the user gave the thread, kept with it from now on.
    func rename(to title: String) {
        state.title = title
        onPersist?(self)
    }

    func dismissCommand(_ id: UUID) {
        guard state.dismissCommand(id) else { return }
        onPersist?(self)
    }

    /// The title the list of a host that keeps it for every device gives the thread:
    /// shown, and neither saved nor sent, as it is the host's already.
    func titleListed(_ title: String?) {
        guard state.title != title else { return }
        state.title = title
    }

    /// How full the model's context is, as far as the host has said.
    var context: ContextUsage? { state.context }

    /// Offer a context action only when the host has listed the command (or its alias).
    var offersCompact: Bool {
        let name = commands.aliases["compact"] ?? "compact"
        return commands.commands.contains { $0.name == name }
            && commands.target(of: SlashInput(name: "compact")) == .host
    }

    var canCompact: Bool {
        !isAtWork && pendingRequest == nil && commandInProgress == nil && connecting == nil && !isRetrying
    }

    func compactContext() {
        guard offersCompact, canCompact else { return }
        send("/compact")
    }

    /// The agents this thread's agent set to work, when any of them is still at it, or
    /// when the host keeps them after they end (a bridge's `subagents`).
    var shownSubagents: [Subagent] {
        state.subagents.contains(where: { $0.isWorking || $0.isKept }) ? state.subagents : []
    }

    /// A new thread nothing was done with: it can be dropped without a trace.
    var isUnused: Bool { thread == nil && isEmpty && connecting == nil }
    /// Something is typed or attached in the composer, not sent: words other than spaces,
    /// an image or a file.
    var hasDraft: Bool {
        !composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !composer.images.isEmpty || !composer.files.isEmpty
    }

    /// Nothing in it is under way: no run, no question for the user, no agent it set to
    /// work still at it (they can outlast the turn), nothing on its way to the host or
    /// queued, not being reopened or tried again, no call to the host waiting on its
    /// answer (`callsOut`), and no attachment bytes owned only in memory. Such a
    /// thread, off screen, can be let go and opened from its saved copy (`OpenThreads`).
    /// A command it left running in the background does not hold it, as it does not
    /// keep it at work: let go of, the thread is opened whole when it is shown again, and
    /// the command's row comes back from the host's list (`subagent.list`) as it is then,
    /// its output so far and its Stop with it, and follows the command on from there.
    var isAtRest: Bool {
        thread != nil && !isAtWork && pendingRequest == nil && state.pending.isEmpty && state.queued.isEmpty
            && connecting == nil && !isRetrying && commandInProgress == nil && callsOut == 0 && unstagedPayloads.isEmpty
    }

    /// Whether "Try again" can be offered: not during a run, nor while something sent
    /// is still on its way.
    var canRetry: Bool { !isRunning && state.pending.isEmpty && !isRetrying }

    private func noteRunChanges() {
        if isRunning != state.isRunning { isRunning = state.isRunning }
        if isAtWork != state.isAtWork { isAtWork = state.isAtWork }
        let first = state.openRequests.first
        if pendingRequest != first { pendingRequest = first }
        if waitsOnlyOnUser != state.waitsOnlyOnUser { waitsOnlyOnUser = state.waitsOnlyOnUser }
    }

    /// What the agent is doing right now, for the line under the turn it is on. Nil at
    /// rest, and while the reply is being written.
    var runStatus: RunStatus? {
        state.runStatus(replyIsArriving: replyIsArriving, headlines: !DebugLaunch.statusHeadlineBefore)
    }

    /// The last thing said into the thread, on one line, for finding it in a list
    /// (`Transcript.preview`).
    var preview: String? { state.transcript.preview }

    /// The host described the agent anew: same agent, possibly another name.
    func agentChanged(_ agent: Agent) {
        guard agent.id == self.agent.id else { return }
        self.agent = agent
    }

    // MARK: Model

    /// A model the host asked about before switching to it.
    struct ModelConfirmation: Identifiable {
        let id = UUID()
        var message: String
        var model: String
        var provider: String
    }

    /// The model and thinking level this thread runs on, or will start on. Nil until
    /// the agent's models are known.
    var modelSetting: ModelSetting? {
        offerings.models?.setting(for: state.model)
    }

    /// How much the thread asks before acting, for an agent whose threads take a mode:
    /// as the host last said, as chosen for a thread not on the host yet, else the
    /// agent's own. nil for an agent without modes.
    var mode: ModeState? {
        guard let fallback = offerings.models?.defaultMode else { return nil }
        let current = state.mode ?? fallback
        return savedConversation?.pendingInitialMode.map { current.picking($0) } ?? current
    }

    /// Changes how much the thread asks before acting. The choice stays in the journal
    /// until confirmed, and every message waits for that confirmation.
    func pickMode(_ picked: ThreadMode) {
        guard !isClosed, let current = mode, current.mode != picked else { return }
        state.mode = current.picking(picked)
        guard isOnHost || savedConversation?.pendingInitialMode != nil else { return }
        if savedConversation == nil {
            savedConversation = SavedConversation(id: localID, agent: agent.id, options: creationOptions, folder: folder)
        }
        savedConversation?.pendingInitialMode = picked
        let saved = persistRecovery()
        onPersist?(self)
        guard saved else {
            say("This device could not save the mode choice. Free some space, then try again.", .warning)
            return
        }
        guard isOnHost else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                _ = try await currentThread()
            } catch {
                // The pending choice stays for retry; applying it reports its failure.
                AppLog.chat.error("Could not confirm mode: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// What to call a model in a line of the thread: the host's name for it, where it
    /// gives one ("Opus 5.5" for Claude Code's `default`).
    private func shortName(of setting: ModelSetting) -> String {
        offerings.models?.shortName(of: setting) ?? setting.shortName
    }

    /// Moves this thread to another model. A thread that is not on the host yet starts
    /// on it; one that is switches, from its next message on. A level chosen for the
    /// thread goes with it; otherwise the new model runs at its own.
    func pickModel(_ model: String, provider: String, confirmed: Bool = false) {
        guard isOnHost else {
            state.model = ModelSetting(model: model, provider: provider, level: state.model?.level)
            return
        }
        changeOnHost(orSay: "The model was not changed") { [self] host, thread in
            switch try await host.setModel(model, provider: provider, in: thread, confirmed: confirmed) {
            case let .needsConfirmation(message):
                modelConfirmation = ModelConfirmation(message: message, model: model, provider: provider)
                return nil
            case let .applied(note):
                // With the level chosen as it is now: it can have changed while the host was asked.
                let choice = ModelSetting(model: model, provider: provider, level: state.model?.level)
                state.model = choice
                return ["Model changed to \(shortName(of: choice)).", note].compactMap(\.self).joined(separator: " ")
            }
        }
    }

    /// Changes how hard the model thinks in this thread.
    func pickLevel(_ level: ThinkingLevel) {
        guard let current = modelSetting, current.level != level else { return }
        // Shown at once, so the slider stays where it was let go; taken back if the
        // host refuses.
        state.model = ModelSetting(model: current.model, provider: current.provider, level: level)
        guard isOnHost else { return }
        changeOnHost(orSay: "The thinking level was not changed") { [self] in
            // Only the level goes back, onto whatever the thread runs on by now.
            if state.model?.level == level { state.model?.level = current.level }
        } _: { [self] host, thread in
            try await host.setThinkingLevel(level, in: thread)
            // The host can have been heard from meanwhile, with the level from before.
            if let running = modelSetting {
                state.model = ModelSetting(model: running.model, provider: running.provider, level: level)
            }
            return "Thinking set to \(level.title)."
        }
    }

    /// Back to the agent's own model and thinking level.
    func resetModel() {
        guard let base = offerings.models?.agentDefault else { return }
        guard isOnHost else {
            state.model = nil
            return
        }
        changeOnHost(orSay: "The model was not changed") { [self] host, thread in
            _ = try await host.setModel(base.model, provider: base.provider, in: thread, confirmed: true)
            // The model is the agent's from here, whatever becomes of the level.
            state.model = ModelSetting(model: base.model, provider: base.provider, level: modelSetting?.level)
            if let level = base.level { try await host.setThinkingLevel(level, in: thread) }
            state.model = base
            return "Back to \(agent.displayName)'s own model, \(shortName(of: base))."
        }
    }

    /// Whether a choice is the host's to carry out: the thread is there, or on its way
    /// there with what was chosen before.
    private var isOnHost: Bool { thread != nil || connecting != nil }

    /// Makes a change to how the thread runs on the host, then says how it went:
    /// `change` returns the line to say, or nil for nothing. When it fails, `undo`
    /// takes back what was shown ahead of the host's answer, and `failure` opens the
    /// warning.
    private func changeOnHost(
        orSay failure: String,
        undo: @escaping () -> Void = {},
        _ change: @escaping (any ModelSelecting, ThreadRef.ID) async throws -> String?
    ) {
        guard let host = backend as? any ModelSelecting else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                let thread = try await currentThread()
                if let said = try await change(host, thread.id) { say(said) }
            } catch {
                undo()
                say("\(failure): \(error.localizedDescription)", .warning)
            }
        }
    }

    // MARK: Actions

    /// Reconnects the thread to the host, so it shows what the host has, follows a run
    /// that is going on there, and can be continued. Already-connected threads keep
    /// their scope's command catalog. New threads need no host yet.
    func prepare() {
        // Not again while what a catch-up brought is still on its way in (`catchUp`): the
        // host said everything already, and its end says the thread is followed again.
        if catchUp.isHolding { return }
        guard needsOpening else { return refreshCommands() }
        guard connecting == nil else { return }
        // Opened again (after a failure, or followed again after a reconnect) with still
        // nothing to show: its history is coming, until it is taken in or the thread is
        // caught up (`ThreadState.isLoadingHistory`).
        state.awaitHistory()
        Task {
            do {
                _ = try await currentThread()
            } catch {
                // The saved copy stays readable; sending will say what is wrong.
                state.historyNotComing()
                AppLog.chat.error("Could not reopen thread: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// The chat was scrolled up to the first turn it holds of an ongoing conversation with
    /// more before it (`ThreadState.hasEarlierHistory`): the turns before are asked for and
    /// put above it. Taken again whole when the host's conversation is not the one it took.
    ///
    /// `ready` is waited for before they are put in: the screen holds them while a finger
    /// is on the chat, whose drag would undo the move that keeps the place.
    func loadEarlier(when ready: @escaping @MainActor () async -> Void = {}) {
        guard state.hasEarlierHistory, !isLoadingEarlier, !needsOpening, connecting == nil, let thread,
              let host = backend as? any HistoryPaging else { return }
        isLoadingEarlier = true
        let first = state.transcript.turns.first?.id
        Task {
            defer { isLoadingEarlier = false }
            do {
                guard let earlier = try await host.earlierTurns(of: thread.id) else {
                    guard !isClosed else { return }
                    needsOpening = true
                    prepare()
                    return
                }
                await ready()
                // Opened again while they came or waited: what it holds begins elsewhere now.
                guard !isClosed, self.thread?.id == thread.id, state.transcript.turns.first?.id == first else { return }
                applyHeldPieces()
                state.takeEarlier(earlier)
                onPersist?(self)
            } catch is CancellationError {
                // Opened again meanwhile: what it holds now begins elsewhere.
            } catch {
                AppLog.chat.error("Could not read the earlier turns of thread \(thread.id.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// What a message sent while the agent works does, as Settings has it: handed to the
    /// running turn (the default), or kept for a turn of its own.
    static var whenBusy: WhenBusy {
        UserDefaults.standard.string(forKey: WhenBusy.settingKey).flatMap(WhenBusy.init(rawValue:)) ?? .steer
    }

    /// Asks the host what it takes, once it is connected: files of any kind, or images only.
    func checkHost() async {
        offersMessageFork = await (backend as? any MessageForking)?.offersMessageFork ?? false
        takesFiles = await (backend as? any FileAttaching)?.attachesFiles ?? false
        readsFiles = await (backend as? any FileReading)?.readsFiles ?? false
        searchesFiles = await (backend as? any FileSearching)?.searchesFiles ?? false
        takesFileMentions = await (backend as? any FileSearching)?.takesFileMentions ?? false
    }

    func refreshMCPAuth(invalidated: Bool = false) {
        guard !isClosed, agent.kind == "droid", let thread, !thread.isReadOnly,
              let host = backend as? any MCPAuthenticating else { return }
        Task {
            guard !isClosed else { return }
            await mcpAuth.refresh(from: host, thread: thread, agent: agent, invalidated: invalidated)
        }
    }

    func signIn(_ action: MCPAuthAction, server: String) {
        guard !isClosed, let thread, let host = backend as? any MCPAuthenticating else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            guard !isClosed else { return }
            await mcpAuth.perform(action, server: server, from: host, thread: thread, agent: agent)
        }
    }

    /// Where the composer's `@` menu searches: the thread's folder once the thread is on
    /// the host, before that the folder chosen for it (the new-thread screen). nil on a host
    /// that does not search files, and for a new thread in no folder.
    var mentionScope: FileSearchScope? {
        guard searchesFiles else { return nil }
        if let thread { return .thread(thread.id) }
        return folder.map { .folder($0.path) }
    }

    /// The host's best files and folders for what is typed after an `@` (`FileSearching`).
    /// A folder is searched for the agent the new thread will run, whose note on a large
    /// file the answer then has. Throws `FileSearchError`.
    func searchFiles(_ query: String, in scope: FileSearchScope, limit: Int) async throws -> FileSearchResults {
        guard let host = backend as? any FileSearching else { throw FileSearchError.unavailable }
        let agent: String? = if case .folder = scope { self.agent.id.name } else { nil }
        return try await host.searchFiles(query, in: scope, limit: limit, agent: agent)
    }

    /// Where this thread's files are kept apart from other threads' on this device: the
    /// host and the thread. nil before the thread is on the host.
    var fileScope: String? {
        thread.map { "\(backend.host.rawValue)/\($0.id.rawValue)" }
    }

    /// The host's side of the panel beside the chat (`ThreadPanelProviding`): nil from a
    /// host without it.
    var panelHost: (any ThreadPanelProviding)? {
        backend as? any ThreadPanelProviding
    }

    /// Reads a file on the host's Mac for this thread (`FileReading`). Throws
    /// `FileReadError`.
    func readFile(_ path: String, purpose: FilePurpose, unless: String? = nil) async throws -> HostFile {
        guard let thread, let host = backend as? any FileReading else { throw FileReadError.unavailable }
        return try await host.readFile(path, in: thread.id, purpose: purpose, unless: unless)
    }

    /// Sends `text`, with any images and files, and beside it the files it mentions
    /// (`mentions`, written in it as `@path`) to a host that takes them. During a run it
    /// steers the run or waits for a turn of its own, as Settings says and the agent can
    /// (`WhenBusy`). A slash command is carried out instead of being said.
    func send(_ text: String, images: [ImageAttachment] = [], files: [FileAttachment] = [], mentions: [String] = []) {
        submit(text, images: images, files: files, mentions: mentions, announced: false)
    }

    /// `send`'s work; `announced`, for a send that is not you sending just now (a retry's
    /// own, once the thread is in line), which `sentHere` has counted already.
    private func submit(_ text: String, images: [ImageAttachment], files: [FileAttachment], mentions: [String] = [], announced: Bool) {
        let message = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ChatFeature.messageLimit))
        guard !message.isEmpty || !images.isEmpty || !files.isEmpty else { return }
        if !announced { sentHere += 1 }
        // Images and files go to the agent, so words sent with them are a message
        // whatever they start with.
        if images.isEmpty, files.isEmpty, let command = SlashInput(message) {
            run(command)
            return
        }
        deliver(message, images: images, files: files, mentions: mentions)
    }

    /// Sends `text` to the agent. `shownAs` is what the transcript shows in its place
    /// when the text is not written for the reader: a skill's instructions, shown as
    /// the command that asked for them, which is also what the host's history shows.
    private func deliver(
        _ text: String, images: [ImageAttachment] = [], files: [FileAttachment] = [], mentions: [String] = [], shownAs: String? = nil,
        restaging: UUID? = nil
    ) {
        defer { onSend?(self) }
        // The transcript shows the app's own copies: the host's history only names
        // the images it was sent.
        images.forEach { imageStore.saveImage($0.data, id: $0.id) }
        sentFiles.keep(files)
        // Shown at once. A saved thread that is not in step with the host yet holds
        // the message where it can be seen until it is: reopening can replace the
        // transcript, and must not take a turn opened now with it.
        applyHeldPieces()
        let item = state.messageSent(shownAs ?? text, images: images.map(\.reference), files: files.map(\.reference), held: needsOpening)
        if !images.isEmpty || !files.isEmpty { unstagedPayloads[item] = (images, files) }
        lastActivity = .now
        var conversation = savedConversation ?? SavedConversation(id: localID, agent: agent.id, options: creationOptions, folder: folder)
        if thread == nil, conversation.pendingInitialMode == nil {
            conversation.pendingInitialMode = state.mode?.mode
        }
        conversation.thread = thread
        var submission = SavedSubmission(id: item, text: text,
            message: UserMessage(text: shownAs ?? text, sentAt: lastActivity, images: images.map(\.reference), files: files.map(\.reference)))
        // Once this attempt is accepted, the one it sends again is settled.
        submission.retries = restaging
        if !mentions.isEmpty { submission.mentions = mentions }
        SentMentionsMemory.shared.sent.sent(mentions, as: item)
        conversation.submissions.append(submission)
        savedConversation = conversation
        guard persistRecovery() else {
            state.messageFailed(item, TurnFailure(message: "This device could not save the message. Free some space, then try again."))
            onPersist?(self)
            return
        }
        // On its way from here until the host answers or it fails (`isSending`).
        sendsInFlight += 1
        // Retain even a conversation whose first create call never returns a ref.
        onPersist?(self)
        let chosen = Self.whenBusy
        let earlier = sending
        // Disk work is independent of earlier network calls, which may be held
        // for minutes. Only the network submissions retain their original order.
        let payloads = Task {
            try await submissionStore.savePayloadsInBackground(images: images, files: files, in: localID)
            guard !isClosed else { throw CancellationError() }
            unstagedPayloads[item] = nil
            if let restaging { unstagedPayloads[restaging] = nil }
            guard persistRecovery() else { throw CocoaError(.fileWriteUnknown) }
            onPersist?(self)
        }
        sending = Task {
            let staged = await payloads.result
            // Even a failed staging task remains a link in the network ordering
            // chain. A later send cannot pass an earlier upload still in flight.
            await earlier?.value
            do {
                try staged.get()
                guard !isClosed else { throw CancellationError() }
                let thread = try await currentThread()
                guard persistRecovery() else { throw CocoaError(.fileWriteUnknown) }
                // Queue is the setting's only where the host keeps what waits: elsewhere
                // the message steers, as it always did.
                let whenBusy = chosen.on(hostListingQueue: await (backend as? any QueueControlling)?.listsQueue)
                // A message sent while the agent waits on you tells it to do something
                // else: what it asked is declined (an approval) or dropped (a question)
                // first, so the run is free to follow the message. One that is to wait
                // for a turn of its own leaves the question open, and so does any
                // message for what a subagent at work by itself asked.
                if whenBusy == .steer || !state.isRunning {
                    for request in state.openRequests where !request.outlivesTurn {
                        // Each after what was held meanwhile: the answer before it was awaited.
                        applyHeldPieces()
                        state.requestAnswered(request.id, with: .cancelled)
                        try? await backend.respond(to: request.id, in: thread.id, with: .cancelled)
                    }
                }
                // A choice made while the queue was checked or a request declined
                // must be confirmed too, before this message reaches the agent.
                _ = try await currentThread()
                // Under the thread's id for it, which the host's word that it took it names.
                let receipt: SendReceipt
                // Beside the text only to a host that takes them; the text names them anyway.
                let beside = FileMentionDraft.mentions(picked: mentions, in: text, hostTakesThem: takesFileMentions)
                if !beside.isEmpty, let host = backend as? any FileMentionSending {
                    receipt = try await host.send(text, images: images, files: files, mentions: beside, whenBusy: whenBusy, messageID: item, to: thread.id)
                    SentMentionsMemory.shared.sent.answered(receipt.largeMentions, for: item)
                } else {
                    receipt = try await backend.send(text, images: images, files: files, whenBusy: whenBusy, messageID: item, to: thread.id)
                }
                applyHeldPieces()
                state.messageDelivered(item, outcome: receipt.outcome, queueID: receipt.queueID)
                if let index = savedConversation?.submissions.firstIndex(where: { $0.id == item }) {
                    savedConversation?.submissions[index].accepted = true
                    savedConversation?.submissions[index].queueID = receipt.queueID
                }
            } catch {
                AppLog.chat.error("Send failed: \(String(describing: error), privacy: .public)")
                applyHeldPieces()
                let failure = TurnFailure(message: error.localizedDescription)
                state.messageFailed(item, failure)
                if let index = savedConversation?.submissions.firstIndex(where: { $0.id == item }) {
                    savedConversation?.submissions[index].failure = failure
                }
            }
            // Answered for either way, before it is saved as such.
            sendsInFlight -= 1
            onPersist?(self)
        }
    }

    /// Small journal writes are synchronous; attachment bytes go off the main actor
    /// before the RPC. A failure leaves the in-memory recovery entry owned by the host.
    @discardableResult
    func persistRecovery() -> Bool {
        // Closed: discarded, deleted or let go, and whoever did that owns the journal now.
        guard !isClosed else { return false }
        guard var conversation = savedConversation else { return true }
        conversation.thread = thread
        // A bound conversation already has its normal transcript cache. Its
        // journal keeps only outgoing payloads, not another copy of a long chat.
        conversation.transcript = thread == nil ? persistableTranscript : Transcript()
        conversation.updatedAt = lastActivity
        savedConversation = conversation
        do {
            try submissionStore.save(withDurablePayloads(conversation))
            return true
        } catch {
            return false
        }
    }

    /// A cache must not name bytes that are still being staged, even when another
    /// attempt or a host event asks the owner to persist the whole conversation.
    var persistableTranscript: Transcript {
        guard !unstagedPayloads.isEmpty else { return state.transcript }
        var transcript = state.transcript
        transcript.turns = transcript.turns.compactMap { turn in
            var saved = turn
            saved.items.removeAll { unstagedPayloads[$0.id] != nil }
            return saved.items.isEmpty && !turn.items.isEmpty ? nil : saved
        }
        return transcript
    }

    private func withDurablePayloads(_ conversation: SavedConversation) -> SavedConversation {
        var durable = conversation
        durable.submissions.removeAll { unstagedPayloads[$0.id] != nil }
        return durable
    }

    /// Delete the journal only after both the host receipt and the normal local
    /// transcript/list are durable. What still waits on the host's list, and what the
    /// thread still offers to try again, keep their payloads (`SavedConversation.unsettled`).
    func finishRecoveryAfterSaving() {
        guard var conversation = savedConversation else { return }
        conversation.submissions = conversation.unsettled(shows: state.transcript, waiting: state.pending, staging: Set(unstagedPayloads.keys))
        do {
            if conversation.submissions.isEmpty, conversation.pendingInitialMode == nil {
                try submissionStore.remove(localID)
                savedConversation = nil
            } else {
                try submissionStore.save(withDurablePayloads(conversation))
                savedConversation = conversation
                try? submissionStore.removeUnusedPayloads(in: conversation)
            }
        } catch { /* The retained journal is safe to reconcile at the next open. */ }
    }

    // MARK: Commands

    /// Something a command asks of the screen.
    enum ScreenRequest: Equatable {
        case newThread
        /// Show the model picker.
        case showModels
        /// Put this in the composer, ready to edit.
        case draft(String)
        /// Put this in the composer when nothing is written there yet: words given back,
        /// which must not take the place of others being written.
        case restore(String)
        /// Put the cursor in the composer: a new tab, from + or ⌘T, is typed in at once,
        /// as a browser's new tab is.
        case focusComposer
    }

    private func run(_ command: SlashInput) {
        switch commands.target(of: command) {
        case let .app(own): perform(own, command)
        case let .unavailable(why): commandFailed(command, why)
        case .host: runOnHost(command)
        }
    }

    /// A command that did not run, said where its answer would have been.
    private func commandFailed(_ command: SlashInput, _ reason: String) {
        applyHeldPieces()
        state.commandFailed(command.text, reason: reason)
        if thread != nil { onPersist?(self) }
    }

    /// A line of the app's own in the transcript.
    private func say(_ text: String, _ level: Notice.Level = .info) {
        applyHeldPieces()
        state.apply(.notice(Notice(level, text)))
        if thread != nil { onPersist?(self) }
    }

    private func perform(_ own: AppCommand, _ command: SlashInput) {
        switch own {
        case .new:
            // An agent's one ongoing conversation is never left for a new one: it is
            // compacted in place, as Hermes Desktop does with it.
            if thread?.isOngoing == true { return runOnHost(SlashInput(name: "compress")) }
            screenRequest = .newThread
        case .stop:
            if isRunning { stop() } else { say("Nothing is running.") }
        case .retry:
            guard !isRunning else { return say("The agent is still working. Stop it first, or wait.") }
            guard let turn = turns.last(where: { $0.items.contains(where: \.isUserMessage) }) else {
                return say("There is no message to send again.")
            }
            retry(turn.id, evenIfAnswered: true)
        case .model:
            pickModel(named: command.argument)
        case .reasoning:
            pickLevel(named: command.argument)
        case .help:
            // The menu is the list of commands.
            screenRequest = .draft("/")
        }
    }

    /// "/model": switches to the one model the name stands for, or shows the picker.
    private func pickModel(named name: String) {
        guard let models = offerings.models else { return say("The host has not listed this agent's models yet.") }
        if let match = models.model(named: name, preferring: modelSetting?.provider) {
            pickModel(match.model, provider: match.provider)
        } else {
            screenRequest = .showModels
        }
    }

    /// "/reasoning": sets the level the word stands for, or shows the picker.
    private func pickLevel(named name: String) {
        guard offerings.models != nil else { return say("The host has not listed this agent's models yet.") }
        if let level = ThinkingLevel(named: name) {
            pickLevel(level)
        } else {
            screenRequest = .showModels
        }
    }

    /// Has the host run a command. Its answer is text for the transcript, a message
    /// for the agent (a skill), or something to put in the composer.
    private func runOnHost(_ command: SlashInput) {
        guard let host = backend as? any CommandRunning else { return commandFailed(command, "This host does not take commands.") }
        commandInProgress = command.text
        Task {
            do {
                let thread = try await currentThread()
                let outcome = try await host.runCommand(command, in: thread.id)
                commandEnded(command)
                switch outcome {
                case let .output(text):
                    applyHeldPieces()
                    state.commandAnswered(command.text, output: text)
                    onPersist?(self)
                case let .message(message, shownAs, note):
                    if let note { say(note) }
                    deliver(message, shownAs: shownAs)
                case let .draft(text, note):
                    if let note { say(note) }
                    screenRequest = .draft(text)
                }
            } catch {
                commandEnded(command)
                AppLog.chat.error("Command failed: \(String(describing: error), privacy: .public)")
                commandFailed(command, error.localizedDescription)
            }
        }
    }

    /// The host answered a command, or failed to: the line that says it is running goes.
    private func commandEnded(_ command: SlashInput) {
        if commandInProgress == command.text { commandInProgress = nil }
    }

    /// Answers an approval or a question. The answer shows in the transcript at once.
    func answer(_ request: PendingRequest, with answer: RequestAnswer) {
        guard !isClosed, thread != nil, state.openRequests.contains(where: { $0.id == request.id }) else { return }
        if case let .option(id, editedPlan, _) = answer, request.offeredOption(id, editedPlan: editedPlan) == nil { return }
        applyHeldPieces()
        state.requestAnswered(request.id, with: answer)
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                // An answer can resume the agent, or become its next message.
                let thread = try await currentThread()
                try await backend.respond(to: request.id, in: thread.id, with: answer)
            } catch {
                AppLog.chat.error("Answer not delivered: \(String(describing: error), privacy: .public)")
                // Not sent: the card is open again, for what the host says once the device
                // is back. One the backend no longer holds was settled already.
                if (error as? AgentBackendError) != .unknownRequest { state.answerNotSent(request) }
                say("Your answer did not reach the agent: \(error.localizedDescription)", .warning)
            }
        }
    }

    /// Stops the run in progress.
    func stop() {
        guard let thread, isRunning else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            // The host says it stopped nothing: the run may have ended while the app
            // was not listening, so what is shown is brought in line with the host.
            if (try? await backend.interrupt(thread.id)) != true, connecting == nil {
                needsOpening = true
                // What is shown is not the host's: it is taken whole.
                canCatchUp = false
                _ = try? await currentThread()
            }
        }
    }

    /// Asks again after a failed or stopped turn, as a new turn. `evenIfAnswered` is
    /// for asking again on purpose ("/retry"), whatever became of the turn.
    func retry(_ turnID: UUID, evenIfAnswered: Bool = false) {
        guard canRetry else { return }
        // You asking again, now: what it sends, maybe once the thread is in line, is not
        // counted again (a scroll up meanwhile is yours to keep).
        sentHere += 1
        guard needsOpening else { return resend(turnID, evenIfAnswered: evenIfAnswered) }
        // The copy on screen may be behind the host, where the turn may have been
        // answered since. It is brought in line first; one tap is enough for that.
        isRetrying = true
        Task {
            _ = try? await currentThread()
            isRetrying = false
            if canRetry { resend(turnID, evenIfAnswered: evenIfAnswered) }
        }
    }

    private func resend(_ turnID: UUID, evenIfAnswered: Bool) {
        guard let turn = turns.first(where: { $0.id == turnID }), evenIfAnswered || turn.outcome != .completed else { return }
        let askedItem = turn.items.first { item in
            if case .user = item.content { true } else { false }
        }
        guard let askedItem, case let .user(asked) = askedItem.content else { return }
        let original = savedConversation?.submissions.first { submission in
            turn.items.contains { $0.id == submission.id }
        }
        // The files it mentioned beside its text: kept with it until the host took it, and
        // after that while the app runs.
        let mentions = original?.mentions ?? SentMentionsMemory.shared.sent.paths(of: askedItem.id)
        // A command's turn (a skill's, shown as the command that asked for it) whose own
        // words this device no longer keeps: the command runs again, as it was asked
        // for. Its name sent as a message would be another message.
        if original == nil, asked.images.isEmpty, asked.files.isEmpty, SlashInput(asked.text) != nil {
            return submit(asked.text, images: [], files: [], announced: true)
        }
        // What this device holds in memory goes at once: bytes still being written to
        // the journal, and the files sent lately (`SentFileBytes`).
        var images: [UUID: ImageAttachment] = [:], files: [UUID: FileAttachment] = [:]
        for staged in unstagedPayloads.values {
            for image in staged.images { images[image.id] = image }
            for file in staged.files { files[file.id] = file }
        }
        for file in asked.files where files[file.id] == nil {
            // Under its own id: a Mac that has it waiting already from a send that failed half way does not take it twice.
            if let data = sentFiles.data(for: file.id) { files[file.id] = FileAttachment(id: file.id, data: data, filename: file.filename) }
        }
        let unread = (images: asked.images.filter { images[$0.id] == nil }, files: asked.files.filter { files[$0.id] == nil })
        guard !unread.images.isEmpty || !unread.files.isEmpty else {
            return resend(asked, original: original, mentions: mentions, images: images, files: files)
        }
        // The rest from disk, off the main thread: the images from the copies kept when
        // they were first sent, the files from the journal. Not tried again meanwhile.
        isRetrying = true
        let held = (images: images, files: files)
        Task {
            let read = await submissionStore.attachmentsInBackground(
                images: unread.images, files: unread.files, in: localID, copies: imageStore
            )
            isRetrying = false
            guard !isClosed, canRetry else { return }
            var images = held.images, files = held.files
            for image in read.images { images[image.id] = image }
            for file in read.files { files[file.id] = file }
            resend(asked, original: original, mentions: mentions, images: images, files: files)
        }
    }

    /// Sends again what `asked` carried, with the bytes found for it, by id.
    private func resend(
        _ asked: UserMessage, original: SavedSubmission?, mentions: [String], images: [UUID: ImageAttachment], files: [UUID: FileAttachment]
    ) {
        let carried = (images: asked.images.compactMap { images[$0.id] }, files: asked.files.compactMap { files[$0.id] })
        // Never without some of what it carried: that would be another message, or a
        // command when its words look like one. It goes back to the composer instead.
        guard carried.images.count == asked.images.count, carried.files.count == asked.files.count else {
            say("This device no longer has what was attached to that message. Attach it again, then send.", .warning)
            screenRequest = .restore(asked.text)
            return
        }
        // A retry is a message, not a freshly interpreted slash command.
        deliver(
            original?.text ?? asked.text, images: carried.images, files: carried.files, mentions: mentions, shownAs: asked.text,
            restaging: original?.id
        )
    }

    // MARK: Subagents

    /// Stops one subagent or workflow by itself; the turn and the others go on. The host's
    /// news of it says when it has stopped.
    func stopSubagent(_ id: Subagent.ID) {
        guard let thread, let host = backend as? any SubagentStopping else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                if try await !host.stopSubagent(id, in: thread.id) {
                    say("It had already ended.")
                }
            } catch {
                say("It was not stopped: \(error.localizedDescription)", .warning)
            }
        }
    }

    // MARK: Messages waiting

    func placeQueued(_ id: String, at placement: WhenBusy) {
        guard thread != nil, let host = backend as? any QueueControlling,
              state.queued.contains(where: { $0.id == id && $0.placement != nil }) else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                let thread = try await currentThread()
                if try await host.placeQueued(id, at: placement, in: thread.id) == .queued {
                    say("The message is still waiting in the queue.")
                }
            } catch {
                say("The message was not moved: \(error.localizedDescription)", .warning)
            }
        }
    }

    /// Takes a message waiting for the running turn off the host's list: it is never sent.
    func removeQueued(_ id: String) {
        guard let thread, let host = backend as? any QueueControlling else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                _ = try await host.removeQueued(id, in: thread.id)
            } catch {
                say("The message was not removed: \(error.localizedDescription)", .warning)
            }
        }
    }

    /// Hands a waiting message to the running turn now. The host says so to every device
    /// when it has; when the agent cannot take it in now, it waits on.
    func steerQueued(_ id: String) {
        guard thread != nil, let host = backend as? any QueueControlling else { return }
        callsOut += 1
        Task {
            defer { callsOut -= 1 }
            do {
                let thread = try await currentThread()
                if try await host.steerQueued(id, in: thread.id) == .queued {
                    say("\(agent.displayName) cannot take a message in right now. It stays queued.")
                }
            } catch {
                say("The message was not sent now: \(error.localizedDescription)", .warning)
            }
        }
    }

    /// Stops listening, for good: the thread stays on the host, and nothing still in
    /// flight for it is saved once it has been closed.
    func close() {
        isClosed = true
        mcpAuth.clear()
        threadCommands.cancel()
        eventsTask?.cancel()
        eventsTask = nil
        connecting?.cancel()
        connecting = nil
        sending?.cancel()
        sending = nil
        onPersist = nil
        onSend = nil
        onDetached = nil
        onTitleChanged = nil
    }

    // MARK: Internals

    /// The thread on the host, created or reopened if it is not connected yet.
    private func currentThread() async throws -> ThreadRef {
        while true {
            guard !isClosed else { throw CancellationError() }
            let task: Task<ThreadRef, Error>
            if let connecting {
                task = connecting
            } else {
                if let thread, !needsOpening, savedConversation?.pendingInitialMode == nil { return thread }
                // Commands can create a thread too, without going through deliver's journal.
                if thread == nil, savedConversation?.pendingInitialMode == nil, let chosen = state.mode?.mode {
                    if savedConversation == nil {
                        savedConversation = SavedConversation(id: localID, agent: agent.id, options: creationOptions, folder: folder)
                    }
                    savedConversation?.pendingInitialMode = chosen
                    guard persistRecovery() else { throw CocoaError(.fileWriteUnknown) }
                }
                task = Task {
                    // No waiter can mistake a completed task for a newer choice's barrier.
                    defer { connecting = nil }
                    let current: ThreadRef
                    if let thread, !needsOpening { current = thread } else { current = try await connect() }
                    try await applyPendingMode(to: current)
                    return current
                }
                connecting = task
            }
            let current = try await task.value
            guard !isClosed else { throw CancellationError() }
            // Another choice can arrive after the shared task ends, before a waiter resumes.
            if savedConversation?.pendingInitialMode == nil { return current }
        }
    }

    /// No message outruns a mode chosen for the thread. Changes share the connection
    /// task, and the latest intent is cleared only after confirmation.
    private func applyPendingMode(to thread: ThreadRef) async throws {
        while let chosen = savedConversation?.pendingInitialMode {
            guard !isClosed else { throw CancellationError() }
            do {
                guard let host = backend as? any ModeSelecting else { throw ModeError.unavailable }
                let applied = try await host.setMode(chosen, in: thread.id)
                guard !isClosed else { throw CancellationError() }
                state.mode = applied
                if savedConversation?.pendingInitialMode == chosen {
                    guard applied.mode == chosen else { throw ModeError.notConfirmed }
                    savedConversation?.pendingInitialMode = nil
                }
                guard persistRecovery() else { throw CocoaError(.fileWriteUnknown) }
                onPersist?(self)
            } catch {
                say("The mode was not changed. Your message was not sent: \(error.localizedDescription)", .warning)
                throw error
            }
        }
    }

    private func connect() async throws -> ThreadRef {
        if let existing = thread {
            let snapshot: ThreadSnapshot
            if canCatchUp, let host = backend as? any ThreadCatchingUp {
                // Only what it missed, on the stream it follows, when the host can. Held
                // until its end (`.caughtUp`), and taken in all at once then.
                catchUp.begin()
                let caughtUp: ThreadSnapshot?
                do {
                    caughtUp = try await host.catchUp(existing)
                } catch {
                    takeIn(catchUp.end(), from: existing)
                    throw error
                }
                guard let whole = caughtUp else {
                    // Followed again: the stream says so after what it missed (`.caughtUp`), so
                    // that a detach after it is not overtaken.
                    guard !isClosed else { throw CancellationError() }
                    AppLog.chat.notice("Caught up on thread \(existing.id.rawValue, privacy: .public)")
                    return thread ?? existing
                }
                snapshot = whole
            } else {
                // The host's version is taken first, then what happens after it: the
                // events that follow the snapshot are on a new stream.
                let asking = ContinuousClock.now
                snapshot = try await backend.openThread(existing)
                OpenProbe.step(existing.id.rawValue, "fetched", took: .now - asking)
            }
            // Closed meanwhile: whoever follows the thread now has its own stream.
            guard !isClosed else { throw CancellationError() }
            canCatchUp = false
            let adopting = ContinuousClock.now
            state.adopt(snapshot)
            OpenProbe.step(existing.id.rawValue, "adopted", took: .now - adopting)
            folderReported(snapshot.workingDirectory)
            AppLog.chat.notice("Reopened thread \(existing.id.rawValue, privacy: .public), running: \(self.state.isRunning)")
            needsOpening = false
            follow(existing)
            onPersist?(self)
            state.openRequests.forEach(autoAnswerIfAsked)
            return thread ?? existing
        }
        // A model or thinking level chosen for the new thread goes with its creation,
        // unless it is what the agent uses anyway.
        let options = creationOptions
        let created = try await backend.createThread(with: agent.id, options: options)
        guard !isClosed else { throw CancellationError() }
        thread = created
        startedHere = true
        needsOpening = true
        // Save the real ref before any upload/send. A crash cannot turn this
        // conversation back into a new host session on manual recovery.
        guard persistRecovery() else { throw CocoaError(.fileWriteUnknown) }
        needsOpening = false
        follow(created)
        if created.isOngoing {
            // The agent's one ongoing conversation, which may hold what was said before:
            // the creation brings none of it.
            do {
                let snapshot = try await backend.openThread(created)
                guard !isClosed else { throw CancellationError() }
                state.adopt(snapshot)
                follow(created)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                AppLog.chat.error("Could not read the conversation of thread \(created.id.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
            }
        }
        onPersist?(self)
        return created
    }

    private var creationOptions: ThreadOptions {
        var options = options
        if let chosen = state.model {
            let models = offerings.models
            let isAgents = models?.isAgentModel(chosen) ?? false
            options.model = isAgents ? nil : ModelOverride(model: chosen.model, provider: chosen.provider)
            options.thinkingLevel = chosen.level == models?.agentDefault.level ? nil : chosen.level
        }
        return options
    }

    private func follow(_ thread: ThreadRef) {
        refreshMCPAuth()
        eventsTask?.cancel()
        // A new stream: what the one before held is older than what this one starts with.
        _ = catchUp.end()
        eventsTask = Task { [weak self] in
            guard let events = await self?.backend.events(for: thread.id) else { return }
            for await event in events {
                // Cancelled when the thread is reopened: what is left of the old
                // stream is from before the snapshot.
                guard let self, !Task.isCancelled else { return }
                switch event {
                case .mcpAuthCleared:
                    mcpAuth.clear()
                    continue
                case .mcpAuthChanged:
                    refreshMCPAuth(invalidated: true)
                    continue
                default:
                    break
                }
                // What a catch-up replays is taken in at its end, all at once
                // (`CatchUpHold`): the screen never shows it half done, a turn that ended
                // while the app was away seen running for a frame or two, its thread in
                // Running. Then, while no window can be seen, a reply's pieces are held
                // too (`admit`).
                takeIn(catchUp.take(event), from: thread)
            }
        }
        // Pieces the stream before held are older than what this one starts with.
        held = HeldPieces()
        refreshCommands()
    }

    private func refreshCommands() {
        guard let thread, let host = backend as? any CommandRunning, !isClosed else { return }
        threadCommands.refresh(for: thread, using: host)
    }

    /// Pieces of a reply held while no window of the app can be seen, or while this
    /// thread's chat is kept built off screen (`isKeptOffScreen`), with a run's steps then.
    @ObservationIgnored private var held = HeldPieces()
    /// The thread's chat is kept built while another is on screen (`Fleet.keptChats`): a
    /// reply's pieces are held, as while no window can be seen, and while it runs its
    /// steps too (`ThreadEvent.isStepOfRun`), so that a chat nobody sees is not worked out
    /// again with every word and every tool call; they are applied as it is shown again,
    /// before it is drawn, or before anything else the thread hears (its turn's end, a
    /// question). Set by `Fleet`.
    @ObservationIgnored var isKeptOffScreen = false {
        didSet {
            guard oldValue, !isKeptOffScreen, !held.isEmpty else { return }
            apply(held.release())
            pacer.applied(at: .now)
            caughtUpAt = .now
        }
    }
    /// When the pieces held while the chat was kept off screen were applied, as it was
    /// shown again: the reply they make shows at once, as it would in a chat built anew,
    /// rather than playing in (`ReplyTextView`).
    private(set) var caughtUpAt: Date?
    /// Whether pieces are held now: no window can be seen, or the chat is kept off screen.
    private var holdsPieces: Bool {
        isKeptOffScreen || WindowVisibility.shared.isHidden
    }
    /// Whether the held pieces are to be applied once a window can be seen.
    @ObservationIgnored private var appliesHeldPiecesWhenSeen = false

    /// The pieces of a reply on screen change the transcript at most ten times a second
    /// (`PiecePacer`): each change works the whole chat screen out again.
    @ObservationIgnored private var pacer = PiecePacer(interval: ChatFeature.pieceInterval)
    /// Applies the pieces the pacer held, once they are due.
    @ObservationIgnored private var pacedPieces: Task<Void, Never>?

    /// While no window of the app can be seen, the pieces of a reply are held, and applied
    /// together once one can (`HeldPieces`); while one can, a piece that comes soon after
    /// the last change waits for the next (`PiecePacer`): nil for one held. Anything else
    /// comes after the pieces held before it, applied here as one change.
    private func admit(_ event: ThreadEvent) -> ThreadEvent? {
        let at = Date.now
        let isHidden = WindowVisibility.shared.isHidden
        // Its chat kept out of sight, a run's steps are held too: they only add to what the
        // chat shows (`ThreadEvent.isStepOfRun`), each of them laid it out again.
        var now = held.events(for: event, at: at, holding: holdsPieces || pacer.holds(at: at),
                              holdingSteps: isKeptOffScreen && state.isRunning)
        guard let last = now.popLast() else {
            if case .textDelta = event {
                lastTextAt = .now
                replyTextArrived()
            }
            if isKeptOffScreen {
                // Applied as the chat is shown again (`isKeptOffScreen`).
            } else if isHidden {
                applyHeldPiecesWhenSeen()
            } else {
                applyPacedPieces(after: pacer.due(after: at))
            }
            return nil
        }
        apply(now)
        pacer.applied(at: at)
        return last.event
    }

    /// Applies the pieces held by the pacer `delay` from now, as one change; once only,
    /// however many come meanwhile. Still held if no window can be seen by then.
    private func applyPacedPieces(after delay: TimeInterval) {
        guard pacedPieces == nil else { return }
        pacedPieces = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self else { return }
            pacedPieces = nil
            guard !held.isEmpty, !isKeptOffScreen else { return }
            if WindowVisibility.shared.isHidden {
                applyHeldPiecesWhenSeen()
            } else {
                apply(held.release())
                pacer.applied(at: .now)
            }
        }
    }

    /// Applies the pieces held, each at the time it came, as one change of `state`: the
    /// transcript changes once for all of them.
    private func apply(_ pieces: [HeldPieces.Piece]) {
        guard !pieces.isEmpty else { return }
        var next = state
        next.apply(pieces)
        state = next
    }

    /// Applies the pieces held now: before the transcript changes here (a message sent or
    /// delivered, an answer, a line of the app's own), so that what the thread heard
    /// first comes first, and before it is saved, so that what is saved has all it heard.
    func applyHeldPieces() {
        apply(held.release())
    }

    private func applyHeldPiecesWhenSeen() {
        guard !appliesHeldPiecesWhenSeen else { return }
        appliesHeldPiecesWhenSeen = true
        withObservationTracking {
            _ = WindowVisibility.shared.isHidden
        } onChange: { [weak self] in
            // Told as it is about to change: looked at once it has.
            Task { @MainActor [weak self] in
                guard let self else { return }
                appliesHeldPiecesWhenSeen = false
                if WindowVisibility.shared.isHidden {
                    if !held.isEmpty { applyHeldPiecesWhenSeen() }
                } else if !isKeptOffScreen {
                    apply(held.release())
                }
            }
        }
    }

    /// Takes in what the thread's stream brought, as the catch-up's hold gives it back
    /// (`CatchUpHold`): each through `admit`, which holds a reply's pieces while no window
    /// can be seen and applies them before anything after them.
    private func takeIn(_ events: [ThreadEvent], from thread: ThreadRef) {
        for event in events {
            if let event = admit(event) { take(event, from: thread) }
        }
    }

    /// A turn ended: told, with the turn the host named for it (`endedTurn`), used once.
    private func turnFinished() {
        onTurnFinished?(self)
        endedTurn = nil
    }

    /// Applies one event the thread's stream brought.
    private func take(_ event: ThreadEvent, from thread: ThreadRef) {
            let wasRunning = state.isRunning
            state.apply(event)
            if case let .turnListed(turn) = event { endedTurn = turn } else if !wasRunning, state.isRunning { endedTurn = nil }
            switch event {
            case .textDelta:
                lastTextAt = .now
                replyTextArrived()
            case .turnFinished, .turnSpent, .turnChanged, .titleChanged:
                if event.endsTurn {
                    lastActivity = .now
                    lastTextAt = nil
                }
                onPersist?(self)
                if event.endsTurn { turnFinished() }
                if case .titleChanged = event { onTitleChanged?(self) }
            case .toolFinished where !state.isRunning:
                // A background call can replace its launch receipt after the turn's save.
                onPersist?(self)
            case let .snapshot(snapshot):
                ReturnProbe.shared?.note("thread-snapshot", thread.id.rawValue)
                folderReported(snapshot.workingDirectory)
                refreshCommands()
                refreshMCPAuth()
                onPersist?(self)
                // The run ended while the connection was away.
                if wasRunning, !state.isRunning { turnFinished() }
                state.openRequests.forEach(autoAnswerIfAsked)
            case .detached:
                mcpAuth.clear()
                ReturnProbe.shared?.note("thread-detached", thread.id.rawValue)
                needsOpening = true
                canCatchUp = true
                threadCommands.cancel()
                onDetached?(self)
            case let .caughtUp(info):
                ReturnProbe.shared?.note("thread-caught-up", thread.id.rawValue)
                needsOpening = false
                canCatchUp = false
                folderReported(info.workingDirectory)
                refreshCommands()
                refreshMCPAuth()
                // Saved as a thread opened whole is: the context and model the info gave,
                // and, followed again, its own word on whether it runs over the host's.
                onPersist?(self)
            case let .requestOpened(request):
                autoAnswerIfAsked(request)
            case let .ownTurnStarted(id, _), let .ownMessageSteered(id, _):
                // The host's word that it took a message of this device's settles its
                // submission, also when the send's answer was lost.
                if savedConversation?.hostTook(id) == true { onPersist?(self) }
            default:
                break
            }
    }

    /// The host said where its General folder is: a new thread that was given no folder
    /// works there, and its intro says so.
    func generalFolderKnown(_ general: Folder) {
        guard folder == nil, thread == nil, options.workingDirectory == nil else { return }
        folder = general
    }

    /// The host said which folder the thread works in: kept with the thread, for its row.
    private func folderReported(_ path: String?) {
        guard let path, !path.isEmpty, thread?.workingDirectory != path else { return }
        thread?.workingDirectory = path
    }

    /// Reply text is coming in. That holds until it has been quiet for a moment: a
    /// reply that stalls, or gives way to the next step, is no longer "arriving".
    private func replyTextArrived() {
        guard !replyIsArriving else { return }
        replyIsArriving = true
        replyWatch?.cancel()
        replyWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(400))
                guard let self, !Task.isCancelled else { return }
                let quiet = lastTextAt.map { ContinuousClock.now - $0 > .seconds(ChatFeature.replyQuiet) } ?? true
                if quiet {
                    replyIsArriving = false
                    return
                }
            }
        }
    }

    /// Answers a request the way the development switch says, if it is set.
    private func autoAnswerIfAsked(_ request: PendingRequest) {
        guard let answer = autoAnswer?(request) else { return }
        Task {
            // Long enough to see the card before it is answered.
            try? await Task.sleep(for: .seconds(1.5))
            self.answer(request, with: answer)
        }
    }
}

private extension ThreadEvent {
    var endsTurn: Bool {
        if case .turnFinished = self { true } else { false }
    }
}
