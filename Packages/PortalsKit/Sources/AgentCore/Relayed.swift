import Foundation

/// Who sent a message into a thread through a host's fleet (another agent's thread, or a
/// person or script at a terminal, with `portals send`), or started a thread through it:
/// a few facts, which a Portals bridge gives beside such a message and such a thread
/// (`senders`), and which are read here from the message's first line for a host that
/// gives none. The app shows these; the line is for the agent.
///
/// Every fact may be missing. None of `agentName` and `thread` is a terminal ("the
/// command line"). `machine` and `machineName` are there only when it came from another
/// Mac than the thread's: its stable id (`HostConfig.machineID`, which an app paired with
/// that Mac too knows it by) and its name for itself.
public struct MessageSender: Codable, Hashable, Sendable {
    /// The sending thread's agent by its name on its host (`claude`), when the host knows it.
    public var agent: String?
    /// That agent as the person knows it: "Claude Code".
    public var agentName: String?
    /// The sending thread's id on its own host.
    public var thread: String?
    /// Its title when it sent the message.
    public var title: String?
    /// The stable id of the Mac it came from, when that is another than the thread's.
    public var machine: String?
    /// That Mac's name for itself.
    public var machineName: String?

    public init(agent: String? = nil, agentName: String? = nil, thread: String? = nil, title: String? = nil, machine: String? = nil, machineName: String? = nil) {
        self.agent = agent
        self.agentName = agentName
        self.thread = thread
        self.title = title
        self.machine = machine
        self.machineName = machineName
    }

    /// The facts as a host gives them (`from`: `agent`, `agent_name`, `thread`, `title`,
    /// `machine`, `machine_name`): each a line of text, any of them missing.
    public init(fields: [String: String]) {
        func fact(_ key: String) -> String? {
            guard let value = fields[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        self.init(agent: fact("agent"), agentName: fact("agent_name"), thread: fact("thread"), title: fact("title"),
                  machine: fact("machine"), machineName: fact("machine_name"))
    }

    /// Sent by a person or a script at a terminal, not by an agent's thread.
    public var isCommandLine: Bool { agentName == nil && thread == nil }

    /// From another Mac than the thread's.
    public var isFromAnotherMac: Bool { machine != nil || machineName != nil }

    /// Who it is in words, "Codex on mini · Review", "the command line": the Mac by
    /// `macName` (the app's own name for the host it knows by that id), else by the
    /// Mac's name for itself, before the title, so that a long title is what is cut.
    public func words(macName: (String) -> String? = { _ in nil }) -> String {
        let who = isCommandLine ? "the command line" : (agentName ?? agent ?? "an agent")
        let mac = machine.flatMap(macName) ?? machineName ?? machine
        let on = mac.map { " on \($0)" } ?? ""
        // A title that only repeats the agent's name says nothing more.
        let title = title.flatMap { $0 == who ? nil : " · \($0)" } ?? ""
        return "\(who)\(on)\(title)"
    }
}

/// A message the user did not type: one sent into the thread through a host's fleet, by
/// another agent's thread or a script (`portals send`). The host opens it with a line that
/// says who it is from, which the agent reads too and which every stored copy keeps:
/// `[Portals: from the command line]`, `[Portals: from Claude Code · "Fix the login"
/// (thread 6d3c…)]`, `… (thread 7d2a41c09be36f58/6d3c…) on mini` from another Mac (its
/// stable id and its name), `… on mbp16` from an older bridge. That line is how such a
/// message is known, live and in history alike, whatever the agent; who sent it is read
/// from the facts the host gives (`MessageSender`), and from the line only without them.
public struct RelayedMessage: Hashable, Sendable {
    /// Who sent it, as the host says or as its line says; nil for a line worded by a
    /// host that wrote who as it liked, which `words` holds.
    public var from: MessageSender?
    /// Who sent it as its line says, for a line not read into facts.
    var words: String
    /// The message as it was sent, without that line.
    public var text: String

    /// What its row is labelled with: "From the command line", "From Claude Code · Fix the
    /// login", "From Codex on mini · Review": a Mac by `macName` when it knows that Mac's id.
    public func label(macName: (String) -> String? = { _ in nil }) -> String {
        "From \(from?.words(macName: macName) ?? words)"
    }

    /// The label with each Mac by its own name for itself.
    public var label: String { label() }

    /// The message as it reads, without the Markdown marks its row draws it with (the
    /// stars of bold, the backticks of code): what is read out for it.
    public var plainText: String { Markdown.plainText(text) }

    /// Sent from the command line rather than from another agent's thread.
    public var isFromCommandLine: Bool { from?.isCommandLine ?? words.hasPrefix(Self.commandLine) }

    private static let commandLine = "the command line"

    /// The longest words a line may name who by and still be read: more than any line a
    /// Portals bridge writes (bridge/src/fleet/line.ts `longestWords`, the same). The
    /// patterns that read them take time with the square of their length, and a row reads
    /// them as it is drawn: 1,200 characters at worst take about 25 ms.
    static let longestWords = 1200

    /// The message `text` is, when it opens with the fleet's line; nil for any other
    /// message, one with that line further down included. `from` is who sent it as the
    /// host says (`senders`), which is taken over what the line says.
    public init?(parsing text: String, from given: MessageSender? = nil) {
        let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = lines.first, let who = Self.sender(inLine: first) else { return nil }
        from = given ?? Self.facts(in: who)
        // Words are worked out only for a line with no facts.
        words = from == nil ? Self.words(for: who) : ""
        self.text = lines.count > 1 ? String(lines[1]) : ""
    }

    /// Who the line names, when `line` is the fleet's line; nil when it is not one.
    static func sender(inLine line: Substring) -> String? {
        let line = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let opening = "[Portals: from "
        guard line.hasPrefix(opening), line.hasSuffix("]"), line.count > opening.count else { return nil }
        return String(line.dropFirst(opening.count).dropLast())
    }

    /// The facts the words of a line name, as a Portals bridge writes them
    /// (bridge/src/fleet/line.ts): `the command line[ (machine <Mac's id>)][ on <Mac>]`, or `<agent>[ ·
    /// "<title>"] (thread [<Mac's id>/]<id>)[ on <Mac>]`. Nil for words another host
    /// wrote as it liked.
    static func facts(in who: String) -> MessageSender? {
        // Longer than any line a bridge writes: not read (`longestWords`).
        guard who.count <= longestWords else { return nil }
        if let terminal = who.wholeMatch(of: #/the command line(?: \(machine ([^()\s]+)\))?(?: on (.+))?/#) {
            return MessageSender(machine: terminal.1.map(String.init), machineName: terminal.2.map(String.init))
        }
        guard let matched = who.wholeMatch(of: #/(.+?)(?: · "(.*)")? \(thread ([^()\s]+)\)(?: on (.+))?/#) else { return nil }
        let ref = String(matched.3)
        let slash = ref.firstIndex(of: "/")
        return MessageSender(
            agentName: String(matched.1), thread: slash.map { String(ref[ref.index(after: $0)...]) } ?? ref,
            title: matched.2.map(String.init), machine: slash.map { String(ref[..<$0]) }, machineName: matched.4.map(String.init)
        )
    }

    /// The sender as a reader is told it, for words not read into facts: without a
    /// thread's id, which is there for the agent, and with a title out of its quotes.
    static func words(for who: String) -> String {
        // Its patterns cost the square of its length: a crafted line is shown cut instead.
        guard who.count <= longestWords else { return "\(who.prefix(80))…" }
        var words = who
        // Only the id the host puts after the title, before the Mac it came from: a title
        // may say "(thread …)" too.
        if let suffixed = words.wholeMatch(of: #/(.*) \(thread [^()\s]+\)((?: on [^()]+)?)/#) {
            words = "\(suffixed.1)\(suffixed.2)"
        }
        if let titled = words.wholeMatch(of: #/(.+?) · "(.*)"(.*)/#) {
            words = "\(titled.1) · \(titled.2)\(titled.3)"
        }
        words = words.trimmingCharacters(in: .whitespaces)
        return words.isEmpty ? "Portals" : words
    }
}

extension UserMessage {
    /// Who sent it and what it says, when it came through a host's fleet rather than from
    /// the user (`RelayedMessage`).
    public var relayed: RelayedMessage? { RelayedMessage(parsing: text, from: from) }
}

extension QueuedMessage {
    /// Who sent it and what it says, when it came through a host's fleet.
    public var relayed: RelayedMessage? { RelayedMessage(parsing: parts.text, from: from) }
}
