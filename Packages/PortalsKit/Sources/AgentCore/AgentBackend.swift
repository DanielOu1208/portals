import Foundation

/// One host's agents, as the app talks to them. Hermes is the first implementation;
/// Codex and Claude Code are meant to fit behind the same interface.
public protocol AgentBackend: Sendable {
    /// The host this backend talks to.
    nonisolated var host: HostID { get }
    /// Connection changes, newest last. One consumer.
    nonisolated var connectionStates: AsyncStream<ConnectionState> { get }

    func connect() async throws
    func disconnect() async

    /// The app is leaving the foreground: close the connection cleanly and stop trying
    /// to keep it. Runs on the host carry on.
    func suspend() async
    /// The app is back: reconnect. A thread with a run in progress is brought up to
    /// date on its event stream (the events it missed, or a `.snapshot` when those
    /// cannot be had); the others get `.detached`.
    func resume() async

    /// The persistent agents on this host.
    func listAgents() async throws -> [Agent]

    func createThread(with agent: Agent.ID, options: ThreadOptions) async throws -> ThreadRef

    /// Opens a thread that already exists on the host, so it can be read, followed and
    /// continued. Safe to call again: it refreshes the connection to the thread.
    ///
    /// What happened after the snapshot arrives on a new event stream: call
    /// `events(for:)` again. The stream from before ends.
    func openThread(_ thread: ThreadRef) async throws -> ThreadSnapshot

    /// What happens in a thread from now on. One consumer per thread.
    func events(for thread: ThreadRef.ID) async -> AsyncStream<ThreadEvent>

    /// Sends a message, with any images and files. During a run `whenBusy` says whether
    /// it is to be handed to the run or kept for a turn of its own; the host decides in
    /// the end (an agent that cannot take one in queues it), and the receipt says which.
    func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, to thread: ThreadRef.ID
    ) async throws -> SendReceipt

    /// `send`, with this app's own id for the message (the thread's for it): a host that
    /// tells of the message under it (a bridge's `turn_messages`) names it so, and the
    /// thread knows it by that (`ThreadEvent.ownMessageSteered`).
    func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, messageID: UUID, to thread: ThreadRef.ID
    ) async throws -> SendReceipt

    /// Stops the current run. Returns false when nothing was running.
    @discardableResult
    func interrupt(_ thread: ThreadRef.ID) async throws -> Bool

    /// Answers an approval or a question the agent is blocked on.
    func respond(to request: PendingRequest.ID, in thread: ThreadRef.ID, with answer: RequestAnswer) async throws
}

extension AgentBackend {
    /// A host that never tells of a message by an id of this app's: as `send`.
    public func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, messageID: UUID, to thread: ThreadRef.ID
    ) async throws -> SendReceipt {
        try await send(text, images: images, files: files, whenBusy: whenBusy, to: thread)
    }

    /// Sends a message with no images.
    public func send(_ text: String, to thread: ThreadRef.ID) async throws -> SendOutcome {
        try await send(text, images: [], to: thread)
    }

    /// Sends a message with images and no files, handed to a running turn where it can be.
    public func send(_ text: String, images: [ImageAttachment], to thread: ThreadRef.ID) async throws -> SendOutcome {
        try await send(text, images: images, files: [], whenBusy: .steer, to: thread).outcome
    }
}

/// A thread as the host has it right now.
public struct ThreadSnapshot: Hashable, Sendable {
    /// The stored turns, and last, when a run is in progress, the turn it is on (still
    /// running, with whatever it has produced so far).
    public var transcript: Transcript
    /// A run is in progress on the host.
    public var isRunning: Bool
    public var title: String?
    /// What the run is blocked on, waiting for an answer.
    public var openRequests: [PendingRequest]
    /// The model the thread runs on, when the host says.
    public var model: ModelSetting?
    /// How full the model's context is, when the host knows. A session the host has
    /// just loaded again does not, until its next turn.
    public var context: ContextUsage?
    /// The folder the agent works in, when the host says.
    public var workingDirectory: String?
    /// How much the thread asks before acting, when the host says.
    public var mode: ModeState?
    /// The messages waiting on the host for the running turn to end, for a host that
    /// lists them (`QueueControlling`); nil for one that does not.
    public var queued: [QueuedMessage]?
    /// The agent can take a waiting message into a running turn.
    public var canSteerQueued: Bool
    /// A repaired canonical display history replaces streamed host-owned content,
    /// including obsolete tool and reasoning rows, not just its final reply. Only for a
    /// snapshot taken because the host repaired the thread (`session.invalidated`, or a
    /// repair missed while away): an ordinary open keeps the detail seen live.
    public var authoritative: Bool
    /// The host's messages carry the ids this app sent them with (a bridge's
    /// `message_ids`): a message whose delivery was never confirmed is the host's only
    /// under its own id. From any other host, one with the same words is taken for it
    /// (`Transcript.merged`).
    public var hostKeepsMessageIDs: Bool
    /// What the status line of the run going on says, as the host holds it (a bridge's
    /// `status_line`: compacting, its API asked again); nil when none is up, at rest, or
    /// from a host that does not say.
    public var statusLine: String?
    /// Only the conversation's last turns, from a host that gives a thread so
    /// (`HistoryPaging`): whether it has more before them. nil for the whole of it.
    public var hasEarlier: Bool?

    public init(
        transcript: Transcript = Transcript(),
        isRunning: Bool = false,
        title: String? = nil,
        openRequests: [PendingRequest] = [],
        model: ModelSetting? = nil,
        context: ContextUsage? = nil,
        workingDirectory: String? = nil,
        mode: ModeState? = nil,
        queued: [QueuedMessage]? = nil,
        canSteerQueued: Bool = false,
        authoritative: Bool = false,
        hostKeepsMessageIDs: Bool = false,
        statusLine: String? = nil,
        hasEarlier: Bool? = nil
    ) {
        self.transcript = transcript
        self.isRunning = isRunning
        self.title = title
        self.openRequests = openRequests
        self.model = model
        self.context = context
        self.workingDirectory = workingDirectory
        self.mode = mode
        self.queued = queued
        self.canSteerQueued = canSteerQueued
        self.authoritative = authoritative
        self.hostKeepsMessageIDs = hostKeepsMessageIDs
        self.statusLine = statusLine
        self.hasEarlier = hasEarlier
    }
}

/// What the host says of a thread besides its conversation: what a snapshot has with its
/// transcript, and what a host that brings a thread up to date event by event says as it
/// does (`ThreadCatchingUp`), since some of it changes with no event (a model chosen on
/// another device). nil is what the host leaves out.
public struct ThreadInfo: Hashable, Sendable {
    public var title: String?
    public var model: ModelSetting?
    public var context: ContextUsage?
    public var workingDirectory: String?
    public var mode: ModeState?

    public init(title: String? = nil, model: ModelSetting? = nil, context: ContextUsage? = nil, workingDirectory: String? = nil, mode: ModeState? = nil) {
        self.title = title
        self.model = model
        self.context = context
        self.workingDirectory = workingDirectory
        self.mode = mode
    }
}

extension ThreadSnapshot {
    /// What it says of the thread besides its conversation.
    public var info: ThreadInfo {
        ThreadInfo(title: title, model: model, context: context, workingDirectory: workingDirectory, mode: mode)
    }
}

/// A host that can bring a thread the app followed up to date with only the events it
/// missed while it did not follow it, where opening it again sends the whole conversation
/// (a Portals bridge's `resume_replay`).
public protocol ThreadCatchingUp: Sendable {
    /// Follows `thread` again, as `openThread` does, for a thread that has applied every
    /// event of its stream up to `.detached`. When the host replays what the thread missed,
    /// those events come on that same stream, then `.caughtUp`, and this returns nil: with
    /// them, what the thread shows is the host's. Otherwise it returns the snapshot, and
    /// what happens after it comes on a new stream, as from `openThread`.
    func catchUp(_ thread: ThreadRef) async throws -> ThreadSnapshot?
}

/// A host that opens a long thread with its last turns only (`ThreadSnapshot.hasEarlier`)
/// and gives the ones before them as they are asked for: an agent's one ongoing
/// conversation (`ThreadRef.ongoing`) on a bridge with `history_pages`.
public protocol HistoryPaging: Sendable {
    /// The turns before the first the thread holds of its conversation, as many as a page
    /// has. nil when the host's conversation is not the one the thread took any more (it
    /// changed with no event): the thread is then opened again.
    func earlierTurns(of thread: ThreadRef.ID) async throws -> EarlierTurns?
}

/// Turns of a thread from before the first it holds (`HistoryPaging`).
public struct EarlierTurns: Hashable, Sendable {
    public var transcript: Transcript
    /// The host has more before these.
    public var hasEarlier: Bool

    public init(transcript: Transcript, hasEarlier: Bool) {
        self.transcript = transcript
        self.hasEarlier = hasEarlier
    }
}

public struct ThreadOptions: Codable, Hashable, Sendable {
    public var title: String?
    /// Where the agent works: a folder the host offers (`FolderProviding`). nil leaves it
    /// to the host: its General folder, or wherever a Hermes agent is set up to work.
    public var workingDirectory: String?
    /// nil uses the agent's configured model.
    public var model: ModelOverride?
    /// nil uses the agent's configured thinking level.
    public var thinkingLevel: ThinkingLevel?

    public init(title: String? = nil, workingDirectory: String? = nil, model: ModelOverride? = nil, thinkingLevel: ThinkingLevel? = nil) {
        self.title = title
        self.workingDirectory = workingDirectory
        self.model = model
        self.thinkingLevel = thinkingLevel
    }
}

public struct ModelOverride: Codable, Hashable, Sendable {
    public var model: String
    public var provider: String?

    public init(model: String, provider: String? = nil) {
        self.model = model
        self.provider = provider
    }
}

public enum AgentBackendError: LocalizedError, Hashable, Sendable {
    case notConnected
    case unknownThread
    case unknownRequest

    public var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to the host."
        case .unknownThread: "This thread is no longer open on the host."
        case .unknownRequest: "The agent is no longer waiting for this answer."
        }
    }
}
