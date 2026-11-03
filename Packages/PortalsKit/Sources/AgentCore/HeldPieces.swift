import Foundation

/// Pieces of a reply or of its reasoning held back while no one can see the thread, to be
/// applied together once someone can. A Mac window covered by others laid out and drew
/// every word of a reply as one in view does, at about a third of a core
/// (docs/perf-mac-scroll.md). Whatever else the thread hears is applied at once, after
/// the pieces held before it, so the events keep their order and only how often the
/// transcript changes is less. Each piece keeps the time it came at and is applied at
/// that time, so that what is timed from them (how long the model thought, when a turn
/// began) is as if it had been applied as it came.
public struct HeldPieces: Sendable {
    /// An event and the time it came at.
    public struct Piece: Sendable, Equatable {
        public var event: ThreadEvent
        public var at: Date

        public init(_ event: ThreadEvent, at: Date) {
            self.event = event
            self.at = at
        }
    }

    private var pieces: [Piece] = []
    /// Where the latest progress of each tool held since its start is (`pieces`), and the
    /// latest status line since anything that takes one down was held: a later one is
    /// folded into it rather than kept beside it.
    private var progressAt: [String: Int] = [:]
    private var statusAt: Int?

    public init() {}

    /// Whether no piece is held.
    public var isEmpty: Bool { pieces.isEmpty }

    /// What to apply now on hearing `event` at `now`: nothing when it is a piece and
    /// `holding`, or a step of the run (`ThreadEvent.isStepOfRun`) and `holdingSteps`;
    /// otherwise what was held before it, then it.
    public mutating func events(for event: ThreadEvent, at now: Date = .now, holding: Bool, holdingSteps: Bool = false) -> [Piece] {
        if holding && event.isStreamedPiece || holdingSteps && (event.isStreamedPiece || event.isStepOfRun) {
            hold(event, at: now)
            return []
        }
        return release() + [Piece(event, at: now)]
    }

    /// The pieces held, in the order they came, to apply now.
    public mutating func release() -> [Piece] {
        defer {
            pieces = []
            progressAt = [:]
            statusAt = nil
        }
        return pieces
    }

    /// Holds `event`. A tool's progress is a snapshot of its output's tail, each one in place
    /// of the one before, and a status line stands in place of the last: held while a run
    /// goes on out of sight (a command printing for an hour), each is folded into the one
    /// held before it, which applied after it would come to the same, so that what is held
    /// stays the size of what it shows. Never across the tool's start or end, which a later
    /// tool of the same id may follow, and a status line never across what may take the
    /// line down (`mayTakeStatusLineDown`), which folded before that would leave the line
    /// down where it is up.
    private mutating func hold(_ event: ThreadEvent, at now: Date) {
        if event.mayTakeStatusLineDown { statusAt = nil }
        switch event {
        case let .toolProgress(progress):
            if let index = progressAt[progress.id], case let .toolProgress(before) = pieces[index].event {
                pieces[index].event = .toolProgress(ToolProgress(
                    id: progress.id,
                    output: progress.output ?? before.output,
                    progress: progress.progress ?? before.progress,
                    outputTruncated: progress.outputTruncated ?? before.outputTruncated
                ))
                return
            }
            progressAt[progress.id] = pieces.count
        case .status:
            if let index = statusAt {
                pieces[index].event = event
                return
            }
            statusAt = pieces.count
        case let .toolStarted(run):
            progressAt[run.id] = nil
        case let .toolFinished(result):
            progressAt[result.id] = nil
        default:
            break
        }
        pieces.append(Piece(event, at: now))
    }
}

extension ThreadState {
    /// Applies events at the times they came at.
    public mutating func apply(_ pieces: [HeldPieces.Piece]) {
        for piece in pieces { apply(piece.event, at: piece.at) }
    }
}

extension ThreadEvent {
    /// A piece of a reply's text or of its reasoning, as it streams.
    public var isStreamedPiece: Bool {
        switch self {
        case .textDelta, .reasoningDelta: true
        default: false
        }
    }

    /// A step that may take the status line down (`ThreadState`): the agent at work again
    /// (a reply, a thought, closed text, a tool call), after which a line from before
    /// ("trying again (attempt 6 of 10)…") is over. Not a tool's end, even one whose start
    /// was missed that opens a turn: the host keeps its line over it, and so does the app.
    var mayTakeStatusLineDown: Bool {
        switch self {
        case .textDelta, .reasoningDelta, .interimText, .toolStarted: true
        default: false
        }
    }

    /// A step of a run under way that only adds to what its transcript shows: a tool
    /// called, its progress and its end, a piece of text closed, a line about what the
    /// agent does. Nothing else the app does hangs on it (whether the thread is at work,
    /// waits for an answer, has a title): a thread whose chat no one sees holds these too
    /// while it runs (`ThreadController.isKeptOffScreen`).
    public var isStepOfRun: Bool {
        switch self {
        case .toolStarted, .toolProgress, .toolFinished, .interimText, .status: true
        default: false
        }
    }
}

/// How often the pieces of a reply on screen change the transcript: at most once every
/// `interval`. A piece that comes sooner after the last change is held (`HeldPieces`) and
/// applied with the others held by then, `interval` after that change. The first piece
/// after a pause is applied at once, so a reply starts showing as soon as it comes.
///
/// Each change of the transcript has the whole chat screen worked out again, at about
/// 3 ms of an iPhone simulator's main thread; a reply comes in 12 to 30 pieces a
/// second, and its text is eased in on screen twenty steps a second whatever the pieces
/// are (`TurnView`'s reveal), so applying them ten times a second shows the same and
/// took a tenth off what a reply costs the phone app (docs/perf-phone.md).
public struct PiecePacer: Sendable {
    public let interval: TimeInterval
    /// When pieces last changed the transcript.
    private var lastApplied: Date?

    public init(interval: TimeInterval) {
        self.interval = interval
    }

    /// Whether a piece heard at `now` waits for the next change rather than making one.
    public func holds(at now: Date) -> Bool {
        guard let lastApplied else { return false }
        return now.timeIntervalSince(lastApplied) < interval
    }

    /// When the pieces held now are to be applied: `interval` after the last change.
    public func due(after now: Date) -> TimeInterval {
        guard let lastApplied else { return 0 }
        return max(0, interval - now.timeIntervalSince(lastApplied))
    }

    /// Pieces changed the transcript at `now`.
    public mutating func applied(at now: Date) {
        lastApplied = now
    }
}
