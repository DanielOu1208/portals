#if os(macOS)
import Foundation
import Testing
import WebKit
@testable import AgentCore

/// The page a visual is drawn in, in a real web view (the Mac's WebKit, which the iPhone's
/// shares): what its scripts can reach, set up as the app sets it up (WidgetSandbox.swift).
@MainActor
@Suite(.serialized) struct WidgetSandboxTests {
    private static let colors = WidgetPage.Theme.Colors(
        text: "#000", secondaryText: "#666", surface: "#eee", line: "#ccc", accent: "#00f",
        positive: "#0a0", negative: "#a00", series: ["#1", "#2", "#3", "#4", "#5", "#6"]
    )
    private static let theme = WidgetPage.Theme(light: colors, dark: colors, fontSize: 16, padding: 4)
    private static let world = WKContentWorld.world(name: "portals-widget-test")

    @Test func aPageHasNoWebRTCInItselfOrInAFrameItMakes() async throws {
        let page = """
            <p id="out"></p>
            <script>
              const frame = document.createElement("iframe");
              document.body.appendChild(frame);
              let made = "no";
              try { new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:9" }] }); made = "yes"; } catch (error) {}
              out.textContent = [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel, typeof frame.contentWindow.RTCPeerConnection, made].join(" ");
              RTCPeerConnection = function () {};
              out.textContent += " " + typeof RTCPeerConnection;
            </script>
            """
        let view = try await Self.load(page, sealed: true)
        let result = try await view.evaluateJavaScript("document.getElementById('out').textContent", in: nil, contentWorld: Self.world) as? String
        #expect(result == "undefined undefined undefined undefined no undefined")
        // Without it, WebKit has them.
        let open = try await Self.load(page, sealed: false)
        let unsealed = try await open.evaluateJavaScript("document.getElementById('out').textContent", in: nil, contentWorld: Self.world) as? String
        #expect(unsealed?.hasPrefix("function") == true)
    }

    @Test func visualsWithOtherHTMLShareNoCookieInTheStorageTheyShare() async throws {
        let setting = "<p>A</p><script>document.cookie = 'shared=only-in-A; Domain=portals-widget.invalid; Path=/; Secure';</script>"
        let reading = "<p id=\"out\"></p><script>document.getElementById('out').textContent = 'cookies: ' + document.cookie;</script>"
        func read(allowingCookies: Bool) async throws -> String? {
            let store = WKWebsiteDataStore.nonPersistent()
            // As the app sets its storage up (WidgetSandbox.contentRules), before any page.
            if !allowingCookies { await store.httpCookieStore.setCookiePolicy(.disallow) }
            let first = try await Self.load(setting, sealed: true, store: store, hash: 0xa1)
            let second = try await Self.load(reading, sealed: true, store: store, hash: 0xb2)
            withExtendedLifetime(first) {}
            return try await second.evaluateJavaScript("document.getElementById('out').textContent", in: nil, contentWorld: Self.world) as? String
        }
        #expect(try await read(allowingCookies: false) == "cookies: ")
        // With cookies, the second visual reads what the first set.
        #expect(try await read(allowingCookies: true) == "cookies: shared=only-in-A")
    }

    @Test func aDraftsPageRunsNoHandlerOfItsOwnButTheAppsScriptsRun() async throws {
        let draft = WidgetPage.draft(#"<img src="data:," onerror="document.title = 'ran'"><p onclick="x()">Half a vis"#)
        for isDraft in [true, false] {
            let view = try await Self.load("", sealed: true, isDraft: isDraft)
            _ = try await view.callAsyncJavaScript(WidgetPage.showingDraft, arguments: ["html": draft], in: nil, contentWorld: Self.world)
            try await Task.sleep(for: .milliseconds(300))
            let title = try await view.evaluateJavaScript("[document.title, document.body.innerHTML.includes('Half a vis')].join(' ')", in: nil, contentWorld: Self.world) as? String
            #expect(title == (isDraft ? " true" : "ran true"), "draft: \(isDraft)")
        }
    }

    @Test func aDraftShowsSomethingOnceItHasTextOrShapesAndNothingAScriptIsToWork() async throws {
        let cases: [(String, Bool)] = [
            (#"<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>"#, true),
            ("<h3>Two plans</h3><div>Monthly: $5</div>", true),
            (#"<div id="rows"></div>"#, false),
            ("<style>.a { color: red; }</style>", false),
            (#"<label>Monthly <input type="range"></label>"#, false),
            ("<p>Latency</p><canvas></canvas>", false),
            ("<p>Step</p><button>Next</button>", false),
        ]
        for (draft, shows) in cases {
            let posts = Posts()
            let view = try await Self.load("", sealed: true, isDraft: true, measuredBy: posts)
            _ = try await view.callAsyncJavaScript(WidgetPage.showingDraft, arguments: ["html": WidgetPage.draft(draft)], in: nil, contentWorld: Self.world)
            try await Task.sleep(for: .milliseconds(300))
            #expect(posts.last?["shows"] as? Bool == shows, "\(draft)")
        }
    }

    @Test func whatAPagesOwnScriptClicksOrChangesIsNotTheUsersDoing() async throws {
        // A tab clicked and a field changed by the page's script as it draws: not used,
        // so it is still drawn again when shown wider (`WidgetWidening.used`). The user's
        // own taps and keys (`isTrusted`) cannot be made from a test.
        let posts = Posts()
        let view = try await Self.load(#"<p>Rate</p><button id="b">More</button><input id="i">"#, sealed: true, measuredBy: posts)
        _ = try await view.evaluateJavaScript("""
            document.getElementById('b').click();
            const i = document.getElementById('i');
            i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            0
            """, in: nil, contentWorld: .page)
        try await Task.sleep(for: .milliseconds(300))
        #expect(posts.all.contains { $0["height"] != nil })
        #expect(posts.all.filter { $0["used"] as? Bool == true }.isEmpty)
    }

    /// A web view set up as a visual's (WidgetSandbox.swift), with `source` loaded as the
    /// app loads it, once it has loaded; measured by `measuredBy`, as the app measures it.
    private static func load(
        _ source: String, sealed: Bool, isDraft: Bool = false, measuredBy posts: Posts? = nil,
        store: WKWebsiteDataStore = .nonPersistent(), hash: UInt64 = 0xabc
    ) async throws -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        if let posts {
            configuration.userContentController.add(posts, contentWorld: world, name: WidgetPage.messageName)
            configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.measuring, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        }
        if sealed {
            configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.sealing, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        }
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 400), configuration: configuration)
        let loaded = Loaded()
        view.navigationDelegate = loaded
        let address = WidgetPage.address(of: hash)
        let response = try #require(HTTPURLResponse(url: address, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": WidgetPage.contentSecurityPolicy(isDraft: isDraft),
        ]))
        await withCheckedContinuation { continuation in
            loaded.done = { continuation.resume() }
            view.loadSimulatedRequest(URLRequest(url: address), response: response, responseData: Data(WidgetPage.document(source, theme: theme, isDraft: isDraft).utf8))
        }
        withExtendedLifetime(loaded) {}
        // The page's scripts have run once it has loaded.
        view.navigationDelegate = nil
        return view
    }

    /// What the measuring script posted, the last first.
    private final class Posts: NSObject, WKScriptMessageHandler {
        var last: [String: Any]?
        var all: [[String: Any]] = []

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            last = message.body as? [String: Any]
            if let last { all.append(last) }
        }
    }

    private final class Loaded: NSObject, WKNavigationDelegate {
        var done: (() -> Void)?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            done?()
            done = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            done?()
            done = nil
        }
    }
}
#endif
