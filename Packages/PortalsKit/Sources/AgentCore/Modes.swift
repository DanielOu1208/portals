import Foundation

/// How much a coding agent's thread asks before acting (a Portals bridge's `modes`,
/// what `/mode` sets). The raw values are the bridge's.
public enum ThreadMode: String, Codable, CaseIterable, Hashable, Sendable {
    /// Edits files and runs commands without asking.
    case full
    /// Edits files without asking; asks before running commands.
    case edits
    /// Reversible development actions may run without asking, where the provider offers it.
    case medium
    /// Asks before editing files or running commands.
    case ask
    /// Plans first, and asks before carrying the plan out.
    case plan
    /// Whatever the agent's own settings at the desk say.
    case settings = "default"

    public var title: String {
        switch self {
        case .full: "Full access"
        case .edits: "Accept edits"
        case .medium: "Medium"
        case .ask: "Ask first"
        case .plan: "Plan"
        case .settings: "Your settings"
        }
    }

    /// What the agent does in it, after "Claude …".
    public var meaning: String {
        switch self {
        case .full: "edits files and runs commands without asking"
        case .edits: "edits files without asking, and asks before running commands"
        case .medium: "can run reversible development actions without asking, but may still ask for approval"
        case .ask: "asks before editing files or running commands"
        case .plan: "plans first, and asks before carrying the plan out"
        case .settings: "follows your settings"
        }
    }

    /// The SF Symbol that stands for it in the composer.
    public var symbol: String {
        switch self {
        case .full: "bolt.fill"
        case .edits: "pencil"
        case .medium: "bolt"
        case .ask: "hand.raised"
        case .plan: "map"
        case .settings: "gearshape"
        }
    }
}

/// The provider's own name and permission meaning for a mode.
public struct ModeOption: Codable, Hashable, Sendable, Identifiable {
    public var id: ThreadMode
    public var label: String
    public var description: String

    public init(id: ThreadMode, label: String, description: String) {
        self.id = id
        self.label = label
        self.description = description
    }
}

/// A thread's mode, and what following the agent's settings comes to, when known.
public struct ModeState: Codable, Hashable, Sendable {
    public var mode: ThreadMode
    /// What `settings` comes to ("full"), when the host says.
    public var defaultsTo: ThreadMode?
    public var options: [ModeOption]?

    public init(mode: ThreadMode, defaultsTo: ThreadMode? = nil, options: [ModeOption]? = nil) {
        self.mode = mode
        self.defaultsTo = defaultsTo == .settings ? nil : defaultsTo
        self.options = options?.isEmpty == false ? options : nil
    }

    /// The mode in force: the thread's own, or what the settings come to.
    public var effective: ThreadMode {
        mode == .settings ? (defaultsTo ?? .settings) : mode
    }

    /// The same thread with `picked` chosen, before the host has said: what the settings
    /// come to and the provider's own choices stay (a Droid thread keeps Medium and its
    /// names in the picker until the host answers, or until its first message).
    public func picking(_ picked: ThreadMode) -> ModeState {
        ModeState(mode: picked, defaultsTo: defaultsTo, options: options)
    }

    public var offeredModes: [ThreadMode] {
        options?.map(\.id) ?? [.full, .edits, .ask, .plan, .settings]
    }

    public func option(for mode: ThreadMode) -> ModeOption? {
        options?.first { $0.id == mode }
    }

    public func title(for mode: ThreadMode) -> String {
        option(for: mode)?.label ?? mode.title
    }

    public func meaning(for mode: ThreadMode) -> String {
        option(for: mode)?.description ?? mode.meaning
    }

    /// The settings row names what it comes to, when the host says.
    public func pickerTitle(for mode: ThreadMode) -> String {
        guard mode == .settings, let actual = defaultsTo else { return title(for: mode) }
        return "\(title(for: mode)) (\(title(for: actual)))"
    }

    /// Provider descriptions are already standalone; legacy meanings are sentence endings.
    public func pickerDescription(for mode: ThreadMode) -> String {
        if let option = option(for: mode) { return option.description }
        if mode == .settings { return "As the agent's own settings at the desk say" }
        let meaning = meaning(for: mode)
        return meaning.prefix(1).uppercased() + meaning.dropFirst()
    }
}

/// A host whose coding agents' threads take a mode (a Portals bridge's `modes`).
public protocol ModeSelecting: Sendable {
    /// Whether the host's threads take modes, as of the last connection; nil before the first.
    var offersModes: Bool? { get async }
    /// Changes the thread's mode; the answer is the mode as the host has it now.
    func setMode(_ mode: ThreadMode, in thread: ThreadRef.ID) async throws -> ModeState
}

public enum ModeError: LocalizedError, Hashable, Sendable {
    /// The host's threads take no mode.
    case unavailable
    /// The host answered with a different mode from the one requested.
    case notConfirmed

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This agent's threads have no modes."
        case .notConfirmed: "The host did not confirm the chosen mode."
        }
    }
}
