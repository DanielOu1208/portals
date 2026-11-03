import Foundation

/// A machine that runs agents (one `hermes serve`, later a Codex or Claude Code host).
public struct HostID: Hashable, Codable, Sendable, RawRepresentable {
    public var rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }
}

/// A persistent agent on a host. For Hermes this is a profile: its own memory,
/// personality, skills and configuration.
public struct Agent: Identifiable, Hashable, Codable, Sendable {
    public struct ID: Hashable, Codable, Sendable {
        public var host: HostID
        /// The name the backend knows the agent by.
        public var name: String

        public init(host: HostID, name: String) {
            self.host = host
            self.name = name
        }
    }

    public var id: ID
    /// What to show; never empty.
    public var displayName: String
    public var summary: String?
    public var model: String?
    public var isDefault: Bool
    /// Which agent runs it, as a Portals bridge that says so calls it: `claude`,
    /// `codex`, `pi`, `cursor`, or `hermes` for a Hermes profile, whose name can be
    /// anything. nil from every other host, and in agents saved before this was kept.
    public var kind: String?
    /// Desk adoption supported by this agent. Absent on older bridges means none, but for
    /// the fork of a thread only read, which they always took (`forks`).
    public var adoptModes: [AdoptMode]?

    public init(
        id: ID, displayName: String? = nil, summary: String? = nil, model: String? = nil, isDefault: Bool = false, kind: String? = nil,
        adoptModes: [AdoptMode]? = nil
    ) {
        self.id = id
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.displayName = trimmed.isEmpty ? id.name : trimmed
        self.summary = summary?.isEmpty == false ? summary : nil
        self.model = model
        self.isDefault = isDefault
        self.kind = kind
        self.adoptModes = adoptModes
    }
}

/// One conversation with one agent.
public struct ThreadRef: Identifiable, Hashable, Codable, Sendable {
    /// Stable for the life of the thread, whatever the backend does to its own ids.
    public struct ID: Hashable, Codable, Sendable, RawRepresentable {
        public var rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }
    }

    public var id: ID
    public var agent: Agent.ID
    public var title: String?
    public var createdAt: Date
    /// The folder on the host the agent works in, when the thread has one: the folder it
    /// was started in, as the host last reported it. nil in threads saved before folders
    /// were kept.
    public var workingDirectory: String?
    /// A session started on the host, in a terminal that has it open, taken up only to
    /// read: the thread takes no messages. nil (in threads saved before this was kept,
    /// and every other thread) is false.
    public var readOnly: Bool?
    /// The agent's one ongoing conversation (a Hermes profile's bot chat, a bridge's
    /// `bot_chat`): every new thread with the agent is this one, which is never removed nor
    /// renamed, `/new` in it compacts it, and it opens with its last turns only, the ones
    /// before them coming as it is scrolled up. nil (every other thread) is false.
    public var ongoing: Bool?

    public init(
        id: ID, agent: Agent.ID, title: String? = nil, createdAt: Date = .now, workingDirectory: String? = nil,
        readOnly: Bool? = nil, ongoing: Bool? = nil
    ) {
        self.id = id
        self.agent = agent
        self.title = title
        self.createdAt = createdAt
        self.workingDirectory = workingDirectory
        self.readOnly = readOnly == true ? true : nil
        self.ongoing = ongoing == true ? true : nil
    }

    /// The thread is only for reading (`readOnly`).
    public var isReadOnly: Bool { readOnly == true }
    /// The agent's one ongoing conversation (`ongoing`).
    public var isOngoing: Bool { ongoing == true }
}

/// A thread wherever it is. A thread's id is only unique on its own host, so anything
/// that holds threads from several hosts tells them apart by this. The id inside is
/// still the one the host knows the thread by.
public struct ThreadKey: Hashable, Codable, Sendable {
    public var host: HostID
    public var id: ThreadRef.ID

    public init(host: HostID, id: ThreadRef.ID) {
        self.host = host
        self.id = id
    }
}

extension ThreadRef {
    public var key: ThreadKey { ThreadKey(host: agent.host, id: id) }
}
