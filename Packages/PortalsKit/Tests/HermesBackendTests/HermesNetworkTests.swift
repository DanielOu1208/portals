import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// What the backend does when the device's way onto the network changes, and how long it
/// waits before trying again: on a clock the test moves, with the network the test says.
@Suite struct HermesNetworkTests {
    private let steps: [Duration] = [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(10)]

    private func makeBackend(
        _ transports: TransportSequence, network: ScriptedNetworkPaths? = nil, clock: TestClock, jitter: Double = 1,
        authenticator: any HermesAuthenticator = LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t")
    ) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "test"), authenticator: authenticator, reconnectDelays: steps,
            network: network, clock: clock, jitter: { jitter }, makeTransport: { _ in transports.make() }
        )
    }

    /// A backend connected on Wi-Fi, or on the way onto the network given.
    private func connected(
        on path: NetworkPath = .wifi,
        authenticator: any HermesAuthenticator = LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t")
    ) async throws -> (HermesBackend, TransportSequence, ScriptedTransport, ScriptedNetworkPaths, TestClock) {
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(path)
        let clock = TestClock()
        let backend = makeBackend(transports, network: network, clock: clock, authenticator: authenticator)
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        try await transport.shakeHands(epoch: "e1")
        try await connecting.value
        return (backend, transports, transport, network, clock)
    }

    // MARK: Waiting to try again

    @Test func eachWaitBeforeTryingAgainIsItsStepCutByTheJitter() async throws {
        let transports = TransportSequence()
        let clock = TestClock()
        let backend = makeBackend(transports, clock: clock, jitter: 0.5)
        let connecting = Task { try await backend.connect() }
        try #require(await transports.next()).drop()
        await #expect(throws: (any Error).self) { try await connecting.value }

        // The steps as before, the last one repeating, each cut to half here.
        for step in steps + [.seconds(10)] {
            #expect(await clock.nextSleep() == step / 2)
            clock.advance(by: step / 2)
            try #require(await within { await transports.next() }).drop()
        }
        await backend.disconnect()
    }

    // MARK: A change of network while not connected

    @Test func aNewWayOntoTheNetworkWhileWaitingToTryAgainTriesAtOnceAndTheWaitsStartOver() async throws {
        let (backend, transports, first, network, clock) = try await connected()
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        try #require(await within { await transports.next() }).drop()
        #expect(await clock.nextSleep() == .seconds(1))

        // On cellular now: tried at once, without waiting out the second.
        network.change(to: .cellular)
        try #require(await within { await transports.next() }).drop()
        // And the waits start over from the first.
        #expect(await clock.nextSleep() == .milliseconds(500))

        network.change(to: .wifi)
        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        await backend.disconnect()
    }

    @Test func anAttemptUnderWayOnAWayOutThatStaysIsWaitedForAndFollowedAtOnceShouldItFail() async throws {
        let (backend, transports, first, network, clock) = try await connected(on: .cellular)
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        // Begun on cellular, which is still there when Wi-Fi comes: it may yet get through.
        let begun = try #require(await within { await transports.next() })
        network.change(to: .wifi)
        try await Task.sleep(for: .milliseconds(50))
        #expect(transports.count == 2)
        #expect(!begun.isClosed)
        begun.drop()

        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        await backend.disconnect()
    }

    /// The one under way may wait 20 s for its ticket and 15 for `gateway.ready` on a way
    /// that is gone: it is let go, and another goes on the way the device has now.
    @Test func anAttemptUnderWayOnAWayOutThatGoesIsLetGoForAnotherAtOnce() async throws {
        let (backend, transports, first, network, clock) = try await connected()
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        // Begun on Wi-Fi, which goes while it waits for the host's `gateway.ready`.
        let begun = try #require(await within { await transports.next() })
        network.change(to: .cellular)

        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        #expect(await within { begun.isClosed ? true : nil } == true)
        await backend.disconnect()
    }

    /// One let go that fails late (its ticket refused, which would stop trying again) says
    /// nothing: the connection in its place goes on.
    @Test func anAttemptLetGoThatFailsLateLeavesTheConnectionInItsPlaceAlone() async throws {
        let tickets = HeldTicket(holding: 2)
        let (backend, transports, first, network, clock) = try await connected(authenticator: tickets)
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        first.drop()
        guard case .disconnected = await states.next() else { Issue.record("not disconnected"); return }
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        // Its ticket is asked for on Wi-Fi, which goes before the host answers.
        #expect(await within { tickets.isHolding ? true : nil } == true)
        #expect(await states.next() == .connecting)
        network.change(to: .cellular)
        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1")
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        tickets.release(throwing: .invalidCredentials)
        #expect(await within { tickets.isHolding ? nil : true } == true)
        try await Task.sleep(for: .milliseconds(50))
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
        #expect(await states.next() == .disconnected(reason: nil))
    }

    /// One let go that gets its ticket late has the socket it opens closed: the connection in
    /// its place stays the one.
    @Test func anAttemptLetGoThatGetsItsTicketLateIsClosed() async throws {
        let tickets = HeldTicket(holding: 2)
        let (backend, transports, first, network, clock) = try await connected(authenticator: tickets)
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        #expect(await within { tickets.isHolding ? true : nil } == true)
        network.change(to: .cellular)
        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1", features: ["subagents"])

        tickets.release()
        let late = try #require(await within { await transports.next() })
        late.deliver(["jsonrpc": "2.0", "method": "event", "params": [
            "type": "gateway.ready", "payload": ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["subagents"]]],
        ]])
        #expect(await within { late.isClosed ? true : nil } == true)
        #expect(!second.isClosed)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
    }

    /// One let go that ends while the attempt in its place is under way leaves that one the
    /// attempt everyone shares: no third begins beside it.
    @Test func anAttemptLetGoThatEndsLateLeavesTheOneInItsPlaceShared() async throws {
        let tickets = HeldTicket(holding: 2)
        let (backend, transports, first, network, clock) = try await connected(authenticator: tickets)
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        #expect(await within { tickets.isHolding ? true : nil } == true)
        network.change(to: .cellular)
        let second = try #require(await within { await transports.next() })

        tickets.release(throwing: .invalidCredentials)
        #expect(await within { tickets.isHolding ? nil : true } == true)
        try await Task.sleep(for: .milliseconds(50))
        // The app asks to connect meanwhile (`HostModel.start`, Retry): it waits for that one.
        let connecting = Task { try await backend.connect() }
        try await Task.sleep(for: .milliseconds(50))
        #expect(transports.count == 2)
        try await second.shakeHands(epoch: "e1")
        try await connecting.value
        #expect(transports.count == 2)
        await backend.disconnect()
    }

    /// The app that asked to connect (`HostModel.start`) and waits for an attempt let go of
    /// waits for the one in its place, and hears how that went: that the first was let go
    /// of is no problem of the host's to show.
    @Test func aConnectWaitingOnAnAttemptLetGoWaitsForTheOneInItsPlace() async throws {
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(transports, network: network, clock: TestClock())
        let connecting = Task { try await backend.connect() }
        // Its first attempt, begun on Wi-Fi, which goes while it waits for the host's
        // `gateway.ready`.
        let begun = try #require(await within { await transports.next() })
        network.change(to: .cellular)

        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        try await connecting.value
        #expect(begun.isClosed)
        #expect(transports.count == 2)
        await backend.disconnect()
    }

    /// And hears it as soon as the one in its place connects, though the ticket of the one
    /// let go of is still on its way (asked for on a way that went, it need not heed being
    /// let go of): `HostModel.start` would keep starting, the agents not loaded, until then.
    @Test func aConnectWaitingOnAnAttemptLetGoReturnsAsTheOneInItsPlaceConnectsThoughItsTicketIsStillAwaited() async throws {
        let tickets = HeldTicket(holding: 1)
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(transports, network: network, clock: TestClock(), authenticator: tickets)
        let returned = Flag()
        let connecting = Task {
            try await backend.connect()
            returned.set()
        }
        // Its first attempt asks for its ticket on Wi-Fi, which goes before the host gives it.
        #expect(await within { tickets.isHolding ? true : nil } == true)
        network.change(to: .cellular)

        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1")
        #expect(await within { returned.isSet ? true : nil } == true)
        #expect(tickets.isHolding)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)

        // The ticket comes at last: the socket it opens is closed, and the connection in its
        // place stays the one.
        tickets.release()
        let late = try #require(await within { await transports.next() })
        late.deliver(["jsonrpc": "2.0", "method": "event", "params": [
            "type": "gateway.ready", "payload": ["replay_epoch": "e1", "heartbeat": false],
        ]])
        #expect(await within { late.isClosed ? true : nil } == true)
        #expect(!second.isClosed)
        try await connecting.value
        let again = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await again.value.count == 1)
        await backend.disconnect()
    }

    /// One begun before the app went to the background, on a way gone as it comes back, is
    /// let go of as the way it comes back on is heard: no change follows to do it.
    @Test func anAttemptUnderWayAsTheAppComesBackOnAnotherWayOutIsLetGoForAnotherAtOnce() async throws {
        let (backend, transports, first, network, clock) = try await connected()
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        // Begun on Wi-Fi, still waiting for the host's `gateway.ready` as the app goes to the
        // background, and on cellular as it comes back.
        let begun = try #require(await within { await transports.next() })
        await backend.suspend()
        #expect(await within { network.watchers == 0 ? true : nil } == true)
        network.change(to: .cellular)

        let resuming = Task { await backend.resume() }
        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        await resuming.value
        #expect(await within { begun.isClosed ? true : nil } == true)
        #expect(transports.count == 3)
        await backend.disconnect()
    }

    /// One that gets the host's answer after the app went to the background closes the
    /// socket it opened, and the app comes back on another way out while it does: let go of
    /// for one on that way, it says nothing as it ends. The connection in its place stays
    /// connected, where the app heard it disconnected (and stopped asking for the sidebar)
    /// though it works.
    @Test func anAttemptLetGoOfWhileItClosesTheSocketItOpenedInTheBackgroundSaysNothingAsItEnds() async throws {
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(transports, network: network, clock: TestClock())
        var states = backend.connectionStates.makeAsyncIterator()
        let connecting = Task { try await backend.connect() }
        // Begun on Wi-Fi, still waiting for the host's `gateway.ready` as the app goes to the
        // background.
        let begun = try #require(await within { await transports.next() })
        #expect(await states.next() == .connecting)
        await backend.suspend()
        #expect(await within { network.watchers == 0 ? true : nil } == true)
        // The host answers, and the socket is slow to close.
        begun.holdClose()
        defer { begun.releaseClose() }
        try await begun.shakeHands(epoch: "e1")
        #expect(await within { begun.isClosing ? true : nil } == true)

        // The app comes back on cellular meanwhile.
        network.change(to: .cellular)
        let resuming = Task { await backend.resume() }
        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1")
        await resuming.value
        try await connecting.value
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        // The first socket closes at last: that says nothing, and the connection in its place
        // goes on.
        begun.releaseClose()
        #expect(await within { begun.isClosed ? true : nil } == true)
        try await Task.sleep(for: .milliseconds(50))
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        // The next the app hears of is that one's end.
        second.drop()
        #expect(await states.next() == .disconnected(reason: ScriptedTransport.Closed().localizedDescription))
        await backend.disconnect()
    }

    /// And says nothing though the app has gone to the background again by then: the one in
    /// its place, still under way, says how it went.
    @Test func anAttemptLetGoOfWhileItClosesTheSocketItOpenedSaysNothingThoughTheAppHasGoneToTheBackgroundAgain() async throws {
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(transports, network: network, clock: TestClock())
        var states = backend.connectionStates.makeAsyncIterator()
        let connecting = Task { try await backend.connect() }
        let begun = try #require(await within { await transports.next() })
        #expect(await states.next() == .connecting)
        await backend.suspend()
        #expect(await within { network.watchers == 0 ? true : nil } == true)
        begun.holdClose()
        defer { begun.releaseClose() }
        try await begun.shakeHands(epoch: "e1")
        #expect(await within { begun.isClosing ? true : nil } == true)

        // The app comes back on cellular, and goes to the background again while the attempt
        // on that way waits for the host.
        network.change(to: .cellular)
        let resuming = Task { await backend.resume() }
        let second = try #require(await within { await transports.next() })
        #expect(await states.next() == .connecting)
        await backend.suspend()
        begun.releaseClose()
        #expect(await within { begun.isClosed ? true : nil } == true)
        try await Task.sleep(for: .milliseconds(50))
        try await second.shakeHands(epoch: "e1")
        #expect(await within { second.isClosed ? true : nil } == true)
        await resuming.value
        try await connecting.value
        #expect(await states.next() == .disconnected(reason: nil))

        // The next the app hears of is the connection it comes back to.
        let again = Task { await backend.resume() }
        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        await again.value
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        await backend.disconnect()
    }

    /// Or the app comes back on the same way out while it closes the socket: it wants a
    /// connection again, so another attempt is made as that one ends, where the app was left
    /// with none and nothing trying again.
    @Test func anAttemptClosingTheSocketItOpenedInTheBackgroundAsTheAppComesBackIsFollowedByAnother() async throws {
        let transports = TransportSequence()
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(transports, network: network, clock: TestClock())
        var states = backend.connectionStates.makeAsyncIterator()
        let connecting = Task { try await backend.connect() }
        let begun = try #require(await within { await transports.next() })
        #expect(await states.next() == .connecting)
        await backend.suspend()
        #expect(await within { network.watchers == 0 ? true : nil } == true)
        begun.holdClose()
        defer { begun.releaseClose() }
        try await begun.shakeHands(epoch: "e1")
        #expect(await within { begun.isClosing ? true : nil } == true)

        // The app comes back on Wi-Fi still, and waits for that attempt.
        let resuming = Task { await backend.resume() }
        #expect(await within { network.watchers == 1 ? true : nil } == true)
        begun.releaseClose()
        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1")
        await resuming.value
        try await connecting.value
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
        #expect(await states.next() == .disconnected(reason: nil))
    }

    @Test func aSignInTheHostRefusedIsNotTriedAgainForANewWayOntoTheNetwork() async throws {
        let authenticator = CountedRefusal(.invalidCredentials)
        let network = ScriptedNetworkPaths(.wifi)
        let backend = makeBackend(TransportSequence(), network: network, clock: TestClock(), authenticator: authenticator)
        await #expect(throws: HermesAuthError.invalidCredentials) { try await backend.connect() }

        // Each try would count against the host's limit on sign-in attempts.
        network.change(to: .cellular)
        try await Task.sleep(for: .milliseconds(60))
        #expect(authenticator.attempts == 1)
        await backend.disconnect()
    }

    // MARK: A change of network while connected

    @Test func aNewWayOntoTheNetworkWhileConnectedChecksTheSocketAtOnce() async throws {
        let (backend, transports, transport, network, clock) = try await connected()
        network.change(to: .cellular)
        let ping = try #require(await within { await transport.nextSent() })
        #expect(ping["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))

        // The host answers: the socket goes on as it was. (A call answered after the pong
        // is there to know the pong has arrived before the check is over.)
        try transport.answer(ping, ["ok": true])
        let listing = Task { try await backend.listAgents() }
        try transport.answer(try await transport.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        clock.advance(by: .seconds(5))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!transport.isClosed)
        #expect(transports.count == 1)

        let again = Task { try await backend.listAgents() }
        try transport.answer(try await transport.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await again.value.count == 1)
        await backend.disconnect()
    }

    /// A host that does not offer the heartbeat (this one's `gateway.ready` says
    /// `heartbeat: false`) is checked all the same. A Hermes from before the heartbeat
    /// answers `gateway.ping` as a method it does not know, with an error, at once
    /// (tui_gateway's `handle_request`): an error is a frame like any other, and says the
    /// socket is alive.
    @Test func aHostThatAnswersThePingWithAnErrorKeepsItsSocket() async throws {
        let (backend, transports, transport, network, clock) = try await connected()
        network.change(to: .cellular)
        let ping = try #require(await within { await transport.nextSent() })
        #expect(ping["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))

        // Nothing else arrives before the check is over: the error alone says it.
        try transport.fail(ping, code: JSONRPCError.methodNotFoundCode, message: "unknown method: gateway.ping")
        try await Task.sleep(for: .milliseconds(50))
        clock.advance(by: .seconds(5))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!transport.isClosed)
        #expect(transports.count == 1)

        let listing = Task { try await backend.listAgents() }
        try transport.answer(try await transport.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
    }

    @Test func aSocketThatSaysNothingAfterTheCheckIsReplacedAtOnce() async throws {
        let (backend, transports, transport, network, clock) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        network.change(to: .cellular)
        #expect(try #require(await within { await transport.nextSent() })["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))
        clock.advance(by: .seconds(5))
        #expect(await states.next() == .disconnected(reason: JSONRPCPeerError.heartbeatTimedOut.localizedDescription))
        #expect(transport.isClosed)

        // Reopened at once: nothing waits on the clock first.
        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        await backend.disconnect()
    }

    /// Wi-Fi that comes back and goes again while the socket is checked for its first going:
    /// what arrived after the first says nothing of the socket after the second, so the check
    /// starts over with a ping of its own, and a socket that says nothing after the second is
    /// closed at that one's deadline, where the first's pong had it left to the heartbeat.
    @Test func aWayOutThatGoesAgainWhileTheSocketIsCheckedStartsTheCheckOver() async throws {
        let (backend, transports, transport, network, clock) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        network.change(to: .cellular)
        let ping = try #require(await within { await transport.nextSent() })
        #expect(ping["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))
        // The host answers. (A call answered after the pong is there to know the pong has
        // arrived.)
        try transport.answer(ping, ["ok": true])
        let listing = Task { try await backend.listAgents() }
        try transport.answer(try await transport.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)

        // Two seconds on, Wi-Fi comes back and goes again, and nothing arrives after.
        clock.advance(by: .seconds(2))
        network.change(to: .wifi)
        network.change(to: .cellular)
        #expect(try #require(await within { await transport.nextSent() })["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))
        // The first check's deadline passes: the second's has not.
        clock.advance(by: .seconds(3))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!transport.isClosed)

        // The second's does: closed, and reopened at once.
        clock.advance(by: .seconds(2))
        #expect(await states.next() == .disconnected(reason: JSONRPCPeerError.heartbeatTimedOut.localizedDescription))
        #expect(transport.isClosed)
        try await #require(await within { await transports.next() }).shakeHands(epoch: "e1")
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        await backend.disconnect()
    }

    @Test func aSocketOpenedWhileTheOneBeforeWasCheckedIsCheckedAtTheNextChange() async throws {
        let (backend, transports, first, network, clock) = try await connected()
        network.change(to: .cellular)
        #expect(try #require(await within { await first.nextSent() })["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))

        // That socket goes by itself before its check is over, and another is opened.
        first.drop()
        #expect(await clock.nextSleep() == .milliseconds(500))
        clock.advance(by: .milliseconds(500))
        let second = try #require(await within { await transports.next() })
        try await second.shakeHands(epoch: "e1")
        var connects = 0
        for await state in backend.connectionStates where state == .connected {
            connects += 1
            if connects == 2 { break }
        }

        // Opened on cellular, which goes.
        network.change(to: .wifiAlone)
        #expect(try #require(await within { await second.nextSent() })["method"] == "gateway.ping")
        await backend.disconnect()
    }

    /// A change that leaves the way the socket went out by (Wi-Fi joining cellular) does not
    /// check it: it is likely alive, and a large frame on its way over a slow link (a long
    /// conversation resumed, a first list) would hold the answer to a check back past its
    /// deadline, which would close a socket that works for the next to fetch it all again.
    @Test func aSocketOnAWayOutThatStaysIsNotCheckedSoALargeAnswerOnItsWayIsNotCut() async throws {
        let (backend, transports, transport, network, clock) = try await connected(on: .cellular)
        let listing = Task { try await backend.listAgents() }
        let asked = try #require(await transport.nextSent())
        #expect(asked["method"] == "profiles.list")

        network.change(to: .wifi)
        try await Task.sleep(for: .milliseconds(50))
        clock.advance(by: .seconds(5))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!transport.isClosed)
        // The answer arrives, long after.
        try transport.answer(asked, ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        #expect(transports.count == 1)

        // Nothing was sent in between: the next frame is the app's own call.
        let again = Task { try await backend.listAgents() }
        let next = try #require(await transport.nextSent())
        #expect(next["method"] == "profiles.list")
        try transport.answer(next, ["profiles": [["name": "default"]]])
        #expect(try await again.value.count == 1)
        await backend.disconnect()
    }

    /// Wi-Fi that goes with no way out for a while, then comes back (another network, as
    /// likely as not) took the socket's way away in between: it is checked.
    @Test func aSocketWhoseWayOutWentWithNoWayOutBetweenIsCheckedWhenAWayComesBack() async throws {
        let (backend, _, transport, network, _) = try await connected(on: .wifiAlone)
        network.change(to: .none)
        network.change(to: .wifiAlone)
        #expect(try #require(await within { await transport.nextSent() })["method"] == "gateway.ping")
        await backend.disconnect()
    }

    /// A socket that answered its check after its way went (it goes through a tunnel, which
    /// went over to cellular) is not checked again until that way comes and goes again.
    @Test func aSocketThatAnsweredItsCheckIsCheckedAgainOnlyWhenItsWayOutGoesAgain() async throws {
        let (backend, transports, transport, network, clock) = try await connected()
        network.change(to: .cellular)
        let ping = try #require(await within { await transport.nextSent() })
        #expect(ping["method"] == "gateway.ping")
        #expect(await clock.nextSleep() == .seconds(5))
        try transport.answer(ping, ["ok": true])
        try await Task.sleep(for: .milliseconds(50))
        clock.advance(by: .seconds(5))
        try await Task.sleep(for: .milliseconds(50))
        #expect(!transport.isClosed)

        // The tunnel comes up on cellular: Wi-Fi is no more gone than it was.
        network.change(to: .cellularWithTunnel)
        try await Task.sleep(for: .milliseconds(50))
        let listing = Task { try await backend.listAgents() }
        let next = try #require(await transport.nextSent())
        try #require(next["method"] == "profiles.list")
        try transport.answer(next, ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)

        // Wi-Fi comes back and goes again: checked.
        network.change(to: .wifi)
        network.change(to: .cellular)
        #expect(try #require(await within { await transport.nextSent() })["method"] == "gateway.ping")
        #expect(transports.count == 1)
        await backend.disconnect()
    }

    @Test func theWayTheDeviceIsOnAlreadyOrOneWithNoWayOutSendsNothing() async throws {
        let (backend, _, transport, network, _) = try await connected()
        network.change(to: .wifi)
        // Nothing gets through: what is under way finds that out by itself.
        network.change(to: .none)
        try await Task.sleep(for: .milliseconds(100))

        // The first thing sent after the handshake is the app's own call.
        let listing = Task { try await backend.listAgents() }
        let sent = try #require(await transport.nextSent())
        #expect(sent["method"] == "profiles.list")
        try transport.answer(sent, ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
    }

    @Test func theNetworkIsWatchedOnlyWhileAConnectionIsWanted() async throws {
        let (backend, transports, _, network, _) = try await connected()
        #expect(network.watchers == 1)

        await backend.suspend()
        #expect(await within { network.watchers == 0 ? true : nil } == true)
        network.change(to: .cellular)
        try await Task.sleep(for: .milliseconds(60))
        #expect(transports.count == 1)

        let resuming = Task { await backend.resume() }
        try await #require(await transports.next()).shakeHands(epoch: "e1")
        await resuming.value
        #expect(network.watchers == 1)
        await backend.disconnect()
    }
}

// MARK: - Helpers

/// What `value` gives, or nil when it takes longer than `limit` to: a test that waits for
/// something meant to come at once fails, rather than hangs, when it does not come. A
/// `value` that gives nil is asked again until it does not.
func within<Value: Sendable>(_ limit: Duration = .seconds(5), _ value: @escaping @Sendable () async -> Value?) async -> Value? {
    await withTaskGroup(of: Value?.self) { group in
        group.addTask {
            while !Task.isCancelled {
                if let given = await value() { return given }
                try? await Task.sleep(for: .milliseconds(5))
            }
            return nil
        }
        group.addTask {
            try? await Task.sleep(for: limit)
            return nil
        }
        defer { group.cancelAll() }
        return await group.next() ?? nil
    }
}

extension NetworkPath {
    static let wifi = NetworkPath(isSatisfied: true, interfaces: ["en0", "pdp_ip0"])
    static let cellular = NetworkPath(isSatisfied: true, interfaces: ["pdp_ip0"])
    /// Wi-Fi with no cellular beside it (an iPad, a Mac).
    static let wifiAlone = NetworkPath(isSatisfied: true, interfaces: ["en0"])
    /// Cellular, with a VPN's tunnel that came up on it.
    static let cellularWithTunnel = NetworkPath(isSatisfied: true, interfaces: ["pdp_ip0", "utun4"])
    static let none = NetworkPath(isSatisfied: false, interfaces: [])
}

/// The device's way onto the network, as the test says it is.
final class ScriptedNetworkPaths: NetworkPathWatching {
    private struct State {
        var path: NetworkPath
        var watchers: [Int: AsyncStream<NetworkPath>.Continuation] = [:]
        var lastID = 0
    }

    private let state: Mutex<State>

    init(_ path: NetworkPath) {
        state = Mutex(State(path: path))
    }

    /// How many streams of it are being watched.
    var watchers: Int { state.withLock { $0.watchers.count } }

    func paths() -> AsyncStream<NetworkPath> {
        let (stream, continuation) = AsyncStream.makeStream(of: NetworkPath.self)
        let id = state.withLock { state in
            state.lastID += 1
            state.watchers[state.lastID] = continuation
            continuation.yield(state.path)
            return state.lastID
        }
        continuation.onTermination = { [weak self] _ in
            self?.state.withLock { _ = $0.watchers.removeValue(forKey: id) }
        }
        return stream
    }

    func change(to path: NetworkPath) {
        let watchers = state.withLock { state in
            state.path = path
            return Array(state.watchers.values)
        }
        for watcher in watchers { watcher.yield(path) }
    }
}

/// A clock that moves only when the test moves it, and tells the test each wait begun on
/// it.
final class TestClock: Clock, Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        var id: Int
        var deadline: Instant
        var continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var now = Instant(offset: .zero)
        var sleepers: [Sleeper] = []
        /// Waits cancelled before they were put down to be woken.
        var cancelled: Set<Int> = []
        var lastID = 0
    }

    private let state = Mutex(State())
    private let begun: AsyncStream<Duration>
    private let begunContinuation: AsyncStream<Duration>.Continuation

    init() {
        (begun, begunContinuation) = AsyncStream.makeStream()
    }

    var now: Instant { state.withLock { $0.now } }
    var minimumResolution: Duration { .zero }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let (id, now) = state.withLock { state in
            state.lastID += 1
            return (state.lastID, state.now)
        }
        begunContinuation.yield(now.duration(to: deadline))
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let outcome: Result<Void, any Error>? = state.withLock { state in
                    if state.cancelled.remove(id) != nil { return .failure(CancellationError()) }
                    if deadline <= state.now { return .success(()) }
                    state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return nil
                }
                if let outcome { continuation.resume(with: outcome) }
            }
        } onCancel: {
            let sleeper = state.withLock { state -> Sleeper? in
                guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else {
                    state.cancelled.insert(id)
                    return nil
                }
                return state.sleepers.remove(at: index)
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Moves the clock on, waking the waits that are over.
    func advance(by duration: Duration) {
        let woken = state.withLock { state in
            state.now = state.now.advanced(by: duration)
            let now = state.now
            let woken = state.sleepers.filter { $0.deadline <= now }
            state.sleepers.removeAll { $0.deadline <= now }
            return woken
        }
        for sleeper in woken { sleeper.continuation.resume() }
    }

    /// How long the next wait begun on the clock is for; nil when none begins within a few
    /// seconds.
    func nextSleep() async -> Duration? {
        let begun = begun
        return await within {
            for await duration in begun { return duration }
            return nil
        }
    }
}

/// A sign-in the host always refuses the same way, counting the tries.
private final class CountedRefusal: HermesAuthenticator {
    private let error: HermesAuthError
    private let tries = Mutex(0)
    let baseURL = URL(string: "http://127.0.0.1:9119")!

    init(_ error: HermesAuthError) {
        self.error = error
    }

    var attempts: Int { tries.withLock { $0 } }

    func webSocketRequest() async throws -> URLRequest {
        tries.withLock { $0 += 1 }
        throw error
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw error
    }
}

/// Tickets for the host, the `holding`-th of which is not given until the test releases it,
/// as one asked for on a way out that went: it waits whether or not it was cancelled.
private final class HeldTicket: HermesAuthenticator {
    private struct State {
        var asked = 0
        var waiting: CheckedContinuation<Result<Void, HermesAuthError>, Never>?
        var released: Result<Void, HermesAuthError>?
    }

    private let holding: Int
    private let state = Mutex(State())
    let baseURL = URL(string: "http://127.0.0.1:9119")!

    init(holding: Int) {
        self.holding = holding
    }

    /// The held ticket was asked for and is not given yet.
    var isHolding: Bool { state.withLock { $0.waiting != nil } }

    func webSocketRequest() async throws -> URLRequest {
        let asked = state.withLock { state in
            state.asked += 1
            return state.asked
        }
        if asked == holding {
            let outcome = await withCheckedContinuation { continuation in
                let released = state.withLock { state in
                    if state.released == nil { state.waiting = continuation }
                    return state.released
                }
                if let released { continuation.resume(returning: released) }
            }
            try outcome.get()
        }
        return URLRequest(url: try baseURL.hermesWebSocketURL(query: [URLQueryItem(name: "token", value: "t")]))
    }

    /// Gives the held ticket, or refuses it with `error`.
    func release(throwing error: HermesAuthError? = nil) {
        let outcome: Result<Void, HermesAuthError> = error.map { .failure($0) } ?? .success(())
        let waiting = state.withLock { state in
            state.released = outcome
            defer { state.waiting = nil }
            return state.waiting
        }
        waiting?.resume(returning: outcome)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw HermesAuthError.unexpectedStatus(404)
    }
}
