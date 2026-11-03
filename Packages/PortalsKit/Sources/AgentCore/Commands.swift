import Foundation

/// A line from the composer read as a slash command: `/name`, then whatever follows.
public struct SlashInput: Hashable, Sendable {
    /// The command's name, lower case, without the slash.
    public var name: String
    /// What follows the name, with the whitespace around it removed.
    public var argument: String

    public init(name: String, argument: String = "") {
        self.name = name.lowercased()
        self.argument = argument.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// nil when `text` is a message, not a command. A command is a slash at the very
    /// start, then a name with no second slash in it, then a space or the end, the
    /// rule Hermes's own clients use: "/usr/local is full" and "run /clean" are
    /// messages.
    public init?(_ text: String) {
        guard text.hasPrefix("/") else { return nil }
        let rest = text.dropFirst()
        let name = rest.prefix { !$0.isWhitespace }
        guard !name.isEmpty, !name.contains("/") else { return nil }
        self.init(name: String(name), argument: String(rest.dropFirst(name.count)))
    }

    /// The command as it is run and shown: "/name argument".
    public var text: String {
        argument.isEmpty ? "/\(name)" : "/\(name) \(argument)"
    }
}

/// A command the app carries out itself, whatever the host would do with the name.
public enum AppCommand: String, CaseIterable, Hashable, Sendable {
    case new, stop, retry, model, reasoning, help

    public var summary: String {
        switch self {
        case .new: "Start a new thread"
        case .stop: "Stop the run in progress"
        case .retry: "Send your last message again"
        case .model: "Choose the model for this thread"
        case .reasoning: "Set how hard the model thinks"
        case .help: "Show the commands"
        }
    }

    /// What can follow the name.
    public var usage: String? {
        switch self {
        case .model: "[name]"
        case .reasoning: "[level]"
        default: nil
        }
    }
}

/// A slash command the composer offers.
public struct SlashCommand: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        /// The app does it (`AppCommand`).
        case app
        /// The host runs it, and answers with text or turns it into a message.
        case host
        /// A skill: instructions the agent follows, with whatever is written after it.
        case skill
    }

    /// Without the slash.
    public var name: String
    public var summary: String
    /// What can follow the name ("[N]", "<prompt>").
    public var usage: String?
    public var kind: Kind
    /// The only first words the command takes from this app, when the host limits them.
    public var allowedArguments: [String]?

    public var id: String { name }

    public init(name: String, summary: String, usage: String? = nil, kind: Kind = .host, allowedArguments: [String]? = nil) {
        self.name = name
        self.summary = summary
        self.usage = usage
        self.kind = kind
        self.allowedArguments = allowedArguments
    }
}

/// Where a typed command goes.
public enum CommandTarget: Hashable, Sendable {
    case app(AppCommand)
    /// It cannot be run from this app. The sentence says why.
    case unavailable(String)
    /// The host's to run, or to say it does not know.
    case host
}

/// The slash commands an agent offers, optionally scoped to one thread's folder.
public struct CommandCatalog: Hashable, Sendable {
    /// The host's commands, then its skills, in the order to offer them.
    public var commands: [SlashCommand]
    /// Other names for commands ("reset" for "new").
    public var aliases: [String: String]
    /// Commands the host knows that cannot be run from this app, and why.
    public var unavailable: [String: String]

    public init(commands: [SlashCommand] = [], aliases: [String: String] = [:], unavailable: [String: String] = [:]) {
        self.commands = commands
        self.aliases = aliases
        self.unavailable = unavailable
    }

    /// Everything the composer offers: the app's own commands, then the host's. A host
    /// command the app does itself is offered once, as the app's.
    public var offered: [SlashCommand] {
        let own = AppCommand.allCases.map { SlashCommand(name: $0.rawValue, summary: $0.summary, usage: $0.usage, kind: .app) }
        return own + commands.filter { AppCommand(rawValue: $0.name) == nil }
    }

    /// What to suggest while a command's name is being typed. Empty once `draft` is
    /// not a slash followed by part of a name: a message, or a command that has its
    /// name and is on to what follows.
    ///
    /// Names that start with what was typed come first, then other names it stands
    /// for, then names with a word that starts with it ("rev" for "code-review", "pdf"
    /// for "anthropic-skills:pdf"), then names that contain it. Any part of a name finds
    /// it: a beta tester had to type a skill's whole name (2026-10-31). Where none of
    /// those match three letters or more, names with its letters in order do ("cdrev"
    /// for "code-review").
    public func suggestions(for draft: String) -> [SlashCommand] {
        guard draft.hasPrefix("/"), !draft.contains(where: \.isWhitespace) else { return [] }
        let typed = draft.dropFirst().lowercased()
        guard !typed.contains("/") else { return [] }
        let all = offered
        guard !typed.isEmpty else { return all }

        let named = all.map { (command: $0, name: $0.name.lowercased()) }
        let starts = named.filter { $0.name.hasPrefix(typed) }.map(\.command)
        var found = Set(starts.map(\.name))
        let aliased = aliases
            .filter { $0.key.lowercased().hasPrefix(typed) }
            .sorted { $0.key < $1.key }
            .compactMap { alias in all.first { $0.name == alias.value } }
            .filter { found.insert($0.name).inserted }
        let words = named.filter { Self.hasWord(startingWith: typed, in: $0.name) && found.insert($0.command.name).inserted }.map(\.command)
        let contains = named.filter { $0.name.contains(typed) && found.insert($0.command.name).inserted }.map(\.command)
        let matched = starts + aliased + words + contains
        guard matched.isEmpty, typed.count >= 3 else { return matched }
        return named.filter { Self.hasLetters(of: typed, inOrderIn: $0.name) }.map(\.command)
    }

    /// A word of `name` after its first, past a dash, an underscore, a dot or a colon,
    /// starts with `typed`.
    private static func hasWord(startingWith typed: String, in name: String) -> Bool {
        name.split(whereSeparator: { "-_.:".contains($0) }).dropFirst().contains { $0.hasPrefix(typed) }
    }

    /// Every letter of `typed` is in `name`, in the same order.
    private static func hasLetters(of typed: String, inOrderIn name: String) -> Bool {
        var rest = name[...]
        for letter in typed {
            guard let at = rest.firstIndex(of: letter) else { return false }
            rest = rest[rest.index(after: at)...]
        }
        return true
    }

    public func target(of input: SlashInput) -> CommandTarget {
        let name = aliases[input.name] ?? input.name
        if let own = AppCommand(rawValue: name) { return .app(own) }
        if let why = unavailable[name] { return .unavailable(why) }
        if let allowed = commands.first(where: { $0.name == name })?.allowedArguments {
            let first = input.argument.split(whereSeparator: \.isWhitespace).first.map { $0.lowercased() }
            guard let first, allowed.contains(first) else {
                return .unavailable("From here /\(name) takes one of: \(allowed.joined(separator: ", ")).")
            }
        }
        return .host
    }
}

/// What came of running a command on the host.
public enum CommandOutcome: Hashable, Sendable {
    /// The host answered with text. Nothing was said to the agent.
    case output(String)
    /// The command stands for a message to the agent. `shownAs` is what the reader
    /// sees in its place, when the message itself is not written for them (a skill's
    /// instructions). `note` is something the host wants said about it.
    case message(String, shownAs: String?, note: String?)
    /// Text for the composer, to edit and send.
    case draft(String, note: String?)

    /// The command stands for a message to the agent: it has done nothing yet.
    public var isMessage: Bool {
        if case .message = self { true } else { false }
    }
}

// MARK: A command's turn

extension Turn {
    /// The slash command the turn was started with: an agent's own command, sent for the
    /// agent to run ("/compact"), or a skill, shown as the command that asked for it.
    /// nil for a turn a message or the host started.
    public var command: SlashInput? {
        guard case let .user(message)? = items.first?.content, message.images.isEmpty else { return nil }
        return SlashInput(message.text)
    }

    /// A slash command's turn that went well with nothing to show for it: the agent said
    /// nothing, did no work and left no mark. The command still ran, and a line says so
    /// where a message would have had its answer.
    public var isCommandWithoutAnswer: Bool {
        guard outcome == .completed, command != nil else { return false }
        return items.dropFirst().allSatisfy { item in
            switch item.content {
            case .notice, .reasoning: true
            case .user, .text, .tool, .request, .command, .event, .compaction: false
            }
        }
    }
}

/// A backend whose threads take slash commands.
public protocol CommandRunning: Sendable {
    func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog
    /// Project commands for this thread, where supported. The agent-only catalog
    /// remains safe to share; a thread's catalog must stay with that thread.
    func commandCatalog(for agent: Agent.ID, in thread: ThreadRef.ID) async throws -> CommandCatalog
    /// Runs a command in a thread. The app's own commands never get here.
    func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome
}

extension CommandRunning {
    public func commandCatalog(for agent: Agent.ID, in thread: ThreadRef.ID) async throws -> CommandCatalog {
        try await commandCatalog(for: agent)
    }
}
