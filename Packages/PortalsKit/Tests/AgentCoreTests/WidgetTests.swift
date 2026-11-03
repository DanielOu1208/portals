import Foundation
import Testing
@testable import AgentCore

/// The page a widget is drawn in, and the heights remembered for widgets.
@Suite struct WidgetTests {
    private static let colors = WidgetPage.Theme.Colors(
        text: "#000", secondaryText: "#666", surface: "#eee", line: "#ccc", accent: "#00f",
        positive: "#0a0", negative: "#a00", series: ["#1", "#2", "#3", "#4", "#5", "#6"]
    )
    private static let theme = WidgetPage.Theme(light: colors, dark: colors, fontSize: 16, padding: 12)

    @Test func thePageHasTheAppsHeadFirstAndTheWidgetAsItsBody() throws {
        let page = WidgetPage.document("<div id=\"w\">x</div>", theme: Self.theme)
        let policy = try #require(page.range(of: "http-equiv=\"Content-Security-Policy\""))
        let widget = try #require(page.range(of: "<div id=\"w\">x</div>"))
        let body = try #require(page.range(of: "<body>"))
        // Nothing before the policy can load anything.
        #expect(page[..<policy.lowerBound].contains("<meta charset=\"utf-8\">"))
        #expect(!page[..<policy.lowerBound].contains("<script"))
        #expect(!page[..<policy.lowerBound].contains("<link"))
        #expect(policy.upperBound < body.lowerBound && body.upperBound < widget.lowerBound)
        #expect(page.contains("--portals-series-6: #6;"))
        #expect(page.contains("--portals-size: 16px;"))
        #expect(page.contains("@media (prefers-color-scheme: dark)"))
        #expect(page.hasSuffix("</body></html>"))
    }

    @Test func thePolicyLetsOnlyTheThreeCDNsLoadScriptsStylesAndFonts() {
        let policy = WidgetPage.contentSecurityPolicy
        #expect(policy.hasPrefix("default-src 'none'; "))
        #expect(policy.contains("connect-src 'none'"))
        #expect(policy.contains("frame-src 'none'"))
        #expect(policy.contains("form-action 'none'"))
        #expect(policy.contains("img-src data: blob:;"))
        #expect(policy.contains("script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com;"))
        // In an attribute in double quotes.
        #expect(!policy.contains("\""))
    }

    @Test func aDraftsPolicyIsThePagesWithoutScripts() {
        let policy = WidgetPage.draftPolicy
        #expect(policy.contains("; script-src 'none'; "))
        #expect(!policy.contains("unsafe-eval") && !policy.contains("script-src 'unsafe-inline"))
        #expect(policy.replacingOccurrences(of: "script-src 'none'", with: "") == WidgetPage.contentSecurityPolicy.replacingOccurrences(of: "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com", with: ""))
        #expect(WidgetPage.document("", theme: Self.theme, isDraft: true).contains("content=\"\(policy)\""))
        #expect(WidgetPage.document("", theme: Self.theme).contains("content=\"\(WidgetPage.contentSecurityPolicy)\""))
    }

    @Test func theRulesBlockEverythingThenLetThroughTheCDNsScriptsStylesAndFonts() throws {
        let rules = try #require(try JSONSerialization.jsonObject(with: Data(WidgetPage.contentRules.utf8)) as? [[String: [String: Any]]])
        #expect(rules.first?["action"]?["type"] as? String == "block")
        #expect(rules.first?["trigger"]?["url-filter"] as? String == ".*")
        let letThrough = rules.dropFirst()
        #expect(letThrough.allSatisfy { $0["action"]?["type"] as? String == "ignore-previous-rules" })
        // WebKit's filters have no alternation.
        #expect(rules.allSatisfy { !(($0["trigger"]?["url-filter"] as? String) ?? "|").contains("|") })
        let hosts = letThrough.compactMap { rule -> String? in
            guard let types = rule["trigger"]?["resource-type"] as? [String], types == ["script", "style-sheet", "font"] else { return nil }
            return rule["trigger"]?["url-filter"] as? String
        }
        #expect(hosts == [#"^https://cdn\.jsdelivr\.net/"#, #"^https://unpkg\.com/"#, #"^https://cdnjs\.cloudflare\.com/"#])
        // The page's own address is the one document let through.
        let documents = letThrough.filter { ($0["trigger"]?["resource-type"] as? [String]) == ["document"] }
        let pattern = try #require(documents.first?["trigger"]?["url-filter"] as? String)
        #expect(documents.count == 1)
        let address = WidgetPage.address(of: 0xabc123).absoluteString
        #expect(address == "https://wabc123.portals-widget.invalid/")
        #expect(address.range(of: pattern, options: .regularExpression) != nil)
        #expect("https://example.com/".range(of: pattern, options: .regularExpression) == nil)
    }

    @Test func theScriptedRepliesHoldTheWidgetsTheySay() {
        func widgets(_ prompt: String) -> [MarkdownWidget] {
            Markdown.blocks(FakeBackend.widgetReply(prompt)).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } }
        }
        #expect(widgets("savings").map(\.title) == ["Savings over ten years"])
        #expect(widgets("a chart").map(\.title) == ["Latency this week"])
        #expect(widgets("escape").map(\.title) == ["Sandbox check"])
        #expect(widgets("many").map(\.title) == ["Savings", "Latency this week", "Sandbox check"])
        #expect(widgets("many").allSatisfy { $0.isComplete && !$0.isTooLarge })
        #expect(widgets("unclosed").map(\.isComplete) == [false])
    }

    @Test func aDraftShowsElementsAndStylesButNoScripts() {
        #expect(WidgetPage.draft("<style>.a{}</style><div class=a>x</div>") == "<style>.a{}</style><div class=a>x</div>")
        #expect(WidgetPage.draft("<div>a</div><script>run()</script><p>b</p>") == "<div>a</div><p>b</p>")
        #expect(WidgetPage.draft("<div>a</div><SCRIPT type=module src=x></SCRIPT >\n<p>b") == "<div>a</div>\n<p>b")
        // One still being written is left out from where it starts.
        #expect(WidgetPage.draft("<div>a</div>\n<script>\nconst x = 1;\nfor (") == "<div>a</div>\n")
        #expect(WidgetPage.draft("<div>a</div><script src=\"https://cdn") == "<div>a</div>")
        #expect(WidgetPage.draft("<p>a <scriptless>b</scriptless></p>") == "<p>a <scriptless>b</scriptless></p>")
        // A tag whose name has not come yet, which the page would show as text.
        #expect(WidgetPage.draft("<label>Monthly</label>\n  <") == "<label>Monthly</label>\n  ")
        #expect(WidgetPage.draft("<p>a</") == "<p>a")
        #expect(WidgetPage.draft("<p>1 < 2") == "<p>1 < 2")
    }

    @Test func readingTheWidgetGuideIsPlanningAWidgetUntilOneIsWritten() {
        let guide = ToolRun(id: "g", name: "terminal", label: "\"/Users/x/portals-bridge/bin/portals\" guide visuals", state: .succeeded)
        #expect(guide.readsWidgetGuide)
        #expect(!ToolRun(id: "t", name: "terminal", label: "portals guide", state: .succeeded).readsWidgetGuide)
        var turn = Turn(items: [TurnItem(.user(UserMessage(text: "explain"))), TurnItem(.tool(guide))])
        #expect(turn.isPlanningWidget)
        turn.items.append(TurnItem(.text("Here it is:\n\n```portals-visual\n<div>")))
        #expect(!turn.isPlanningWidget)
        // The guide and the block under the names they had at first.
        let old = ToolRun(id: "o", name: "terminal", label: "portals guide widgets", state: .succeeded)
        #expect(old.readsWidgetGuide)
        var before = Turn(items: [TurnItem(.tool(old))])
        #expect(before.isPlanningWidget)
        before.items.append(TurnItem(.text("```portals-widget\n<div>")))
        #expect(!before.isPlanningWidget)
        #expect(!Turn(items: [TurnItem(.text("Hello"))]).isPlanningWidget)
    }

    @Test func theTurnHoldsAVisualsPlaceFromItsPlanningUntilTheReplyShowsIt() {
        let guide = TurnItem(.tool(ToolRun(id: "g", name: "terminal", label: "portals guide visuals", state: .succeeded)))
        let words = TurnItem(.text("Dijkstra settles the nearest node first."))
        // Words first, then the guide: planning, with nothing shown yet.
        var turn = Turn(items: [TurnItem(.user(UserMessage(text: "explain"))), words, guide])
        #expect(turn.awaitsWidget(shown: 0))
        // The visual begun: held until the reply, a moment behind, lays it out.
        turn.items.append(TurnItem(.text("```portals-visual title=\"Graph\"\n<svg>")))
        #expect(!turn.isPlanningWidget)
        #expect(turn.awaitsWidget(shown: 0))
        #expect(!turn.awaitsWidget(shown: 1))
        // A second visual, after the guide is read again.
        turn.items[turn.items.count - 1] = TurnItem(.text("```portals-visual\n<svg></svg>\n```\n\nMore."))
        turn.items.append(guide)
        #expect(turn.awaitsWidget(shown: 1))
        turn.items.append(TurnItem(.text("````portals-visual\n```\n<b>")))
        #expect(turn.awaitsWidget(shown: 1))
        #expect(!turn.awaitsWidget(shown: 2))
        // Not once the turn is over, nor in a turn that never read the guide, nor for a
        // visual in a list, which is shown as code.
        turn.outcome = .completed
        #expect(!turn.awaitsWidget(shown: 0))
        #expect(!Turn(items: [TurnItem(.text("```portals-visual\n<b>"))]).awaitsWidget(shown: 0))
        #expect(!Turn(items: [guide, TurnItem(.text("- a\n\n  ```portals-visual\n  <b>"))]).awaitsWidget(shown: 0))
        #expect(MarkdownWidget.begunCount(in: "```portals-visual\n```\n~~~ portals-widget\nx\n~~~\n    ```portals-visual\n> ```portals-visual") == 2)
    }

    @Test func theGalleryHasTenVisualsOfTheirOwn() {
        let widgets = Markdown.blocks(FakeBackend.widgetReply("gallery")).compactMap { if case let .widget(widget) = $0.kind { widget } else { nil } }
        #expect(widgets.count == 10)
        #expect(Set(widgets.map(\.sourceHash)).count == 10)
        #expect(Markdown.blocks(FakeBackend.widgetReply("diagram")).contains { $0.isWidget })
        #expect(Markdown.blocks(FakeBackend.widgetReply("frames")).contains { $0.isWidget })
    }

    @Test func aVisualIsBeingWrittenWhateverItsFenceIsMadeOf() {
        for text in [
            "Here:\n\n~~~portals-visual title=\"T\"\n<div>",
            "``` portals-visual\n<div>",
            "````portals-visual height=200\n```inner```",
            "   ```portals-widget",
            "- item\n\n  ```portals-visual\n  <b>",
        ] {
            #expect(MarkdownWidget.isOpened(in: text), "\(text)")
            #expect(!Turn(items: [TurnItem(.tool(ToolRun(id: "g", name: "terminal", label: "portals guide visuals", state: .succeeded))), TurnItem(.text(text))]).isPlanningWidget, "\(text)")
        }
        for text in ["Say `portals-visual` here.", "```portals-visuals\nx", "``portals-visual", "    ```portals-visual", "```js\nportals-visual", "a ```portals-visual"] {
            #expect(!MarkdownWidget.isOpened(in: text), "\(text)")
        }
    }

    @Test func heightsAreKeptByWidthAndTheNearestWidthServesAnother() {
        var heights = WidgetHeights()
        #expect(heights.height(for: 1, width: 400) == nil)
        let first = heights.record(300, for: 1, width: 400)
        let again = heights.record(300, for: 1, width: 401)
        #expect(first)
        #expect(!again)
        #expect(heights.height(for: 1, width: 400) == 300)
        #expect(heights.height(for: 1, width: 405) == 300)
        // Four steps of 16 points away at most.
        #expect(heights.height(for: 1, width: 460) == 300)
        #expect(heights.height(for: 1, width: 500) == nil)
        #expect(heights.height(for: 2, width: 400) == nil)
        heights.record(520, for: 1, width: 360)
        #expect(heights.height(for: 1, width: 360) == 520)
        #expect(heights.height(for: 1, width: 400) == 300)
        // The nearer of two.
        #expect(heights.height(for: 1, width: 372) == 520)
    }

    @Test func theLeastRecentlyMeasuredHeightsGoFirst() throws {
        var heights = WidgetHeights()
        for hash in 0..<UInt64(WidgetHeights.capacity) { heights.record(100, for: hash, width: 400) }
        // Measured again, the first is now among the newest.
        heights.record(200, for: 0, width: 400)
        heights.record(100, for: 9999, width: 400)
        #expect(heights.height(for: 0, width: 400) == 200)
        #expect(heights.height(for: 1, width: 400) == nil)
        #expect(heights.height(for: 2, width: 400) == 100)
        #expect(heights.height(for: 9999, width: 400) == 100)
        let saved = try JSONDecoder().decode(WidgetHeights.self, from: JSONEncoder().encode(heights))
        #expect(saved == heights)
    }
}
