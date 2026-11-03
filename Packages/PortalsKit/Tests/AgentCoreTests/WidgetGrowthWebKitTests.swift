#if os(macOS)
import Foundation
import Testing
import WebKit
@testable import AgentCore

/// Real DOM measurements must keep following separate interactions after the old
/// lifetime growth limit would have clipped the next expansion, and stop following a page
/// that keeps changing its own height.
@MainActor
@Suite(.serialized) struct WidgetGrowthWebKitTests {
    /// `byTheUser`: each toggle is a click, as a tap is; otherwise the page's own script
    /// changes its height, with nobody touching it (an animation, a timer).
    @Test(arguments: [true, false])
    func separateDOMInteractionsKeepResizingWhileThePagesOwnChangesStop(byTheUser: Bool) async throws {
        let posts = Posts()
        let world = WKContentWorld.world(name: "portals-growth-test")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let rules = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "portals-growth-test", encodedContentRuleList: WidgetPage.contentRules
        )
        configuration.userContentController.add(try #require(rules))
        configuration.userContentController.add(posts, contentWorld: world, name: WidgetPage.messageName)
        configuration.userContentController.addUserScript(WKUserScript(
            source: WidgetPage.measuring, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world
        ))
        configuration.userContentController.addUserScript(WKUserScript(
            source: WidgetPage.sealing, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page
        ))
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 100), configuration: configuration)
        defer {
            view.stopLoading()
            configuration.userContentController.removeAllScriptMessageHandlers()
        }
        let colors = WidgetPage.Theme.Colors(
            text: "#000", secondaryText: "#666", surface: "#eee", line: "#ccc",
            accent: "#00f", positive: "#0a0", negative: "#a00", series: []
        )
        let source = """
            <style>body{padding:0!important}button{display:block;height:20px;padding:0}#more{height:80px}</style>
            <button onclick="more.style.height=more.offsetHeight===80?'180px':'80px'">Toggle</button><div id="more"></div>
            """
        let page = WidgetPage.document(source, theme: .init(light: colors, dark: colors, fontSize: 16, padding: 4))
        let address = WidgetPage.address(of: 0x4659)
        let response = try #require(HTTPURLResponse(
            url: address, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": WidgetPage.contentSecurityPolicy]
        ))
        view.loadSimulatedRequest(URLRequest(url: address), response: response, responseData: Data(page.utf8))
        try await wait("initial size") { posts.count > 0 }
        for click in 0..<81 {
            let previous = posts.count
            _ = try await view.evaluateJavaScript(
                byTheUser ? "document.querySelector('button').click()" : "more.style.height=more.offsetHeight===80?'180px':'80px'"
            )
            // Off-window WebKit may defer ResizeObserver delivery. Ask through the same
            // measuring entry point the app uses after putting draft HTML in its page.
            _ = try await view.evaluateJavaScript("window.portalsMeasure()", in: nil, contentWorld: world)
            try await wait("toggle \(click), last height \(posts.growth.contentHeight ?? 0)") { posts.count > previous }
        }
        #expect(posts.growth.contentHeight == 200)
        if byTheUser {
            #expect(posts.acceptedHeight == 200)
            #expect(!posts.needsScroll)
        } else {
            // Followed for its first 40 growths, then only as it shrank: what it grows by
            // after that scrolls inside the frame instead of moving the chat.
            #expect(posts.acceptedHeight == 100)
            #expect(posts.needsScroll)
        }
    }

    private func wait(_ step: String, _ ready: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !ready(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(ready(), "The page did not post its new size: \(step)")
    }

    @MainActor private final class Posts: NSObject, WKScriptMessageHandler {
        var growth = WidgetGrowth()
        var acceptedHeight = 0.0
        var count = 0

        var needsScroll: Bool {
            (growth.contentHeight ?? acceptedHeight) > min(max(acceptedHeight, 48), 560) + 1
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let height = (body["height"] as? NSNumber)?.doubleValue,
                  let width = (body["width"] as? NSNumber)?.doubleValue else { return }
            count += 1
            // As the app reads it: the page says when the user did something on it.
            if growth.record(height: height, width: width, interacted: (body["interacted"] as? Bool) ?? false) { acceptedHeight = height }
        }
    }
}
#endif
