import AgentCore
import Foundation

/// One `hermes serve` as an `AgentBackend`. Agents are Hermes profiles; a thread is a
/// Hermes session.
///
/// The connection is kept for as long as the app wants it: when the socket drops it is
/// reopened with backoff, and at once when the device's way onto the network changes,
/// which also has an open socket checked at once when the change took away the way it
/// went out by (`networkChanged`). Hermes keeps a run going with no client attached and
/// holds its approvals, but a new connection follows no session until it resumes it. So
/// after a reconnect:
/// - a thread with a run that may still be going is resumed at once. When it is the same
///   server run and the same live session, the events it missed are fetched with
///   `session.events.since` and applied in order, each exactly once; a bridge with
///   `resume_replay` brings them in its answer to the resume itself, one call where that
///   is two. Otherwise (the server restarted, the session was reloaded, the replay log no
///   longer reaches back) the thread gets a `.snapshot` built from `session.resume`;
/// - a thread with nothing running gets `.detached`, and is resumed when it is next
///   opened or used. Resuming loads the session on the host, which is not worth doing
///   for every thread each time the app comes back. One that followed its stream until
///   then is caught up the same way when the bridge can (`catchUp`).
///
/// A Mac of the device's net may also be reached through the Portals relay
/// (docs/net-plan.md, "The relay as backup, per host"): when its address does not answer
/// within `directLimit`, the relay's tunnel is tried as well and whichever answers first is
/// the connection; when its heartbeat stalls, the next attempt goes through the relay
/// first (`RelayFallback`). While it does, the address is tried every
/// `directRetry` and when the network changes, and the connection moves back to it as
/// soon as it answers, its threads followed again on it as after a reconnect.
public actor HermesBackend: AgentBackend, ThreadCatchingUp, HistoryPaging, RouteReporting {
    public nonisolated let host: HostID
    /// Connection changes, newest last. One consumer.
    public nonisolated let connectionStates: AsyncStream<ConnectionState>
    /// Each `poll.now` from a bridge that lists `poll_now` (`HostMoveReporting`). One consumer.
    public nonisolated let hostMoves: AsyncStream<Void>
    /// What a bridge that lists `net` says of it: where its list is, as each connection
    /// opens and with each `poll.now`, and that it did not take the device's token
    /// (`NetReporting`). One consumer.
    public nonisolated let netNews: AsyncStream<NetNews>
    /// The way each connection goes, as it opens and as it moves (`RouteReporting`). One
    /// consumer.
    public nonisolated let connectionRoutes: AsyncStream<ConnectionRoute>

    private struct Binding {
        var profile: String
        /// The id events arrive under. Hermes gives a session a new one each time it is
        /// loaded.
        var runtimeID: String
        /// The highest event sequence number applied to the thread.
        var lastSeq = 0
        /// A bridge's: the last event the snapshot the thread was last opened with holds
        /// (`latest_seq`, `turn_messages`). A message steered in numbered up to it, which came
        /// as the thread was opened again, is in the snapshot already.
        var snapshotSeq = 0
        /// The server run (`replay_epoch`) whose events the two numbers above count, while
        /// what the thread's stream brought is the whole thread as of them: a bridge with
        /// `resume_replay` can then send only what came after. nil when it is not: the session
        /// was resumed for a call without the thread being told (`attach`), or the thread was
        /// made or taken up here and has not been opened whole since (`follow`).
        var replayEpoch: String?
        /// With it, where the bridge's replay of the conversation the thread took began
        /// (`replay_base` of the answer it was opened whole with), which a resume sends back:
        /// the bridge moves it on whenever the conversation changes with no event, so a thread
        /// that followed its stream on through such a change, with the conversation from
        /// before it, is taken whole. nil for none.
        var replayBase: Int?
        /// A run is, or may be, in progress.
        var isActive = false
        /// The current connection has not resumed the session: nothing arrives for it,
        /// and its runtime id may be stale.
        var isDetached = false
        /// How many resumes of the session are under way. Meanwhile what arrives for it
        /// waits in `held`, so it cannot overtake what the resume brings.
        var resyncs = 0
        var invalidatedBase: Int?
        var snapshotRefreshID: UUID?
        /// The refresh under way is for a failure taken back from a paged thread
        /// (`message.taken`), so it asks for the whole conversation: the UI may hold a page
        /// that still shows the failure. A plain repair keeps the thread paged.
        var refreshesWhole = false
        var requestBoundary = 0
        var held: [JSONRPCPeer.Inbound] = []
        /// Goes up each time the thread is replaced by what a resume returned, so a
        /// slower resume can tell it was overtaken.
        var generation = 0
        var stream: AsyncStream<ThreadEvent>
        var continuation: AsyncStream<ThreadEvent>.Continuation
        /// Which stream of the backend's `stream` is (`makeStream`): its listener going away
        /// lets the thread go only while it is still the thread's.
        var streamNumber = 0
        /// The stream's listener went while the session was being resumed: the thread is let
        /// go once that is over, unless it was opened again meanwhile (`finishResync`).
        var listenerGone = false
        /// The frame the latest news of its subagents applied to it came in, on which
        /// connection (`listSubagents`): a list answered before it is older than that news.
        var subagentNews: (peer: JSONRPCPeer, frame: Int)?
        /// An agent's one ongoing conversation, on a bridge with `history_pages`: it is
        /// resumed with its last turns only (`pageLimit`), the ones before them asked for as
        /// the chat is scrolled up (`earlierTurns`).
        var paged = false
        /// For one, where in the host's conversation the turns the thread holds begin
        /// (`history_start`), and how many of them it holds; nil until a resume says.
        var heldStart: Int?
        var heldTurns = 0
    }

    /// How many turns a page of an ongoing conversation has (`history_pages`).
    static let pageTurns = 30
    /// At most this many turns to a resume of one: a bridge gives no more to a page.
    static let maxPageTurns = 200

    /// Where a bridge with `resume_replay` can replay a thread from (`replayPoint`): the last
    /// event it holds, the run that numbered it, and where the replay of the conversation it
    /// took began.
    private struct ReplayPoint {
        let since: Int
        let epoch: String
        let base: Int
    }

    /// One attempt to connect.
    private struct Opening {
        /// Which one it is: one let go of finds another in its place, or none.
        let number: Int
        let task: Task<Void, Never>
        var way: WayOut
        /// Who waits to hear how it went: told as it ends, or as it is let go of, whichever
        /// comes first. Not by waiting for its task, which may not heed being let go of (a
        /// ticket asked for on a way that went) and end only long after the one in its place.
        var waiting: [CheckedContinuation<Void, any Error>] = []
    }

    /// What those waiting for an attempt to connect hear when it was let go of, or closed the
    /// socket it opened for the app gone to the background, which came back meanwhile.
    private struct LetGo: Error {}

    private let authenticator: any HermesAuthenticator
    private let makeTransport: HermesConnection.TransportFactory
    private let reconnectDelays: [Duration]
    private let network: (any NetworkPathWatching)?
    private let clock: any Clock<Duration>
    private let jitter: @Sendable () -> Double
    private let checkDeadline: Duration
    private let stateContinuation: AsyncStream<ConnectionState>.Continuation
    private let movesContinuation: AsyncStream<Void>.Continuation
    private let netContinuation: AsyncStream<NetNews>.Continuation
    private let routesContinuation: AsyncStream<ConnectionRoute>.Continuation
    /// The way through the relay to the host, asked for as each attempt to connect begins
    /// (the net's list may have changed); nil for a host the relay cannot reach.
    private let relayRoute: (@Sendable () async -> RelayRoute?)?
    private let makeRelayTransport: @Sendable (RelayRoute) -> any WebSocketTransport
    private let directLimit: Duration
    private let directRetry: Duration
    /// Which way attempts to connect go first.
    private var fallback = RelayFallback()

    private var connection: HermesConnection?
    /// The way out the connection went by: the attempt's that opened it.
    private var connectionWay = WayOut(nil)
    /// Whether the connection goes to the host's address or through the relay.
    private var connectionRoute = ConnectionRoute.direct
    /// While the connection goes through the relay: trying the host's address again.
    private var tryingDirect: Task<Void, Never>?
    /// What the host said about itself on the last connection; nil until the first.
    public private(set) var gatewayReady: HermesWire.GatewayReady?
    private var pump: Task<Void, Never>?
    /// The app wants a connection: it connected and has not suspended or disconnected.
    private var wantsConnection = false
    /// The attempt to connect that is under way, shared by everything that needs one.
    private var opening: Opening?
    /// How many attempts to connect have begun.
    private var openings = 0
    private var reconnecting: Task<Void, Never>?
    /// The last attempt failed in a way trying again cannot fix (a rejected password): a
    /// change of network does not try again either.
    private var isStopped = false
    /// Follows the device's way onto the network while a connection is wanted.
    private var watchingNetwork: Task<Void, Never>?
    /// The device's way onto the network as last heard, while it is watched.
    private var currentPath: NetworkPath?
    /// The check of the socket after a change of network that is under way.
    private var checking: Task<Void, Never>?
    /// The server run of the last connection; a different one means it restarted.
    private var lastEpoch: String?
    private var bindings: [ThreadRef.ID: Binding] = [:]
    private var threadsByRuntimeID: [String: ThreadRef.ID] = [:]
    /// How many event streams have been made for threads, to tell them apart.
    private var streamsMade = 0
    /// Sessions of threads let go of (`letGo`) that the current connection may still hear
    /// from, with the thread each was: a host without `session_leave` sends their events
    /// until the connection ends, and one with it until it has the leave. What comes for
    /// them is dropped unread; a question is not answered either (one for a thread the app
    /// does not know is refused). Opened again, the thread takes its session back at once
    /// (`openThread`), so that what comes after the resume's answer is held for it.
    private var letGoSessions: [String: ThreadRef.ID] = [:]
    /// The `session.leave` of each thread let go of on this connection, which a resume of the
    /// thread waits for: it must not overtake the resume and leave the thread unfollowed.
    private var leaving: [ThreadRef.ID: Task<Void, Never>] = [:]
    /// Requests shown to the user and not answered yet, with the thread they belong to.
    private var openRequests: [PendingRequest.ID: (thread: ThreadRef.ID, request: PendingRequest)] = [:]
    /// Who waits for a thread's resumes under way to be over (`untilResynced`).
    private var resyncWaiters: [ThreadRef.ID: [CheckedContinuation<Void, Never>]] = [:]
    /// The ids this app gave the messages it sent lately (`turn_messages`), oldest first:
    /// a message the host tells of under one of them is this app's own, shown already.
    private var sentMessageIDs: [String] = []
    private static let sentMessageIDsKept = 512
    /// Whether the host's push routes stop notifying one device, as its `GET status` said
    /// (`scopesWatchers`); asked again on each connection, which may be to an updated host.
    private var pushRoutesScoped: Bool?
    private var allowsLeanDeltas: Bool { LeanDeltaFallback.allows(host) }

    /// - Parameters:
    ///   - reconnectDelays: how long to wait before each attempt to reopen a dropped
    ///     connection; the last one repeats.
    ///   - network: where the device's way onto the network is watched, while a
    ///     connection is wanted; nil watches nothing.
    ///   - clock: what the waits before reopening and a check of the socket are measured on.
    ///   - jitter: the part of each wait before reopening that is waited, from 0.5 to 1.
    ///   - checkDeadline: how long a check of the socket after a change of network waits
    ///     for anything to arrive.
    ///   - relay: the way through the relay to the host, for a Mac of the device's net; nil
    ///     (or a nil answer) for one reached at its address alone.
    ///   - directLimit: with a way through the relay, how long the address is given to
    ///     answer (up to `gateway.ready`) before the relay is tried as well, and how long
    ///     a try of the address while on the relay waits; measured on `clock`.
    ///   - directRetry: how often the address is tried while connected through the relay.
    public init(
        host: HostID,
        authenticator: any HermesAuthenticator,
        reconnectDelays: [Duration] = [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(10)],
        network: (any NetworkPathWatching)? = nil,
        clock: any Clock<Duration> = ContinuousClock(),
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0.5...1) },
        checkDeadline: Duration = .seconds(5),
        relay: (@Sendable () async -> RelayRoute?)? = nil,
        directLimit: Duration = .seconds(5),
        directRetry: Duration = .seconds(60),
        makeTransport: @escaping HermesConnection.TransportFactory = { URLSessionWebSocketTransport(request: $0) },
        makeRelayTransport: @escaping @Sendable (RelayRoute) -> any WebSocketTransport = { RelayTunnelTransport(route: $0) }
    ) {
        self.host = host
        self.authenticator = authenticator
        self.reconnectDelays = reconnectDelays.isEmpty ? [.seconds(1)] : reconnectDelays
        self.network = network
        self.clock = clock
        self.jitter = jitter
        self.checkDeadline = checkDeadline
        self.makeTransport = makeTransport
        relayRoute = relay
        self.makeRelayTransport = makeRelayTransport
        self.directLimit = directLimit
        self.directRetry = directRetry
        (connectionStates, stateContinuation) = AsyncStream.makeStream(of: ConnectionState.self)
        // Only that a poll is due: several waiting are as one.
        (hostMoves, movesContinuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        (netNews, netContinuation) = AsyncStream.makeStream(of: NetNews.self, bufferingPolicy: .bufferingNewest(8))
        (connectionRoutes, routesContinuation) = AsyncStream.makeStream(of: ConnectionRoute.self, bufferingPolicy: .bufferingNewest(1))
    }

    // MARK: Connection

    /// Connects. When this fails the backend keeps trying in the background, so the app
    /// comes online by itself once the host can be reached. A failure that trying again
    /// cannot fix (a rejected password) is left at that, as `.stopped`.
    public func connect() async throws {
        wantsConnection = true
        watchNetwork()
        if connection != nil { return }
        do {
            try await open()
        } catch {
            if Self.isWorthRetrying(error) { keepTrying() }
            throw error
        }
    }

    public func disconnect() async {
        await close()
    }

    public func suspend() async {
        await close()
    }

    public func resume() async {
        wantsConnection = true
        watchNetwork()
        if connection != nil { return }
        do {
            try await open()
        } catch {
            if Self.isWorthRetrying(error) { keepTrying() }
        }
    }

    /// One attempt to connect, shared by everyone who asks while it is under way. Who waits
    /// for one that is let go of (`tryAgainNow`) waits for the one in its place from then.
    private func open() async throws {
        while connection == nil {
            do {
                return try await withCheckedThrowingContinuation { waiter in
                    if opening == nil { beginOpening() }
                    opening?.waiting.append(waiter)
                }
            } catch is LetGo {
                // The app went to the background meanwhile: as for an attempt that ends then.
                if !wantsConnection { return }
            }
        }
    }

    private func beginOpening() {
        openings += 1
        let number = openings
        let task = Task {
            let outcome: Result<Void, any Error>
            do {
                try await performOpen(number)
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            // Let go of before anyone waiting hears how it went: one who tries again then
            // makes a new attempt, not this one over. Unless it was let go of before: those
            // waiting were told then, and what is there now is the attempt in its place.
            guard let attempt = opening, attempt.number == number else { return }
            opening = nil
            for waiter in attempt.waiting { waiter.resume(with: outcome) }
        }
        opening = Opening(number: number, task: task, way: WayOut(currentPath))
    }

    /// Attempt `number` to connect. One let go of meanwhile changes nothing as it ends, and
    /// the socket it opened, if any, is closed: the attempt in its place says how it went.
    private func performOpen(_ number: Int) async throws {
        stateContinuation.yield(.connecting)
        let opened: HermesConnection
        let route: ConnectionRoute
        do {
            (opened, route) = try await openSomeWay()
        } catch {
            guard opening?.number == number else { throw LetGo() }
            LeanDeltaFallback.record(error, for: host)
            heardRefusal(error)
            let reason = Self.describe(error)
            isStopped = !Self.isWorthRetrying(error)
            stateContinuation.yield(isStopped ? .stopped(reason: reason) : .disconnected(reason: reason))
            throw error
        }
        // Let go of as the host answered (the change was heard while this came back).
        guard let attempt = opening, attempt.number == number else {
            await opened.peer.close()
            throw LetGo()
        }
        isStopped = false
        // The app may have gone to the background while this was under way.
        guard wantsConnection else {
            await opened.peer.close()
            // And may have come back while the socket closed: then this says nothing. One let
            // go of meanwhile leaves that to the attempt in its place; one the app waits for
            // again has another made in its place (`open`).
            guard opening?.number == number, !wantsConnection else { throw LetGo() }
            stateContinuation.yield(.disconnected(reason: nil))
            return
        }
        install(opened, way: attempt.way, route: route)
    }

    /// Makes `opened` the connection, and follows the threads on it.
    private func install(_ opened: HermesConnection, way: WayOut, route: ConnectionRoute) {
        clearMCPAuth()
        let sameServerRun = lastEpoch != nil && lastEpoch == opened.ready.replayEpoch
        lastEpoch = opened.ready.replayEpoch
        gatewayReady = opened.ready
        pushRoutesScoped = nil
        connection = opened
        connectionWay = way
        connectionRoute = route
        let peer = opened.peer
        pump = Task {
            for await message in peer.inbound {
                self.receive(message)
            }
            await self.connectionEnded(peer)
        }
        routesContinuation.yield(route)
        stateContinuation.yield(.connected)
        if let net = opened.ready.bridge?.net { netContinuation.yield(.at(net)) }
        reattachThreads(on: peer, sameServerRun: sameServerRun)
        if route == .relay { keepTryingDirect() }
    }

    // MARK: The relay

    /// Opens a connection the first way that answers (`RelayFallback`): the host's address,
    /// then, for a host the relay reaches, its tunnel. When both fail, the address's failure
    /// is what is said; a refusal through the relay (the token not taken) is said at once.
    private func openSomeWay() async throws -> (HermesConnection, ConnectionRoute) {
        guard let relay = await relayRoute?() else {
            return (try await HermesConnection.open(authenticator: authenticator, allowLeanDeltas: allowsLeanDeltas, makeTransport: makeTransport), .direct)
        }
        guard fallback.prefersRelay else { return try await openAddressThenRelay(relay) }
        do {
            return (try await HermesConnection.open(transport: makeRelayTransport(relay), allowLeanDeltas: allowsLeanDeltas), .relay)
        } catch {
            LeanDeltaFallback.record(error, for: host)
            guard !Task.isCancelled, RelayFallback.isUnreachable(error) else { throw error }
        }
        // Not through the relay either: the address, with only its own limit, as a slow
        // network may need it all.
        do {
            let opened = try await HermesConnection.open(authenticator: authenticator, allowLeanDeltas: allowsLeanDeltas, makeTransport: makeTransport)
            fallback.directAnswered()
            return (opened, .direct)
        } catch {
            if !Task.isCancelled { _ = fallback.directFailed(error) }
            throw error
        }
    }

    /// What came of one of the ways an attempt tries, or that the address had its
    /// `directLimit`.
    private enum Arrival: Sendable {
        case direct(Result<HermesConnection, any Error>)
        case relay(Result<HermesConnection, any Error>)
        case limit
    }

    /// The host's address, and the relay as well once the address has had `directLimit` or
    /// could not be reached. The address is not let go of when the relay is tried: whichever
    /// reaches `gateway.ready` first is the connection, and the other is closed, so an
    /// address that needs longer than the limit on a slow network still connects when the
    /// relay cannot.
    private func openAddressThenRelay(_ relay: RelayRoute) async throws -> (HermesConnection, ConnectionRoute) {
        let outcome = await withTaskGroup(of: Arrival.self) { group -> Result<(HermesConnection, ConnectionRoute), any Error> in
            group.addTask { [authenticator, makeTransport, allowsLeanDeltas] in
                do {
                    return .direct(.success(try await HermesConnection.open(authenticator: authenticator, allowLeanDeltas: allowsLeanDeltas, makeTransport: makeTransport)))
                } catch {
                    return .direct(.failure(error))
                }
            }
            group.addTask { [clock, directLimit] in
                try? await clock.sleep(for: directLimit)
                return .limit
            }
            var relayStarted = false
            var directFailure: (any Error)?
            var relayFailure: (any Error)?
            var outcome: Result<(HermesConnection, ConnectionRoute), any Error>?
            while outcome == nil, let arrival = await group.next() {
                switch arrival {
                case .limit:
                    guard !Task.isCancelled, directFailure == nil, !relayStarted else { break }
                    relayStarted = true
                    group.addTask { [makeRelayTransport, allowsLeanDeltas] in await Self.openRelay(relay, makeRelayTransport, allowLeanDeltas: allowsLeanDeltas) }
                case let .direct(.success(opened)):
                    fallback.directAnswered()
                    outcome = .success((opened, .direct))
                case let .direct(.failure(error)):
                    LeanDeltaFallback.record(error, for: host)
                    guard !Task.isCancelled, fallback.directFailed(error) else {
                        outcome = .failure(error)
                        break
                    }
                    directFailure = error
                    if relayFailure != nil {
                        outcome = .failure(error)
                    } else if !relayStarted {
                        relayStarted = true
                        group.addTask { [makeRelayTransport, allowsLeanDeltas] in await Self.openRelay(relay, makeRelayTransport, allowLeanDeltas: allowsLeanDeltas) }
                    }
                case let .relay(.success(opened)):
                    // The address had its time and did not answer: the relay first from now on.
                    if directFailure == nil { _ = fallback.directFailed(HermesConnectionError.notReady) }
                    outcome = .success((opened, .relay))
                case let .relay(.failure(error)):
                    LeanDeltaFallback.record(error, for: host)
                    guard !Task.isCancelled, RelayFallback.isUnreachable(error) else {
                        outcome = .failure(error)
                        break
                    }
                    relayFailure = error
                    if let directFailure { outcome = .failure(directFailure) }
                }
            }
            // The other way is let go of; one that opened all the same is closed.
            group.cancelAll()
            while let late = await group.next() {
                switch late {
                case let .direct(.success(opened)), let .relay(.success(opened)):
                    LeanDeltaFallback.record(await opened.peer.closeError, for: host)
                    await opened.peer.close()
                case let .direct(.failure(error)), let .relay(.failure(error)):
                    LeanDeltaFallback.record(error, for: host)
                case .limit:
                    break
                }
            }
            return outcome ?? .failure(CancellationError())
        }
        return try outcome.get()
    }

    private static func openRelay(
        _ relay: RelayRoute, _ makeTransport: @Sendable (RelayRoute) -> any WebSocketTransport, allowLeanDeltas: Bool
    ) async -> Arrival {
        do {
            return .relay(.success(try await HermesConnection.open(transport: makeTransport(relay), allowLeanDeltas: allowLeanDeltas)))
        } catch {
            return .relay(.failure(error))
        }
    }

    /// The host's address, given `directLimit` to answer: past it the attempt is let go of
    /// and fails as `notReady`.
    private func openDirect() async throws -> HermesConnection {
        try await withThrowingTaskGroup(of: HermesConnection?.self) { group in
            group.addTask { [authenticator, makeTransport, allowsLeanDeltas] in
                try await HermesConnection.open(authenticator: authenticator, allowLeanDeltas: allowsLeanDeltas, makeTransport: makeTransport)
            }
            group.addTask { [clock, directLimit] in
                try await clock.sleep(for: directLimit)
                return nil
            }
            defer { group.cancelAll() }
            if let first = try await group.next(), let opened = first { return opened }
            // Past the limit. The attempt is let go of; one that opened all the same is closed.
            group.cancelAll()
            while let late = try? await group.next() {
                await late?.peer.close()
            }
            throw HermesConnectionError.notReady
        }
    }

    /// While connected through the relay: tries the host's address every `directRetry`,
    /// and at once when `now`, until the connection moves back to it or ends.
    private func keepTryingDirect(now: Bool = false) {
        tryingDirect?.cancel()
        tryingDirect = Task {
            var now = now
            while !Task.isCancelled {
                if !now { try? await clock.sleep(for: directRetry) }
                now = false
                if Task.isCancelled || connectionRoute != .relay || connection == nil { return }
                if await moveToDirect() { return }
            }
        }
    }

    /// One try of the host's address while connected through the relay. When it answers,
    /// the connection moves to it: the threads are followed again on it, as after a
    /// reconnect, and the relay's connection is closed. True when there is nothing more to
    /// try: it moved, or the relay's connection is not the connection any more.
    private func moveToDirect() async -> Bool {
        guard let relayed = connection, connectionRoute == .relay else { return true }
        let way = WayOut(currentPath)
        let opened: HermesConnection
        do {
            opened = try await openDirect()
        } catch {
            LeanDeltaFallback.record(error, for: host)
            return false
        }
        // Let go of meanwhile, or the relay's connection ended and another attempt took over.
        guard !Task.isCancelled, wantsConnection, let current = connection, current.peer === relayed.peer else {
            await opened.peer.close()
            return true
        }
        fallback.directAnswered()
        tryingDirect = nil
        pump?.cancel()
        checking?.cancel()
        checking = nil
        install(opened, way: way, route: .direct)
        await relayed.peer.close()
        return true
    }

    private func close() async {
        wantsConnection = false
        reconnecting?.cancel()
        reconnecting = nil
        tryingDirect?.cancel()
        tryingDirect = nil
        watchingNetwork?.cancel()
        watchingNetwork = nil
        currentPath = nil
        checking?.cancel()
        checking = nil
        guard let connection else { return }
        self.connection = nil
        clearMCPAuth()
        pump?.cancel()
        pump = nil
        // Said before the socket closes, which may take a while: the app may come back
        // meanwhile, and how the attempt made then goes is said after this, not before.
        stateContinuation.yield(.disconnected(reason: nil))
        await connection.peer.close()
    }

    private func connectionEnded(_ peer: JSONRPCPeer) async {
        let closeError = await peer.closeError
        // Ignore the end of a connection that was already replaced or closed on purpose.
        guard let connection, connection.peer === peer else { return }
        self.connection = nil
        clearMCPAuth()
        pump = nil
        tryingDirect?.cancel()
        tryingDirect = nil
        LeanDeltaFallback.record(closeError, for: host)
        fallback.ended(connectionRoute, with: closeError)
        if let closeError { heardRefusal(closeError) }
        let reason = closeError.map(Self.describe)
        stateContinuation.yield(.disconnected(reason: reason ?? "The connection closed."))
        if wantsConnection { keepTrying() }
    }

    /// Reopens the connection, waiting longer between attempts, until it is back or no
    /// longer wanted. The first `unwaited` attempts go without a wait, and do not count
    /// toward the longer ones.
    private func keepTrying(unwaited: Int = 0) {
        guard reconnecting == nil else { return }
        reconnecting = Task {
            var attempt = 0
            var unwaited = unwaited
            while !Task.isCancelled, wantsConnection, connection == nil {
                if unwaited > 0 {
                    unwaited -= 1
                } else {
                    try? await clock.sleep(for: reconnectDelay(attempt))
                    attempt += 1
                }
                if Task.isCancelled || !wantsConnection || connection != nil { break }
                do {
                    try await open()
                } catch {
                    if !Self.isWorthRetrying(error) { break }
                }
            }
            // A cancelled loop was already replaced or cleared by whoever cancelled it.
            if !Task.isCancelled { reconnecting = nil }
        }
    }

    /// The wait before attempt `attempt` (from 0) to reopen the connection: its step, the
    /// last one repeating, cut by the jitter to between half of it and the whole, so the
    /// devices that lost a host at the same moment do not all come back in step.
    private func reconnectDelay(_ attempt: Int) -> Duration {
        reconnectDelays[min(attempt, reconnectDelays.count - 1)] * min(max(jitter(), 0.5), 1)
    }

    /// Tries to reopen the connection at once, and should that fail, waits from the first
    /// step again. An attempt under way whose way out went with a change of network is let
    /// go of, for one on the way the device has now: it could wait 20 s for its ticket and
    /// 15 for `gateway.ready` on a way that is gone.
    private func tryAgainNow() {
        reconnecting?.cancel()
        reconnecting = nil
        if let opening, opening.way.wentAway {
            opening.task.cancel()
            self.opening = nil
            // Whoever waits for it goes on to the one in its place now, not once it ends.
            for waiter in opening.waiting { waiter.resume(throwing: LetGo()) }
        }
        // An attempt under way on a way still there began before the change: should it
        // fail, the next goes at once too.
        keepTrying(unwaited: opening == nil ? 1 : 2)
    }

    // MARK: The network

    /// Follows the device's way onto the network, from now until the app no longer wants a
    /// connection. The way it is on as this begins is the one the connection is made on.
    private func watchNetwork() {
        guard let network, watchingNetwork == nil else { return }
        let paths = network.paths()
        watchingNetwork = Task { [weak self] in
            var last: NetworkPath?
            for await path in paths {
                guard let self else { return }
                if path != last { await self.network(is: path, changed: last != nil) }
                last = path
            }
        }
    }

    /// The device's way onto the network is `path`: the one it is on as watching begins,
    /// then each change of it. An attempt to connect under way, and the connection, hear of
    /// it. One begun before the app went to the background, whose way out went meanwhile,
    /// hears the first as a change.
    private func network(is path: NetworkPath, changed: Bool) {
        currentPath = path
        opening?.way.follow(path)
        connectionWay.follow(path)
        if changed || (connection == nil && opening?.way.wentAway == true) { networkChanged(to: path) }
    }

    /// The device's way onto the network changed (Wi-Fi to cellular, say). While waiting to
    /// try again, the backend tries at once, and the waits start over: the host may be
    /// reachable this way. While connected, the socket is checked at once when the way it
    /// went out by went, with this change or one with no way out just before it: it has
    /// likely gone with it, which the heartbeat finds only after 45 s. A socket on a way
    /// still there is left to the heartbeat (on a host without one, to the system, which may
    /// take minutes to give up on it): it is likely alive, and a large frame on its way over
    /// a slow link (a long conversation resumed, a first list) would hold the check's answer
    /// back past its deadline, closing a socket that works for the next to fetch it all
    /// again. But not for a Mac the relay reaches too, connected at its address: through
    /// Tailscale that address can look reachable after any change of network while nothing
    /// gets through it (on iOS 27, magicsock stops receiving after a move between Wi-Fi and
    /// cellular), and a check that fails sends the next attempt through the relay at once,
    /// so a large frame cut short costs a reconnect, not the 45 s a stall would. A way with
    /// nothing out changes nothing: what is under way finds that out by itself.
    private func networkChanged(to path: NetworkPath) {
        guard wantsConnection, path.isSatisfied else { return }
        // The host's address may answer this way: tried first again, and at once when the
        // connection goes through the relay.
        fallback.networkChanged()
        if connection != nil, connectionRoute == .relay { keepTryingDirect(now: true) }
        if let connection {
            let mayHaveStalled = relayRoute != nil && connectionRoute == .direct
            guard connectionWay.wentAway || mayHaveStalled else { return }
            connectionWay.wentAway = false
            check(connection.peer)
        } else if !isStopped {
            tryAgainNow()
        }
    }

    /// Checks the socket at once (`JSONRPCPeer.checkAlive`), one check at a time. One that
    /// says nothing within the deadline is closed, and the connection reopened at once. A
    /// check under way gives way to this one, with a ping of its own and only what arrives
    /// from now counting: it was of a socket gone meanwhile, or of this one before its way
    /// went again (Wi-Fi back and gone again), and what arrived after the first going says
    /// nothing of the socket after the second.
    private func check(_ peer: JSONRPCPeer) {
        checking?.cancel()
        checking = Task {
            let alive = await peer.checkAlive(within: checkDeadline, on: clock)
            // Let go of meanwhile (the app went to the background, or a check began after
            // it): nothing more to do.
            guard !Task.isCancelled else { return }
            checking = nil
            guard !alive else { return }
            await connectionEnded(peer)
            if wantsConnection, connection == nil, !isStopped { tryAgainNow() }
        }
    }

    func peer() throws -> JSONRPCPeer {
        guard let connection else { throw AgentBackendError.notConnected }
        return connection.peer
    }

    // MARK: Agents and threads

    public func listAgents() async throws -> [Agent] {
        let result: HermesWire.ProfilesListResult = try await peer().call(
            HermesWire.Method.profilesList, HermesWire.ProfilesListParams()
        )
        let saysKinds = offers(BridgeWire.Feature.agentKinds)
        return (result.profiles ?? []).map { profile in
            Agent(
                id: Agent.ID(host: host, name: profile.name),
                displayName: profile.displayName,
                summary: profile.description,
                model: profile.model,
                isDefault: profile.isDefault ?? false,
                kind: saysKinds ? profile.kind?.stringValue : nil,
                adoptModes: offers(BridgeWire.Feature.deskSessions) ? profile.adoptModes?.arrayValue?.compactMap {
                    $0.stringValue.flatMap(AdoptMode.init(rawValue:))
                } : nil
            )
        }
    }

    public func createThread(with agent: Agent.ID, options: ThreadOptions) async throws -> ThreadRef {
        let created: HermesWire.SessionCreateResult = try await peer().call(
            HermesWire.Method.sessionCreate,
            HermesWire.SessionCreateParams(
                profile: agent.name,
                source: "tui",
                title: options.title,
                cwd: options.workingDirectory,
                model: options.model?.model,
                provider: options.model?.provider,
                reasoningEffort: options.thinkingLevel?.rawValue
            ),
            // Building the agent for a profile's first session can take a while.
            timeout: .seconds(120)
        )
        return follow(created, with: agent, title: options.title, workingDirectory: options.workingDirectory)
    }

    /// The thread a session the connection now follows stands for: created, or taken up
    /// from the host's desk (`session.adopt`), which answers the same way.
    func follow(
        _ created: HermesWire.SessionCreateResult, with agent: Agent.ID, title: String?, workingDirectory: String?, readOnly: Bool = false
    ) -> ThreadRef {
        // The durable id names the thread; the runtime id is only where events arrive.
        let id = ThreadRef.ID(rawValue: created.storedSessionID ?? created.sessionID)
        let (stream, continuation, number) = makeStream(for: id)
        bindings[id]?.continuation.finish()
        // It holds none of a conversation the session may have had already, which no event
        // tells, as one taken up from the desk has. Its first resume takes it whole.
        bindings[id] = Binding(
            profile: agent.name, runtimeID: created.sessionID, stream: stream, continuation: continuation, streamNumber: number
        )
        threadsByRuntimeID[created.sessionID] = id
        letGoSessions[created.sessionID] = nil
        bindings[id]?.paged = created.ongoing == true
        if let info = created.info {
            // Buffered until the app follows: keep settings without replacing the first
            // optimistic message with an empty snapshot or reopening the new session.
            continuation.yield(.caughtUp(HermesHistoryMapper.info(from: info, features: hostFeatures)))
        }
        // Where the host says the agent works, else where it was asked to.
        let folder = created.info?.cwd.flatMap { $0.isEmpty ? nil : $0 } ?? workingDirectory
        return ThreadRef(
            id: id, agent: agent, title: title ?? created.info?.title, workingDirectory: folder, readOnly: readOnly, ongoing: created.ongoing
        )
    }

    public func openThread(_ thread: ThreadRef) async throws -> ThreadSnapshot {
        if bindings[thread.id] == nil {
            let (stream, continuation, number) = makeStream(for: thread.id)
            // The session the thread is known to be under, so that what arrives for it
            // between the resume's answer and the snapshot being taken in is held, not lost
            // (the answer and the events after it reach this actor by separate ways): the
            // one it had when it was let go of, or, from a bridge, which keeps a thread's id
            // as its session's, the thread's id. Elsewhere (Hermes gives a session a new id
            // as it is loaded) it is known only from the answer.
            let known = letGoSessions.first(where: { $0.value == thread.id })?.key
                ?? (gatewayReady?.bridge != nil ? thread.id.rawValue : nil)
            bindings[thread.id] = Binding(
                profile: thread.agent.name, runtimeID: known ?? "", isDetached: true, stream: stream, continuation: continuation,
                streamNumber: number
            )
            if let known {
                letGoSessions[known] = nil
                threadsByRuntimeID[known] = thread.id
            }
        }
        if thread.isOngoing { bindings[thread.id]?.paged = true }
        bindings[thread.id]?.resyncs += 1
        defer { finishResync(thread.id) }
        let resumed = try await resumeSession(thread.id, profile: thread.agent.name)
        return opened(resumed, for: thread.id)
    }

    /// The turns of an ongoing conversation before the first the thread holds, a page of
    /// them (`history_pages`). nil when the bridge's conversation is not the one the thread
    /// took (it changed with no event), or the thread was never opened whole in this run:
    /// it is opened again. Throws `CancellationError` when it was opened again meanwhile.
    public func earlierTurns(of thread: ThreadRef.ID) async throws -> EarlierTurns? {
        guard let binding = bindings[thread], binding.paged, offers(BridgeWire.Feature.historyPages),
              let start = binding.heldStart, let epoch = binding.replayEpoch, epoch == gatewayReady?.replayEpoch,
              let base = binding.replayBase else { return nil }
        guard start > 0 else { return EarlierTurns(transcript: Transcript(), hasEarlier: false) }
        let answer: BridgeWire.SessionHistoryResult = try await peer().call(
            BridgeWire.Method.sessionHistory,
            BridgeWire.SessionHistoryParams(
                sessionID: thread.rawValue, profile: binding.profile, before: start, limit: Self.pageTurns, replayEpoch: epoch, replayBase: base
            ),
            timeout: .seconds(60)
        )
        // What the thread holds begins elsewhere now: these are not the turns before it.
        guard let now = bindings[thread], now.generation == binding.generation,
              now.heldStart == start, now.replayBase == base else { throw CancellationError() }
        guard answer.moved != true, let messages = answer.messages, let from = answer.start else { return nil }
        let transcript = HermesHistoryMapper.transcript(from: messages, features: hostFeatures)
        bindings[thread]?.heldStart = from
        bindings[thread]?.heldTurns += transcript.turns.count
        return EarlierTurns(transcript: transcript, hasEarlier: answer.hasEarlier ?? (from > 0))
    }

    /// How many turns a resume of an ongoing conversation asks for (`history_pages`): a
    /// page's, or as many as the thread holds with a page's more for those said since, so
    /// that what was scrolled up to stays; nil for any other thread.
    private func pageLimit(for thread: ThreadRef.ID) -> Int? {
        guard let binding = bindings[thread], binding.paged, offers(BridgeWire.Feature.historyPages) else { return nil }
        return min(binding.heldTurns + Self.pageTurns, Self.maxPageTurns)
    }

    /// The thread opened again with a whole resume answer: its snapshot, and what follows
    /// it on a new stream, so nothing from before it can be applied after it.
    private func opened(_ resumed: HermesWire.SessionResumeResult, for thread: ThreadRef.ID) -> ThreadSnapshot {
        let snapshot = adopt(resumed, for: thread)
        let (stream, continuation, number) = makeStream(for: thread)
        bindings[thread]?.continuation.finish()
        bindings[thread]?.stream = stream
        bindings[thread]?.continuation = continuation
        bindings[thread]?.streamNumber = number
        // Whoever opened it listens on the new stream.
        bindings[thread]?.listenerGone = false
        listSubagents(for: thread)
        return snapshot
    }

    /// A stream for a thread's events, which tells the backend when its listener goes away
    /// (`letGo`). Finished by the backend (a newer stream in its place), it tells nothing.
    private func makeStream(for thread: ThreadRef.ID) -> (AsyncStream<ThreadEvent>, AsyncStream<ThreadEvent>.Continuation, Int) {
        streamsMade += 1
        let number = streamsMade
        let (stream, continuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        continuation.onTermination = { [weak self] termination in
            guard case .cancelled = termination else { return }
            Task { await self?.listenerLeft(thread, stream: number) }
        }
        return (stream, continuation, number)
    }

    /// Nothing listens to a thread's stream any more: the app let go of the thread (its
    /// controller was closed, at rest past the few kept open, or the thread left the list).
    /// The thread is let go of here too, unless the stream is not its own any more (opened
    /// again since) or a resume is under way, after which it is (`finishResync`).
    private func listenerLeft(_ thread: ThreadRef.ID, stream number: Int) {
        guard let binding = bindings[thread], binding.streamNumber == number else { return }
        guard binding.resyncs == 0 else {
            bindings[thread]?.listenerGone = true
            return
        }
        letGo(thread)
    }

    /// Stops following a thread nobody listens to: it is forgotten here, so a reconnect does
    /// not resume it, and a bridge with `session_leave` stops sending its events. Before it,
    /// such a thread was followed on until the connection ended, and resumed whole at the
    /// next one whenever it had worked meanwhile (set to work by another device, a terminal
    /// or the fleet), each piece of its replies sent to the app, read and thrown away.
    /// Opened again, it is resumed like any thread not followed.
    private func letGo(_ thread: ThreadRef.ID) {
        guard let binding = bindings.removeValue(forKey: thread) else { return }
        wakeResyncWaiters(thread)
        binding.continuation.finish()
        openRequests = openRequests.filter { $0.value.thread != thread }
        guard !binding.runtimeID.isEmpty else { return }
        if threadsByRuntimeID[binding.runtimeID] == thread { threadsByRuntimeID[binding.runtimeID] = nil }
        // The connection follows the session unless it was never resumed on it.
        guard !binding.isDetached, let peer = connection?.peer else { return }
        letGoSessions[binding.runtimeID] = thread
        guard offers(BridgeWire.Feature.sessionLeave) else { return }
        let params = BridgeWire.SessionLeaveParams(sessionID: binding.runtimeID, profile: binding.profile)
        leaving[thread] = Task {
            let _: BridgeWire.Done? = try? await peer.call(BridgeWire.Method.sessionLeave, params, timeout: .seconds(20))
        }
    }

    /// Follows a thread again that applied every event its stream brought, up to its
    /// `.detached`. From a bridge with `resume_replay`, when it can replay from the last of
    /// them, the events it missed come on that stream, and this returns nil; otherwise the
    /// thread is opened again whole, as `openThread` does.
    public func catchUp(_ thread: ThreadRef) async throws -> ThreadSnapshot? {
        guard let binding = bindings[thread.id], let point = replayPoint(of: binding) else { return try await openThread(thread) }
        bindings[thread.id]?.resyncs += 1
        defer { finishResync(thread.id) }
        let resumed = try await resumeSession(thread.id, profile: binding.profile, from: point)
        guard resumed.replayed == true else { return opened(resumed, for: thread.id) }
        // Resumed by something else meanwhile (a reconnect, a call), or, never from a bridge,
        // under another id: the whole thread then.
        guard resumed.sessionID == binding.runtimeID, bindings[thread.id]?.generation == binding.generation else {
            return try await openThread(thread)
        }
        applyReplay(resumed, to: thread.id)
        return nil
    }

    /// Asks who is at work for a thread's session and tells the thread, after a gap in
    /// which news of them may have been missed (and, from a bridge that keeps them, who
    /// ended). Not waited for: it is news like any
    /// other. A host that cannot say gives an empty list, and the agents show again
    /// with the next thing they do.
    private func listSubagents(for thread: ThreadRef.ID, asked: Int = 0) {
        guard let binding = bindings[thread], !binding.runtimeID.isEmpty, let peer = try? peer() else { return }
        Task {
            let params = try? JSONValue(encoding: HermesWire.SubagentListParams(sessionID: binding.runtimeID, profile: binding.profile))
            let answer = try? await peer.requestWithReceipt(HermesWire.Method.subagentList, params: params ?? .object([:]), timeout: .seconds(20))
            let listed = answer?.value
            // The connection or session changed while this list was in flight.
            guard connection?.peer === peer,
                  bindings[thread]?.runtimeID == binding.runtimeID, bindings[thread]?.generation == binding.generation else { return }
            // News of them that came after the answer on the socket was applied first (the two
            // reach this actor by separate ways): the list is older than that news, and would
            // bring back what it changed (one cleared from the line). Asked again, a few times.
            if let answer, let news = bindings[thread]?.subagentNews, news.peer === peer, news.frame > answer.frame {
                if asked < 3 { listSubagents(for: thread, asked: asked + 1) }
                return
            }
            let subagents = (listed?["subagents"]?.arrayValue ?? []).compactMap { HermesEventMapper.subagent($0) }
            // A bridge with `subagents` lists the ended ones too, which the line keeps.
            let shown = offers(BridgeWire.Feature.subagents) ? [Subagent].lastBatch(of: subagents) : subagents.filter(\.isWorking)
            bindings[thread]?.continuation.yield(.subagentsListed(shown))
        }
    }

    public func events(for thread: ThreadRef.ID) -> AsyncStream<ThreadEvent> {
        bindings[thread]?.stream ?? AsyncStream { $0.finish() }
    }

    public func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, to thread: ThreadRef.ID
    ) async throws -> SendReceipt {
        try await send(text, images: images, files: files, whenBusy: whenBusy, messageID: UUID(), to: thread)
    }

    public func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], whenBusy: WhenBusy, messageID ownID: UUID,
        to thread: ThreadRef.ID
    ) async throws -> SendReceipt {
        try await send(text, images: images, files: files, mentions: [], whenBusy: whenBusy, messageID: ownID, to: thread)
    }

    /// `send`, with the files and folders the message mentions (`FileMentionSending`): sent
    /// beside the text only to a bridge that lists `file_mentions`; the text names them all
    /// the same.
    public func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], mentions: [String], whenBusy: WhenBusy, messageID ownID: UUID,
        to thread: ThreadRef.ID
    ) async throws -> SendReceipt {
        let mentions = mentions.isEmpty || !offers(BridgeWire.Feature.fileMentions) ? nil : mentions
        // Only a bridge takes files, and the say in what a message sent mid-turn does.
        guard files.isEmpty || offers(BridgeWire.Feature.files) else { throw HermesBackendError.fileNotAccepted(nil) }
        let choosesWhenBusy = offers(BridgeWire.Feature.queue)
        // Kept before it is sent: the host's event telling of it can overtake the answer.
        let messageID = choosesWhenBusy && offers(BridgeWire.Feature.turnMessages) ? rememberSent(ownID) : nil
        let result: HermesWire.PromptSubmitResult = try await onSession(thread) { peer, binding in
            // Images are queued on the session first; the message then takes them along.
            for image in images {
                let attached: HermesWire.ImageAttachResult = try await peer.call(
                    HermesWire.Method.imageAttachBytes,
                    HermesWire.ImageAttachBytesParams(
                        sessionID: binding.runtimeID, contentBase64: image.data.base64EncodedString(),
                        filename: image.filename, profile: binding.profile
                    ),
                    timeout: .seconds(60)
                )
                if attached.attached == false {
                    throw HermesBackendError.imageNotAccepted(attached.message)
                }
            }
            // Files the same way: the bridge saves each in the thread's folder.
            for file in files {
                let attached: BridgeWire.FileAttachResult = try await peer.call(
                    BridgeWire.Method.fileAttachBytes,
                    BridgeWire.FileAttachBytesParams(
                        sessionID: binding.runtimeID, contentBase64: file.data.base64EncodedString(),
                        filename: file.filename, id: file.id.uuidString, profile: binding.profile
                    ),
                    timeout: .seconds(120)
                )
                if attached.attached != true {
                    throw HermesBackendError.fileNotAccepted(attached.message)
                }
            }
            if choosesWhenBusy {
                return try await peer.call(
                    BridgeWire.Method.promptSubmit,
                    BridgeWire.PromptSubmitParams(
                        sessionID: binding.runtimeID, text: text, profile: binding.profile, whenBusy: whenBusy, messageID: messageID,
                        mentions: mentions
                    )
                )
            }
            return try await peer.call(
                HermesWire.Method.promptSubmit,
                HermesWire.PromptSubmitParams(sessionID: binding.runtimeID, text: text, profile: binding.profile)
            )
        }
        bindings[thread]?.isActive = true
        // A place on the list only from a host that lists it: one without the feature
        // never says when that message's turn opens.
        return SendReceipt(
            HermesEventMapper.sendOutcome(result.status), queueID: choosesWhenBusy ? result.queueID : nil,
            largeMentions: result.largeMentions?.mentions ?? []
        )
    }

    /// The id of a message this app sends, kept to know the message by when the host tells of it.
    private func rememberSent(_ ownID: UUID) -> String {
        let id = ownID.uuidString
        sentMessageIDs.append(id)
        if sentMessageIDs.count > Self.sentMessageIDsKept { sentMessageIDs.removeFirst(sentMessageIDs.count - Self.sentMessageIDsKept) }
        return id
    }

    @discardableResult
    public func interrupt(_ thread: ThreadRef.ID) async throws -> Bool {
        // A bridge with `subagents` is told to leave the background work running: each
        // subagent and workflow has a Stop of its own on the line.
        let keepsBackground = offers(BridgeWire.Feature.subagents)
        let result: HermesWire.SessionInterruptResult = try await onSession(thread) { peer, binding in
            if keepsBackground {
                return try await peer.call(
                    BridgeWire.Method.sessionInterrupt,
                    BridgeWire.SessionInterruptParams(sessionID: binding.runtimeID, profile: binding.profile)
                )
            }
            return try await peer.call(
                HermesWire.Method.sessionInterrupt,
                HermesWire.SessionInterruptParams(sessionID: binding.runtimeID, profile: binding.profile)
            )
        }
        return result.status == "interrupted"
    }

    public func respond(to request: PendingRequest.ID, in thread: ThreadRef.ID, with answer: RequestAnswer) async throws {
        // A bridge takes no answer from a connection that does not follow the thread (it
        // says nothing of it). One whose resume is under way (the connection just came back)
        // is waited for; a thread at rest, not followed again on reconnecting until it is
        // used, is followed first. Either also says whether the request is still open. Until
        // neither holds: a resume may begin while another ends (the thread on screen opened
        // again as this one follows it).
        var waited = false
        while true {
            if (bindings[thread]?.resyncs ?? 0) > 0 {
                waited = true
                await untilResynced(thread)
            } else if bindings[thread]?.isDetached == true {
                waited = true
                try await attach(thread)
            } else {
                break
            }
        }
        guard let pending = openRequests[request] else { throw AgentBackendError.unknownRequest }
        if case let .option(id, editedPlan, _) = answer, pending.request.offeredOption(id, editedPlan: editedPlan) == nil {
            throw ApprovalAnswerError.invalidOption
        }
        // Sent before it is forgotten: if the connection is down, it can be answered
        // again once the thread is back.
        try await peer().respond(to: request, result: HermesEventMapper.result(for: answer, to: pending.request))
        openRequests[request] = nil
        // A catch-up waited for may have shown the card again (still open on the host until
        // now): it closes with the answer given. Nothing changes where it did not.
        if waited { bindings[thread]?.continuation.yield(.requestAnswered(id: request, answer: answer, by: nil)) }
    }

    /// Returns once no resume of the thread's session is under way (`resyncs`), or the
    /// thread is let go of.
    private func untilResynced(_ thread: ThreadRef.ID) async {
        guard (bindings[thread]?.resyncs ?? 0) > 0 else { return }
        await withCheckedContinuation { waiter in
            resyncWaiters[thread, default: []].append(waiter)
        }
    }

    /// Wakes who waits for the thread's resumes to be over, once none is under way.
    private func wakeResyncWaiters(_ thread: ThreadRef.ID) {
        guard (bindings[thread]?.resyncs ?? 0) == 0, let waiting = resyncWaiters.removeValue(forKey: thread) else { return }
        for waiter in waiting { waiter.resume() }
    }

    /// Runs a call that names the thread's live session, resuming the session first when
    /// this connection does not follow it, and once more when the host says the session
    /// it named is gone (error 4001: unloaded after sitting idle).
    private func onSession<Output: Sendable>(
        _ thread: ThreadRef.ID,
        _ call: (JSONRPCPeer, Binding) async throws -> Output
    ) async throws -> Output {
        try await attach(thread)
        guard let binding = bindings[thread] else { throw AgentBackendError.unknownThread }
        do {
            return try await call(try peer(), binding)
        } catch let error as JSONRPCError where error.code == 4001 {
            bindings[thread]?.isDetached = true
            try await attach(thread)
            guard let binding = bindings[thread] else { throw AgentBackendError.unknownThread }
            return try await call(try peer(), binding)
        }
    }

    // MARK: Resuming sessions

    /// A new connection follows no session. Threads with a run that may still be going
    /// are resumed now; the rest are told, and resumed when they are next used.
    private func reattachThreads(on peer: JSONRPCPeer, sameServerRun: Bool) {
        // A new connection follows nothing: what was let go of on the last one is past.
        letGoSessions = [:]
        leaving = [:]
        for thread in bindings.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            guard let binding = bindings[thread] else { continue }
            bindings[thread]?.requestBoundary = 0
            // Invalidations and refresh jobs belong to the old socket. Its pending
            // tasks may still finish, but cannot clear a replacement job's marker.
            bindings[thread]?.invalidatedBase = nil
            bindings[thread]?.snapshotRefreshID = nil
            bindings[thread]?.refreshesWhole = false
            if !sameServerRun {
                // The host started again: its events number from the start, and where its
                // replay begins too. What the thread counted is another run's, against which
                // nothing of this one (a repair it asks for, an event) may be measured.
                bindings[thread]?.lastSeq = 0
                bindings[thread]?.snapshotSeq = 0
                bindings[thread]?.replayBase = nil
            }
            if binding.isActive {
                // Held from this moment, before anything can arrive for it.
                bindings[thread]?.resyncs += 1
                Task { await resync(thread, on: peer, sameServerRun: sameServerRun) }
            } else {
                bindings[thread]?.isDetached = true
                binding.continuation.yield(.detached)
            }
        }
    }

    /// Brings a thread with a run in progress up to date: the events it missed, or a
    /// snapshot of what the host has.
    private func resync(_ thread: ThreadRef.ID, on peer: JSONRPCPeer, sameServerRun: Bool) async {
        defer { finishResync(thread) }
        guard let binding = bindings[thread] else { return }
        do {
            var resumed = try await resumeSession(thread, profile: binding.profile, from: replayPoint(of: binding))
            // Opened by the app in the meantime: that is newer than this.
            guard bindings[thread]?.generation == binding.generation else { return }
            if resumed.replayed == true {
                // A bridge with `resume_replay` brought what was missed in its answer.
                if resumed.sessionID == binding.runtimeID {
                    applyReplay(resumed, to: thread)
                    return
                }
                // Never from a bridge, whose thread keeps its id: the whole thread then.
                resumed = try await resumeSession(thread, profile: binding.profile)
            } else if !offers(BridgeWire.Feature.resumeReplay), sameServerRun, resumed.sessionID == binding.runtimeID, binding.lastSeq > 0,
                      try await replayMissedEvents(thread, since: binding, resumed: resumed) {
                // Any other host: the events missed, asked for after the resume. A bridge that
                // replays sent the whole thread when it could not, and there is no more to ask.
                return
            }
            guard bindings[thread]?.generation == binding.generation else { return }
            let snapshot = adopt(resumed, for: thread)
            bindings[thread]?.continuation.yield(.snapshot(snapshot))
            listSubagents(for: thread)
        } catch {
            // The connection went again: the next one starts over.
            guard let connection, connection.peer === peer else { return }
            bindings[thread]?.isActive = false
            bindings[thread]?.isDetached = true
            bindings[thread]?.continuation.yield(
                .notice(Notice(.warning, "This thread could not be reconnected: \(Self.describe(error))"))
            )
            // It is not followed any more: whoever shows it opens it again.
            bindings[thread]?.continuation.yield(.detached)
        }
    }

    /// Applies the events between the last one seen and now. Returns false when the
    /// replay log no longer reaches back that far.
    private func replayMissedEvents(
        _ thread: ThreadRef.ID, since binding: Binding, resumed: HermesWire.SessionResumeResult
    ) async throws -> Bool {
        let since: HermesWire.SessionEventsSinceResult = try await peer().call(
            HermesWire.Method.sessionEventsSince,
            HermesWire.SessionEventsSinceParams(sessionID: resumed.sessionID, lastSeen: binding.lastSeq, profile: binding.profile)
        )
        // Replaced by a snapshot in the meantime: nothing left to fill in.
        guard bindings[thread]?.generation == binding.generation else { return true }
        if since.truncated == true { return false }
        applyReplayed(since.events ?? [], openRequests: since.openRequests ?? resumed.openRequests, to: thread)
        return true
    }

    /// Applies a resume that a bridge with `resume_replay` answered with the events missed:
    /// those events, what is open now, the messages waiting, and last what it says of the
    /// thread besides, which can change with no event (a model chosen on another device).
    private func applyReplay(_ resumed: HermesWire.SessionResumeResult, to thread: ThreadRef.ID) {
        if offers(BridgeWire.Feature.sessionResync), let receipt = resumed.receivedAtFrame {
            let boundary = max(bindings[thread]?.requestBoundary ?? 0, receipt)
            bindings[thread]?.requestBoundary = boundary
        }
        // Said first, `.caughtUp` last, nothing awaited between: what shows the thread takes
        // what comes between as one change, the catch-up the thread asked for or not.
        bindings[thread]?.continuation.yield(.catchUpBegan)
        applyReplayed(resumed.events ?? [], openRequests: resumed.openRequests, to: thread)
        if let queued = HermesHistoryMapper.queued(in: resumed, features: hostFeatures) {
            bindings[thread]?.continuation.yield(.queueChanged(queued, canSteer: resumed.canSteer ?? false, steered: nil))
        }
        bindings[thread]?.continuation.yield(.caughtUp(HermesHistoryMapper.info(from: resumed, features: hostFeatures)))
    }

    /// Applies events the host replayed, in order and each once, then what it says is open
    /// now: the thread is followed again.
    private func applyReplayed(_ events: [JSONValue], openRequests listedNow: [JSONValue]?, to thread: ThreadRef.ID) {
        bindings[thread]?.isDetached = false
        for entry in events {
            if let event = GatewayEvent(replayed: entry) { apply(event, to: thread) }
        }

        // Requests are frames, not events, so what is open is only in these answers.
        // Each is shown again even when it was shown before: an answer given while the
        // connection was down never reached the host.
        let listed = requests(in: listedNow)
        for (id, entry) in openRequests where entry.thread == thread && !listed.contains(where: { $0.id == id }) {
            openRequests[id] = nil
            bindings[thread]?.continuation.yield(.requestClosed(id: id, reason: "Answered elsewhere"))
        }
        for request in listed {
            answer(request, in: thread)
        }
    }

    /// Where a bridge with `resume_replay` can replay the thread from: the last event of
    /// this server run up to which its stream brought the whole thread, that run, and where
    /// the replay of the conversation it took began. nil for any other host, or a thread
    /// that holds no such number: it is taken whole.
    private func replayPoint(of binding: Binding) -> ReplayPoint? {
        guard offers(BridgeWire.Feature.resumeReplay), !binding.runtimeID.isEmpty, let epoch = binding.replayEpoch,
              epoch == gatewayReady?.replayEpoch, let base = binding.replayBase else { return nil }
        // After a snapshot and no event since, the last one the snapshot holds.
        return ReplayPoint(since: max(binding.lastSeq, binding.snapshotSeq), epoch: epoch, base: base)
    }

    /// Resumes the thread's session when this connection does not follow it yet.
    ///
    /// Says nothing to the thread: it is a thread with nothing running, and the app is
    /// told separately (`.detached`) to refresh it when it is on screen.
    private func attach(_ thread: ThreadRef.ID) async throws {
        guard let binding = bindings[thread] else { throw AgentBackendError.unknownThread }
        guard binding.isDetached else { return }
        bindings[thread]?.resyncs += 1
        defer { finishResync(thread) }
        let resumed = try await resumeSession(thread, profile: binding.profile)
        if bindings[thread]?.isDetached == true {
            _ = adopt(resumed, for: thread)
            // The thread was not given the snapshot: its stream no longer holds the thread as
            // of the numbers, and the next resume takes it whole.
            bindings[thread]?.replayEpoch = nil
        }
    }

    /// `session.resume`, retried while Hermes is still settling an interrupt (error 4009).
    /// From `point` (`replayPoint`) only to a bridge with `resume_replay`, which is sent this
    /// run's epoch with every resume, so that a whole answer says where the replay of the
    /// conversation it gives begins.
    private func resumeSession(
        _ thread: ThreadRef.ID, profile: String, from point: ReplayPoint? = nil, fullHistory: Bool = false
    ) async throws -> HermesWire.SessionResumeResult {
        // Let go of a moment ago: the leave goes first, or it would come after this resume and
        // leave the thread unfollowed.
        if let leave = leaving.removeValue(forKey: thread) { await leave.value }
        var attempt = 0
        while true {
            do {
                if offers(BridgeWire.Feature.resumeReplay) {
                    return try await resumeAnswer(
                        BridgeWire.Method.sessionResume,
                        BridgeWire.SessionResumeParams(
                            sessionID: thread.rawValue, profile: profile, since: point?.since, replayEpoch: point?.epoch ?? gatewayReady?.replayEpoch,
                            replayBase: point?.base, limit: fullHistory ? nil : pageLimit(for: thread)
                        )
                    )
                }
                return try await resumeAnswer(
                    HermesWire.Method.sessionResume,
                    HermesWire.SessionResumeParams(sessionID: thread.rawValue, profile: profile, inlineImages: false)
                )
            } catch let error as JSONRPCError where error.code == 4009 && attempt < 5 {
                attempt += 1
                try await Task.sleep(for: .milliseconds(400))
            }
        }
    }

    private func resumeAnswer(_ method: String, _ params: some Encodable & Sendable) async throws -> HermesWire.SessionResumeResult {
        let peer = try peer()
        let receipt = try await peer.requestWithReceipt(method, params: JSONValue(encoding: params), timeout: .seconds(120))
        guard connection?.peer === peer else { throw CancellationError() }
        var resumed = try receipt.value.decode(HermesWire.SessionResumeResult.self)
        resumed.receivedAtFrame = receipt.frame
        await resetLegacySpecModel(resumed, on: peer)
        guard connection?.peer === peer else { throw CancellationError() }
        return resumed
    }

    /// A Droid thread on a bridge from before 2026-10-23 can have a Spec model of its own,
    /// chosen from a menu this app no longer has: planning would keep it whatever model the
    /// thread is given. One still set there is put back to follow the thread's model (what
    /// a newer bridge always does), once, as the thread is opened, and before the open
    /// returns, so that a message sent at once is not planned with it. A newer bridge sends
    /// none. (Such a bridge plans with the model's default effort, not the thread's: only a
    /// newer bridge follows the thread's effort too.)
    private func resetLegacySpecModel(_ resumed: HermesWire.SessionResumeResult, on peer: JSONRPCPeer) async {
        guard let info = resumed.info, let spec = info.specModel,
              spec != "default" || !(info.specReasoningEffort ?? "").isEmpty else { return }
        let params = LegacySpecModelReset(sessionID: resumed.sessionID)
        let _: JSONValue? = try? await peer.call(LegacySpecModelReset.method, params, timeout: .seconds(5))
    }

    /// Points the thread at the resumed session and returns the session as a snapshot.
    ///
    /// The snapshot replaces what the thread streamed (`ThreadSnapshot.authoritative`) only
    /// when it was asked for because the host repaired the thread (`repaired`,
    /// `refreshSnapshot`) or covers such a repair anyway: the one a `session.invalidated`
    /// asked for, or one missed while the app was away, which moved where the bridge's
    /// replay begins (`replay_base`) in the run the thread was opened in. Any other open
    /// keeps the detail the app saw live (what was approved, the notices).
    private func adopt(_ resumed: HermesWire.SessionResumeResult, for thread: ThreadRef.ID, repaired: Bool = false) -> ThreadSnapshot {
        let snapshot = HermesHistoryMapper.snapshot(
            from: resumed, features: hostFeatures, authoritative: repaired || coversRepair(resumed, for: thread)
        )
        if let old = bindings[thread]?.runtimeID, old != resumed.sessionID {
            if threadsByRuntimeID[old] == thread { threadsByRuntimeID[old] = nil }
            // What waited under the old id belongs to a session that is gone.
            bindings[thread]?.held = []
        }
        threadsByRuntimeID[resumed.sessionID] = thread
        letGoSessions[resumed.sessionID] = nil
        bindings[thread]?.runtimeID = resumed.sessionID
        // Events that arrive from here on all follow the snapshot.
        bindings[thread]?.lastSeq = 0
        bindings[thread]?.snapshotSeq = resumed.latestSeq ?? 0
        bindings[thread]?.requestBoundary = offers(BridgeWire.Feature.sessionResync) ? resumed.receivedAtFrame ?? 0 : 0
        bindings[thread]?.replayEpoch = gatewayReady?.replayEpoch
        bindings[thread]?.replayBase = resumed.replayBase
        if let wanted = bindings[thread]?.invalidatedBase, let base = resumed.replayBase, base >= wanted {
            bindings[thread]?.invalidatedBase = nil
        }
        bindings[thread]?.generation += 1
        bindings[thread]?.isDetached = false
        bindings[thread]?.isActive = snapshot.isRunning
        bindings[thread]?.heldStart = resumed.historyStart
        bindings[thread]?.heldTurns = resumed.historyStart == nil ? 0 : snapshot.transcript.turns.count

        // What the host is waiting for is now exactly what it says.
        openRequests = openRequests.filter { $0.value.thread != thread }
        for request in requests(in: resumed.openRequests) {
            if let pending = HermesEventMapper.pendingRequest(request, features: hostFeatures) {
                if snapshot.isRunning || pending.outlivesTurn { openRequests[pending.id] = (thread, pending) }
            } else {
                answer(request, in: thread)
            }
        }
        return snapshot
    }

    /// Whether a whole resume answer covers a repair the thread has not taken whole yet
    /// (`adopt`).
    private func coversRepair(_ resumed: HermesWire.SessionResumeResult, for thread: ThreadRef.ID) -> Bool {
        guard let binding = bindings[thread], let base = resumed.replayBase else { return false }
        if let wanted = binding.invalidatedBase, base >= wanted { return true }
        guard let known = binding.replayBase, let epoch = binding.replayEpoch, epoch == gatewayReady?.replayEpoch else { return false }
        return base > known
    }

    private func requests(in entries: [JSONValue]?) -> [ServerRequest] {
        (entries ?? []).compactMap { entry in
            guard let id = entry["id"]?.stringValue, let method = entry["method"]?.stringValue else { return nil }
            return ServerRequest(id: id, method: method, params: entry["params"] ?? .null)
        }
    }

    /// One resume of the thread's session is over. After the last, what waited meanwhile
    /// goes through, in order: a repair asked for meanwhile (`session.invalidated`) measured
    /// against what the resume brought, and what comes after it held again behind the
    /// refresh it starts.
    private func finishResync(_ thread: ThreadRef.ID) {
        defer { wakeResyncWaiters(thread) }
        guard let binding = bindings[thread] else { return }
        bindings[thread]?.resyncs = max(binding.resyncs - 1, 0)
        // Its listener went while it was resumed, and nothing opened it again since.
        if binding.resyncs <= 1, binding.listenerGone {
            letGo(thread)
            return
        }
        guard binding.resyncs <= 1, !binding.held.isEmpty else { return }
        bindings[thread]?.held = []
        for message in binding.held {
            deliver(message, to: thread)
        }
    }

    // MARK: Inbound

    private func receive(_ message: JSONRPCPeer.Inbound) {
        // A thread let go of: nothing to read, and nobody to ask.
        if let session = message.sessionID, letGoSessions[session] != nil { return }
        guard let thread = message.sessionID.flatMap({ threadsByRuntimeID[$0] }) else {
            handle(message, for: nil)
            return
        }
        deliver(message, to: thread)
    }

    /// What arrives for a thread: held while a resume of it is under way, so it cannot
    /// overtake what the resume brings, else handled. A repair (`session.invalidated`) is
    /// held too, and measured once the resume is in: against the numbers of the thread as
    /// the resume left it, not those it had before (another run of the host's, after it
    /// started again). Only the refresh of an earlier repair takes it at once, to ask again
    /// should its answer be from before this one.
    private func deliver(_ message: JSONRPCPeer.Inbound, to thread: ThreadRef.ID) {
        guard let binding = bindings[thread] else {
            handle(message, for: thread)
            return
        }
        if let (base, seq, whole) = invalidation(in: message, for: thread), binding.resyncs == 0 || binding.snapshotRefreshID != nil {
            invalidate(thread, base: base, seq: seq, whole: whole)
        } else if binding.resyncs > 0 {
            bindings[thread]?.held.append(message)
        } else {
            handle(message, for: thread)
        }
    }

    /// Where a repair's replay begins now, its event number, and whether the refresh takes
    /// the whole conversation. Paged reconciliation does: the UI may already hold a returned
    /// page behind a drag. A plain `session.invalidated` keeps a paged thread paged.
    private func invalidation(in message: JSONRPCPeer.Inbound, for thread: ThreadRef.ID) -> (base: Int, seq: Int?, whole: Bool)? {
        guard case let .event(event) = message,
              let base = event.payload["replay_base"]?.intValue, base >= 0 else { return nil }
        switch event.type {
        case BridgeWire.EventType.sessionInvalidated:
            guard offers(BridgeWire.Feature.sessionResync) else { return nil }
        case "message.taken":
            guard offers(BridgeWire.Feature.messageReconciliation), bindings[thread]?.paged == true else { return nil }
        default:
            return nil
        }
        return (base, event.seq, event.type == "message.taken")
    }

    private func handle(_ message: JSONRPCPeer.Inbound, for thread: ThreadRef.ID?) {
        switch message {
        case let .event(event):
            if let thread {
                apply(event, to: thread)
            } else if event.type == BridgeWire.EventType.pollNow, event.sessionID == nil, offers(BridgeWire.Feature.pollNow) {
                // About no thread: something the host's poll reads moved. From anything
                // else, an event without a thread is dropped, as before.
                movesContinuation.yield()
                if offers(BridgeWire.Feature.net), let net = BridgeWire.netRevision(event.payload["net"]) {
                    netContinuation.yield(.at(net))
                }
            }
        case let .request(request):
            if let thread, let received = request.receivedAtFrame, received <= (bindings[thread]?.requestBoundary ?? 0) { return }
            answer(request, in: thread)
        }
    }

    /// Applies one event to a thread, unless it was applied already: a replay and the
    /// live stream overlap.
    private func apply(_ event: GatewayEvent, to thread: ThreadRef.ID) {
        guard let binding = bindings[thread] else { return }
        // A message steered in that the snapshot holds (it came, and was held, as the thread
        // was opened again while this connection followed it): shown there already. Only that
        // kind is left out: a snapshot does not hold everything an event says (a card closing).
        var inSnapshot = false
        if let seq = event.seq {
            if offers(BridgeWire.Feature.sessionResync), seq <= binding.snapshotSeq { return }
            guard seq > binding.lastSeq else { return }
            bindings[thread]?.lastSeq = seq
            inSnapshot = seq <= binding.snapshotSeq && event.type == "message.steered"
        }
        if event.type == "message.taken", offers(BridgeWire.Feature.messageReconciliation),
           let base = event.payload["replay_base"]?.intValue, base > (binding.replayBase ?? -1),
           let start = event.payload["removed_start"]?.intValue, start >= 0,
           let count = event.payload["removed_count"]?.intValue, count > 0 {
            bindings[thread]?.replayBase = base
            if let held = binding.heldStart {
                bindings[thread]?.heldStart = held - min(count, max(0, held - start))
            }
        }
        if event.type.hasPrefix("subagent."), let frame = event.receivedAtFrame, let peer = connection?.peer {
            let before = bindings[thread]?.subagentNews.flatMap { $0.peer === peer ? $0.frame : nil } ?? 0
            bindings[thread]?.subagentNews = (peer, max(before, frame))
        }
        let sent = sentMessageIDs
        for mapped in HermesEventMapper.threadEvents(for: event, features: hostFeatures, isOwn: { sent.contains($0) }) {
            var threadEvent = mapped
            if inSnapshot {
                // Another's is not shown again; this app's own still settles the send it was.
                guard case let .ownMessageSteered(id, _) = mapped else { continue }
                threadEvent = .ownMessageSteered(id, shownAlready: true)
            }
            switch threadEvent {
            case let .requestClosed(id, _), let .requestAnswered(id, _, _):
                openRequests[id] = nil
            case .turnFinished:
                bindings[thread]?.isActive = false
            case .turnStarted, .ownTurnStarted, .turnOpened, .queuedTurnStarted, .messageSteered, .ownMessageSteered, .textDelta, .reasoningDelta, .toolStarted:
                bindings[thread]?.isActive = true
            default:
                break
            }
            binding.continuation.yield(threadEvent)
        }
    }

    /// A repaired session has a new replay base, so replaying the old view can
    /// never converge. Hold synchronously, then fetch the canonical history: the whole of
    /// it when `whole` (a failure taken back from a paged thread), else what a resume of
    /// the thread asks for (a paged one's last turns).
    private func invalidate(_ thread: ThreadRef.ID, base: Int, seq: Int?, whole: Bool) {
        guard let peer = connection?.peer, let binding = bindings[thread],
              base > (binding.replayBase ?? -1) || (seq ?? 0) > max(binding.lastSeq, binding.snapshotSeq) else { return }
        bindings[thread]?.invalidatedBase = max(binding.invalidatedBase ?? base, base)
        // Read again by a refresh already under way, as it asks once more for this repair.
        if whole { bindings[thread]?.refreshesWhole = true }
        guard binding.snapshotRefreshID == nil else { return }
        let refreshID = UUID()
        bindings[thread]?.snapshotRefreshID = refreshID
        bindings[thread]?.resyncs += 1
        Task { await refreshSnapshot(thread, id: refreshID, on: peer) }
    }

    private func refreshSnapshot(_ thread: ThreadRef.ID, id: UUID, on peer: JSONRPCPeer) async {
        defer {
            if bindings[thread]?.snapshotRefreshID == id {
                bindings[thread]?.snapshotRefreshID = nil
                bindings[thread]?.refreshesWhole = false
            }
            finishResync(thread)
        }
        guard self.connection?.peer === peer, let binding = bindings[thread], binding.snapshotRefreshID == id else { return }
        var generation = binding.generation
        do {
            while true {
                let whole = bindings[thread]?.refreshesWhole == true
                let resumed = try await resumeSession(thread, profile: binding.profile, fullHistory: whole)
                guard self.connection?.peer === peer, let current = bindings[thread], current.snapshotRefreshID == id else { return }
                if current.generation != generation {
                    // An explicit open won the race. If it did not cover the repair,
                    // refresh that newer stream rather than losing the invalidation.
                    guard (current.replayBase ?? -1) < (current.invalidatedBase ?? 0) else { return }
                    generation = current.generation
                    continue
                }
                let wanted = bindings[thread]?.invalidatedBase ?? 0
                guard let base = resumed.replayBase, resumed.latestSeq != nil else { throw AgentBackendError.notConnected }
                // Another repair overtook this response; no old frames are released.
                if base < wanted { continue }
                let snapshot = adopt(resumed, for: thread, repaired: true)
                bindings[thread]?.continuation.yield(.snapshot(snapshot))
                listSubagents(for: thread)
                return
            }
        } catch {
            guard self.connection?.peer === peer, bindings[thread]?.snapshotRefreshID == id,
                  bindings[thread]?.generation == generation else { return }
            bindings[thread]?.held = []
            bindings[thread]?.isDetached = true
            bindings[thread]?.continuation.yield(.notice(Notice(.warning, "The repaired thread could not be refreshed. Reopen it to try again.")))
            bindings[thread]?.continuation.yield(.detached)
        }
    }

    /// Passes an approval or a question on to the thread it belongs to, and answers the
    /// kinds this app does not show so the agent fails fast instead of waiting.
    private func answer(_ request: ServerRequest, in thread: ThreadRef.ID?) {
        let binding = thread.flatMap { bindings[$0] }

        if let pending = HermesEventMapper.pendingRequest(request, features: hostFeatures), let thread, let binding {
            openRequests[pending.id] = (thread, pending)
            bindings[thread]?.isActive = true
            binding.continuation.yield(.requestOpened(pending))
            return
        }

        switch request.method {
        case "approval":
            // No thread to ask in: refuse, never allow.
            reply(to: request, with: ["choice": "deny"])
        case "clarify":
            reply(to: request, with: [:])
        case "sudo", "secret", "vault.code", "vault.unlock_prompt", "display.install.sudo":
            // An empty value means "skipped".
            reply(to: request, with: ["value": ""])
            binding?.continuation.yield(.notice(Notice(.warning, "The agent asked for a password or secret, which this app does not provide.")))
        default:
            reply(to: request, with: nil)
        }
    }

    /// Answers a request on the current connection; nil declines it as unsupported.
    private func reply(to request: ServerRequest, with result: JSONValue?) {
        guard let peer = connection?.peer else { return }
        Task {
            if let result {
                try? await peer.respond(to: request.id, result: result)
            } else {
                try? await peer.reject(request.id, code: JSONRPCError.methodNotFoundCode, message: "Not supported by this client")
            }
        }
    }

    /// A Mac of the device's net closed the socket with 4401: it did not take the token,
    /// or took the device out of the net. Said only for a token: a ticket's 4401 is about
    /// the session, which signing in again mends. Through the relay only the Mac's sealed
    /// refusal comes as a 4401 (`RelayTunnelTransport`); the relay's own closes are
    /// `RelayClosed`, the Mac not reached.
    private func heardRefusal(_ error: any Error) {
        guard authenticator is TokenAuthenticator, let closed = error as? WebSocketClosed, closed.isUnauthorized else { return }
        netContinuation.yield(.refused(closed.reason.flatMap { $0.isEmpty ? nil : $0 }))
    }

    private static func describe(_ error: any Error) -> String {
        error.localizedDescription
    }

    /// Whether trying again by itself could help. A rejected password is rejected
    /// again, and each try counts against the host's limit on sign-in attempts.
    private static func isWorthRetrying(_ error: any Error) -> Bool {
        switch error {
        case HermesAuthError.invalidCredentials, HermesAuthError.missingCredentials,
             HermesAuthError.passwordSignInUnavailable, HermesAuthError.invalidBaseURL:
            false
        case let closed as WebSocketClosed:
            // The host refuses this address or origin: a matter of its configuration.
            !closed.isForbidden
        default:
            true
        }
    }
}

// MARK: - Commands

extension HermesBackend: CommandRunning {
    public func commandCatalog(for agent: Agent.ID) async throws -> CommandCatalog {
        let result: JSONValue = try await peer().call(
            HermesWire.Method.commandsCatalog, HermesWire.CommandsCatalogParams(profile: agent.name), timeout: .seconds(60)
        )
        return HermesCommands.catalog(from: result)
    }

    public func commandCatalog(for agent: Agent.ID, in thread: ThreadRef.ID) async throws -> CommandCatalog {
        guard gatewayReady?.bridge != nil else { return try await commandCatalog(for: agent) }
        do {
            let result: JSONValue = try await onSession(thread) { peer, binding in
                try await peer.call(
                    HermesWire.Method.commandsCatalog,
                    BridgeWire.CommandsCatalogParams(profile: agent.name, sessionID: binding.runtimeID),
                    timeout: .seconds(60)
                )
            }
            return HermesCommands.catalog(from: result)
        } catch let error as JSONRPCError where error.code == 4000 || error.code == -32602 {
            // Older bridges reject the new key. Their personal-only list is still safe.
            return try await commandCatalog(for: agent)
        }
    }

    public func runCommand(_ command: SlashInput, in thread: ThreadRef.ID) async throws -> CommandOutcome {
        let (outcome, ran) = try await onSession(thread) { peer, binding in
            var command = command
            // Another name for a command is answered with the command, which is run in
            // its place. A few times at most: names must not lead round in a circle.
            for _ in 0..<3 {
                switch try HermesCommands.answer(in: try await Self.run(command, on: peer, binding: binding), to: command) {
                case let .outcome(outcome): return (outcome, command)
                case let .standsFor(target): command = target
                }
            }
            throw HermesBackendError.commandUnusable("Hermes could not say what \(command.text) stands for.")
        }
        // A command that becomes a message has changed nothing yet: a bridge's `/compact`
        // runs as a turn, whose events say where it compacted.
        if HermesCommands.rewritesConversation.contains(ran.name), !outcome.isMessage {
            // Before the command is called done: a message sent on its heels must
            // meet the conversation as it is now, not be overtaken by this.
            await snapshot(thread)
        }
        return outcome
    }

    /// Tells a thread what the host has now, after something changed its conversation
    /// there that no event reports. A failure leaves it for the next time the thread
    /// is opened.
    private func snapshot(_ thread: ThreadRef.ID) async {
        guard let binding = bindings[thread] else { return }
        bindings[thread]?.resyncs += 1
        defer { finishResync(thread) }
        guard let resumed = try? await resumeSession(thread, profile: binding.profile),
              bindings[thread]?.generation == binding.generation else { return }
        bindings[thread]?.continuation.yield(.snapshot(adopt(resumed, for: thread)))
    }

    /// One command, the way Hermes's own clients run it: as a terminal command first,
    /// and when Hermes says that is not what it is (a skill, a command that becomes a
    /// message), by asking what it stands for.
    private static func run(_ command: SlashInput, on peer: JSONRPCPeer, binding: Binding) async throws -> JSONValue {
        do {
            return try await peer.call(
                HermesWire.Method.slashExec,
                HermesWire.SlashExecParams(sessionID: binding.runtimeID, command: String(command.text.dropFirst()), profile: binding.profile),
                timeout: .seconds(120)
            )
        } catch let error as JSONRPCError where error.code == 4011 || error.code == 4018 {
            return try await peer.call(
                HermesWire.Method.commandDispatch,
                HermesWire.CommandDispatchParams(
                    name: command.name, arg: command.argument.isEmpty ? nil : command.argument,
                    sessionID: binding.runtimeID, profile: binding.profile
                ),
                timeout: .seconds(120)
            )
        }
    }
}

// MARK: - Models

extension HermesBackend: ModelSelecting {
    public func modelCatalog(for agent: Agent.ID) async throws -> ModelCatalog {
        let options: HermesWire.ModelOptionsResult = try await peer().call(
            HermesWire.Method.modelOptions, HermesWire.ModelOptionsParams(profile: agent.name), timeout: .seconds(60)
        )
        // The thinking level is a setting of its own; a host that cannot say leaves it unknown.
        let reasoning: HermesWire.ConfigGetResult? = try? await peer().call(
            HermesWire.Method.configGet, HermesWire.ConfigGetParams(key: "reasoning", profile: agent.name)
        )
        let providers = (options.providers ?? [])
            .filter { $0.authenticated != false }
            .map { ModelProvider(id: $0.slug, name: $0.name ?? $0.slug, models: $0.models ?? []) }
        return ModelCatalog(
            providers: providers,
            agentDefault: ModelSetting(
                model: options.model ?? "",
                provider: options.provider,
                level: reasoning?.value.flatMap(ThinkingLevel.init(rawValue:))
            ),
            // Only from a host that offers them: Hermes has no such keys.
            levelsByModel: offers(BridgeWire.Feature.modelLevels)
                ? BridgeWire.levels(from: options.modelLevels, emptyMeansNone: offers(BridgeWire.Feature.modelLevelsNone))
                : nil,
            namesByModel: offers(BridgeWire.Feature.modelNames) ? BridgeWire.names(from: options.modelNames) : nil,
            defaultLevelsByModel: offers(BridgeWire.Feature.modelDefaultLevels) ? BridgeWire.defaultLevels(from: options.modelDefaultLevels) : nil,
            // An agent whose threads take a mode says so with `modes`, even without a default to name.
            defaultMode: offers(BridgeWire.Feature.modes) && options.modes?.objectValue != nil
                ? BridgeWire.modeState(mode: "default", default: options.modes?["default"]?.stringValue, options: options.modeOptions)
                : nil
        )
    }

    public func setModel(_ model: String, provider: String?, in thread: ThreadRef.ID, confirmed: Bool) async throws -> ModelChange {
        // Hermes reads this the way it reads `/model`: a name, then flags. `--session`
        // is said outright. Left to itself Hermes saves the pick as the profile's own
        // default whenever the profile has none yet, and that default is not the
        // app's to set.
        let value = (provider.map { "\(model) --provider \($0)" } ?? model) + " --session"
        let result: HermesWire.ConfigSetResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                HermesWire.Method.configSet,
                HermesWire.ConfigSetParams(
                    key: "model", value: value, sessionID: binding.runtimeID, profile: binding.profile,
                    confirmExpensiveModel: confirmed ? true : nil
                ),
                timeout: .seconds(60)
            )
        }
        if result.confirmRequired == true {
            return .needsConfirmation(result.confirmMessage ?? "This model costs more to run. Use it anyway?")
        }
        let note = result.deferred == true ? "The model changes when this run is over." : result.warning
        return .applied(note: note?.isEmpty == false ? note : nil)
    }

    public func setThinkingLevel(_ level: ThinkingLevel, in thread: ThreadRef.ID) async throws {
        let _: HermesWire.ConfigSetResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                HermesWire.Method.configSet,
                HermesWire.ConfigSetParams(key: "reasoning", value: level.rawValue, sessionID: binding.runtimeID, profile: binding.profile)
            )
        }
    }
}

// MARK: - Notifications

/// The host sends notifications through the `aeriportal-push` Hermes plugin, which the app
/// talks to over the plugin's routes on the same server (`/api/plugins/aeriportal-push/`).
///
/// A host that lists `push_host` (portals-bridge) is also told the id the app gave it,
/// which its notifications name under `aeriportal.host`. Hermes is never sent that key:
/// its plugin rejects keys it does not know.
extension HermesBackend: PushRegistering {
    public func register(_ device: PushDevice, watching threads: [WatchedThread]) async throws {
        var deviceFields: [String: JSONValue] = [
            "token": .string(device.token),
            "environment": .string(device.environment.rawValue),
            "bundle_id": .string(device.bundleID),
        ]
        // The relay token and the key only to a bridge that takes them
        // (docs/pairing-and-relay.md): Hermes's plugin has no use for either, and the key
        // is not for it to hold.
        if let relayToken = device.relayToken, offers(BridgeWire.Feature.pushRelay) {
            deviceFields["relay_token"] = .string(relayToken)
        }
        if let key = device.key, offers(BridgeWire.Feature.pushSealed) {
            deviceFields["key"] = .string(key.base64EncodedString())
        }
        // Every time, empty too: the bridge keeps a list left out, and an empty one unmutes.
        if offers(BridgeWire.Feature.pushMuting) {
            deviceFields["muted"] = .array(device.muted.sorted().map { .string($0.rawValue) })
        }
        var body: [String: JSONValue] = [
            "device": .object(deviceFields),
            "threads": .array(threads.map { thread in
                [
                    "id": .string(thread.id.rawValue),
                    "agent": .string(thread.agent),
                    "agent_name": .string(thread.agentName),
                    "title": .string(thread.title ?? ""),
                ]
            }),
        ]
        if offers(BridgeWire.Feature.pushHost) {
            body["host"] = .string(host.rawValue)
        }
        try await pushPlugin("PUT", "registration", body: .object(body))
    }

    public func unwatch(_ thread: ThreadRef.ID, deviceToken: String) async throws {
        guard !deviceToken.isEmpty else { return }
        let id = thread.rawValue.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? thread.rawValue
        if try await scopesWatchers() {
            // Only this device stops hearing about the thread. A server that has the route
            // and fails it is not asked the other way: that would stop every device.
            try await pushPlugin("DELETE", "threads/\(id)/watcher", body: ["device_token": .string(deviceToken)])
        } else {
            // A bridge or plugin from before the route (an old one would refuse it, or not
            // know it): the route it has, as this app used before. It stops notifying every
            // device about the thread, which is better than this one being told on about a
            // thread it removed.
            try await pushPlugin("DELETE", "threads/\(id)", body: nil)
        }
    }

    /// Whether the host's push routes stop notifying one device (feature `push_watcher`).
    /// A bridge says so as it connects; a host that lists no features (Hermes, whose plugin
    /// serves the routes, or one not connected to yet) is asked once a connection (`GET
    /// status`, `features`).
    private func scopesWatchers() async throws -> Bool {
        if gatewayReady?.bridge != nil { return offers(BridgeWire.Feature.pushWatcher) }
        if let known = pushRoutesScoped { return known }
        let status = try await pushPluginAnswer("GET", "status", body: nil)
        let scoped = status["features"]?.arrayValue?.contains(.string("watcher")) ?? false
        pushRoutesScoped = scoped
        return scoped
    }

    private func pushPlugin(_ method: String, _ path: String, body: JSONValue?) async throws {
        _ = try await pushPluginData(method, path, body: body)
    }

    /// A push route's answer, read as JSON; null when it is not.
    private func pushPluginAnswer(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue {
        let data = try await pushPluginData(method, path, body: body)
        return (try? JSONValue.parse(String(decoding: data, as: UTF8.self))) ?? .null
    }

    private func pushPluginData(_ method: String, _ path: String, body: JSONValue?) async throws -> Data {
        var request = URLRequest(url: authenticator.baseURL.appendingPathComponent("api/plugins/aeriportal-push/\(path)"))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(try body.serialized().utf8)
        }
        let (data, response) = try await authenticator.send(request)
        switch response.statusCode {
        case 200..<300: return data
        case 404: throw HermesBackendError.pushPluginMissing
        default: throw HermesAuthError.unexpectedStatus(response.statusCode)
        }
    }
}

public enum HermesBackendError: Error, Sendable, Hashable {
    /// The host would not take an image; with its reason when it gave one.
    case imageNotAccepted(String?)
    /// The host would not take a file (or takes none: it is not a bridge that does); with
    /// its reason when it gave one.
    case fileNotAccepted(String?)
    /// The host has no `aeriportal-push` plugin, or it is not enabled.
    case pushPluginMissing
    /// The host's answer to a slash command could not be used. The sentence says why.
    case commandUnusable(String)
}

extension HermesBackendError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case let .imageNotAccepted(reason): reason.map { "The host did not accept an image: \($0)" } ?? "The host did not accept an image."
        case let .fileNotAccepted(reason): reason ?? "This host's bridge cannot take files. Update it to send files."
        case .pushPluginMissing: "The host does not have the aeriportal-push plugin enabled, so it cannot send notifications."
        case let .commandUnusable(why): why
        }
    }
}

private extension JSONRPCPeer.Inbound {
    /// The runtime session the message is about.
    var sessionID: String? {
        switch self {
        case let .event(event): event.sessionID
        case let .request(request): request.params["session_id"]?.stringValue
        }
    }
}

// MARK: - Modes

// Here rather than with the other bridge extensions: it names the thread's live session.
extension HermesBackend: ModeSelecting {
    public var offersModes: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.modes) }
    }

    public func setMode(_ mode: ThreadMode, in thread: ThreadRef.ID) async throws -> ModeState {
        guard offers(BridgeWire.Feature.modes) else { throw ModeError.unavailable }
        let result: BridgeWire.SessionSetModeResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.sessionSetMode,
                BridgeWire.SessionSetModeParams(sessionID: binding.runtimeID, mode: mode.rawValue, profile: binding.profile)
            )
        }
        return BridgeWire.modeState(mode: result.mode, default: result.modeDefault, options: result.modeOptions) ?? ModeState(mode: mode)
    }
}

// MARK: - Queue and files

// Here for the same reason: they name the thread's live session.
extension HermesBackend: QueueControlling {
    public var listsQueue: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.queue) }
    }

    public func removeQueued(_ id: String, in thread: ThreadRef.ID) async throws -> Bool {
        guard offers(BridgeWire.Feature.queue) else { return false }
        let result: BridgeWire.QueueRemoveResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.promptQueueRemove,
                BridgeWire.QueueItemParams(sessionID: binding.runtimeID, queueID: id, profile: binding.profile)
            )
        }
        return result.removed == true
    }

    public func steerQueued(_ id: String, in thread: ThreadRef.ID) async throws -> QueueSteerOutcome {
        guard offers(BridgeWire.Feature.queue) else { return .queued }
        let result: BridgeWire.QueueSteerResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.promptQueueSteer,
                BridgeWire.QueueItemParams(sessionID: binding.runtimeID, queueID: id, profile: binding.profile)
            )
        }
        return result.status.flatMap(QueueSteerOutcome.init(rawValue:)) ?? .queued
    }

    public func placeQueued(_ id: String, at placement: WhenBusy, in thread: ThreadRef.ID) async throws -> QueuePlaceOutcome {
        guard offers(BridgeWire.Feature.queue) else { return .queued }
        let result: BridgeWire.QueueSteerResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.promptQueuePlace,
                BridgeWire.QueueItemParams(sessionID: binding.runtimeID, queueID: id, profile: binding.profile, placement: placement)
            )
        }
        return result.status.flatMap(QueuePlaceOutcome.init(rawValue:)) ?? .queued
    }
}

extension HermesBackend: SubagentStopping {
    public var stopsSubagents: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.subagents) }
    }

    public func stopSubagent(_ id: String, in thread: ThreadRef.ID) async throws -> Bool {
        guard offers(BridgeWire.Feature.subagents) else { return false }
        let result: BridgeWire.SubagentStopResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.subagentStop,
                BridgeWire.SubagentStopParams(sessionID: binding.runtimeID, subagentID: id, profile: binding.profile)
            )
        }
        return result.status == "stopped"
    }
}

extension HermesBackend: SubagentReading {
    public func subagentTranscript(_ id: String, in thread: ThreadRef.ID) async throws -> Transcript? {
        guard offers(BridgeWire.Feature.subagentRead) else { return nil }
        let result: BridgeWire.SubagentReadResult = try await onSession(thread) { peer, binding in
            try await peer.call(
                BridgeWire.Method.subagentRead,
                BridgeWire.SubagentReadParams(sessionID: binding.runtimeID, subagentID: id, profile: binding.profile)
            )
        }
        guard result.available == true else { return nil }
        return HermesHistoryMapper.transcript(from: result.messages ?? [], features: hostFeatures)
    }
}

extension HermesBackend: FileAttaching {
    public var attachesFiles: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.files) }
    }
}

// MARK: - MCP sign-in

extension HermesBackend: MCPAuthenticating {
    private func clearMCPAuth() {
        guard offers(BridgeWire.Feature.mcpAuth) else { return }
        for binding in bindings.values { binding.continuation.yield(.mcpAuthCleared) }
    }

    public func mcpAuth(_ action: MCPAuthAction, in thread: ThreadRef, agent: Agent) async throws -> [MCPAuthCard] {
        guard offers(BridgeWire.Feature.mcpAuth), agent.kind == "droid", agent.id == thread.agent,
              thread.agent.host == host, !thread.isReadOnly else {
            if case .list = action { return [] }
            throw MCPAuthError.unavailable
        }
        do {
            let original = try peer()
            return try await onSession(thread.id) { peer, binding in
                // A retry must not cross onto an old bridge or a replacement connection.
                guard peer === original, offers(BridgeWire.Feature.mcpAuth) else { throw MCPAuthError.unavailable }
                let answer = try await peer.request(
                    MCPAuthWire.method, params: MCPAuthWire.params(action, sessionID: binding.runtimeID, profile: binding.profile)
                )
                guard connection?.peer === original, bindings[thread.id]?.streamNumber == binding.streamNumber else {
                    throw MCPAuthError.unavailable
                }
                return try MCPAuthWire.cards(answer)
            }
        } catch let error as JSONRPCError where error.code == -32602 && error.data?["reason"]?.stringValue == "settling" {
            throw MCPAuthError.settling
        } catch let error as JSONRPCError where error.code == -32602 && error.data?["reason"] == nil {
            // The bridge would not take what was pasted (from another attempt, not a code),
            // and the attempt goes on waiting. Its sentence is not passed on either.
            if case .submit = action { throw MCPAuthError.rejected }
            throw MCPAuthError.failed
        } catch {
            // Never pass a free-form RPC error, or a decoding error with its value, on.
            throw MCPAuthError.failed
        }
    }
}
