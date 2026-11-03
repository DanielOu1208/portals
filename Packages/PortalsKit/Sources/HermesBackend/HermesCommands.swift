import AgentCore
import Foundation

/// Hermes's slash commands as the app offers and runs them.
///
/// Hermes has three kinds of client for them, and a command made for one can be
/// useless or misleading from another: its registry tags each command for graphical
/// clients (`desktop` in `commands.catalog`), and its own desktop app carries out a
/// further set itself instead of passing them on. The app follows both.
enum HermesCommands {
    /// Commands Hermes's desktop app does with a screen or a call of its own. Passed to
    /// the host as text they would act on a helper process, not on the thread ("/yolo"
    /// would say it is on while approvals are still asked for), or open something on
    /// the host's own display. Left out until the app has its own way to do them.
    static let needsItsOwnScreen: Set<String> = [
        "battery", "bg", "branch", "browser", "btw", "focus", "handoff", "hatch", "journey", "palette", "pet",
        "prompt", "resume", "save", "sessions", "skin", "timestamps", "title", "wake", "yolo",
    ]

    /// Commands that change what was said in the thread on the host, with no event to
    /// say so: taking turns back, replacing them with a summary. After one of these the
    /// thread is told what the host has now.
    static let rewritesConversation: Set<String> = ["undo", "compress", "compact"]

    // MARK: The catalog

    /// The commands to offer, from the result of `commands.catalog`. Read by hand and
    /// leniently: a field in a shape this does not expect drops that field, not the list.
    static func catalog(from result: JSONValue) -> CommandCatalog {
        let meta = result["commands"]?.objectValue ?? [:]
        let skills = result["skills"]?.objectValue ?? [:]
        var commands: [SlashCommand] = []
        var unavailable: [String: String] = [:]
        var seen: Set<String> = []

        for category in result["categories"]?.arrayValue ?? [] {
            let terminalOnly = ["tui", "exit"].contains(category["name"]?.stringValue?.lowercased() ?? "")
            for pair in category["pairs"]?.arrayValue ?? [] {
                guard let key = pair.arrayValue?.first?.stringValue, let name = bare(key), seen.insert(name).inserted else { continue }
                let tag = meta[key]?["desktop"]?.stringValue ?? (terminalOnly ? "terminal" : nil)
                if let why = whyNot(name, tag: tag) {
                    unavailable[name] = why
                    continue
                }
                // "hidden" runs but is not offered: the app has something better.
                guard tag == nil else { continue }
                let (summary, usage) = described(pair.arrayValue?.dropFirst().first?.stringValue ?? "", name: name)
                let allowed = meta[key]?["desktop_subcommands"]?.arrayValue?.compactMap(\.stringValue)
                commands.append(SlashCommand(
                    name: name, summary: summary, usage: allowed.map { $0.joined(separator: " | ") } ?? usage,
                    kind: .host, allowedArguments: allowed?.isEmpty == false ? allowed : nil
                ))
            }
        }
        // Names the registry knows that are in no category (aliases, messaging-only ones).
        for (key, entry) in meta {
            guard let name = bare(key), !seen.contains(name), let why = whyNot(name, tag: entry["desktop"]?.stringValue) else { continue }
            unavailable[name] = why
        }

        // Skills are every pair that is not a command, the most used first.
        let skillPairs = (result["pairs"]?.arrayValue ?? []).compactMap { pair -> (name: String, summary: String, uses: Int)? in
            guard let key = pair.arrayValue?.first?.stringValue, let entry = skills[key], let name = bare(key), !seen.contains(name) else { return nil }
            return (name, pair.arrayValue?.dropFirst().first?.stringValue ?? "", entry["usage"]?.intValue ?? 0)
        }
        for skill in skillPairs.sorted(by: { ($1.uses, $0.name) < ($0.uses, $1.name) }) where seen.insert(skill.name).inserted {
            commands.append(SlashCommand(name: skill.name, summary: skill.summary, usage: "[instructions]", kind: .skill))
        }

        var aliases: [String: String] = [:]
        for (alias, target) in result["canon"]?.objectValue ?? [:] {
            guard let from = bare(alias), let to = target.stringValue.flatMap(bare), from != to else { continue }
            aliases[from] = to
        }
        return CommandCatalog(commands: commands, aliases: aliases, unavailable: unavailable)
    }

    /// "/status" without its slash, lower case.
    private static func bare(_ key: String) -> String? {
        let name = key.drop { $0 == "/" }.lowercased()
        return name.isEmpty ? nil : name
    }

    /// Why a command cannot be run from the app, or nil when it can. `tag` is Hermes's
    /// own word for where the command belongs; nil and "hidden" both run.
    private static func whyNot(_ name: String, tag: String?) -> String? {
        switch tag {
        case "terminal": "/\(name) only works in Hermes's terminal app."
        case "messaging": "/\(name) only works in a messaging app such as Discord."
        case nil, "hidden": needsItsOwnScreen.contains(name) ? "/\(name) is not available in Portals." : nil
        default: "/\(name) is not available in Portals."
        }
    }

    /// Hermes writes what can follow a command at the end of its description:
    /// "Back up N user turns (usage: /undo [N])". The two are told apart here.
    private static func described(_ text: String, name: String) -> (summary: String, usage: String?) {
        guard let marker = text.range(of: " (usage: ", options: .backwards), text.hasSuffix(")") else { return (text, nil) }
        let summary = String(text[..<marker.lowerBound])
        var usage = text[marker.upperBound...].dropLast().trimmingCharacters(in: .whitespaces)
        if usage.lowercased().hasPrefix("/\(name)") { usage = usage.dropFirst(name.count + 1).trimmingCharacters(in: .whitespaces) }
        return (summary, usage.isEmpty ? nil : usage)
    }

    // MARK: Running one

    /// What Hermes answered to a command.
    enum Answer: Hashable {
        /// What it asks of the app.
        case outcome(CommandOutcome)
        /// The command is another name for this one, which is to be run in its place.
        case standsFor(SlashInput)
    }

    /// Reads a `slash.exec` or `command.dispatch` result.
    static func answer(in result: JSONValue, to command: SlashInput) throws -> Answer {
        let note = result["notice"]?.stringValue.map(HermesEventMapper.plain).flatMap { $0.isEmpty ? nil : $0 }
        let message = result["message"]?.stringValue ?? ""
        switch result["type"]?.stringValue {
        case nil, "exec", "plugin":
            let body = readable(result["output"]?.stringValue ?? "")
            let warning = result["warning"]?.stringValue.map(HermesEventMapper.plain) ?? ""
            let text = [warning.isEmpty ? nil : "Warning: \(warning)", body.isEmpty ? nil : body].compactMap(\.self).joined(separator: "\n\n")
            return .outcome(.output(text.isEmpty ? "No output." : text))
        case "alias":
            guard let target = result["target"]?.stringValue.flatMap(bare) else {
                throw HermesBackendError.commandUnusable("Hermes could not say what \(command.text) stands for.")
            }
            return .standsFor(SlashInput(name: target, argument: command.argument))
        case "skill", "send":
            guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw HermesBackendError.commandUnusable("Hermes had nothing to send for \(command.text).")
            }
            let shown = result["display"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            return .outcome(.message(message, shownAs: shown?.isEmpty == false ? shown : nil, note: note))
        case "prefill":
            return .outcome(.draft(message, note: note))
        case let other?:
            throw HermesBackendError.commandUnusable("Hermes answered \(command.text) in a way this app does not know (\(other)).")
        }
    }

    /// A command's output as text for a phone. Hermes writes it for a terminal:
    /// coloured, indented two spaces, with blank lines around it, and a one-line
    /// answer often opens with the terminal's face ("(._.) No active agent").
    static func readable(_ output: String) -> String {
        var lines = output
            .replacing(/\u{1B}\[[0-9;]*[A-Za-z]/, with: "")
            .replacing("\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in String(line).replacing(/\s+$/, with: "") }
        while lines.first?.isEmpty == true { lines.removeFirst() }
        while lines.last?.isEmpty == true { lines.removeLast() }
        let indent = lines.filter { !$0.isEmpty }.map { $0.prefix { $0 == " " }.count }.min() ?? 0
        lines = lines.map { String($0.dropFirst(min(indent, $0.count))) }
        if lines.count == 1, let line = lines.first {
            return withoutFace(line)
        }
        return lines.joined(separator: "\n")
    }

    /// A line without the face it opens with: a short bracketed run of symbols with no
    /// word in it ("(._.)", "(^_^)/"), and whatever punctuation follows.
    private static func withoutFace(_ line: String) -> String {
        guard let first = line.first, "([".contains(first) else { return line }
        guard let close = line.firstIndex(where: { ")]".contains($0) }), line.distance(from: line.startIndex, to: close) <= 12 else { return line }
        let inside = line[line.index(after: line.startIndex)..<close]
        let hasWord = zip(inside, inside.dropFirst()).contains { $0.isLetter && $1.isLetter }
        guard !hasWord else { return line }
        let rest = line[line.index(after: close)...].drop { !$0.isLetter && !$0.isNumber }
        return rest.isEmpty ? line : String(rest)
    }
}
