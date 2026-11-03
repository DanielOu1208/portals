import Foundation
#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
import QuartzCore
import UIKit
#endif

/// Watches the composer's caret for scripts and UI tests (`PORTALS_DEBUG_COMPOSER_PROBE`,
/// ComposerUITests): every frame (as committed to the screen), while a text view has the focus, where its caret is
/// on screen (of a selection, the end that moved) and how much of the composer's text can be seen there (the text view's own
/// bounds, cut by every scroll view around it). A line is appended to the file each time
/// either changes: `{"t", "len", "caret": [top, bottom], "seen": [top, bottom], "in": Bool}`,
/// `t` in seconds since the probe started, `len` the text's length, `in` whether the
/// caret's whole line can be seen (within two points: the caret stands over its line). Only a development build reads the switch; elsewhere
/// `start` does nothing.
@MainActor
enum ComposerProbe {
    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
    private static var link: CADisplayLink?
    private static var target: Ticker?
    private static var file: FileHandle?
    private static var began = CACurrentMediaTime()
    private static var last = ""
    /// Of a selection, the end that moved is the one looked at, as the composer follows it.
    private static let edge = SelectionEdge()

    static func start() {
        guard link == nil, let path = DebugLaunch.composerProbePath else { return }
        FileManager.default.createFile(atPath: path, contents: nil)
        file = FileHandle(forWritingAtPath: path)
        began = CACurrentMediaTime()
        // The display link only wakes the main thread every frame. What is looked at is
        // what that pass of the run loop hands to the screen: after its layout and its
        // commit, just before it sleeps (a display link's callback comes before them, and
        // would see a text view's new text before the layout made room for it).
        let ticker = Ticker()
        target = ticker
        let link = CADisplayLink(target: ticker, selector: #selector(Ticker.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { _, _ in
            MainActor.assumeIsolated { ComposerProbe.frame() }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    private final class Ticker: NSObject {
        @objc func tick() {}
    }

    private static func frame() {
        FirstResponder.found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.composerProbeFind), to: nil, from: nil, for: nil)
        guard let view = FirstResponder.found as? UITextView, let window = view.window,
              let range = view.selectedTextRange else { return }
        let caret = view.convert(view.caretRect(for: edge.moving(range, in: view)), to: window)
        var seen = view.convert(view.bounds, to: window)
        var above = view.superview
        while let ancestor = above {
            if ancestor.clipsToBounds { seen = seen.intersection(ancestor.convert(ancestor.bounds, to: window)) }
            above = ancestor.superview
        }
        // The caret stands a point or two over its line, above and below.
        let isIn = !seen.isNull && caret.minY >= seen.minY - 2 && caret.maxY <= seen.maxY + 2
        let state = String(
            format: "\"len\": %d, \"caret\": [%.1f, %.1f], \"seen\": [%.1f, %.1f], \"in\": %@",
            view.text.count, caret.minY, caret.maxY, seen.isNull ? 0 : seen.minY, seen.isNull ? 0 : seen.maxY, isIn ? "true" : "false"
        )
        guard state != last else { return }
        last = state
        let line = String(format: "{\"t\": %.3f, ", CACurrentMediaTime() - began) + state + "}\n"
        file?.write(Data(line.utf8))
    }
    #else
    static func start() {}
    #endif
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
@MainActor
private enum FirstResponder {
    static weak var found: UIResponder?
}

extension UIResponder {
    @objc fileprivate func composerProbeFind() {
        MainActor.assumeIsolated { FirstResponder.found = self }
    }
}
#endif
