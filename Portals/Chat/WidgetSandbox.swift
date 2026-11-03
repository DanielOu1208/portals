import AgentCore
import os
import SwiftUI
import UIKit
import WebKit

/// How a widget's web view is set up (`WidgetPage` says what its page may do): no
/// storage that outlives the app, no windows, frames or navigation, no WebRTC, no text
/// to select or links to preview, media only when tapped, and the content rules that
/// block what the page's own policy blocks. The app's colours go in as CSS variables, resolved
/// for light and dark mode here, where the app keeps them.
enum WidgetSandbox {
    /// The storage widgets share, in memory only: nothing a widget keeps outlives the
    /// app, and nothing of the app's is in it.
    static let storage = WKWebsiteDataStore.nonPersistent()

    /// Where the measuring script runs, apart from the page's own scripts: only there
    /// is the app's message handler, so the page cannot post to the app.
    static let world = WKContentWorld.world(name: "portals-widget")

    private static var rules: Task<WKContentRuleList?, Never>?

    /// The content rules, compiled once (WebKit keeps them for the next launch). Nil when
    /// they cannot be: then no widget is loaded.
    static func contentRules() async -> WKContentRuleList? {
        if let rules { return await rules.value }
        let task = Task<WKContentRuleList?, Never> {
            // No cookies, before any page loads: pages of visuals with other HTML share
            // the storage, and a cookie set for the domain they all have would pass between them.
            await storage.httpCookieStore.setCookiePolicy(.disallow)
            let store = WKContentRuleListStore.default()
            // Named after the rules, so changed rules are compiled again.
            let identifier = "portals-widget-\(String(MarkdownWidget(source: WidgetPage.contentRules).sourceHash, radix: 16))"
            if let found = try? await store?.contentRuleList(forIdentifier: identifier) { return found }
            do {
                return try await store?.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: WidgetPage.contentRules)
            } catch {
                AppLog.chat.error("Widget rules did not compile: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        rules = task
        let compiled = await task.value
        // Asked again next time, rather than never drawing a widget for the whole run.
        if compiled == nil { rules = nil }
        return compiled
    }

    /// A web view for one widget, posting its height to `messages`.
    static func webView(rules: WKContentRuleList, messages: WKScriptMessageHandler) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = storage
        configuration.userContentController.add(rules)
        configuration.userContentController.add(messages, contentWorld: world, name: WidgetPage.messageName)
        configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.measuring, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        // No WebRTC, in the page and in any frame of it: a peer connection reaches hosts
        // that the policy and the rules cannot stop.
        configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.sealing, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isTextInteractionEnabled = false
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.dataDetectorTypes = []
        #if !targetEnvironment(macCatalyst)
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile
        #endif

        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.underPageBackgroundColor = .clear
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = false
        let scroller = view.scrollView
        scroller.backgroundColor = .clear
        scroller.isScrollEnabled = false
        scroller.bounces = false
        scroller.scrollsToTop = false
        scroller.contentInsetAdjustmentBehavior = .never
        scroller.pinchGestureRecognizer?.isEnabled = false
        #if DEBUG
        view.isInspectable = true
        #endif
        return view
    }

    /// Starts `view`'s process, by loading a page with nothing in it at the address a
    /// visual being written is drawn at, so that the visual's own page loads in it at once.
    static func startProcess(of view: WKWebView) {
        let address = WidgetPage.address(of: 0)
        let response = HTTPURLResponse(url: address, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": WidgetPage.draftPolicy,
        ])!
        view.loadSimulatedRequest(URLRequest(url: address), response: response, responseData: Data("<!DOCTYPE html><html><head></head><body></body></html>".utf8))
    }

    /// The app's colours and type for a widget's page. `traits` gives the text size.
    static func theme(_ traits: UITraitCollection) -> WidgetPage.Theme {
        let size = AppTextStyles.fixedSize(of: .body)
            ?? UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize
        return WidgetPage.Theme(light: colors(.light), dark: colors(.dark), fontSize: size, padding: WidgetSizing.padding)
    }

    private static func colors(_ style: UIUserInterfaceStyle) -> WidgetPage.Theme.Colors {
        let traits = UITraitCollection(userInterfaceStyle: style)
        func css(_ color: UIColor) -> String {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let channel = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
            return "rgb(\(channel(red)) \(channel(green)) \(channel(blue)) / \(String(format: "%.3g", Double(alpha))))"
        }
        return WidgetPage.Theme.Colors(
            text: css(.label),
            secondaryText: css(.secondaryLabel),
            // The page is on the chat's background: tiles on it are the app's cards.
            surface: css(UIColor(Theme.cardFill)),
            line: css(.separator),
            accent: css(.systemBlue),
            positive: css(.systemGreen),
            negative: css(.systemRed),
            series: [.systemBlue, .systemOrange, .systemGreen, .systemPurple, .systemPink, .systemTeal].map(css)
        )
    }
}
