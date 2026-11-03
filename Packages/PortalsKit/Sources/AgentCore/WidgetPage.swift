import Foundation

/// The page a widget is drawn in (WidgetSandbox.swift loads it): a head of the app's,
/// then the widget's HTML. What it may load is what `portals guide widgets` tells the
/// agents: scripts, style sheets and fonts from three CDNs, nothing else from the
/// network, and no frames, forms, pop-ups or navigation. The content security policy
/// says so in the page, and the content rules say it again to WebKit's loader, so
/// neither is all that stands in the way.
public enum WidgetPage {
    /// The hosts a widget may load scripts, style sheets and fonts from.
    public static let hosts = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"]

    /// What a widget's page is called: a host of its own, under a name that cannot be
    /// registered (`.invalid`), so no two widgets share their storage and nothing on the
    /// network answers for it. The page never leaves the app.
    public static func address(of hash: UInt64) -> URL {
        URL(string: "https://w\(String(hash, radix: 16)).\(domain)/")!
    }

    static let domain = "portals-widget.invalid"

    /// The content security policy, sent with the page and put first in its head.
    public static let contentSecurityPolicy = policy(scripts: true)

    /// The policy of the page a visual still being written is drawn in (`draft`): no
    /// script of the page's runs at all, an inline handler (`onerror`, `onload`) of a
    /// half-written element included. The app's own scripts still run, in their world.
    public static let draftPolicy = policy(scripts: false)

    /// The policy for `isDraft`: the page's policy, or the draft's.
    public static func contentSecurityPolicy(isDraft: Bool) -> String {
        isDraft ? draftPolicy : contentSecurityPolicy
    }

    private static func policy(scripts: Bool) -> String {
        let cdns = hosts.map { "https://\($0)" }.joined(separator: " ")
        return [
            "default-src 'none'",
            scripts ? "script-src 'unsafe-inline' 'unsafe-eval' \(cdns)" : "script-src 'none'",
            "style-src 'unsafe-inline' \(cdns)",
            "font-src data: \(cdns)",
            "img-src data: blob:",
            "media-src data: blob:",
            "connect-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "object-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ].joined(separator: "; ")
    }

    /// Run before anything else in every frame of the page, in the page's own world:
    /// takes WebRTC away. A peer connection reaches any host it is given over UDP or TCP
    /// (STUN and TURN), past the policy and the content rules, which govern only what is
    /// fetched: a page could send what it holds, and the device's address, anywhere. The
    /// names are made undefined for good, so the page cannot put them back.
    ///
    /// A frame the page makes with an address or `srcdoc`, read in the same moment, still
    /// has them (WebKit adds the script to a frame's first, empty page only when nothing
    /// is on its way into it); nothing a visual is meant to do needs that, but a page
    /// written to get around this can.
    public static let sealing = """
        (() => {
          for (const name of [\(webRTCNames.map { "\"\($0)\"" }.joined(separator: ", "))]) {
            try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (error) {}
          }
        })();
        """

    /// What `sealing` takes away: the interfaces that make or carry a peer connection.
    static let webRTCNames: [String] = [
        "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate",
        "RTCSessionDescription", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver",
        "RTCIceTransport", "RTCDtlsTransport", "RTCSctpTransport", "RTCCertificate",
        "RTCRtpScriptTransform", "RTCDTMFSender", "RTCPeerConnectionIceEvent",
        "RTCDataChannelEvent", "RTCTrackEvent", "RTCError", "RTCErrorEvent",
        "RTCEncodedAudioFrame", "RTCEncodedVideoFrame", "RTCStatsReport",
    ]

    /// The rules WebKit's loader keeps to (`WKContentRuleList`): everything is blocked,
    /// then the page itself, the three CDNs' scripts, style sheets and fonts, and what
    /// is inline, are let through. A rule's filter is a plain expression without `|`,
    /// so each host has one of its own.
    public static let contentRules: String = {
        var rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": #"^https://w[0-9a-f]+\.portals-widget\.invalid/"#, "resource-type": ["document"]], "action": ["type": "ignore-previous-rules"]],
        ]
        for host in hosts {
            let pattern = "^https://" + host.replacingOccurrences(of: ".", with: #"\."#) + "/"
            rules.append(["trigger": ["url-filter": pattern, "resource-type": ["script", "style-sheet", "font"]], "action": ["type": "ignore-previous-rules"]])
        }
        rules.append(["trigger": ["url-filter": "^data:", "resource-type": ["image", "font", "media"]], "action": ["type": "ignore-previous-rules"]])
        rules.append(["trigger": ["url-filter": "^blob:", "resource-type": ["image", "media"]], "action": ["type": "ignore-previous-rules"]])
        let data = try! JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }()

    /// The page for `source`: the app's head, then the widget's HTML as the body. A
    /// widget written as a whole document still works: the parser folds its `<html>`
    /// and `<body>` into the page's, and keeps what its `<head>` holds.
    /// `isDraft`: the page a visual still being written is put in, under `draftPolicy`.
    public static func document(_ source: String, theme: Theme, isDraft: Bool = false) -> String {
        """
        <!DOCTYPE html>
        <html><head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy(isDraft: isDraft))">
        <meta http-equiv="x-dns-prefetch-control" content="off">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <meta name="color-scheme" content="light dark">
        <style>\(theme.css)</style>
        </head><body>
        \(source)
        </body></html>
        """
    }

    /// What of a widget still being written is drawn: its elements and styles as far as
    /// they go, without its scripts, which run once it is finished. A script cut short
    /// is left out from where it starts; the page's parser drops a tag cut short, but
    /// shows a `<` or `</` whose name has not come yet as text, so those are left out
    /// too. Its page's policy (`draftPolicy`) keeps inline handlers from running as well.
    public static func draft(_ partial: String) -> String {
        var text = partial.replacingOccurrences(of: #"<script\b[\s\S]*?</script\s*>"#, with: "", options: [.regularExpression, .caseInsensitive])
        if let open = text.range(of: #"<script\b[\s\S]*$"#, options: [.regularExpression, .caseInsensitive]) {
            text.removeSubrange(open)
        }
        if let tag = text.range(of: #"</?\z"#, options: .regularExpression) {
            text.removeSubrange(tag)
        }
        return text
    }

    /// Puts what `draft` gives into a page loaded with no widget in it, in place of what
    /// was there, and has the page measured again (`measuring`): run with the draft as
    /// `html`, in the app's world.
    public static let showingDraft = "document.body.innerHTML = html; if (window.portalsMeasure) window.portalsMeasure();"

    /// The name the measuring script posts to (`measuring`).
    public static let messageName = "portalsWidget"

    /// What tells the app how tall the page is and whether it shows anything yet, whenever
    /// either changes: run once the page is read,
    /// apart from the page's own scripts, which cannot post to the app. The body is
    /// measured, not the page, which is never shorter than the view it is shown in and so
    /// would never let a widget shrink. It shows something once it has text, an SVG
    /// shape or an image, and no control or canvas: a page with a control or a canvas is
    /// drawn by its script, which runs only once the visual is finished, so until then
    /// it is half drawn at best. Each measurement also says whether the user did something
    /// on the page since the last (`interacted`: a tap, a key), which lets the frame follow
    /// it again (`WidgetGrowth`). The first such thing since the page loaded is also told
    /// at once, on its own (`used`), whatever the page's size does: a page the user has
    /// done something on is not drawn again when it is shown wider (`WidgetWidening`).
    /// Only the user's own (`isTrusted`): a page's script that clicks a tab or sends a
    /// change as it draws has not been used.
    public static let measuring = """
        (() => {
          const app = window.webkit.messageHandlers.\(messageName);
          let last = "", queued = false, touched = false, used = false;
          const drawn = "svg circle, svg rect, svg path, svg line, svg polyline, svg polygon, svg ellipse, svg text, svg image, img, video, progress, meter";
          const scripted = "input, button, select, textarea, canvas";
          const shows = (body) => ((body.innerText || "").trim() !== "" || body.querySelector(drawn) !== null) && body.querySelector(scripted) === null;
          const measure = () => {
            queued = false;
            const body = document.body;
            if (!body) return;
            const style = getComputedStyle(body);
            const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height) + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0));
            const width = document.documentElement.clientWidth;
            const content = shows(body);
            const said = `${height} ${width} ${content}`;
            if (said === last) return;
            last = said;
            app.postMessage({ height, width, shows: content, interacted: touched });
            touched = false;
          };
          const ask = () => { if (!queued) { queued = true; setTimeout(measure, 16); } };
          window.portalsMeasure = ask;
          for (const type of ["pointerdown", "click", "keydown", "input", "change"]) {
            addEventListener(type, (event) => {
              touched = true;
              if (!used && event.isTrusted) { used = true; app.postMessage({ used: true }); }
            }, { capture: true, passive: true });
          }
          if (document.body) new ResizeObserver(ask).observe(document.body);
          addEventListener("load", ask);
          if (document.fonts) document.fonts.ready.then(ask);
          ask();
        })();
        """

    /// The app's colours and type as the CSS variables a widget is told of, for light
    /// and dark mode, and the page's own: no margin, a transparent background, nothing
    /// at the sides so it lines up with the reply's text, text in the app's colour, font
    /// and size.
    public struct Theme: Hashable, Sendable {
        public struct Colors: Hashable, Sendable {
            public var text: String
            public var secondaryText: String
            public var surface: String
            public var line: String
            public var accent: String
            public var positive: String
            public var negative: String
            /// Six, for data series.
            public var series: [String]

            public init(text: String, secondaryText: String, surface: String, line: String, accent: String, positive: String, negative: String, series: [String]) {
                self.text = text
                self.secondaryText = secondaryText
                self.surface = surface
                self.line = line
                self.accent = accent
                self.positive = positive
                self.negative = negative
                self.series = series
            }

            var variables: String {
                var lines = [
                    "--portals-text: \(text);",
                    "--portals-text-2: \(secondaryText);",
                    "--portals-surface: \(surface);",
                    "--portals-line: \(line);",
                    "--portals-accent: \(accent);",
                    "--portals-positive: \(positive);",
                    "--portals-negative: \(negative);",
                ]
                for (index, color) in series.enumerated() { lines.append("--portals-series-\(index + 1): \(color);") }
                return lines.joined(separator: " ")
            }
        }

        public var light: Colors
        public var dark: Colors
        /// The body text's size, in CSS pixels (points).
        public var fontSize: Double
        /// The space above and below what the page shows.
        public var padding: Double

        public init(light: Colors, dark: Colors, fontSize: Double, padding: Double) {
            self.light = light
            self.dark = dark
            self.fontSize = fontSize
            self.padding = padding
        }

        public var css: String {
            """
            :root { color-scheme: light dark; --portals-font: -apple-system, system-ui, sans-serif; \
            --portals-mono: ui-monospace, SFMono-Regular, Menlo, monospace; --portals-size: \(Self.number(fontSize))px; \
            --portals-radius: 10px; \(light.variables) }
            @media (prefers-color-scheme: dark) { :root { \(dark.variables) } }
            html { -webkit-text-size-adjust: 100%; overflow-x: hidden; }
            html, body { margin: 0; background: transparent; }
            body { padding: \(Self.number(padding))px 0; font: var(--portals-size)/1.4 var(--portals-font); color: var(--portals-text); \
            -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
            """
        }

        private static func number(_ value: Double) -> String {
            value.rounded() == value ? String(Int(value)) : String(value)
        }
    }
}
