import Foundation
import Testing
@testable import AgentCore

/// The demo the welcome offers (`FakeBackend+Demo`): what a reviewer with no Mac sees.
@Suite struct FakeBackendDemoTests {
    private let host = HostID(rawValue: "portals-demo")

    private func connected() async throws -> FakeBackend {
        let backend = FakeBackend(script: .demo, host: host, pace: .zero)
        try await backend.connect()
        return backend
    }

    private func replyText(_ state: ThreadState) -> String {
        state.transcript.turns.flatMap(\.items).compactMap { if case let .text(text) = $0.content { text } else { nil } }.joined()
    }

    private func tools(_ state: ThreadState) -> [ToolRun] {
        state.transcript.turns.flatMap(\.items).compactMap { if case let .tool(run) = $0.content { run } else { nil } }
    }

    /// Plays the tour in its thread, as the app begins it, `answer` playing the person, and
    /// follows the review it asks of Codex in that thread to its end.
    private func playTour(
        answer: @escaping (PendingRequest) -> RequestAnswer
    ) async throws -> (tour: ThreadState, review: ThreadState, asked: [PendingRequest]) {
        let backend = try await connected()
        let threads = FakeBackend.demoThreads(on: host)
        let tour = try #require(threads.first { $0.record.id == FakeBackend.demoTourID })
        let review = try #require(threads.first { $0.record.id == FakeBackend.demoReviewID })

        _ = try await backend.openThread(review.record.ref)
        let reviewEvents = await backend.events(for: review.record.id)
        let reviewing = Task {
            var state = ThreadState(transcript: review.transcript)
            for await event in reviewEvents {
                state.apply(event)
                if case .turnFinished = event { break }
            }
            return state
        }

        _ = try await backend.openThread(tour.record.ref)
        var state = ThreadState(transcript: tour.transcript)
        let sent = state.messageSent(FakeBackend.demoTourPrompt)
        state.messageDelivered(sent, outcome: try await backend.send(FakeBackend.demoTourPrompt, to: tour.record.id))
        var asked: [PendingRequest] = []
        for await event in await backend.events(for: tour.record.id) {
            state.apply(event)
            if case let .requestOpened(request) = event {
                asked.append(request)
                let given = answer(request)
                state.requestAnswered(request.id, with: given)
                try await backend.respond(to: request.id, in: tour.record.id, with: given)
            }
            if case .turnFinished = event { break }
        }
        return (state, await reviewing.value, asked)
    }

    @Test func theDemoHostHasClaudeCodeAndCodexInAProject() async throws {
        let backend = try await connected()
        let agents = try await backend.listAgents()
        #expect(agents.map(\.displayName) == ["Claude Code", "Codex"])
        #expect(agents.map(\.kind) == ["claude", "codex"])
        #expect(agents.filter(\.isDefault).map(\.id.name) == ["claude"])
        #expect(await backend.offersFolders == true)
        let folders = try await backend.folders(for: agents[0].id)
        #expect(folders.recent.map(\.path) == [FakeBackend.demoProject])
        #expect(folders.general.isGeneral)
        // Every other script still offers no folders, and says nothing of them.
        #expect(await FakeBackend(script: .greeting).offersFolders == nil)
    }

    @Test func theDemoThreadsReadAsMadeUpAndTheReviewIsUnderTheTour() throws {
        let threads = FakeBackend.demoThreads(on: host)
        #expect(threads.map(\.record.id) == [FakeBackend.demoTourID, FakeBackend.demoReviewID, FakeBackend.demoNotesID])
        #expect(threads.allSatisfy { $0.record.ref.title?.hasPrefix("Demo") == true })
        #expect(threads.allSatisfy { $0.record.ref.workingDirectory == FakeBackend.demoProject })
        #expect(threads.allSatisfy { !$0.transcript.turns.isEmpty && $0.transcript.turns.allSatisfy { $0.outcome == .completed } })
        let review = threads[1].record
        #expect(review.startedFrom == threads[0].record.key)
        let agents = Set(FakeBackend.demoAgents(on: host).map(\.id))
        let nested = StartedThreads.nested(threads.map(\.record), nesting: [host], listed: agents)
        #expect(nested == [review.key])
    }

    @Test func theTourAsksTwiceShowsCodeAndAVisualAndHasCodexReview() async throws {
        let played = try await playTour { request in
            switch request.kind {
            case .approval: .approval(.once)
            case .clarify: .clarify(["fix": "Round to cents (Recommended)"])
            default: .cancelled
            }
        }
        #expect(played.asked.count == 2)
        guard played.asked.count == 2 else { return }
        if case let .approval(approval) = played.asked[0].kind {
            #expect(approval.command == "rm -rf build")
        } else {
            Issue.record("the tour's first request is not an approval")
        }
        if case let .clarify(questions) = played.asked[1].kind {
            #expect(questions.map(\.choices) == [["Round to cents (Recommended)", "Count in whole cents"]])
        } else {
            Issue.record("the tour's second request is not a question")
        }
        // Each request its own: two threads may wait at once.
        #expect(Set(played.asked.map(\.id)).count == 2)

        let tourTurn = try #require(played.tour.transcript.turns.last)
        #expect(tourTurn.outcome == .completed)
        let reply = replyText(played.tour)
        #expect(reply.contains("Welcome to the Portals demo"))
        #expect(reply.contains("Math.round(sum * 100) / 100"))
        let kinds = Markdown.blocks(reply).map(\.kind)
        #expect(kinds.contains(.code(language: "js")))
        #expect(kinds.contains { if case .widget = $0 { true } else { false } })
        #expect(tools(played.tour).contains { $0.label == "rm -rf build" })

        // Codex's thread: its turn before, then the review the tour asked for.
        let review = played.review
        #expect(review.transcript.turns.count == 2)
        #expect(review.transcript.turns.last?.outcome == .completed)
        let opener = review.transcript.turns.last?.items.first
        if case let .user(message)? = opener?.content {
            #expect(message.from?.agentName == "Claude Code")
        } else {
            Issue.record("the review does not open with Claude Code's message")
        }
        #expect(replyText(review).contains("The fix is right"))
    }

    /// Its host keeps what was said, as a real host does: a thread opened is given its
    /// turns, those played since included, which the app takes over its own copy.
    @Test func aDemoThreadOpenedHasItsTurns() async throws {
        let backend = try await connected()
        let threads = FakeBackend.demoThreads(on: host)
        for thread in threads {
            let opened = try await backend.openThread(thread.record.ref)
            #expect(opened.transcript.turns.count == thread.transcript.turns.count)
            #expect(opened.title == thread.record.ref.title)
        }
        let tour = threads[0].record
        _ = try await backend.send(FakeBackend.demoTourPrompt, to: tour.id)
        var asked: PendingRequest?
        for await event in await backend.events(for: tour.id) {
            if case let .requestOpened(request) = event {
                asked = request
                break
            }
        }
        // Opened while it waits: the turn so far, and the request.
        let waiting = try await backend.openThread(tour.ref)
        #expect(waiting.isRunning)
        #expect(waiting.transcript.turns.count == 2)
        #expect(waiting.openRequests.map(\.id) == [asked?.id])
        #expect(waiting.transcript.turns.last?.items.first.flatMap { item in
            if case let .user(message) = item.content { message.text } else { nil }
        } == FakeBackend.demoTourPrompt)
        await backend.disconnect()
        // Nothing of the kind for any other script.
        let greeting = FakeBackend(script: .greeting, pace: .zero)
        try await greeting.connect()
        let agent = try #require(try await greeting.listAgents().first)
        let made = try await greeting.createThread(with: agent.id, options: ThreadOptions())
        _ = try await greeting.send("hi", to: made.id)
        for await event in await greeting.events(for: made.id) {
            if case .turnFinished = event { break }
        }
        #expect(try await greeting.openThread(made).transcript.turns.isEmpty)
    }

    /// A thread let go of here (its follower gone, which ends the stream it followed) and
    /// opened again hears what comes next on a stream of its own.
    @Test(.timeLimit(.minutes(1))) func aThreadOpenedAgainHearsWhatComesNext() async throws {
        let backend = try await connected()
        let notes = try #require(FakeBackend.demoThreads(on: host).first { $0.record.id == FakeBackend.demoNotesID }).record
        _ = try await backend.openThread(notes.ref)
        let first = await backend.events(for: notes.id)
        let follower = Task { for await _ in first {} }
        follower.cancel()
        _ = await follower.value

        let opened = try await backend.openThread(notes.ref)
        #expect(opened.transcript.turns.count == 1)
        _ = try await backend.send("one more", to: notes.id)
        var finished = false
        for await event in await backend.events(for: notes.id) {
            if case .turnFinished(.completed, _) = event {
                finished = true
                break
            }
        }
        #expect(finished)
        #expect(try await backend.openThread(notes.ref).transcript.turns.count == 2)
    }

    /// Opened once its turn has ended, while its script still waits to start the next by
    /// itself: at rest, as the events said, not running for as long as the script lives
    /// (opened then, a turn's end it had missed would never come).
    @Test func aThreadOpenedBetweenTurnsIsAtRest() async throws {
        let backend = FakeBackend(script: .wakeup, pace: .milliseconds(20))
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())
        _ = try await backend.send("run the tests", to: thread.id)
        for await event in await backend.events(for: thread.id) {
            if case .turnFinished = event { break }
        }
        #expect(try await backend.openThread(thread).isRunning == false)
        await backend.disconnect()
    }

    /// Stopped mid-turn: the host's copy ends that turn interrupted and nothing of the
    /// script comes after it, so the next message runs a turn of its own.
    @Test func aStoppedTurnStaysStopped() async throws {
        let backend = FakeBackend(script: .demo, host: host, pace: .milliseconds(1))
        try await backend.connect()
        let claude = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: claude.id, options: ThreadOptions())
        _ = try await backend.send("hello", to: thread.id)
        var afterTheEnd: [ThreadEvent] = []
        var ended = false
        for await event in await backend.events(for: thread.id) {
            if ended { afterTheEnd.append(event) }
            if case .textDelta = event, !ended {
                #expect(try await backend.interrupt(thread.id))
            }
            if case .turnFinished(.interrupted, _) = event {
                ended = true
                // Anything the script had left would come within a few of its paces.
                try await Task.sleep(for: .milliseconds(50))
                break
            }
        }
        #expect(ended)
        #expect(afterTheEnd.isEmpty)
        let kept = try await backend.openThread(ThreadRef(id: thread.id, agent: claude.id))
        #expect(!kept.isRunning)
        #expect(kept.transcript.turns.last?.outcome == .interrupted)
    }

    /// Bug hunt round 4, KIT1: Stop in another demo thread answered the tour's waiting card
    /// as cancelled, so the tour said the command was denied and the card's Allow then
    /// failed. A Stop ends only its own thread's waiting cards.
    @Test(.timeLimit(.minutes(1))) func interruptElsewhereLeavesTheToursCardWaiting() async throws {
        // Paced, so the other thread is still running when it is stopped.
        let backend = FakeBackend(script: .demo, host: host, pace: .milliseconds(2))
        try await backend.connect()
        let tour = try #require(FakeBackend.demoThreads(on: host).first { $0.record.id == FakeBackend.demoTourID }).record
        _ = try await backend.openThread(tour.ref)
        var tourEvents = await backend.events(for: tour.id).makeAsyncIterator()
        _ = try await backend.send(FakeBackend.demoTourPrompt, to: tour.id)
        var approval: PendingRequest?
        while let event = await tourEvents.next() {
            if case let .requestOpened(request) = event {
                approval = request
                break
            }
        }
        let asked = try #require(approval)

        let claude = try #require(try await backend.listAgents().first)
        let other = try await backend.createThread(with: claude.id, options: ThreadOptions())
        _ = try await backend.send("hi", to: other.id)
        for await event in await backend.events(for: other.id) {
            if case .textDelta = event {
                #expect(try await backend.interrupt(other.id))
            }
            if case .turnFinished(.interrupted, _) = event { break }
        }
        // What the tour would have played on a cancelled card comes within a few paces.
        try await Task.sleep(for: .milliseconds(100))

        try await backend.respond(to: asked.id, in: tour.id, with: .approval(.once))
        var ran: ToolResult?
        while let event = await tourEvents.next() {
            if case let .toolFinished(result) = event, result.id == "demo-t3" {
                ran = result
                break
            }
        }
        #expect(ran?.succeeded == true)
        await backend.disconnect()
    }

    @Test func aDeniedCommandIsLeftAloneAndTheOtherFixIsMade() async throws {
        let played = try await playTour { request in
            switch request.kind {
            case .approval: .approval(.deny)
            case .clarify: .clarify(["fix": "Count in whole cents"])
            default: .cancelled
            }
        }
        let reply = replyText(played.tour)
        #expect(reply.contains("I left the build folder alone"))
        #expect(reply.contains("priceInCents"))
        #expect(!reply.contains("Math.round"))
    }

    @Test func anythingElseIsAnsweredAsTheDemoByItsAgent() async throws {
        let backend = try await connected()
        let codex = try #require(try await backend.listAgents().first { $0.id.name == "codex" })
        let thread = try await backend.createThread(with: codex.id, options: ThreadOptions(workingDirectory: FakeBackend.demoProject))
        #expect(thread.workingDirectory == FakeBackend.demoProject)

        var state = ThreadState()
        var finished = 0
        for message in ["fix the login page", "and the signup page"] {
            let sent = state.messageSent(message)
            state.messageDelivered(sent, outcome: try await backend.send(message, to: thread.id))
            for await event in await backend.events(for: thread.id) {
                state.apply(event)
                if case .turnFinished = event { break }
            }
            finished += 1
        }
        #expect(finished == 2)
        let reply = replyText(state)
        #expect(reply.contains("\u{201C}fix the login page\u{201D}"))
        #expect(reply.contains("This is the demo"))
        #expect(reply.contains("Codex on your Mac"))
        // Titled once, from its first message.
        #expect(state.title == "Demo: Fix the login page")
    }

    @Test func aDemoThreadsTitleIsItsFirstWords() {
        #expect(FakeBackend.demoTitle(for: "what can you do") == "Demo: What can you do")
        #expect(FakeBackend.demoTitle(for: "") == "Demo: a new thread")
        #expect(FakeBackend.demoTitle(for: "one two three four five six seven eight") == "Demo: One two three four five six")
        let long = FakeBackend.demoTitle(for: "Supercalifragilisticexpialidocious antidisestablishmentarianism words")
        #expect(long.count <= 6 + 48 && long.hasSuffix("…"))
    }
}
