import Foundation
import Testing
@testable import AgentCore

@Suite struct MarkdownTests {
    private func kinds(_ source: String) -> [MarkdownBlock.Kind] {
        Markdown.blocks(source).map(\.kind)
    }

    private func texts(_ source: String) -> [String] {
        Markdown.blocks(source).map(\.plainText)
    }

    @Test func plainTextKeepsWhatIsSaidWithoutItsMarks() {
        let source = "# Plan\n\nRun **the tests** first, then `make`.\n\n- one\n- two\n  1. nested\n\n```sh\nmake all\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        #expect(Markdown.plainText(source) == "Plan\n\nRun the tests first, then make.\n\n• one\n• two\n    1. nested\n\nmake all\n\na\tb\n1\t2")
        #expect(Markdown.plainText("") == "")
    }

    @Test func paragraphsAndHeadings() {
        let source = "# Title\n\nFirst paragraph.\n\n### Smaller\n\nSecond paragraph."
        #expect(kinds(source) == [.heading(level: 1), .paragraph, .heading(level: 3), .paragraph])
        #expect(texts(source) == ["Title", "First paragraph.", "Smaller", "Second paragraph."])
    }

    @Test func aSingleNewlineStaysInsideTheParagraph() {
        #expect(texts("one\ntwo") == ["one two"])
    }

    @Test func inlineStylingSurvives() throws {
        let block = try #require(Markdown.blocks("Some **bold**, `code` and a [link](https://example.com).").first)
        #expect(block.plainText == "Some bold, code and a link.")

        let runs = block.text.runs
        let bold = try #require(runs.first { String(block.text[$0.range].characters) == "bold" })
        #expect(bold.inlinePresentationIntent == .stronglyEmphasized)
        let code = try #require(runs.first { String(block.text[$0.range].characters) == "code" })
        #expect(code.inlinePresentationIntent == .code)
        let link = try #require(runs.first { String(block.text[$0.range].characters) == "link" })
        #expect(link.link == URL(string: "https://example.com"))
    }

    @Test func bulletsNumbersAndNesting() {
        let source = """
            - one
            - two
              - nested
            1. first
            2. second
            """
        #expect(kinds(source) == [
            .listItem(.bullet, depth: 1),
            .listItem(.bullet, depth: 1),
            .listItem(.bullet, depth: 2),
            .listItem(.number(1), depth: 1),
            .listItem(.number(2), depth: 1),
        ])
        #expect(texts(source) == ["one", "two", "nested", "first", "second"])
    }

    @Test func aSecondParagraphInAnItemHasNoMarker() {
        let source = "1. first\n\n   more about first\n2. second"
        #expect(kinds(source) == [
            .listItem(.number(1), depth: 1),
            .listItem(.none, depth: 1),
            .listItem(.number(2), depth: 1),
        ])
    }

    @Test func codeBlockKeepsItsLayoutAndLanguage() {
        let source = "Before\n\n```swift\nlet x = 1\n\n    indented()\n```\n\nAfter"
        let blocks = Markdown.blocks(source)
        #expect(blocks.map(\.kind) == [.paragraph, .code(language: "swift"), .paragraph])
        #expect(blocks[1].plainText == "let x = 1\n\n    indented()")
    }

    @Test func codeBlockWithoutALanguage() {
        #expect(kinds("```\nplain\n```") == [.code(language: nil)])
    }

    @Test func markdownInsideCodeIsNotInterpreted() {
        let blocks = Markdown.blocks("```\n# not a heading\n**not bold**\n```")
        #expect(blocks.count == 1)
        #expect(blocks[0].plainText == "# not a heading\n**not bold**")
    }

    @Test func anUnclosedFenceWhileStreamingIsStillACodeBlock() {
        let blocks = Markdown.blocks("Here it is:\n\n```python\ndef hello():\n    print(")
        #expect(blocks.map(\.kind) == [.paragraph, .code(language: "python")])
        #expect(blocks[1].plainText == "def hello():\n    print(")
    }

    @Test func fenceClosingRules() {
        #expect(Markdown.closingOpenFence("```\ncode") == "```\ncode\n```")
        #expect(Markdown.closingOpenFence("```\ncode\n```") == "```\ncode\n```")
        #expect(Markdown.closingOpenFence("````\n```\nstill open") == "````\n```\nstill open\n````")
        #expect(Markdown.closingOpenFence("~~~\ncode\n") == "~~~\ncode\n~~~")
        #expect(Markdown.closingOpenFence("no fence `inline`") == "no fence `inline`")
        // A fence line with an info string cannot close a block.
        #expect(Markdown.closingOpenFence("```\na\n```swift\nb") == "```\na\n```swift\nb\n```")
    }

    @Test func quoteAndRule() {
        #expect(kinds("> quoted\n\n---\n\nafter") == [.quote, .rule, .paragraph])
        #expect(Markdown.blocks("---")[0].plainText.isEmpty)
    }

    @Test func table() throws {
        let source = "| Name | Value |\n|---|---|\n| a | 1 |\n| b | `2` |\n\nAfter"
        let blocks = Markdown.blocks(source)
        #expect(blocks.count == 2)
        guard case let .table(table) = blocks[0].kind else {
            Issue.record("expected a table, got \(blocks[0].kind)")
            return
        }
        #expect(table.header.map { String($0.characters) } == ["Name", "Value"])
        #expect(table.rows.map { $0.map { String($0.characters) } } == [["a", "1"], ["b", "2"]])
        #expect(table.columnCount == 2)
        #expect(blocks[1].kind == .paragraph)
    }

    @Test func idsFollowDocumentOrder() {
        #expect(Markdown.blocks("a\n\n- b\n\n```\nc\n```").map(\.id) == [0, 1, 2])
    }

    @Test func emptyAndWhitespaceOnly() {
        #expect(Markdown.blocks("").isEmpty)
        #expect(Markdown.blocks("  \n\n ").isEmpty)
    }

    @Test func aGrowingReplyOnlyAddsOrExtendsBlocks() {
        let full = "# Plan\n\nFirst do this.\n\n- step one\n- step two\n\n```sh\nmake test\n```\n\nDone."
        var previous: [MarkdownBlock.Kind] = []
        for length in stride(from: 1, through: full.count, by: 3) {
            let current = Markdown.blocks(String(full.prefix(length))).map(\.kind)
            #expect(current.count >= previous.count - 1, "blocks should not collapse at \(length)")
            previous = current
        }
        #expect(Markdown.blocks(full).map(\.kind) == [
            .heading(level: 1), .paragraph, .listItem(.bullet, depth: 1), .listItem(.bullet, depth: 1),
            .code(language: "sh"), .paragraph,
        ])
    }

    // MARK: Math

    /// Every formula in the reply, in order, table cells included.
    private func formulas(_ source: String) -> [MathFormula] {
        Markdown.blocks(source).flatMap { block -> [AttributedString] in
            if case let .table(table) = block.kind { return table.header + table.rows.flatMap { $0 } }
            return [block.text]
        }
        .flatMap { text in text.runs.compactMap(\.mathFormula) }
    }

    private func inline(_ latex: String, _ source: String) -> MathFormula {
        MathFormula(latex: latex, isDisplay: false, source: source)
    }

    private func display(_ latex: String, _ source: String) -> MathFormula {
        MathFormula(latex: latex, isDisplay: true, source: source)
    }

    @Test func inlineFormulasBetweenDollarsOrParentheses() {
        #expect(formulas(#"Euler: $e^{i\pi} + 1 = 0$, famously."#) == [inline(#"e^{i\pi} + 1 = 0"#, #"$e^{i\pi} + 1 = 0$"#)])
        #expect(formulas(#"The area \( \pi r^2 \) grows."#) == [inline(#"\pi r^2"#, #"\( \pi r^2 \)"#)])
        #expect(formulas("$a$-$b$") == [inline("a", "$a$"), inline("b", "$b$")])
    }

    @Test func markdownLeavesAFormulaAsWritten() {
        // Unprotected, the underscores would be emphasis and the escapes eaten.
        let source = #"Both $a_1 + b_1$ and \(\{x_i\}\) stay, as does $\frac{1}{2}\,\%$."#
        #expect(Markdown.blocks(source).map(\.plainText) == [source])
        #expect(formulas(source).map(\.latex) == [#"a_1 + b_1"#, #"\{x_i\}"#, #"\frac{1}{2}\,\%"#])
    }

    @Test func displayFormulasStandBetweenTheTextAroundThem() throws {
        let source = "Before\n\n$$\\int_0^1 x\\,dx$$\n\nAfter"
        let blocks = Markdown.blocks(source)
        #expect(blocks.map(\.kind) == [.paragraph, .paragraph, .paragraph])
        #expect(blocks[1].pieces == [.formula(display(#"\int_0^1 x\,dx"#, #"$$\int_0^1 x\,dx$$"#))])
        #expect(blocks[0].pieces.count == 1)

        let inProse = try #require(Markdown.blocks(#"Since \[ x = 1 \] holds, we are done."#).first)
        guard case let .text(before) = inProse.pieces.first, case let .text(after) = inProse.pieces.last, inProse.pieces.count == 3 else {
            Issue.record("expected text, a formula and text, got \(inProse.pieces)")
            return
        }
        #expect(String(before.characters) == "Since")
        #expect(inProse.pieces[1] == .formula(display("x = 1", #"\[ x = 1 \]"#)))
        #expect(String(after.characters) == "holds, we are done.")
    }

    @Test func aDisplayFormulaCanSpanLines() {
        let aligned = "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}"
        #expect(formulas("$$\n\(aligned)\n$$") == [display(aligned, "$$\n\(aligned)\n$$")])
        #expect(formulas("\\[\n\(aligned)\n\\]").map(\.latex) == [aligned])
    }

    @Test func aDisplayFormulaInAListItemStaysInTheItem() throws {
        // As Codex models write them, indented under the item.
        let source = "1. First:\n   \\[\n   E = mc^2\n   \\]\n2. Second, with $x$."
        let blocks = Markdown.blocks(source)
        #expect(blocks.map(\.kind) == [.listItem(.number(1), depth: 1), .listItem(.number(2), depth: 1)])
        let pieces = blocks[0].pieces
        #expect(pieces.count == 2)
        if case let .text(text) = pieces.first { #expect(String(text.characters) == "First:") }
        #expect(pieces.last == .formula(display("E = mc^2", "\\[\n   E = mc^2\n   \\]")))
        #expect(blocks[1].pieces == [.text(blocks[1].text)])
    }

    @Test func formulasInHeadingsQuotesAndTables() throws {
        #expect(formulas("## The $n$-th term\n\n> where $a_n \\to 0$") == [inline("n", "$n$"), inline(#"a_n \to 0"#, #"$a_n \to 0$"#)])

        // A bar inside a formula does not split the cell.
        let blocks = Markdown.blocks("| f | value |\n|---|---|\n| $x_1$ | $|x|$ |")
        guard case let .table(table) = blocks.first?.kind else {
            Issue.record("expected a table, got \(blocks.map(\.kind))")
            return
        }
        #expect(table.rows.map { $0.map { String($0.characters) } } == [["$x_1$", "$|x|$"]])
        #expect(table.rows[0].map { $0.runs.first?.mathFormula?.latex } == ["x_1", "|x|"])
    }

    @Test func aFormulaKeepsTheStylingAroundIt() throws {
        let block = try #require(Markdown.blocks("**$x$** and [$y$](https://example.com)").first)
        let x = try #require(block.text.runs.first { $0.mathFormula?.latex == "x" })
        #expect(x.inlinePresentationIntent == .stronglyEmphasized)
        let y = try #require(block.text.runs.first { $0.mathFormula?.latex == "y" })
        #expect(y.link == URL(string: "https://example.com"))
    }

    @Test func currencyIsNotMath() {
        for text in [
            "It costs $5 and $10.",
            "Between $20,000 and $30,000 a year.",
            "From $5-$10, or from $1M to $2M.",
            "A $ sign, and US$5.",
            "Escaped: \\$x\\$ and \\$5.",
            "$ x$ and $x $ are not formulas.",
        ] {
            #expect(formulas(text).isEmpty, "\(text)")
        }
        #expect(Markdown.plainText("It costs $5 and $10.") == "It costs $5 and $10.")
        #expect(Markdown.plainText("Escaped: \\$x\\$.") == "Escaped: $x$.")
        // A price before a formula does not swallow it.
        #expect(formulas("It costs $5, and $x^2$ grows.") == [inline("x^2", "$x^2$")])
    }

    @Test func codeIsNotMath() {
        #expect(formulas("Run `echo $HOME$` or ``a $x$ b``, and `\\(y\\)`.").isEmpty)
        #expect(Markdown.plainText("Run `echo $HOME$` or ``a $x$ b``.") == "Run echo $HOME$ or a $x$ b.")

        let fenced = Markdown.blocks("$x$\n\n```sh\necho $$ $y$ \\[z\\]\n```\n\n$w$")
        #expect(fenced.map(\.kind) == [.paragraph, .code(language: "sh"), .paragraph])
        #expect(fenced[1].plainText == "echo $$ $y$ \\[z\\]")
        #expect(formulas("$x$\n\n```sh\necho $$ $y$ \\[z\\]\n```\n\n$w$").map(\.latex) == ["x", "w"])

        // An indented code block, which is not looked for, comes back as written.
        let indented = Markdown.blocks("Text\n\n    cost=$a$b\n")
        #expect(indented.map(\.kind) == [.paragraph, .code(language: nil)])
        #expect(indented[1].plainText == "cost=$a$b")

        // A formula cannot reach into a code span.
        #expect(formulas("$a `b$` c").isEmpty)
    }

    @Test func noFormulaSpansABlankLine() {
        #expect(formulas("$$x\n\ny$$").isEmpty)
        #expect(formulas("$x\n\ny$").isEmpty)
        #expect(formulas("$x\ny$") == [inline("x\ny", "$x\ny$")])
    }

    @Test func anUnclosedDisplayFormulaShowsAsWrittenWhileStreaming() {
        // Not set as Markdown: the underscores stay, and so do the backslashes.
        #expect(texts("Here:\n\n$$\\int_0^1 x_i") == ["Here:", "$$\\int_0^1 x_i"])
        #expect(texts("Here:\n\n\\[ a_1 + b_1") == ["Here:", "\\[ a_1 + b_1"])
        #expect(texts("So \\( a_1 + b_1") == ["So \\( a_1 + b_1"])
        #expect(texts("$$\n\\begin{aligned}\na_1 &= b_1") == ["$$\n\\begin{aligned}\na_1 &= b_1"])
        #expect(formulas("Here:\n\n$$\\int_0^1 x_i").isEmpty)
        // Only at the end: an opener that never closes earlier on is plain text, and the
        // Markdown after it is still read.
        #expect(texts("$$ alone\n\n**bold**") == ["$$ alone", "bold"])
    }

    @Test func aGrowingReplyOnlyShowsWholeFormulas() {
        let full = """
            The roots of $ax^2 + bx + c$ are

            $$
            x_{1,2} = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
            $$

            when $a \\neq 0$, and \\(x\\) costs $5 to compute:

            \\[ \\sum_{i=1}^{n} x_i \\]
            """
        let whole = Set(formulas(full))
        #expect(whole.count == 5)
        for length in 1...full.count {
            let prefix = String(full.prefix(length))
            for formula in formulas(prefix) {
                #expect(whole.contains(formula), "\(formula.source) at \(length)")
            }
            // Half a display formula never loses its backslash to Markdown.
            #expect(!Markdown.plainText(prefix).contains("\n\n["), "at \(length)")
        }
    }

    @Test func plainTextKeepsFormulasWithTheirDelimiters() {
        let source = "Area \\(\\pi r_0^2\\), and\n\n\\[\nE = mc^2\n\\]\n\n- with $a_1$\n- or $$b_1$$"
        #expect(Markdown.plainText(source) == "Area \\(\\pi r_0^2\\), and\n\n\\[\nE = mc^2\n\\]\n\n• with $a_1$\n• or $$b_1$$")
    }

    @Test func placeholdersAlreadyInTheTextLeaveItUnprotected() {
        let source = "\u{F0000} and $x$"
        #expect(formulas(source).isEmpty)
        #expect(Markdown.plainText(source) == source)
    }

    // MARK: Widgets

    @Test func aWidgetFenceIsAWidgetWithItsTitleHeightAndHTML() {
        // A dollar in its script is not math, and nothing in it is styled.
        let html = "<div id=\"a\">**x**</div>\n<script>a.textContent = `$1 and $2`</script>"
        let blocks = Markdown.blocks("Before.\n\n```portals-visual title=\"Build time\" height=360\n\(html)\n```\n\nAfter.")
        #expect(blocks.map(\.kind) == [.paragraph, .widget(MarkdownWidget(title: "Build time", height: 360, source: html)), .paragraph])
        #expect(blocks[1].text == AttributedString())
        #expect(blocks[1].isWidget)
        #expect(!blocks[0].isWidget)
    }

    @Test func theParserGivesACodeBlocksWholeInfoString() {
        // Undocumented, and what a widget's title and height come from: Foundation gives
        // all of the info string as the language, trimmed at its ends only.
        #expect(kinds("```swift title\nlet a = 1\n```") == [.code(language: "swift title")])
        #expect(kinds("``` portals-visual   height=200 \nx\n```") == [.widget(MarkdownWidget(height: 200, source: "x"))])
    }

    @Test func aVisualUnderTheNameItHadAtFirstIsOneToo() {
        #expect(kinds("```portals-widget title=\"Old\"\nx\n```") == [.widget(MarkdownWidget(title: "Old", source: "x"))])
        #expect(MarkdownWidget(infoString: "portals-widget height=200")?.height == 200)
        #expect(Markdown.plainText("```portals-widget title=\"Old\"\nx\n```") == "[Visual: Old]")
    }

    @Test func aWidgetOnlyAtTheTopLevelAndByItsExactName() {
        #expect(kinds("- item\n\n  ```portals-visual\n  <b>x</b>\n  ```") == [.listItem(.bullet, depth: 1), .code(language: "portals-visual")])
        #expect(kinds("> ```portals-visual\n> <b>x</b>\n> ```") == [.code(language: "portals-visual")])
        #expect(kinds("```portals-visuals\nx\n```") == [.code(language: "portals-visuals")])
        #expect(kinds("```PORTALS-WIDGET\nx\n```") == [.code(language: "PORTALS-WIDGET")])
        #expect(kinds("~~~portals-visual\nx\n~~~") == [.widget(MarkdownWidget(source: "x"))])
    }

    @Test func aWidgetIsUnfinishedUntilItsFenceCloses() {
        let reply = "Here:\n\n````portals-visual title=\"T\"\n<div>one</div>\n```\n<div>two</div>\n````\n\nAfter it."
        let closedAt = reply.range(of: "</div>\n````")!.upperBound
        var seen = 0
        for length in 1...reply.count {
            let prefix = reply.prefix(length)
            let widgets = Markdown.blocks(String(prefix)).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } }
            guard let widget = widgets.first else { continue }
            seen += 1
            #expect(widgets.count == 1)
            #expect(widget.title == "T")
            #expect(widget.isComplete == (prefix.endIndex >= closedAt), "at \(length)")
        }
        #expect(seen > 40)
        // A reply that ended inside one leaves it unfinished.
        #expect(kinds("```portals-visual\n<div>half") == [.widget(MarkdownWidget(source: "<div>half", isComplete: false))])
    }

    @Test func aFenceIndentedAsCodeInAVisualDoesNotEndIt() {
        let reply = "```portals-visual\n<pre>\n    ```\n    let x = 1\n    ```\n</pre>\n```\n\nAfter."
        let widgets = { (text: String) in Markdown.blocks(text).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } } }
        let whole = widgets(reply)
        #expect(whole.count == 1)
        #expect(whole.first?.isComplete == true)
        #expect(whole.first?.source.contains("    ```\n    let x = 1\n    ```") == true)
        // Before its own fence, it is unfinished, past the indented ones too.
        let before = String(reply[..<reply.range(of: "</pre>\n```")!.upperBound].dropLast(4))
        #expect(widgets(before).map(\.isComplete) == [false])
        #expect(Markdown.closingOpenFence(before).hasSuffix("</pre>\n```"))
        // Opened with one to three spaces, past three it is still the code's.
        for opener in 1...3 {
            for inner in 4...6 {
                let pad = { (count: Int) in String(repeating: " ", count: count) }
                let open = "\(pad(opener))```portals-visual\n<pre>\n\(pad(inner))```\n</pre>"
                #expect(widgets(open).map(\.isComplete) == [false], "opener \(opener), inner \(inner)")
                #expect(widgets(open + "\n```").map(\.isComplete) == [true], "opener \(opener), inner \(inner)")
            }
        }
        // One with only space in it so far is unfinished too.
        #expect(widgets("```portals-visual\n  ").map(\.isComplete) == [false])
        // Code in a list closes where the item's text lines up, past its opening line: the visual after it is the open one.
        let list = "- item\n\n  ```js\n  const x = 1;\n    ```\n\n```portals-visual\n<div>half</div>"
        #expect(widgets(list).map(\.isComplete) == [false])
        #expect(Markdown.closingOpenFence(list).hasSuffix("<div>half</div>\n```"))
        // Code at the top level, opened a space in: a fence four spaces in is its own line, not its end.
        let top = " ```js\nconst x = 1;\n    ```\nstill code\n```\n\n```portals-visual\n<script>window.ran = true</script>"
        #expect(widgets(top).map(\.isComplete) == [false])
    }

    @Test func aVisualThatEndedStaysFinishedWhenTheNextFenceOpens() {
        let done = "```portals-visual\n<b>x</b>\n```\n\n"
        let widgets = { (text: String) in Markdown.blocks(text).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } } }
        for next in ["```swift\n", "```swift\nlet x", "```portals-visual\n", "```portals-visual"] {
            #expect(widgets(done + next).first?.isComplete == true, "\(next)")
        }
        // The next visual, once something is in it, is the unfinished one.
        #expect(widgets(done + "```portals-visual\n<i>y").map(\.isComplete) == [true, false])
    }

    @Test func aWidgetIsNamedInPlainText() {
        #expect(Markdown.plainText("Before.\n\n```portals-visual title=\"T\"\n<b>x</b>\n```\n\nAfter.") == "Before.\n\n[Visual: T]\n\nAfter.")
        #expect(Markdown.plainText("```portals-visual\n<b>x</b>\n```") == "[Visual]")
    }

    @Test func widgetInfoStrings() {
        let cases: [(String, String?, Int?)] = [
            ("portals-visual", nil, nil),
            ("portals-visual title=\"A b\" height=360", "A b", 360),
            ("portals-visual   title='Single'  height=10", "Single", 48),
            ("portals-visual height=99999 title=Bare", "Bare", 2000),
            ("portals-visual title=\"Left open height=3", "Left open height=3", nil),
            ("portals-visual title=\"first\" title=\"second\" height=x", "first", nil),
            ("portals-visual title=\"  \" other=1 =odd lonely", nil, nil),
            ("portals-visual title=\"\(String(repeating: "x", count: 100))\"", String(repeating: "x", count: 80), nil),
        ]
        for (info, title, height) in cases {
            let widget = MarkdownWidget(infoString: info)
            #expect(widget?.title == title, "\(info)")
            #expect(widget?.height == height, "\(info)")
            #expect(widget?.source == "")
        }
        for info in ["", "swift", "portals-visuals", "xportals-visual", "portals-visual=1"] {
            #expect(MarkdownWidget(infoString: info) == nil, "\(info)")
        }
    }

    @Test func aWidgetsHashIsFNV1a() {
        #expect(MarkdownWidget.hash("") == 0xcbf2_9ce4_8422_2325)
        #expect(MarkdownWidget.hash("a") == 0xaf63_dc4c_8601_ec8c)
        #expect(MarkdownWidget(source: "<b>x</b>").sourceHash == MarkdownWidget.hash("<b>x</b>"))
        #expect(MarkdownWidget(source: "<b>x</b>").sourceHash != MarkdownWidget(source: "<b>y</b>").sourceHash)
    }

    @Test func aWidgetTooLargeIsSaidToBe() {
        #expect(!MarkdownWidget(source: String(repeating: "x", count: MarkdownWidget.maximumSource)).isTooLarge)
        #expect(MarkdownWidget(source: String(repeating: "x", count: MarkdownWidget.maximumSource + 1)).isTooLarge)
    }
}
