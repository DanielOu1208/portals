import Foundation

/// A session a coding agent has on its host that was started there, in a terminal at
/// the desk, and is not a thread of the app's: one the app can take up.
public struct DeskSession: Identifiable, Hashable, Sendable {
    /// What the session is doing on the host.
    public enum State: String, Hashable, Sendable {
        /// A terminal has it open (Claude Code). Continuing it from the phone would write
        /// behind that terminal's back, so it can only be forked or read.
        case open
        /// Nobody has it open: it can be continued.
        case closed
        /// The agent is at work on it (Codex).
        case running
        /// The agent waits for an answer to an approval or a question (Codex).
        case waiting
        /// Loaded on the host, with nothing running (Codex).
        case idle
    }

    /// The host's id for the session.
    public var id: String
    public var agent: Agent.ID
    /// What to call it; never empty.
    public var title: String
    /// The folder it works in, as its full path on the host.
    public var folder: String
    /// When it last changed, when the host says.
    public var updated: Date?
    public var state: State
    /// The ways the host takes it up, when not all its agent's (`adopt_modes`): a chat of
    /// Cursor's terminal is only forked. Nil for all of them.
    public var adoptModes: [AdoptMode]?

    public init(
        id: String, agent: Agent.ID, title: String? = nil, folder: String, updated: Date? = nil, state: State,
        adoptModes: [AdoptMode]? = nil
    ) {
        self.id = id
        self.agent = agent
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.title = trimmed.isEmpty ? "Untitled session" : trimmed
        self.folder = folder
        self.updated = updated
        self.state = state
        self.adoptModes = adoptModes
    }

    /// What to call its folder: "No project" for the host's General folder (`general`, its
    /// path), its last path component otherwise.
    public func folderName(general: String?) -> String {
        Folder.name(of: folder, general: general)
    }

    /// Continuing it is not offered: a terminal has it open, so it is forked or read.
    public var isOpenInTerminal: Bool { state == .open }

    /// Whether the host takes it up as `mode`, as far as the session itself says.
    public func allows(_ mode: AdoptMode) -> Bool { adoptModes?.contains(mode) ?? true }

    /// It cannot be continued at all, only forked (a chat of Cursor's terminal).
    public var isForkOnly: Bool { !allows(.continue) && !allows(.read) && allows(.fork) }

    /// How a tap takes it up when nothing has to be asked first: continued.
    public var defaultMode: AdoptMode? { isOpenInTerminal || !allows(.continue) ? nil : .continue }

    /// A thread only read, as a desk session again, to fork it.
    public init(viewOnly thread: ThreadRef) {
        self.init(thread: thread)
    }

    /// Any saved thread, offered to its provider as the source of a fork.
    public init(thread: ThreadRef) {
        self.init(
            id: thread.id.rawValue, agent: thread.agent, title: thread.title,
            folder: thread.workingDirectory ?? "", state: .open
        )
    }
}

/// How a desk session becomes a thread of the app's.
public enum AdoptMode: String, Hashable, Codable, Sendable, CaseIterable {
    /// The thread is the session itself, and goes on from where it is.
    case `continue`
    /// A new thread with the session's history so far; the session is left alone.
    case fork
    /// The thread shows the session and takes no messages.
    case read
}

extension Agent {
    /// Whether a thread of this agent's can be forked into a new one (an agent's one
    /// ongoing conversation never is). A bridge that says how its agents adopt sessions
    /// (`adopt_modes`) forks where it lists `fork`. One from before that (0.3.0) still forks
    /// a thread only read, as the note under such a thread always offered.
    public func forks(_ thread: ThreadRef) -> Bool {
        guard !thread.isOngoing else { return false }
        guard let adoptModes else { return thread.isReadOnly }
        return adoptModes.contains(.fork)
    }
}

/// A backend whose coding agents have sessions started on the host itself, in a
/// terminal, which the app can list and take up as threads. Hosts that do not (Hermes)
/// say so.
public protocol DeskSessionProviding: Sendable {
    /// Whether the host offers its desk sessions, as of the last connection; nil before
    /// the first.
    var offersDeskSessions: Bool? { get async }
    /// The agent's sessions from the desk that are not threads of the app's yet, most
    /// recent first. Throws `DeskSessionError.unavailable` for a host that offers none.
    func deskSessions(for agent: Agent.ID) async throws -> [DeskSession]
    /// Makes a desk session a thread of the app's. The host refuses to continue a
    /// session a terminal has open, with a sentence saying so
    /// (`DeskSessionError.continueRefused`).
    func adopt(_ session: DeskSession, as mode: AdoptMode) async throws -> ThreadRef
}

public enum DeskSessionError: LocalizedError, Hashable, Sendable {
    /// The host does not offer its desk sessions.
    case unavailable
    /// The host would not continue the session, with its sentence on why: open elsewhere,
    /// unfinished tool calls, its folder moved. A list can call a session closed and still
    /// be refused, so it is offered to fork or read instead.
    case continueRefused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host does not offer sessions started on it."
        case let .continueRefused(sentence): sentence
        }
    }
}
