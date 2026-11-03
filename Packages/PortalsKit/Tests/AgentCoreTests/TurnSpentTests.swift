import Foundation
import Testing
@testable import AgentCore

/// The quiet line under an ended turn, and what it spent kept with the turn.
@Suite struct TurnSpentTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func ended(_ outcome: TurnOutcome = .completed, after seconds: TimeInterval = 102, spent: TurnSpent? = nil) -> Turn {
        Turn(startedAt: t0, endedAt: t0.addingTimeInterval(seconds), outcome: outcome, items: [TurnItem(.user(UserMessage(text: "Go.", sentAt: t0))), TurnItem(.text("Done."))], spent: spent)
    }

    @Test func theFooterSaysTheTimeAndTheTokensAsOneLine() {
        #expect(ended(spent: TurnSpent(seconds: 102.4, tokens: 52_300)).footer == "1m 42s · 52.3k tokens")
        // The host's time wins over the app's own; without one, the turn's start and end.
        #expect(ended(after: 30, spent: TurnSpent(seconds: 12)).footer == "12s")
        #expect(ended(after: 30).footer == "30s")
        #expect(ended(.interrupted, after: 4, spent: TurnSpent(tokens: 950)).footer == "4s · 950 tokens")
        #expect(ended(.failed(TurnFailure(message: "No.")), after: 61, spent: TurnSpent(tokens: 1_234_567)).footer == "1m 1s · 1.2M tokens")
    }

    @Test func liveTokensShowButTheAppsOwnLinesAndInstantFailuresHaveNoFooter() {
        var running = ended(spent: TurnSpent(seconds: 5, tokens: 10))
        running.outcome = nil
        running.endedAt = nil
        #expect(running.footer == "10 tokens so far")
        running.spent = nil
        #expect(running.footer == nil)
        let command = Turn(startedAt: t0, endedAt: t0.addingTimeInterval(3), outcome: .completed, items: [TurnItem(.notice(Notice(.info, "Usage: …")))])
        #expect(command.footer == nil)
        #expect(ended(.failed(TurnFailure(message: "Not sent.")), after: 0.2).footer == nil)
        // An instant that says its tokens still has them.
        #expect(ended(after: 0.2, spent: TurnSpent(tokens: 900)).footer == "0s · 900 tokens")
    }

    @Test func theLatestEndedTurnOfTheHostsListsTheStartedThreads() {
        let first = ended(), second = ended(.interrupted)
        var running = ended()
        running.outcome = nil
        running.endedAt = nil
        let command = Turn(startedAt: t0, endedAt: t0.addingTimeInterval(3), outcome: .completed, items: [TurnItem(.notice(Notice(.info, "Usage: …")))])
        #expect([first, second].turnListingStartedThreads == second.id)
        // Not a turn still running, nor a command's answer: the one before them.
        #expect([first, second, command, running].turnListingStartedThreads == second.id)
        #expect([running].turnListingStartedThreads == nil)
        #expect([Turn]().turnListingStartedThreads == nil)
    }

    @Test func tokensAreSaidAsPeopleSayThem() {
        #expect(TurnSpent.tokens(950) == "950")
        #expect(TurnSpent.tokens(1_000) == "1k")
        #expect(TurnSpent.tokens(52_300) == "52.3k")
        #expect(TurnSpent.tokens(99_960) == "100k")
        #expect(TurnSpent.tokens(523_400) == "523k")
        #expect(TurnSpent.tokens(999_600) == "1M")
        #expect(TurnSpent.tokens(1_250_000) == "1.3M")
    }

    @Test func whatTheHostSaysAfterTheEndGoesWithTheTurnThatEnded() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("Go.", at: t0), outcome: .started, at: t0)
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(5))
        state.apply(.turnSpent(TurnSpent(seconds: 4.8, tokens: 25_215)), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.last?.spent == TurnSpent(seconds: 4.8, tokens: 25_215))
        #expect(state.transcript.turns.last?.footer == "5s · 25.2k tokens")
        // Never for a turn still running.
        state.messageDelivered(state.messageSent("More.", at: t0), outcome: .started, at: t0)
        state.apply(.turnSpent(TurnSpent(seconds: 1)), at: t0)
        #expect(state.transcript.turns.last?.spent == nil)
    }

    @Test func aCommandAnsweredDuringTheTurnDoesNotTakeWhatTheTurnSpent() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("Go.", at: t0), outcome: .started, at: t0)
        state.commandAnswered("/usage", output: "1,200 tokens", at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(5))
        // The local answer is inside the agent's turn; only that turn gets a footer.
        #expect(state.transcript.turns.count == 1)
        state.apply(.turnSpent(TurnSpent(seconds: 4.8, tokens: 25_215)), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns[0].spent == TurnSpent(seconds: 4.8, tokens: 25_215))
        #expect(state.transcript.turns[0].items.contains { if case .command = $0.content { true } else { false } })
    }

    @Test func aCopyKeepsWhatItSpentWhenTheHostNoLongerSays() {
        let mine = Transcript(turns: [ended(spent: TurnSpent(seconds: 9, tokens: 45_728))])
        // The host's history after it restarted: the same turn, without it.
        var theirs = ended()
        theirs.id = UUID()
        #expect(mine.merged(withHost: Transcript(turns: [theirs])).turns.first?.spent == TurnSpent(seconds: 9, tokens: 45_728))
        // A host that says it is taken at its word.
        theirs.spent = TurnSpent(seconds: 9.2, tokens: 45_730)
        #expect(mine.merged(withHost: Transcript(turns: [theirs])).turns.first?.spent == TurnSpent(seconds: 9.2, tokens: 45_730))
    }

    @Test func aTurnSavedBeforeTheFooterStillOpens() throws {
        let saved = try JSONEncoder().encode(ended())
        var object = try #require(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        object["spent"] = nil
        let old = try JSONSerialization.data(withJSONObject: object)
        let turn = try JSONDecoder().decode(Turn.self, from: old)
        #expect(turn.spent == nil)
        #expect(turn.footer == "1m 42s")
    }
}
