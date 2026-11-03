import Foundation

/// Whether the app can reach a host right now.
public enum ConnectionState: Hashable, Sendable {
    /// Not connected. Unless the app let go of the connection itself, the backend is
    /// trying again.
    case disconnected(reason: String?)
    /// Not connected, and not trying: it would fail the same way until something is
    /// changed (the password, the address).
    case stopped(reason: String)
    case connecting
    case connected
}

/// Which way a connection to a host goes.
public enum ConnectionRoute: Hashable, Sendable {
    /// To the host's own address (over Tailscale, say).
    case direct
    /// Through the Portals relay's tunnel, sealed end to end: a Mac of the device's net
    /// whose address did not answer (docs/net-plan.md, "The relay as backup, per host").
    case relay
}

/// A backend that may reach its host another way than its address.
public protocol RouteReporting: Sendable {
    /// The way each connection went, as it opens, and again when it moves to another way
    /// while open. One consumer.
    var connectionRoutes: AsyncStream<ConnectionRoute> { get }
}
