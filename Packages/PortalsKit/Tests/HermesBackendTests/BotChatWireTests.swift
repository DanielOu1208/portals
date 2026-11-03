import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A Hermes profile's one ongoing conversation on a bridge (features `bot_chat`,
/// `history_pages`): made by a first message like any thread and known as such, opened
/// with its last turns, the ones before them asked for page by page.
@Suite struct BotChatWireTests {
    private static let features = ["resume_replay", "bot_chat", "history_pages", "thread_sync"]
    private static let host = HostID(rawValue: "mac")
    private static let bot = ThreadRef(id: ThreadRef.ID(rawValue: "bot"), agent: Agent.ID(host: host, name: "hermes"), ongoing: true)

    private func connect(features: [String] = Self.features) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: Self.host,
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1", features: features)
        try await connecting.value
        return (backend, transport)
    }

    /// The next request for `method`, what else is asked meanwhile (who is at work in the
    /// thread) answered with nothing.
    private func next(_ method: String, on transport: ScriptedTransport, sourceLocation: SourceLocation = #_sourceLocation) async throws -> JSONValue {
        while true {
            let request = try #require(await transport.nextSentRequest(), sourceLocation: sourceLocation)
            if request["method"]?.stringValue == method { return request }
            try transport.answer(request, [:])
        }
    }

    /// Turns `range`, a question and its answer each, as the bridge stores them.
    private static func turns(_ range: ClosedRange<Int>) -> JSONValue {
        .array(range.flatMap { turn -> [JSONValue] in
            [["role": "user", "text": .string("Question \(turn)")], ["role": "assistant", "text": .string("Answer \(turn)")]]
        })
    }

    private static func firstQuestion(of transcript: Transcript) -> String? {
        transcript.turns.first?.items.lazy.compactMap { item -> String? in
            if case let .user(message) = item.content { message.text } else { nil }
        }.first
    }

    @Test func aThreadMadeForABotIsItsOngoingConversation() async throws {
        let (backend, transport) = try await connect()
        let creating = Task { try await backend.createThread(with: Self.bot.agent, options: ThreadOptions()) }
        let create = try await next("session.create", on: transport)
        try transport.answer(create, ["session_id": "bot", "stored_session_id": "bot", "info": ["title": "Hermes"], "ongoing": true])
        let made = try await creating.value
        #expect(made.id == Self.bot.id)
        #expect(made.isOngoing)
    }

    @Test func anOngoingConversationOpensWithItsLastTurnsAndTakesTheOnesBeforePageByPage() async throws {
        let (backend, transport) = try await connect()

        let opening = Task { try await backend.openThread(Self.bot) }
        let resume = try await next("session.resume", on: transport)
        #expect(resume["params"]?["limit"] == 30)
        try transport.answer(resume, [
            "session_id": "bot", "running": false, "messages": Self.turns(41...70), "latest_seq": 0, "replay_base": 0,
            "history_start": 80, "has_earlier": true,
        ])
        let snapshot = try await opening.value
        #expect(snapshot.hasEarlier == true)
        #expect(snapshot.transcript.turns.count == 30)

        // The page before the first turn it holds.
        let asking = Task { try await backend.earlierTurns(of: Self.bot.id) }
        let history = try await next("session.history", on: transport)
        #expect(history["params"] == [
            "session_id": "bot", "profile": "hermes", "before": 80, "limit": 30, "replay_epoch": "e1", "replay_base": 0,
        ])
        try transport.answer(history, ["messages": Self.turns(11...40), "start": 20, "has_earlier": true])
        let earlier = try #require(try await asking.value)
        #expect(earlier.hasEarlier)
        #expect(earlier.transcript.turns.count == 30)
        #expect(Self.firstQuestion(of: earlier.transcript) == "Question 11")

        // And the last of them.
        let last = Task { try await backend.earlierTurns(of: Self.bot.id) }
        let more = try await next("session.history", on: transport)
        #expect(more["params"]?["before"] == 20)
        try transport.answer(more, ["messages": Self.turns(1...10), "start": 0, "has_earlier": false])
        #expect(try await last.value?.hasEarlier == false)
        // Nothing is before the first turn.
        #expect(try await backend.earlierTurns(of: Self.bot.id) == EarlierTurns(transcript: Transcript(), hasEarlier: false))

        // Opened again, it asks for as many turns as it holds, and a page more.
        let reopening = Task { try await backend.openThread(Self.bot) }
        let again = try await next("session.resume", on: transport)
        #expect(again["params"]?["limit"] == 100)
        try transport.answer(again, [
            "session_id": "bot", "running": false, "messages": Self.turns(1...70), "latest_seq": 0, "replay_base": 0,
            "history_start": 0, "has_earlier": false,
        ])
        #expect(try await reopening.value.hasEarlier == false)
    }

    @Test func aConversationThatMovedUnderThePagesIsOpenedAgain() async throws {
        let (backend, transport) = try await connect()
        let opening = Task { try await backend.openThread(Self.bot) }
        try transport.answer(try await next("session.resume", on: transport), [
            "session_id": "bot", "running": false, "messages": Self.turns(41...70), "latest_seq": 0, "replay_base": 0,
            "history_start": 80, "has_earlier": true,
        ])
        _ = try await opening.value
        let asking = Task { try await backend.earlierTurns(of: Self.bot.id) }
        try transport.answer(try await next("session.history", on: transport), ["moved": true])
        #expect(try await asking.value == nil)
    }

    @Test(arguments: [false, true])
    func takingAFailureBackResyncsPagedHistoryIncludingAnAlreadyReturnedPage(returned: Bool) async throws {
        let (backend, transport) = try await connect(features: Self.features + ["message_reconciliation", "session_resync"])
        let opening = Task { try await backend.openThread(Self.bot) }
        try transport.answer(try await next("session.resume", on: transport), [
            "session_id": "bot", "running": true, "messages": Self.turns(41...70), "latest_seq": 0, "replay_base": 0,
            "history_start": 80, "has_earlier": true,
        ])
        var state = ThreadState()
        state.adopt(try await opening.value)
        let first = state.transcript.turns.first?.id
        var events = await backend.events(for: Self.bot.id).makeAsyncIterator()
        let asking = Task { try await backend.earlierTurns(of: Self.bot.id) }
        let history = try await next("session.history", on: transport)
        var page = try #require(Self.turns(11...40).arrayValue)
        page[19] = [
            "role": "assistant", "text": "No receipt.", "display_kind": "failed_turn",
            "display_metadata": ["failed_request_id": "taken"],
        ]
        let answer: JSONValue = ["messages": .array(page), "start": 20, "has_earlier": true]
        var held: EarlierTurns?
        if returned {
            try transport.answer(history, answer)
            held = try await asking.value
            #expect(held?.transcript.turns.contains { $0.failedRequestID == "taken" } == true)
        }
        // The UI may be holding this returned page behind its drag gate (`await ready()`).
        let replying = Task {
            let resume = try await next("session.resume", on: transport)
            #expect(resume["params"]?["limit"] == nil)
            let canonical = try #require(Self.turns(1...70).arrayValue).enumerated()
                .filter { ![38, 39].contains($0.offset) }.map(\.element)
            try transport.answer(resume, [
                "session_id": "bot", "running": true, "messages": .array(canonical), "latest_seq": 3, "replay_base": 1,
            ])
        }
        defer { replying.cancel() }
        transport.event("message.taken", seq: 2, session: "bot", [
            "request_id": "taken", "replay_base": 1, "removed_start": 38, "removed_count": 2,
        ])
        guard case let .snapshot(snapshot) = await events.nextLeavingOutRoster() else {
            Issue.record("A paged reconciliation must take the full authoritative snapshot.")
            return
        }
        #expect(snapshot.authoritative)
        state.adopt(snapshot)
        if let held {
            // ThreadController's existing guard after ready() rejects this stale page.
            #expect(state.transcript.turns.first?.id != first)
            if state.transcript.turns.first?.id == first { state.takeEarlier(held) }
        } else {
            try transport.answer(history, answer)
            await #expect(throws: CancellationError.self) { _ = try await asking.value }
        }
        #expect(!state.transcript.turns.contains { $0.failedRequestID == "taken" })
        #expect(Self.firstQuestion(of: state.transcript) == "Question 1")
        try await replying.value
    }

    /// A plain repair (a message to the bot from elsewhere) keeps the thread paged: it is
    /// resumed with the turns it holds and a page more, not the whole conversation, which
    /// only a failure taken back asks for.
    @Test func aPlainRepairOfAnOngoingConversationKeepsItPaged() async throws {
        let (backend, transport) = try await connect(features: Self.features + ["message_reconciliation", "session_resync"])
        let opening = Task { try await backend.openThread(Self.bot) }
        try transport.answer(try await next("session.resume", on: transport), [
            "session_id": "bot", "running": false, "messages": Self.turns(41...70), "latest_seq": 0, "replay_base": 0,
            "history_start": 80, "has_earlier": true,
        ])
        _ = try await opening.value
        var events = await backend.events(for: Self.bot.id).makeAsyncIterator()
        let replying = Task {
            let resume = try await next("session.resume", on: transport)
            #expect(resume["params"]?["limit"] == 60)
            try transport.answer(resume, [
                "session_id": "bot", "running": false, "messages": Self.turns(42...71), "latest_seq": 1, "replay_base": 1,
                "history_start": 82, "has_earlier": true,
            ])
        }
        defer { replying.cancel() }
        transport.event("session.invalidated", seq: 1, session: "bot", ["replay_base": 1])
        guard case let .snapshot(snapshot) = await events.nextLeavingOutRoster() else {
            Issue.record("A repair takes a snapshot.")
            return
        }
        #expect(snapshot.hasEarlier == true)
        try await replying.value
    }

    @Test func anyOtherThreadIsOpenedWhole() async throws {
        let (backend, transport) = try await connect()
        let other = ThreadRef(id: ThreadRef.ID(rawValue: "t1"), agent: Self.bot.agent)
        let opening = Task { try await backend.openThread(other) }
        let resume = try await next("session.resume", on: transport)
        #expect(resume["params"]?["limit"] == nil)
        try transport.answer(resume, ["session_id": "t1", "running": false, "messages": Self.turns(1...3), "latest_seq": 0, "replay_base": 0])
        #expect(try await opening.value.hasEarlier == nil)
        #expect(try await backend.earlierTurns(of: other.id) == nil)
    }

    @Test func theListSaysWhichThreadIsOngoingOnlyFromABridgeWithBotChats() throws {
        let row: JSONValue = ["id": "bot", "agent": "hermes", "updated": 1_791_323_000, "revision": 3, "ongoing": true]
        #expect(BridgeWire.listedThread(from: row, readsOngoing: true)?.ongoing == true)
        #expect(BridgeWire.listedThread(from: row)?.ongoing == false)
    }

    @Test func aPageOfTheLastTurnsTakesThePlaceOfWhatTheThreadHeldBeforeThem() throws {
        var state = ThreadState(transcript: HermesHistoryMapper.transcript(from: Self.turns(1...70).arrayValue ?? []))
        let answer: JSONValue = [
            "session_id": "bot", "running": false, "messages": Self.turns(61...90), "history_start": 120, "has_earlier": true,
        ]
        let resumed = try answer.decode(HermesWire.SessionResumeResult.self)
        state.adopt(HermesHistoryMapper.snapshot(from: resumed))
        #expect(state.transcript.turns.count == 30)
        #expect(Self.firstQuestion(of: state.transcript) == "Question 61")
        #expect(state.hasEarlierHistory)
        // The turns kept stand where they stood (`TranscriptBlocks`): Question 61 was the 61st.
        #expect(state.turnOrigin == 60)

        state.takeEarlier(EarlierTurns(transcript: HermesHistoryMapper.transcript(from: Self.turns(31...60).arrayValue ?? []), hasEarlier: false))
        #expect(state.transcript.turns.count == 60)
        #expect(Self.firstQuestion(of: state.transcript) == "Question 31")
        #expect(!state.hasEarlierHistory)
        #expect(state.turnOrigin == 30)
    }
}
