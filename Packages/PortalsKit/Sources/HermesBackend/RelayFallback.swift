import AgentCore
import Foundation

/// Which way a backend tries its host, for a Mac of the device's net that the relay can
/// reach too (docs/net-plan.md, "The relay as backup, per host"): the host's own address
/// first; the relay when the address cannot be reached within its limit, or its
/// heartbeat stalls. Once the address has failed so, attempts go through the relay first
/// until the address answers again (tried every minute while on the relay, and when the
/// network changes), so a Mac that is only reachable through the relay is not waited for
/// at its address on every reconnect.
struct RelayFallback: Sendable {
    /// The address failed, or stalled, and has not answered since.
    private(set) var prefersRelay = false

    /// The ways an attempt to connect tries, in order: the address alone when there is no
    /// way through the relay.
    func ways(relayAvailable: Bool) -> [ConnectionRoute] {
        guard relayAvailable else { return [.direct] }
        return prefersRelay ? [.relay, .direct] : [.direct, .relay]
    }

    /// The address failed with `error`. True when the relay is worth trying for it, which
    /// it then is first from now on: the Mac could not be reached. False when it was reached
    /// and said no (a token it does not take, an origin it refuses): it would say the same
    /// through the relay.
    mutating func directFailed(_ error: any Error) -> Bool {
        guard Self.isUnreachable(error) else { return false }
        prefersRelay = true
        return true
    }

    /// The address answered: it comes first again.
    mutating func directAnswered() {
        prefersRelay = false
    }

    /// A connection that went `route` ended with `error`. One to the address whose heartbeat
    /// stalled (or whose check after a change of network did) sends the next attempt to the
    /// relay first: the address may look reachable while nothing gets through it, as
    /// Tailscale on iOS can after a move from Wi-Fi to cellular.
    mutating func ended(_ route: ConnectionRoute, with error: (any Error)?) {
        guard route == .direct, let error, case JSONRPCPeerError.heartbeatTimedOut = error else { return }
        prefersRelay = true
    }

    /// The device's way onto the network changed: the address may answer on the new one,
    /// so it is tried first again.
    mutating func networkChanged() {
        prefersRelay = false
    }

    /// Whether `error`, from an attempt to connect, says the host could not be reached, rather
    /// than that it was reached and refused: a sign-in or an address it does not take, or an
    /// attempt let go of.
    static func isUnreachable(_ error: any Error) -> Bool {
        switch error {
        case let closed as WebSocketClosed:
            !closed.isUnauthorized && !closed.isForbidden
        case is HermesAuthError, is CancellationError:
            false
        case HermesConnectionError.refused:
            false
        default:
            true
        }
    }
}
