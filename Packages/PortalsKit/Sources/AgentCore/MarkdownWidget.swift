import Foundation

/// A visual in a reply (called a widget in the code, as it was at first): a fenced code
/// block at the top level whose info string starts with `portals-visual`, or
/// `portals-widget` as it did at first, holding HTML the app draws live instead of code
/// (WidgetViews.swift). Agents are told how to write one by the bridge
/// (`portals guide visuals`); other apps show the code.
public struct MarkdownWidget: Hashable, Sendable {
    /// The name on its card, from `title="…"`.
    public var title: String?
    /// A fixed height in points, from `height=N`; nil for as tall as its content.
    public var height: Int?
    /// The HTML, as written.
    public var source: String
    /// False while its fence is still open: the reply is being written, or ended inside it.
    public var isComplete: Bool

    /// The code block language that makes a visual.
    public static let language = "portals-visual"
    /// The languages drawn: the one agents are told, and the one they were told at first.
    public static let languages = [language, "portals-widget"]
    /// The fixed heights a widget may ask for.
    public static let heights = 48...2000
    /// The longest title kept, in characters.
    public static let titleLength = 80
    /// The most HTML drawn as a widget, in UTF-8 bytes; more is shown as code.
    public static let maximumSource = 200_000

    public init(title: String? = nil, height: Int? = nil, source: String = "", isComplete: Bool = true) {
        self.title = title
        self.height = height
        self.source = source
        self.isComplete = isComplete
    }

    /// The widget an info string opens, if it opens one: `portals-widget` as its first
    /// word, then `key=value` pairs, a value bare or in quotes. Unknown keys are left
    /// out; of a key given twice, the first counts.
    public init?(infoString: String) {
        var rest = Substring(infoString).drop(while: \.isWhitespace)
        let word = rest.prefix { !$0.isWhitespace }
        guard Self.languages.contains(String(word)) else { return nil }
        rest = rest.dropFirst(word.count)
        var title: String?
        var height: Int?
        var seen: Set<Substring> = []
        while true {
            rest = rest.drop(while: \.isWhitespace)
            guard !rest.isEmpty else { break }
            let key = rest.prefix { !$0.isWhitespace && $0 != "=" }
            rest = rest.dropFirst(key.count)
            var value: Substring = ""
            if rest.first == "=" {
                rest = rest.dropFirst()
                if let quote = rest.first, quote == "\"" || quote == "'" {
                    // A quote left open takes the rest of the line.
                    rest = rest.dropFirst()
                    value = rest.prefix { $0 != quote }
                    rest = rest.dropFirst(value.count).dropFirst()
                } else {
                    value = rest.prefix { !$0.isWhitespace }
                    rest = rest.dropFirst(value.count)
                }
            }
            guard seen.insert(key).inserted else { continue }
            switch key {
            case "title":
                let trimmed = value.trimmingCharacters(in: .whitespaces)
                title = trimmed.isEmpty ? nil : String(trimmed.prefix(Self.titleLength))
            case "height":
                height = Int(value).map { min(max($0, Self.heights.lowerBound), Self.heights.upperBound) }
            default:
                break
            }
        }
        self.init(title: title, height: height)
    }

    /// Whether there is too much HTML to draw it.
    public var isTooLarge: Bool { source.utf8.count > Self.maximumSource }

    /// What a widget is called where it cannot be drawn: in text selected or copied, in
    /// a notification.
    public var name: String {
        title.map { "[Visual: \($0)]" } ?? "[Visual]"
    }

    /// A hash of the HTML that is the same from one launch to the next, unlike Swift's
    /// `Hasher`: what a widget's measured height is remembered under (FNV-1a, 64 bits).
    public var sourceHash: UInt64 { Self.hash(source) }

    static func hash(_ text: String) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
        }
        return hash
    }
}

extension MarkdownBlock {
    /// Whether the block is a widget.
    public var isWidget: Bool {
        if case .widget = kind { true } else { false }
    }
}

extension ToolRun {
    /// Whether the call read how to write a visual (`portals guide visuals`, or
    /// `widgets` as it was at first): the agent is about to make one.
    public var readsWidgetGuide: Bool {
        [label, input].contains { text in
            guard let text, text.contains("portals") else { return false }
            return text.contains("guide visuals") || text.contains("guide widgets")
        }
    }
}

extension Turn {
    /// Whether the agent read how to write a widget in this turn and has not started
    /// writing one since.
    public var isPlanningWidget: Bool {
        guard let read = lastWidgetGuideRead else { return false }
        return !items[(read + 1)...].contains { item in
            guard case let .text(text) = item.content else { return false }
            return MarkdownWidget.isOpened(in: text)
        }
    }

    /// Whether a visual the agent is about to show has no place in the reply yet, so the
    /// app holds that place for it: the agent read how to write one in this turn and has
    /// not begun it (`isPlanningWidget`), or the reply has begun more visuals than it
    /// shows (`shown`, the visuals the reply's views have laid out: they ease the text in,
    /// so they can be a moment behind).
    public func awaitsWidget(shown: Int) -> Bool {
        guard isRunning, lastWidgetGuideRead != nil else { return false }
        if isPlanningWidget { return true }
        let begun = items.reduce(0) { count, item in
            guard case let .text(text) = item.content else { return count }
            return count + MarkdownWidget.begunCount(in: text)
        }
        return begun > shown
    }

    private var lastWidgetGuideRead: Int? {
        items.lastIndex { if case let .tool(run) = $0.content { run.readsWidgetGuide } else { false } }
    }
}

extension MarkdownWidget {
    /// Whether `text` has a line that opens a visual's fence: up to three spaces, three
    /// or more backticks or tildes, any spaces, and one of `languages` as the first word
    /// (`Markdown` draws only those at the top level, but one in a list is being written
    /// all the same).
    static func isOpened(in text: String) -> Bool {
        guard text.contains("portals-") else { return false }
        return text.split(separator: "\n", omittingEmptySubsequences: true).contains { opens($0, inLists: true) }
    }

    /// How many visuals `text` begins where they are drawn, as agents are told to write
    /// them: lines that open a visual's fence at their very start, so not in a list or a
    /// quote, whose lines are indented or marked. A fence line in a visual's HTML (three
    /// backticks in one opened with four) does not name a visual.
    static func begunCount(in text: String) -> Int {
        guard text.contains("portals-") else { return 0 }
        return text.split(separator: "\n", omittingEmptySubsequences: true).count { opens($0, inLists: false) }
    }

    private static func opens(_ line: Substring, inLists: Bool) -> Bool {
        let indent = line.prefix { $0 == " " }.count
        guard indent < (inLists ? 4 : 1) else { return false }
        let content = line.dropFirst(indent)
        // In a list item or a quote, after its marks.
        let unmarked = inLists ? content.drop { $0 == ">" || $0 == "-" || $0 == "*" || $0 == "+" || $0 == " " || $0.isNumber || $0 == "." || $0 == ")" } : content
        guard let marker = unmarked.first, marker == "`" || marker == "~" else { return false }
        let fence = unmarked.prefix { $0 == marker }
        guard fence.count >= 3 else { return false }
        let word = unmarked.dropFirst(fence.count).drop { $0 == " " || $0 == "\t" }.prefix { !$0.isWhitespace }
        return languages.contains(String(word))
    }
}
