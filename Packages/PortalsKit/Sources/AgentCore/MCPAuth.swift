import Foundation
import Observation

/// Live sign-in state, never part of a transcript or a saved thread.
public struct MCPAuthCard: Identifiable, Hashable, Sendable, CustomDebugStringConvertible {
    public enum Status: String, Sendable {
        case required, starting, waiting, completed, cancelled, failed
    }

    public let id: String
    public let serverName: String
    public let status: Status
    public let url: URL?

    public init(id: String, serverName: String, status: Status, url: URL? = nil) {
        self.id = id
        self.serverName = serverName
        let safe = url.flatMap { url -> URL? in
            guard url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil else { return nil }
            return url
        }
        self.status = status == .waiting && safe == nil ? .failed : status
        self.url = self.status == .waiting ? safe : nil
    }

    public var debugDescription: String { "MCPAuthCard(\(status.rawValue))" }
}

public enum MCPAuthAction: Sendable, CustomDebugStringConvertible {
    case list
    case start(server: String)
    case submit(server: String, authID: String, code: String)
    case cancel(server: String, authID: String)

    public var debugDescription: String { "MCPAuthAction(redacted)" }
}

public enum MCPAuthError: Error, Sendable {
    case unavailable, failed, settling
    /// The host would not take a pasted code or address (from another attempt, say), and
    /// the attempt still waits for one: it is pasted again, not started over.
    case rejected
}

extension MCPAuthError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .rejected: "That code or address was not accepted for this attempt. Paste it again."
        case .unavailable, .failed, .settling: "Sign-in did not finish. Try again."
        }
    }
}

public protocol MCPAuthenticating: Sendable {
    func mcpAuth(_ action: MCPAuthAction, in thread: ThreadRef, agent: Agent) async throws -> [MCPAuthCard]
}

/// Replaces the live list on each refresh. A cleared connection cannot be repopulated
/// by an answer still coming from it.
@MainActor @Observable
public final class MCPAuthState {
    public private(set) var cards: [MCPAuthCard] = []
    public private(set) var busyServers: Set<String> = []
    public private(set) var settlingServers: Set<String> = []
    public private(set) var listFailed = false
    public var isRefreshing: Bool { refreshID != nil }
    private var failedAttempts: [String: String] = [:]
    /// The attempt, by server, whose pasted code or address the host would not take.
    private var rejectedPastes: [String: String] = [:]
    /// Attempts listed here before they finished, and finished ones put away (`shownCards`).
    /// Kept through `clear`: a sign-in in the browser can see the connection go and come
    /// back, and the ids are the bridge's own, not part of the sign-in.
    private var watchedAttempts: Set<String> = []
    private var dismissedAttempts: Set<String> = []
    /// The host said a sign-in changed (`invalidated`), and no list has answered since: a
    /// list that fails then says so even with no card shown.
    private var awaitsList = false
    private var lifetime = UUID()
    private var revision = 0
    private var refreshID: UUID?
    private var refreshAgain = false

    public init() {}

    public func clear() {
        lifetime = UUID()
        revision += 1
        cards = []
        busyServers = []
        settlingServers = []
        listFailed = false
        failedAttempts = [:]
        rejectedPastes = [:]
        awaitsList = false
        refreshID = nil
        refreshAgain = false
    }

    /// The cards to show. The host lists a finished sign-in until it restarts, so "Signed
    /// in." is shown only for an attempt this thread saw before it finished, until it is
    /// put away (`dismiss`); one already finished when first listed (another launch) is not
    /// shown.
    public var shownCards: [MCPAuthCard] {
        cards.filter { $0.status != .completed || watchedAttempts.contains($0.id) && !dismissedAttempts.contains($0.id) }
    }

    /// Puts a finished sign-in's card away; any other card stays. With the last card goes
    /// a list error that was only about the cards, as no error stands alone for a card put
    /// away; one for a change the host announced and no list answered stays.
    public func dismiss(_ card: MCPAuthCard) {
        guard card.status == .completed else { return }
        dismissedAttempts.insert(card.id)
        if shownCards.isEmpty, !awaitsList { listFailed = false }
    }

    public func hasActionError(for card: MCPAuthCard) -> Bool {
        failedAttempts[card.serverName] == card.id
    }

    /// The card's attempt still waits, and the code or address last pasted into it was not
    /// taken: it asks for the paste again.
    public func pasteWasRejected(for card: MCPAuthCard) -> Bool {
        card.status == .waiting && rejectedPastes[card.serverName] == card.id
    }

    private func replaceCards(_ listed: [MCPAuthCard]) {
        watchedAttempts.formUnion(listed.filter { $0.status != .completed }.map(\.id))
        cards = listed
        awaitsList = false
        listFailed = false
        failedAttempts = failedAttempts.filter { server, id in
            listed.contains { $0.serverName == server && $0.id == id && $0.status != .completed }
        }
        rejectedPastes = rejectedPastes.filter { server, id in
            listed.contains { $0.serverName == server && $0.id == id && $0.status == .waiting }
        }
    }

    public func refresh(
        from backend: any MCPAuthenticating, thread: ThreadRef, agent: Agent, invalidated: Bool = false
    ) async {
        if invalidated { awaitsList = true }
        revision += 1
        guard refreshID == nil else {
            refreshAgain = true
            return
        }
        let id = UUID()
        let life = lifetime
        refreshID = id
        repeat {
            refreshAgain = false
            let asked = revision
            do {
                let listed = try await backend.mcpAuth(.list, in: thread, agent: agent)
                guard life == lifetime, refreshID == id else { return }
                if asked == revision { replaceCards(listed) }
            } catch {
                guard life == lifetime, refreshID == id else { return }
                // The cards stay as they were: a failed list says nothing of them, and turning
                // them failed would offer a fresh sign-in to a server signed in already, or take
                // the field away from an attempt still waiting for its code.
                if asked == revision { listFailed = awaitsList || !shownCards.isEmpty }
            }
        } while refreshAgain
        if refreshID == id { refreshID = nil }
    }

    public func perform(
        _ action: MCPAuthAction, server: String, from backend: any MCPAuthenticating, thread: ThreadRef, agent: Agent
    ) async {
        guard busyServers.insert(server).inserted else { return }
        failedAttempts[server] = nil
        rejectedPastes[server] = nil
        let attempt = cards.first { $0.serverName == server }?.id
        revision += 1
        let asked = revision
        let life = lifetime
        do {
            let listed = try await backend.mcpAuth(action, in: thread, agent: agent)
            guard life == lifetime else { return }
            if asked == revision { replaceCards(listed) }
        } catch MCPAuthError.settling {
            guard life == lifetime else { return }
            settlingServers.insert(server)
            try? await Task.sleep(for: .seconds(1))
            guard life == lifetime else { return }
            settlingServers.remove(server)
        } catch MCPAuthError.rejected {
            guard life == lifetime else { return }
            if let card = cards.first(where: { $0.serverName == server }), card.id == attempt {
                rejectedPastes[server] = card.id
            }
        } catch {
            guard life == lifetime else { return }
            // No raw error reaches the screen: an SDK error may contain credentials.
            if let card = cards.first(where: { $0.serverName == server }), card.id == attempt,
               card.status != .completed {
                failedAttempts[server] = card.id
            }
        }
        guard life == lifetime else { return }
        busyServers.remove(server)
        await refresh(from: backend, thread: thread, agent: agent)
    }
}
