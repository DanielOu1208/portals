import SwiftUI
import UIKit

/// What moves on screen when the app comes back (`PORTALS_DEBUG_RETURN`), for
/// scripts/return-bench.sh: the frames of the sidebar's rows, the chat's turns, the
/// composer and the chat's scroll position, each written when it changes, and what the
/// app does meanwhile (the scene's phase, the connection, the agents listed, the list
/// merged, the thread on screen brought up to date). A line each,
///
///     <seconds since 1970> <what> <key> [<x> <y> <width> <height>]
///
/// Only a development build reads the switch; everywhere else `shared` is nil and the
/// views' probes are not there at all.
@MainActor
final class ReturnProbe {
    static let shared: ReturnProbe? = {
        guard let path = DebugLaunch.returnProbePath else { return nil }
        return ReturnProbe(path: path)
    }()

    private let file: FileHandle
    private var frames: [String: CGRect] = [:]

    private init?(path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let file = FileHandle(forWritingAtPath: path) else { return nil }
        self.file = file
        #if targetEnvironment(macCatalyst)
        // A Mac's app is inactive while another is in front, and its window may be
        // covered whole: the scene's phase does not say all of it.
        for (name, what) in [
            ("NSApplicationDidBecomeActiveNotification", "app-active"),
            ("NSApplicationDidResignActiveNotification", "app-inactive"),
            ("NSApplicationDidHideNotification", "app-hidden"),
            ("NSApplicationDidUnhideNotification", "app-shown"),
            ("NSWindowDidChangeOcclusionStateNotification", "occlusion"),
        ] {
            NotificationCenter.default.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] notification in
                // A window's occlusion says which way it went: visible (uncovered) or not.
                let key = what == "occlusion" ? Self.occlusion(of: notification.object) : "-"
                MainActor.assumeIsolated { self?.note(what, key) }
            }
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    /// "visible" or "hidden": an NSWindow's `occlusionState`, whose visible bit is 1 << 1.
    nonisolated private static func occlusion(of window: Any?) -> String {
        guard let window else { return "-" }
        let target = window as AnyObject
        guard class_respondsToSelector(object_getClass(target), NSSelectorFromString("occlusionState")),
              let state = target.value(forKey: "occlusionState") as? UInt else { return "-" }
        return state & (1 << 1) != 0 ? "visible" : "hidden"
    }
    #endif

    /// Something the app did, or that happened to it.
    func note(_ what: String, _ key: String = "-") {
        write("\(what) \(key.replacingOccurrences(of: " ", with: "_"))")
    }

    /// Where `key` is now, in the window; written only when it moved or changed size.
    func frame(_ key: String, _ rect: CGRect) {
        let rounded = CGRect(x: rect.minX.rounded(), y: rect.minY.rounded(), width: rect.width.rounded(), height: rect.height.rounded())
        guard frames[key] != rounded else { return }
        frames[key] = rounded
        write("frame \(key.replacingOccurrences(of: " ", with: "_")) \(Int(rounded.minX)) \(Int(rounded.minY)) \(Int(rounded.width)) \(Int(rounded.height))")
    }

    /// `key` left the screen (a lazy list let go of it, or it was removed).
    func gone(_ key: String) {
        frames[key] = nil
        note("gone", key)
    }

    private func write(_ line: String) {
        let stamp = String(format: "%.3f", Date().timeIntervalSince1970)
        file.write(Data("\(stamp) \(line)\n".utf8))
    }
}

extension View {
    /// Writes where this view is to the probe whenever that changes, when the probe is
    /// on (`ReturnProbe`); nothing at all otherwise.
    @ViewBuilder
    func returnProbe(_ key: @autoclosure () -> String) -> some View {
        if let probe = ReturnProbe.shared {
            let key = key()
            onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { probe.frame(key, $0) }
                .onDisappear { probe.gone(key) }
        } else {
            self
        }
    }
}

extension View {
    /// Writes a scroll view's position (y: how far it is scrolled, height: how tall its
    /// content is) to the probe whenever that changes, when the probe is on.
    @ViewBuilder
    func returnProbeScroll(_ key: String) -> some View {
        if let probe = ReturnProbe.shared {
            onScrollGeometryChange(for: CGRect.self) { geometry in
                CGRect(x: 0, y: geometry.contentOffset.y, width: geometry.contentSize.width, height: geometry.contentSize.height)
            } action: { _, rect in
                probe.frame(key, rect)
            }
        } else {
            self
        }
    }
}
