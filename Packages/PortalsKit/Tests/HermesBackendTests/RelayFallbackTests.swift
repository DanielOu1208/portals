import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// When a Mac of the device's net is reached through the relay rather than its address,
/// and when the connection moves back (docs/net-plan.md, "The relay as backup, per host"):
/// the address and the relay's tunnel played by scripted sockets, on a clock the test
/// moves.
@Suite struct RelayFallbackTests {
    private static let route = RelayRoute(
        relay: URL(string: "http://127.0.0.1:8790")!, relayID: "q1w2e3r4t5y6u7i8o9p0aZ",
        macKey: "Q4Zmi5yuCK7mpVPwicnkJXSNrD90polRr7a__xw8Gyw", token: "device-token"
    )!

    /// The address's sockets, the relay's, the clock and the network, and the backend over them.
    private struct Rig {
        let backend: HermesBackend
        let direct = TransportSequence()
        let relay = TransportSequence()
        let clock = TestClock()
        let network: ScriptedNetworkPaths

        init(hasRoute: Bool = true, on path: NetworkPath = .wifi) {
            let direct = direct
            let relay = relay
            network = ScriptedNetworkPaths(path)
            backend = HermesBackend(
                host: HostID(rawValue: "mac"),
                authenticator: TokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9411")!) { "device-token" },
                reconnectDelays: [.milliseconds(500), .seconds(1)],
                network: network, clock: clock, jitter: { 1 },
                relay: { hasRoute ? RelayFallbackTests.route : nil },
                makeTransport: { _ in direct.make() },
                makeRelayTransport: { _ in relay.make() }
            )
        }
    }

    /// A backend connected through the relay: the address did not answer within its limit.
    private func onRelay() async throws -> (Rig, ScriptedTransport) {
        let rig = Rig()
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        let tunnel = try #require(await rig.relay.next())
        try await tunnel.shakeHands(epoch: "e1")
        try await connecting.value
        #expect(await within { address.isClosed ? true : nil } == true)
        return (rig, tunnel)
    }

    // MARK: Trying the address first

    @Test func anAddressThatAnswersIsUsedAndTheRelayIsNotTried() async throws {
        let rig = Rig()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        let connecting = Task { try await rig.backend.connect() }
        try await #require(await rig.direct.next()).shakeHands(epoch: "e1")
        try await connecting.value
        #expect(await routes.next() == .direct)
        #expect(rig.relay.count == 0)
        await rig.backend.disconnect()
    }

    @Test func anAddressSilentForFiveSecondsIsLetGoForTheRelay() async throws {
        let (rig, tunnel) = try await onRelay()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        #expect(await routes.next() == .relay)
        #expect(!tunnel.isClosed)
        #expect(rig.direct.count == 1)
        await rig.backend.disconnect()
    }

    /// On a slow network the address may need longer than its limit: it is kept on while
    /// the relay is tried, and taken when the relay cannot reach the Mac.
    @Test func aSlowAddressStillConnectsWhenTheRelayCannot() async throws {
        let rig = Rig()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        try #require(await within { await rig.relay.next() }).drop(with: WebSocketClosed(code: 4503, reason: "The Mac is not connected to the relay."))
        rig.clock.advance(by: .seconds(2))
        #expect(!address.isClosed)
        try await address.shakeHands(epoch: "e1")
        try await connecting.value
        #expect(await routes.next() == .direct)
        #expect(!address.isClosed)
        await rig.backend.disconnect()
    }

    /// Whichever way answers first is taken, and the other let go of.
    @Test func aSlowAddressThatAnswersBeforeTheRelayIsTakenAndTheTunnelClosed() async throws {
        let rig = Rig()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        let tunnel = try #require(await within { await rig.relay.next() })
        try await address.shakeHands(epoch: "e1")
        try await connecting.value
        #expect(await routes.next() == .direct)
        #expect(await within { tunnel.isClosed ? true : nil } == true)
        await rig.backend.disconnect()
    }

    @Test func anAddressThatCannotBeReachedGoesToTheRelayWithoutWaiting() async throws {
        let rig = Rig()
        let connecting = Task { try await rig.backend.connect() }
        try #require(await rig.direct.next()).drop()
        try await #require(await within { await rig.relay.next() }).shakeHands(epoch: "e1")
        try await connecting.value
        await rig.backend.disconnect()
    }

    /// The Mac answered and refused the token: it would say the same through the relay.
    @Test func aRefusalAtTheAddressIsNotTriedThroughTheRelay() async throws {
        let rig = Rig()
        let connecting = Task { try await rig.backend.connect() }
        try #require(await rig.direct.next()).drop(with: WebSocketClosed(code: 4401, reason: "The token was not accepted."))
        await #expect(throws: WebSocketClosed.self) { try await connecting.value }
        #expect(rig.relay.count == 0)
        await rig.backend.disconnect()
    }

    @Test func aMacWithNoWayThroughTheRelayIsWaitedForAtItsAddressAlone() async throws {
        let rig = Rig(hasRoute: false)
        let connecting = Task { try await rig.backend.connect() }
        try #require(await rig.direct.next()).drop()
        await #expect(throws: (any Error).self) { try await connecting.value }
        // The wait before trying again, not the address's limit.
        #expect(await rig.clock.nextSleep() == .milliseconds(500))
        #expect(rig.relay.count == 0)
        await rig.backend.disconnect()
    }

    /// Through the relay the bridge refused the token (its sealed refusal, which the tunnel
    /// gives as the 4401 it closes with; `RelayRefusalTests`): said as it is, for the net to hear.
    @Test func aRefusalThroughTheRelayIsSaidAsTheMacsNo() async throws {
        let rig = Rig()
        var news = rig.backend.netNews.makeAsyncIterator()
        let connecting = Task { try await rig.backend.connect() }
        try #require(await rig.direct.next()).drop()
        try #require(await within { await rig.relay.next() }).drop(with: WebSocketClosed(code: 4401, reason: "The token was not accepted."))
        await #expect(throws: WebSocketClosed.self) { try await connecting.value }
        #expect(await news.next() == .refused("The token was not accepted."))
        await rig.backend.disconnect()
    }

    /// Neither way: what is said is the address's failure, and the backend keeps trying.
    @Test func whenNeitherWayAnswersTheAddresssFailureIsSaid() async throws {
        let rig = Rig()
        let connecting = Task { try await rig.backend.connect() }
        try #require(await rig.direct.next()).drop()
        try #require(await within { await rig.relay.next() }).drop(with: WebSocketClosed(code: 4503, reason: "The Mac is not connected to the relay."))
        await #expect(throws: ScriptedTransport.Closed.self) { try await connecting.value }
        // The address's limit, let go of as it failed; then the wait before trying again.
        #expect(await rig.clock.nextSleep() == .seconds(5))
        #expect(await rig.clock.nextSleep() == .milliseconds(500))
        await rig.backend.disconnect()
    }

    // MARK: On the relay

    /// A Mac reached only through the relay is not waited for at its address again on each
    /// reconnect: the relay first, then the address.
    @Test func aDroppedTunnelIsOpenedAgainThroughTheRelayFirst() async throws {
        let (rig, tunnel) = try await onRelay()
        #expect(await rig.clock.nextSleep() == .seconds(60))
        tunnel.drop()
        #expect(await rig.clock.nextSleep() == .milliseconds(500))
        rig.clock.advance(by: .milliseconds(500))
        try await #require(await within { await rig.relay.next() }).shakeHands(epoch: "e1")
        #expect(rig.direct.count == 1)
        await rig.backend.disconnect()
    }

    /// Through the relay first, which no longer reaches the Mac: the address is not cut at
    /// its limit then, as it is the only way left.
    @Test func whenTheRelayFailsFirstTheAddressHasItsWholeTime() async throws {
        let (rig, tunnel) = try await onRelay()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        #expect(await routes.next() == .relay)
        #expect(await rig.clock.nextSleep() == .seconds(60))
        tunnel.drop()
        #expect(await rig.clock.nextSleep() == .milliseconds(500))
        rig.clock.advance(by: .milliseconds(500))
        try #require(await within { await rig.relay.next() }).drop(with: WebSocketClosed(code: 4503, reason: "The Mac is not connected to the relay."))
        let address = try #require(await within { await rig.direct.next() })
        rig.clock.advance(by: .seconds(10))
        #expect(!address.isClosed)
        try await address.shakeHands(epoch: "e1")
        #expect(await routes.next() == .direct)
        #expect(!address.isClosed)
        await rig.backend.disconnect()
    }

    @Test func theAddressIsTriedEveryMinuteAndTheConnectionMovesBackWhenItAnswers() async throws {
        let (rig, tunnel) = try await onRelay()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        #expect(await routes.next() == .relay)
        var states = rig.backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        // A minute on: the address, which still does not answer within its limit.
        #expect(await rig.clock.nextSleep() == .seconds(60))
        rig.clock.advance(by: .seconds(60))
        let silent = try #require(await within { await rig.direct.next() })
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        #expect(await within { silent.isClosed ? true : nil } == true)
        #expect(!tunnel.isClosed)

        // Another minute on, it answers: the connection moves to it, and the tunnel closes.
        #expect(await rig.clock.nextSleep() == .seconds(60))
        rig.clock.advance(by: .seconds(60))
        try await #require(await within { await rig.direct.next() }).shakeHands(epoch: "e1")
        #expect(await routes.next() == .direct)
        #expect(await states.next() == .connected)
        #expect(await within { tunnel.isClosed ? true : nil } == true)
        await rig.backend.disconnect()
    }

    @Test func aChangeOfNetworkOnTheRelayTriesTheAddressAtOnce() async throws {
        let (rig, tunnel) = try await onRelay()
        var routes = rig.backend.connectionRoutes.makeAsyncIterator()
        #expect(await routes.next() == .relay)
        rig.network.change(to: .wifiAlone)
        try await #require(await within { await rig.direct.next() }).shakeHands(epoch: "e1")
        #expect(await routes.next() == .direct)
        #expect(await within { tunnel.isClosed ? true : nil } == true)
        await rig.backend.disconnect()
    }

    /// The threads a connection followed are followed on the one it moved to: a run going on
    /// is resumed there at once.
    @Test func aRunGoingOnIsResumedOnTheAddressItMovedTo() async throws {
        let (rig, tunnel) = try await onRelay()
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "s1"), agent: Agent.ID(host: rig.backend.host, name: "default"))
        let opening = Task { try await rig.backend.openThread(thread) }
        let resume = try await tunnel.expect("session.resume")
        try tunnel.answer(resume, ["session_id": "run-1", "resumed": "s1", "message_count": 0, "messages": [], "running": true])
        _ = try await opening.value

        #expect(await rig.clock.nextSleep() == .seconds(60))
        rig.clock.advance(by: .seconds(60))
        let address = try #require(await within { await rig.direct.next() })
        try await address.shakeHands(epoch: "e1")
        #expect(try await address.expect("session.resume")["params"]?["session_id"]?.stringValue == "s1")
        await rig.backend.disconnect()
    }

    /// The address's heartbeat stalled (here its check after a change of network): it may
    /// look reachable while nothing gets through, so the next attempt goes through the relay.
    @Test func aStalledAddressSendsTheNextAttemptThroughTheRelay() async throws {
        let rig = Rig()
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        try await address.shakeHands(epoch: "e1")
        try await connecting.value
        #expect(await rig.clock.nextSleep() == .seconds(5))

        rig.network.change(to: .cellular)
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        #expect(await within { address.isClosed ? true : nil } == true)
        try await #require(await within { await rig.relay.next() }).shakeHands(epoch: "e1")
        #expect(rig.direct.count == 1)
        await rig.backend.disconnect()
    }

    /// A change of network that keeps the address's way out (Wi-Fi joining cellular) still
    /// has the socket checked: through Tailscale the address can stall after any change.
    @Test func aChangeOfNetworkThatKeepsTheWayOutStillChecksTheAddress() async throws {
        let rig = Rig(on: .cellular)
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        try await address.shakeHands(epoch: "e1")
        try await connecting.value
        // The address's limit, still asleep: by now the backend follows the network.
        #expect(await rig.clock.nextSleep() == .seconds(5))

        rig.network.change(to: .wifi)
        let ping = try #require(await address.nextSent())
        #expect(ping["method"] == "gateway.ping")
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        #expect(await within { address.isClosed ? true : nil } == true)
        try await #require(await within { await rig.relay.next() }).shakeHands(epoch: "e1")
        #expect(rig.direct.count == 1)
        await rig.backend.disconnect()
    }

    /// A Mac the relay reaches too that answers its check keeps its socket.
    @Test func anAddressThatAnswersItsCheckAfterAChangeOfNetworkKeepsItsSocket() async throws {
        let rig = Rig(on: .cellular)
        let connecting = Task { try await rig.backend.connect() }
        let address = try #require(await rig.direct.next())
        try await address.shakeHands(epoch: "e1")
        try await connecting.value
        // The address's limit, still asleep: by now the backend follows the network.
        #expect(await rig.clock.nextSleep() == .seconds(5))

        rig.network.change(to: .wifi)
        let ping = try #require(await address.nextSent())
        #expect(ping["method"] == "gateway.ping")
        try address.answer(ping, [:])
        #expect(await rig.clock.nextSleep() == .seconds(5))
        rig.clock.advance(by: .seconds(5))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!address.isClosed)
        #expect(rig.relay.count == 0)
        await rig.backend.disconnect()
    }

    // MARK: Through the relay

    @Test func theTunnelDoesNotCarryACallOver16MiB() throws {
        let tunnel = RelayTunnelTransport(route: Self.route)
        defer { tunnel.close() }
        try tunnel.checkCarries(String(repeating: "a", count: 16 * 1024 * 1024))
        #expect(throws: TooLargeForRelay.self) { try tunnel.checkCarries(String(repeating: "a", count: 16 * 1024 * 1024 + 1)) }
        #expect(TooLargeForRelay().localizedDescription == "This is over 16 MiB, too large to send through the relay. Try again when this device reaches the host directly.")
        // A socket to the Mac's address carries it.
        try ScriptedTransport().checkCarries(String(repeating: "a", count: 16 * 1024 * 1024 + 1))
    }

    // MARK: The decisions alone

    @Test func theWaysInOrder() {
        var fallback = RelayFallback()
        #expect(fallback.ways(relayAvailable: false) == [.direct])
        #expect(fallback.ways(relayAvailable: true) == [.direct, .relay])
        let worthTheRelay = fallback.directFailed(HermesConnectionError.notReady)
        #expect(worthTheRelay)
        #expect(fallback.ways(relayAvailable: true) == [.relay, .direct])
        #expect(fallback.ways(relayAvailable: false) == [.direct])
        fallback.directAnswered()
        #expect(fallback.ways(relayAvailable: true) == [.direct, .relay])
        fallback.ended(.direct, with: JSONRPCPeerError.heartbeatTimedOut)
        #expect(fallback.prefersRelay)
        fallback.networkChanged()
        #expect(!fallback.prefersRelay)
        // A tunnel that stalled, or an address closed for another reason, changes nothing.
        fallback.ended(.relay, with: JSONRPCPeerError.heartbeatTimedOut)
        fallback.ended(.direct, with: ScriptedTransport.Closed())
        fallback.ended(.direct, with: nil)
        #expect(!fallback.prefersRelay)
    }

    @Test func whatCountsAsTheMacNotReached() {
        #expect(RelayFallback.isUnreachable(HermesConnectionError.notReady))
        #expect(RelayFallback.isUnreachable(URLError(.cannotConnectToHost)))
        #expect(RelayFallback.isUnreachable(WebSocketClosed(underlying: "Socket is not connected")))
        #expect(RelayFallback.isUnreachable(WebSocketClosed(code: 4503, reason: "The Mac is not connected to the relay.")))
        #expect(RelayFallback.isUnreachable(TunnelBroken.frame))
        #expect(!RelayFallback.isUnreachable(WebSocketClosed(code: 4401)))
        #expect(!RelayFallback.isUnreachable(WebSocketClosed(code: 4403)))
        #expect(!RelayFallback.isUnreachable(HermesAuthError.missingCredentials))
        #expect(!RelayFallback.isUnreachable(HermesConnectionError.refused("No.")))
        #expect(!RelayFallback.isUnreachable(CancellationError()))
    }
}
