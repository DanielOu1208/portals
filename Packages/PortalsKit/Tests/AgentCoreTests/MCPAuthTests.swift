import Foundation
import Testing
@testable import AgentCore

@MainActor @Suite struct MCPAuthTests {
    private actor Host: MCPAuthenticating {
        struct Request: Sendable {
            let action: MCPAuthAction
            let answer: CheckedContinuation<[MCPAuthCard], any Error>
        }

        nonisolated let requests: AsyncStream<Request>
        private let continuation: AsyncStream<Request>.Continuation

        init() { (requests, continuation) = AsyncStream.makeStream() }

        func mcpAuth(_ action: MCPAuthAction, in thread: ThreadRef, agent: Agent) async throws -> [MCPAuthCard] {
            try await withCheckedThrowingContinuation { answer in
                continuation.yield(Request(action: action, answer: answer))
            }
        }
    }

    /// A host that answers every list at once with the cards it was last given.
    private actor Lister: MCPAuthenticating {
        var listed: [MCPAuthCard] = []
        /// Lists fail while this is set.
        var fails = false

        func list(_ cards: [MCPAuthCard]) { listed = cards }

        func fail(_ failing: Bool) { fails = failing }

        func mcpAuth(_ action: MCPAuthAction, in thread: ThreadRef, agent: Agent) async throws -> [MCPAuthCard] {
            if fails { throw MCPAuthError.failed }
            return listed
        }
    }

    private let agent = Agent(id: Agent.ID(host: HostID(rawValue: "mac"), name: "droid"), kind: "droid")
    private var thread: ThreadRef { ThreadRef(id: ThreadRef.ID(rawValue: "stored"), agent: agent.id) }

    private func card(_ id: String = "attempt", status: MCPAuthCard.Status = .waiting) -> MCPAuthCard {
        MCPAuthCard(id: id, serverName: "Example", status: status, url: URL(string: "https://signin.example.test/auth?state=private"))
    }

    @Test func onlyWaitingKeepsASafeURLAndDebugDescriptionsDoNotExposeIt() {
        for status in [MCPAuthCard.Status.required, .starting, .completed, .cancelled, .failed] {
            #expect(card(status: status).url == nil)
        }
        for url in ["http://example.test", "javascript:alert(1)", "https://user:pass@example.test"] {
            let unsafe = MCPAuthCard(id: "a", serverName: "Example", status: .waiting, url: URL(string: url))
            #expect(unsafe.status == .failed)
            #expect(unsafe.url == nil)
        }
        #expect(card().url?.host == "signin.example.test")
        #expect(!String(reflecting: card()).contains("private"))
        let action = MCPAuthAction.submit(server: "Example", authID: "attempt", code: "private-code")
        #expect(!String(reflecting: action).contains("private-code"))
    }

    @Test func disconnectClearsURLsAndRejectsLateResultsWhileReconnectReplacesTheList() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let request = try #require(await requests.next())
        request.answer.resume(returning: [card()])
        await first.value
        #expect(state.cards == [card()])
        let late = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let oldRequest = try #require(await requests.next())
        state.clear()
        #expect(state.cards.isEmpty)
        let reconnect = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let newRequest = try #require(await requests.next())
        newRequest.answer.resume(returning: [card("new", status: .required)])
        await reconnect.value
        oldRequest.answer.resume(returning: [card("obsolete")])
        await late.value
        #expect(state.cards == [card("new", status: .required)])
        let empty = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let emptyRequest = try #require(await requests.next())
        emptyRequest.answer.resume(returning: [])
        await empty.value
        #expect(state.cards.isEmpty)
    }

    @Test func invalidationDuringAListRefetchesRatherThanApplyingTheOldList() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let old = try #require(await requests.next())
        await state.refresh(from: host, thread: thread, agent: agent)
        old.answer.resume(returning: [card("old")])
        let fresh = try #require(await requests.next())
        #expect(state.cards.isEmpty)
        fresh.answer.resume(returning: [card("current", status: .completed)])
        await first.value
        #expect(state.cards == [card("current", status: .completed)])
    }

    @Test(arguments: [MCPAuthAction.start(server: "Example"),
                      .submit(server: "Example", authID: "attempt", code: "sample-code")])
    func startAndSubmitStayBusyWithoutDuplicatesAndDisconnectRejectsTheirLateResults(action: MCPAuthAction) async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let calling = Task {
            await state.perform(action, server: "Example", from: host, thread: thread, agent: agent)
        }
        let request = try #require(await requests.next())
        #expect(state.busyServers == ["Example"])
        await state.perform(action, server: "Example", from: host, thread: thread, agent: agent)
        state.clear()
        #expect(state.busyServers.isEmpty)
        request.answer.resume(returning: [card()])
        await calling.value
        #expect(state.cards.isEmpty)
    }

    @Test func liveCardsAndTheirInvalidationsNeverEnterTheSavedConversation() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let live = MCPAuthState()
        var conversation = ThreadState()
        _ = conversation.messageSent("Hello")
        conversation.apply(.turnFinished(.completed, finalText: nil))
        let before = try JSONEncoder().encode(conversation.transcript)
        let refresh = Task { await live.refresh(from: host, thread: thread, agent: agent) }
        let request = try #require(await requests.next())
        request.answer.resume(returning: [card()])
        await refresh.value
        conversation.apply(.mcpAuthChanged)
        conversation.apply(.mcpAuthCleared)
        let after = try JSONEncoder().encode(conversation.transcript)
        #expect(try JSONSerialization.jsonObject(with: before) as? NSDictionary == JSONSerialization.jsonObject(with: after) as? NSDictionary)
        #expect(!String(decoding: after, as: UTF8.self).contains("signin.example"))
        #expect(!String(decoding: after, as: UTF8.self).contains("private"))
        #expect(!conversation.isRunning)
    }

    @Test func aSettlingRetryKeepsItsCardQuietAndRefreshesAfterTheBriefPause() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let listing = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let listed = try #require(await requests.next())
        listed.answer.resume(returning: [card(status: .cancelled)])
        await listing.value
        let retry = Task {
            await state.perform(.start(server: "Example"), server: "Example", from: host, thread: thread, agent: agent)
        }
        let starting = try #require(await requests.next())
        starting.answer.resume(throwing: MCPAuthError.settling)
        let refresh = try #require(await requests.next())
        #expect(state.cards.first?.status == .cancelled)
        #expect(state.settlingServers.isEmpty)
        refresh.answer.resume(returning: [card(status: .cancelled)])
        await retry.value
        #expect(state.busyServers.isEmpty)
    }

    /// A list that could not be had says so, and changes no card: a sign-in that finished
    /// still reads "Signed in.", and one still waiting keeps its field for the code.
    @Test(arguments: [MCPAuthCard.Status.waiting, .completed])
    func aListFailureKeepsTheCardsAsTheyWere(status: MCPAuthCard.Status) async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        if status == .completed {
            // Seen while it waited first, so its completion is shown (`shownCards`).
            let waiting = Task { await state.refresh(from: host, thread: thread, agent: agent) }
            try #require(await requests.next()).answer.resume(returning: [card()])
            await waiting.value
        }
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let request = try #require(await requests.next())
        request.answer.resume(returning: [card(status: status)])
        await first.value
        let failing = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let failed = try #require(await requests.next())
        failed.answer.resume(throwing: MCPAuthError.failed)
        await failing.value
        #expect(state.cards == [card(status: status)])
        #expect(state.listFailed)
        state.clear()
        #expect(!state.listFailed)
        #expect(state.cards.isEmpty)
    }

    @Test(arguments: [false, true])
    func initialListFailureOnlyOffersRetryAfterAnAuthInvalidation(invalidated: Bool) async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent, invalidated: invalidated) }
        let request = try #require(await requests.next())
        #expect(state.isRefreshing)
        request.answer.resume(throwing: MCPAuthError.failed)
        await first.value
        #expect(state.cards.isEmpty)
        #expect(state.listFailed == invalidated)
        #expect(!state.isRefreshing)
        let retry = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let next = try #require(await requests.next())
        next.answer.resume(returning: [card(status: .required)])
        await retry.value
        #expect(!state.listFailed)
        #expect(state.cards.first?.status == .required)
    }

    @Test func rejectedSubmitKeepsGenericFeedbackThroughTheWaitingRefreshAndClearsOnRetry() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let listed = try #require(await requests.next())
        listed.answer.resume(returning: [card()])
        await first.value
        let submit = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "bad-state"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        let rejected = try #require(await requests.next())
        rejected.answer.resume(throwing: MCPAuthError.failed)
        let refetch = try #require(await requests.next())
        refetch.answer.resume(returning: [card()])
        await submit.value
        #expect(state.cards.first?.status == .waiting)
        #expect(state.hasActionError(for: card()))
        let retry = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "correct"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        let accepted = try #require(await requests.next())
        #expect(!state.hasActionError(for: card()))
        accepted.answer.resume(returning: [card(status: .completed)])
        let finalList = try #require(await requests.next())
        finalList.answer.resume(returning: [card(status: .completed)])
        await retry.value
        #expect(!state.hasActionError(for: card()))
    }

    /// A paste the bridge would not take leaves the attempt waiting: the card asks for it
    /// again, not to start over, and a paste it takes clears that.
    @Test func aRefusedPasteAsksForTheCodeAgainWhileTheAttemptWaits() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        try #require(await requests.next()).answer.resume(returning: [card()])
        await first.value
        let submit = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "other-state"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        try #require(await requests.next()).answer.resume(throwing: MCPAuthError.rejected)
        try #require(await requests.next()).answer.resume(returning: [card()])
        await submit.value
        #expect(state.cards.first?.status == .waiting)
        #expect(state.pasteWasRejected(for: card()))
        #expect(!state.hasActionError(for: card()))
        let retry = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "correct"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        let accepted = try #require(await requests.next())
        #expect(!state.pasteWasRejected(for: card()))
        accepted.answer.resume(returning: [card(status: .completed)])
        try #require(await requests.next()).answer.resume(returning: [card(status: .completed)])
        await retry.value
        #expect(!state.pasteWasRejected(for: card(status: .completed)))
    }

    /// Once the attempt is no longer waiting, the card's own status speaks for it.
    @Test func aRefusedPasteSaysNothingOnceTheAttemptEnded() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        try #require(await requests.next()).answer.resume(returning: [card()])
        await first.value
        let submit = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "late"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        try #require(await requests.next()).answer.resume(throwing: MCPAuthError.rejected)
        try #require(await requests.next()).answer.resume(returning: [card(status: .cancelled)])
        await submit.value
        #expect(!state.pasteWasRejected(for: card(status: .cancelled)))
    }

    /// The bridge lists a finished sign-in until it restarts. It is shown only when this
    /// thread listed it before it finished, until it is put away; one already finished when
    /// first listed (another launch) is not shown.
    @Test func aFinishedSignInIsShownOnceAndPutAway() async throws {
        let host = Lister()
        let state = MCPAuthState()
        await host.list([card("old", status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.cards.count == 1)
        #expect(state.shownCards.isEmpty)
        await host.list([card()])
        await state.refresh(from: host, thread: thread, agent: agent)
        await host.list([card(status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.shownCards == [card(status: .completed)])
        await host.list([card(status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.shownCards == [card(status: .completed)])
        state.dismiss(card(status: .completed))
        #expect(state.shownCards.isEmpty)
        await host.list([card(status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.shownCards.isEmpty)
        // Only a finished one is put away.
        state.dismiss(card("next", status: .required))
        await host.list([card("next", status: .required)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.shownCards == [card("next", status: .required)])
        // Finished while the connection was away (the browser had the screen).
        state.clear()
        await host.list([card("next", status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(state.shownCards == [card("next", status: .completed)])
    }

    /// Putting the last card away takes a list error over it away too, and a list that
    /// fails after puts none up; a sign-in the host said changed, and that no list has
    /// answered since, still has its error.
    @Test(arguments: [false, true])
    func puttingTheLastCardAwayLeavesNoErrorForIt(invalidated: Bool) async throws {
        let host = Lister()
        let state = MCPAuthState()
        await host.list([card()])
        await state.refresh(from: host, thread: thread, agent: agent)
        await host.list([card(status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        await host.fail(true)
        await state.refresh(from: host, thread: thread, agent: agent, invalidated: invalidated)
        #expect(state.listFailed)
        state.dismiss(card(status: .completed))
        #expect(state.shownCards.isEmpty)
        #expect(state.listFailed == invalidated)
        if !invalidated {
            await state.refresh(from: host, thread: thread, agent: agent)
            #expect(!state.listFailed)
        }
    }

    @Test func aListThatFailsAfterTheLastCardWasPutAwayPutsUpNoError() async throws {
        let host = Lister()
        let state = MCPAuthState()
        await host.list([card()])
        await state.refresh(from: host, thread: thread, agent: agent)
        await host.list([card(status: .completed)])
        await state.refresh(from: host, thread: thread, agent: agent)
        state.dismiss(card(status: .completed))
        await host.fail(true)
        await state.refresh(from: host, thread: thread, agent: agent)
        #expect(!state.listFailed)
    }

    /// A list that fails over a finished sign-in that is not shown puts up no error.
    @Test func aListFailureOverOnlyAHiddenSignInSaysNothing() async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        try #require(await requests.next()).answer.resume(returning: [card(status: .completed)])
        await first.value
        let failing = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        try #require(await requests.next()).answer.resume(throwing: MCPAuthError.failed)
        await failing.value
        #expect(!state.listFailed)
    }

    @Test(arguments: ["new-attempt", "completed", "disconnect"])
    func actionErrorsDoNotSurviveAReplacementCompletionOrDisconnect(change: String) async throws {
        let host = Host()
        var requests = host.requests.makeAsyncIterator()
        let state = MCPAuthState()
        let first = Task { await state.refresh(from: host, thread: thread, agent: agent) }
        let listed = try #require(await requests.next())
        listed.answer.resume(returning: [card()])
        await first.value
        let submit = Task {
            await state.perform(.submit(server: "Example", authID: "attempt", code: "bad-state"),
                                server: "Example", from: host, thread: thread, agent: agent)
        }
        let rejected = try #require(await requests.next())
        rejected.answer.resume(throwing: MCPAuthError.failed)
        let refetch = try #require(await requests.next())
        refetch.answer.resume(returning: [card()])
        await submit.value
        #expect(state.hasActionError(for: card()))
        if change == "disconnect" {
            state.clear()
        } else {
            let refresh = Task { await state.refresh(from: host, thread: thread, agent: agent) }
            let replacement = try #require(await requests.next())
            replacement.answer.resume(returning: [change == "completed" ? card(status: .completed) : card("new-attempt")])
            await refresh.value
        }
        #expect(!state.hasActionError(for: card()))
        #expect(!state.hasActionError(for: card("new-attempt")))
    }
}
