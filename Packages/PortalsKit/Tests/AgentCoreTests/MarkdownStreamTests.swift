import Foundation
import Testing
@testable import AgentCore

/// `MarkdownStream` gives what `Markdown.blocks` gives for the whole text, at every step
/// of a reply being written, while parsing only what follows its last cut.
@Suite struct MarkdownStreamTests {
    /// Feeds `source` to a stream a few characters at a time, as a reply's reveal does,
    /// and checks every step against a whole parse.
    private func expectSameAsWhole(_ source: String, step: Int = 3, sourceLocation: SourceLocation = #_sourceLocation) {
        var stream = MarkdownStream()
        var length = 0
        while length < source.count {
            length = min(length + step, source.count)
            let shown = String(source.prefix(length))
            let streamed = stream.blocks(shown)
            let whole = Markdown.blocks(shown)
            #expect(streamed == whole, "after \(length) characters: \(shown.debugDescription)", sourceLocation: sourceLocation)
            if streamed != whole { return }
        }
    }

    /// The fake agent's bench reply, as its four pieces come in a turn.
    private static let benchReply = """
        ## Part 1: the engine's parser (round 3)

        I read through the parser first, to see where the time goes before changing anything. The short version: most of the cost is in one loop.

        1. **The entry point**, `Engine.run(_:)`, which takes the input and hands it to the stages one by one.
        2. **The hot loop** in `Stage.advance()`, called once per piece of input. It walks `buffer` from the start.
        3. **The cache**, which is keyed by the whole buffer's hash, so it never hits while the input grows.
           - The hash itself is `O(n)`, so even a miss costs as much as the work it was meant to save.
           - Entries are never evicted, so a long session holds every intermediate state.
        4. **The output stage**, which is fine: it only looks at what changed.

        That confirms it. The loop in `advance()` costs $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$ steps for $n$ pieces, so $2 \\times 10^{6}$ visits.

        ```swift
        struct Stage {
            private var settled = 0

            mutating func advance(_ buffer: [Piece]) -> [Output] {
                defer { settled = buffer.count }
            }
        }
        ```

        With that, the cost per piece is constant, and the whole run is $T(n) = c \\cdot n$.

        | Input | Pieces | Before (ms) | After (ms) |
        | --- | ---: | ---: | ---: |
        | short reply | 120 | 1.9 | 0.4 |
        | long reply | 2,000 | 412.0 | 6.1 |

        > The huge log was the case that timed out in CI.

        - The cache is now keyed by the stage's position.
        - The ratio is $\\lim_{n \\to \\infty} \\frac{n^2}{n} = \\infty$.

        ## Summary

        $$\\text{speedup} = \\frac{T_{\\text{before}}}{T_{\\text{after}}} \\approx 816$$

        Next, I'd suggest running the full suite once more.

        """

    /// A settled block is given again as it was at every later step while the text carries
    /// on, and the count of starts over does not move: what lets a reply's view skip
    /// comparing those blocks at each step of its reveal.
    @Test func settledBlocksStayAsTheyWereUntilTheTextStartsOver() {
        var stream = MarkdownStream()
        let source = Self.benchReply
        var length = 0
        var settled: [MarkdownBlock] = []
        while length < source.count {
            length = min(length + 7, source.count)
            let blocks = stream.blocks(String(source.prefix(length)))
            #expect(stream.startedOver == 0)
            #expect(stream.settledCount >= settled.count)
            #expect(Array(blocks.prefix(settled.count)) == settled, "after \(length) characters")
            settled = Array(blocks.prefix(stream.settledCount))
        }
        #expect(settled.count > 3)

        // Text that does not carry on: started over, once.
        _ = stream.blocks("# Another reply\n\nWritten anew")
        #expect(stream.startedOver == 1)
        _ = stream.blocks("# Another reply\n\nWritten anew, and more.")
        #expect(stream.startedOver == 1)
    }

    @Test func theBenchReplyAtEveryStep() {
        expectSameAsWhole(Self.benchReply, step: 1)
        expectSameAsWhole(Self.benchReply, step: 7)
    }

    @Test func theShowcases() {
        expectSameAsWhole(FakeBackend.markdownShowcase)
        expectSameAsWhole(FakeBackend.mathShowcase)
    }

    @Test func aLooseNumberedListKeepsItsNumbers() {
        // A blank line between items: the third is still the list's third, and an
        // item's later paragraph is still the item's.
        expectSameAsWhole("Steps:\n\n1. one\n\n2. two\n\n   more about two\n\n3. three\n\nAfter the list.\n\n4. a new list\n", step: 1)
        expectSameAsWhole("- a\n\n- b\n\n  - nested after a blank\n\n- c\n\ntext\n", step: 1)
        expectSameAsWhole("5. starts at five\n\n6. six\n\nPara\n\n7) other\n", step: 1)
    }

    @Test func codeWithBlankLinesInside() {
        expectSameAsWhole("Before.\n\n```\nlet a = 1\n\nlet b = 2\n\n# not a heading\n```\n\nAfter.\n\n~~~~\nx\n\n~~~\nstill code\n~~~~\n\nEnd.\n", step: 1)
        // An indented code block, and fenced code inside a list item.
        expectSameAsWhole("Para.\n\n    indented\n\n    more\n\nNext.\n\n- item\n\n  ```\n  code\n\n  more\n  ```\n\nDone.\n", step: 1)
    }

    @Test func mathAcrossLines() {
        expectSameAsWhole("Text.\n\n$$\na + b\n= c\n$$\n\nAnd $x$ inline.\n\n\\[\nx^2\n\\]\n\nThen $5 and $10.\n\n$$ unclosed\n\nnext\n", step: 1)
    }

    @Test func quotesTablesAndRules() {
        expectSameAsWhole("> one\n> two\n\n> three\n\n---\n\n***\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n\nTitle\n=====\n\nEnd\n", step: 1)
    }

    @Test func definitionsAndHTMLAreParsedWhole() {
        expectSameAsWhole("See [the docs][docs] first.\n\nMore text.\n\n[docs]: https://example.com\n\nAfter.\n", step: 1)
        expectSameAsWhole("Before.\n\n<!-- a comment\n\nover blank lines -->\n\nAfter.\n", step: 1)
        expectSameAsWhole("Line one\r\n\r\nLine two\r\n", step: 1)
    }

    @Test func fencesTheLinesCannotTellApart() {
        // A line indented four spaces inside fenced code is code, not its closing fence;
        // a fence opened after a list item's marker closes on an indented line.
        expectSameAsWhole("Before.\n\n```\na\n    ```\n\nB.\n", step: 1)
        expectSameAsWhole("- ```\n  a\n  ```\n\nB.\n\n```\nc\n\nD.\n", step: 1)
        expectSameAsWhole("> ```\n> a\n\n```\nb\n\nC.\n```\n\nE.\n", step: 1)
    }

    /// A widget's HTML and CSS look like HTML blocks and link definitions to a line,
    /// but in a fence that is surely one they are code: the reply is not parsed whole.
    private static let widgetReply = """
        Here is the chart.

        ```portals-visual title="Latency" height=320
        <!-- a comment -->
        <style>
          [data-x]:hover { color: red; }
          .a { margin: 0 }

          .b { padding: 0 }
        </style>
        [label]: value
        <div data-x>[a]: b</div>

        <script>
          const total = `$${1 + 2}`;
        </script>
        ```

        After the widget, a paragraph that says [a] and [label].

        Another paragraph.
        """

    @Test func aWidgetDoesNotHaveTheReplyParsedWhole() {
        expectSameAsWhole(Self.widgetReply, step: 1)
        var stream = MarkdownStream()
        for length in 1...Self.widgetReply.count { _ = stream.blocks(String(Self.widgetReply.prefix(length))) }
        #expect(!stream.isParsingWhole)
        // The opening paragraph and the widget: the last line is still being written.
        #expect(stream.settledCount == 2)
    }

    /// A visual keeps its place in the reply while it is written (its page is drawn under
    /// it, `WidgetKey`), in a fence of four backticks with three inside it, or of tildes,
    /// after a list and a table.
    @Test func aVisualKeepsItsPlaceWhileItIsWritten() {
        let reply = """
            Two things:
            - one
            - two
            | a | b |
            |---|---|
            | 1 | 2 |
            ````portals-visual title="Four"
            <pre>
            ```
            not the end
            ```
            </pre>
            ````
            Between.

            ~~~portals-visual title="Tildes"
            <p>```</p>
            ~~~
            """
        expectSameAsWhole(reply, step: 1)
        var stream = MarkdownStream()
        var places: [String: Set<Int>] = [:]
        for length in 1...reply.count {
            for block in stream.blocks(String(reply.prefix(length))) {
                if case let .widget(widget) = block.kind { places[widget.title ?? "", default: []].insert(block.id) }
            }
        }
        #expect(places.count == 2)
        #expect(places.values.allSatisfy { $0.count == 1 }, "\(places)")
        let whole = Markdown.blocks(reply).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } }
        #expect(whole.map(\.title) == ["Four", "Tildes"])
        #expect(whole.first?.source == "<pre>\n```\nnot the end\n```\n</pre>")
        #expect(whole.allSatisfy { $0.isComplete })
    }

    @Test func fencesThatMayNotBeTheParsersStillHaveDefinitionsLookedFor() {
        // Where the count of fences may differ from the parser's, what it takes for code
        // can be a definition, which the links above it point to.
        expectSameAsWhole("See [x].\n\nMiddle.\n\n- ```\n  a\n  ```\n\n[x]: https://example.com\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\nMiddle.\n\n> ```\n> a\n\n```\n[x]: https://example.com\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\nMiddle.\n\n```\na\n    ```\n\nstill code\n```\n\n```\n[x]: https://example.com\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\nMiddle.\n\n``` a`b\n\n```\n[x]: https://example.com\n```\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\nMiddle.\n\n<div>\n```\n</div>\n\n[x]: https://example.com\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\n- item\n\n  ```\n  code\n```\nX\n```\n[x]: https://example.com\n\nEnd.\n", step: 1)
        expectSameAsWhole("See [x].\n\nMiddle.\n\n  ```\n[x]: https://example.com\n  ```\n\nEnd.\n", step: 1)
    }

    @Test func definitionsInQuotesListsAndOverLines() {
        expectSameAsWhole("See [docs].\n\nMiddle.\n\n> [docs]: https://example.com\n", step: 1)
        expectSameAsWhole("See [docs].\n\nMiddle.\n\n- [docs]: https://example.com\n", step: 1)
        expectSameAsWhole("See [the docs].\n\nMiddle.\n\n[the\ndocs]: https://example.com\n", step: 1)
    }

    @Test func aByteOrderMarkHidesNoDefinition() {
        // The parser leaves out a byte order mark at the start: the line after it is a
        // definition, which the links written later point to.
        expectSameAsWhole("\u{FEFF}[docs]: https://example.com\n\nMiddle.\n\nSee [docs].\n", step: 1)
        expectSameAsWhole("Para.\n\n\u{FEFF}Text after a mark.\n\nMore.\n", step: 1)
    }

    /// Once the parser does not agree with a cut, the reply is parsed whole: a long
    /// code block counted as closed is not asked about again at every blank line in it.
    @Test func aCutRefusedLeavesTheReplyParsedWhole() {
        var stream = MarkdownStream()
        var reply = "- ```\n  a\n  ```\n\nB.\n\n```\n"
        for line in 0..<6 { reply += "x\(line)\n\nfunc f\(line)() {}\n" }
        reply += "```\n\nAfter.\n"
        var length = 0
        while length < reply.count {
            length = min(length + 1, reply.count)
            let shown = String(reply.prefix(length))
            #expect(stream.blocks(shown) == Markdown.blocks(shown))
        }
        #expect(stream.settledCount == 0)
        #expect(stream.isParsingWhole)
    }

    @Test func aPlaceholderAnywhereLeavesNoFormulaAnywhere() {
        // MathProtection protects nothing in a text that already has one of its
        // placeholders, wherever it is.
        expectSameAsWhole("$x_1$\n\nMiddle.\n\n\u{F0000}", step: 1)
        expectSameAsWhole("\u{F0000}\n\nMiddle.\n\n$x_1$", step: 1)
    }

    @Test func settledBlocksAreKept() {
        var stream = MarkdownStream()
        // Cut before the last whole line after a blank one: "Third" is still being
        // written.
        _ = stream.blocks("First paragraph.\n\nSecond paragraph.\n\nThird")
        #expect(stream.settledCount == 1)
        let more = stream.blocks("First paragraph.\n\nSecond paragraph.\n\nThird, and more.\n\nFourth")
        #expect(stream.settledCount == 2)
        #expect(more.map(\.id) == [0, 1, 2, 3])
    }

    @Test func anotherTextStartsAgain() {
        var stream = MarkdownStream()
        _ = stream.blocks("One.\n\nTwo.\n\nThree")
        #expect(stream.blocks("Other.\n\nText") == Markdown.blocks("Other.\n\nText"))
        #expect(stream.blocks("") == [])
    }

    /// Replies put together at random from the pieces agents write, in every order, each
    /// checked at every few characters.
    @Test(arguments: 0..<24) func repliesPutTogetherAtRandom(seed: UInt64) {
        var random = SplitMix(seed: seed)
        let pieces = [
            "## Heading \(seed)\n\n",
            "A paragraph with `code`, **bold** and $x^2$ in it.\nIt goes on a second line.\n\n",
            "1. one\n2. two\n3. three\n\n",
            "1. loose one\n\n2. loose two\n\n   more of two\n\n",
            "- a\n- b\n  - nested\n\n",
            "- item\n\n  ```sh\n  make\n\n  make test\n  ```\n\n",
            "```swift\nlet a = 1\n\nlet b = 2\n```\n\n",
            "$$\na + b\n$$\n\n",
            "> quoted\n> more\n\n",
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n",
            "---\n\n",
            "    indented code\n\n    more\n\n",
            "Text right before a list:\n- x\n- y\n\n",
            "7. starts at seven\n8. eight\n\n",
            "Title\n=====\n\n",
            "2024 was a year; 3.5 is a number.\n\n",
            "```portals-visual title=\"W\"\n<style>\n[data-x]:hover { color: red }\n</style>\n<!-- c -->\n\n<div>[a]: b</div>\n```\n\n",
            "See [a] here.\n\n",
        ]
        var reply = ""
        for _ in 0..<12 { reply += pieces[Int(random.next() % UInt64(pieces.count))] }
        expectSameAsWhole(reply, step: 1 + Int(random.next() % 5))
    }

    /// The same with the pieces that look like one thing to a line and are another to
    /// the parser: fences after a list item's marker or in a quote, lines of backticks
    /// indented as code or inside fenced code, definitions in quotes and lists.
    @Test(arguments: 0..<24) func trickyRepliesPutTogetherAtRandom(seed: UInt64) {
        var random = SplitMix(seed: seed &+ 1000)
        let pieces = [
            "Plain paragraph \(seed).\n\n",
            "```\na\n    ```\n\nstill code\n```\n\n",
            "- ```\n  in the item\n  ```\n\n",
            "> ```\n> quoted code\n\n",
            "    ```\n    indented, not a fence\n\n",
            "~~~\ntilde code\n\n```\nnot closing\n~~~\n\n",
            "```\n",
            "See [docs] and [more].\n\n",
            "> [docs]: https://example.com\n\n",
            "- [more]: https://example.org\n\n",
            "1. step\n\n   ```sh\n   run\n\n   again\n   ```\n\n",
            "Inline `code` and $y_2$.\n\n",
            "<div>\nhtml\n</div>\n\n",
            "```portals-visual\n<script>\nlet a = 1\n\n</script>\n[docs]: in code\n```\n\n",
            "- ```portals-visual\n  <b>in a list</b>\n  ```\n\n",
            "<div>\n```\n</div>\n\n",
        ]
        var reply = ""
        for _ in 0..<10 { reply += pieces[Int(random.next() % UInt64(pieces.count))] }
        expectSameAsWhole(reply, step: 1 + Int(random.next() % 4))
    }

    @Test func aLineStillBeingWrittenIsNotCutBefore() {
        var stream = MarkdownStream()
        // "2" could become "2. ", the list's second item.
        _ = stream.blocks("1. one\n\n2")
        #expect(stream.settledCount == 0)
        #expect(stream.blocks("1. one\n\n2. two\n") == Markdown.blocks("1. one\n\n2. two\n"))
    }
}

/// A small seeded generator, the same on every run.
private struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// What parsing a reply at every step of its reveal costs, whole and with
/// `MarkdownStream`: a reply of about 2,000 and 12,000 characters revealed 8 characters
/// a step. Only when asked:
///
///     PORTALS_BENCH=1 swift test -c release --filter MarkdownStreamBenchmarks
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["PORTALS_BENCH"] == "1", "Only with PORTALS_BENCH=1")) struct MarkdownStreamBenchmarks {
    @Test(arguments: [1, 6]) func parsingAtEveryStep(copies: Int) {
        let reply = String(repeating: FakeBackend.markdownShowcase + "\n\n", count: copies)
        func time(_ parse: (String) -> [MarkdownBlock]) -> (seconds: Double, steps: Int) {
            let clock = ContinuousClock()
            var steps = 0
            let elapsed = clock.measure {
                var length = 0
                while length < reply.count {
                    length = min(length + 8, reply.count)
                    _ = parse(String(reply.prefix(length)))
                    steps += 1
                }
            }
            return (Double(elapsed.components.attoseconds) / 1e18 + Double(elapsed.components.seconds), steps)
        }
        let whole = time(Markdown.blocks)
        var stream = MarkdownStream()
        let streamed = time { stream.blocks($0) }
        print(String(format: "reply of %d characters, %d steps: whole %.2f ms a step, stream %.2f ms a step",
                     reply.count, whole.steps, whole.seconds * 1000 / Double(whole.steps), streamed.seconds * 1000 / Double(streamed.steps)))
    }

    /// A long reply with no cut (one paragraph on one line, code still open, one list, or
    /// code whose blank lines look like cuts the parser refuses): the stream has nothing
    /// to keep, and has to cost what a whole parse costs. Fifty steps of 40 characters
    /// from 80,000 characters on.
    @Test(arguments: ["line", "code", "list", "refused", "showcase"]) func aLongReplyWithNoCut(kind: String) {
        let reply: String = switch kind {
        case "line": String(repeating: "A sentence with **bold**, `code` and $x^2$ in it, ", count: 2_000)
        case "code": "```swift\n" + String(repeating: "let value = compute(input, with: options) // and so on\n", count: 1_700)
        case "list": String(repeating: "- an item with *emphasis* and a [link](https://example.com)\n", count: 1_500)
        // Code the fence count takes for prose: a cut at every blank line, each refused.
        case "refused": "- ```\n  a\n  ```\n\nB.\n\n```\n" + String(repeating: "x = compute(input, with: options)\n\ndef f(): pass\n", count: 2_000)
        default: String(repeating: FakeBackend.markdownShowcase + "\n\n", count: 40)
        }
        let start = 80_000
        let prefixes = (0..<50).map { String(reply.prefix(start + $0 * 40)) }
        let clock = ContinuousClock()
        let whole = clock.measure { for text in prefixes { _ = Markdown.blocks(text) } }
        var stream = MarkdownStream()
        _ = stream.blocks(String(reply.prefix(start - 40)))
        let streamed = clock.measure { for text in prefixes { _ = stream.blocks(text) } }
        func ms(_ duration: Duration) -> Double {
            (Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18) * 1000 / Double(prefixes.count)
        }
        print(String(format: "%@ of %d characters: whole %.2f ms a step, stream %.2f ms a step (%.2fx), %d blocks kept",
                     kind, start, ms(whole), ms(streamed), ms(streamed) / ms(whole), stream.settledCount))
    }
}
