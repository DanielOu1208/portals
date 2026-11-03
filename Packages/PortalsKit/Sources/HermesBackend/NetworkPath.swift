import Foundation
import Network

/// The device's way onto the network, as much of it as says whether a connection made
/// earlier may have gone with it: whether there is a way out at all, and the interfaces
/// it goes by (Wi-Fi, cellular, a cable), in the order the system prefers them.
public struct NetworkPath: Hashable, Sendable {
    public var isSatisfied: Bool
    /// The interfaces' names (`en0`, `pdp_ip0`).
    public var interfaces: [String]

    public init(isSatisfied: Bool, interfaces: [String]) {
        self.isSatisfied = isSatisfied
        self.interfaces = interfaces
    }
}

/// The way out a socket, or an attempt to open one, went by, as far as the device's way
/// onto the network says: the interface the system put first as it began. A way onto the
/// network heard since without that interface took it away, and with it what went by it,
/// but for what goes through a tunnel (a VPN's interface, which the system need not put
/// first).
struct WayOut: Sendable {
    /// Nil when the device had no way out as it began.
    private(set) var interface: String?
    /// Whether the device's way onto the network was heard as it began. When not, the first
    /// heard is the one it began on.
    private var isKnown: Bool
    /// Whether the last way onto the network heard has the interface.
    private var isThere: Bool
    /// The interface went from a way onto the network heard since it began, or since this
    /// was last put back by whoever acted on it.
    var wentAway = false

    /// - Parameter path: the device's way onto the network as it begins; nil when not heard
    ///   yet.
    init(_ path: NetworkPath?) {
        interface = path?.interfaces.first
        isKnown = path != nil
        isThere = interface != nil
    }

    /// The device's way onto the network is now `path`.
    mutating func follow(_ path: NetworkPath) {
        guard isKnown else {
            self = WayOut(path)
            return
        }
        let there = interface.map(path.interfaces.contains) ?? false
        if isThere, !there { wentAway = true }
        isThere = there
    }
}

/// Where the backend hears of the device's way onto the network. A protocol, so a test can
/// say when it changes.
public protocol NetworkPathWatching: Sendable {
    /// The way onto the network now, then each time it changes, until the stream is let go
    /// of.
    func paths() -> AsyncStream<NetworkPath>
}

/// The system's word on it (`NWPathMonitor`), one monitor for each stream. Watching sends
/// nothing: the system says when the way changes.
public struct SystemNetworkPaths: NetworkPathWatching {
    public init() {}

    public func paths() -> AsyncStream<NetworkPath> {
        AsyncStream { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                continuation.yield(NetworkPath(isSatisfied: path.status == .satisfied, interfaces: path.availableInterfaces.map(\.name)))
            }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "HermesBackend.SystemNetworkPaths"))
        }
    }
}
