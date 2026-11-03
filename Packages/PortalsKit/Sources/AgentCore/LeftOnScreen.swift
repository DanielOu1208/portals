import Foundation

/// The thread on screen as the app went to the background, kept so that the app the
/// system ended there opens with it again (`Fleet`), as it was left.
public struct LeftOnScreen: Hashable, Sendable {
    public var route: PushRoute

    public init(host: HostID, thread: ThreadRef.ID) {
        route = PushRoute(host: host, thread: thread)
    }

    /// As kept in the app's settings.
    public init?(saved: [String: String]?) {
        guard let saved, let host = saved["host"], let thread = saved["thread"], !host.isEmpty, !thread.isEmpty else { return nil }
        self.init(host: HostID(rawValue: host), thread: ThreadRef.ID(rawValue: thread))
    }

    public var saved: [String: String] {
        ["host": route.host?.rawValue ?? "", "thread": route.thread.rawValue]
    }

    /// The thread to open, from the list as the app has it at launch: none once it is
    /// gone from the list, or archived.
    public func record(in threads: [ThreadRecord]) -> ThreadRecord? {
        route.resolve(in: threads).flatMap { $0.isArchived ? nil : $0 }
    }
}

/// Where the thread left on screen is kept, and for how long: noted as the app goes to the
/// background, and forgotten as it comes back, as it is quit, and once a launch has read
/// it. Only an app ended while away opens with it; one that crashed or was killed in front
/// (after coming back and opening another thread, say) does not open an older one.
public struct LeftOnScreenNote {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "screen.threadLeftOnScreen") {
        self.defaults = defaults
        self.key = key
    }

    /// The app goes to the background with `left` on screen (nil: a new thread).
    public func wentAway(with left: LeftOnScreen?) {
        if let left { defaults.set(left.saved, forKey: key) } else { forget() }
    }

    /// The app is back in front, or is quit: it was not ended while away.
    public func forget() {
        defaults.removeObject(forKey: key)
    }

    /// At launch: the thread left on screen by an app ended while away, read once.
    public func takeAtLaunch() -> LeftOnScreen? {
        defer { forget() }
        return LeftOnScreen(saved: defaults.dictionary(forKey: key) as? [String: String])
    }
}
