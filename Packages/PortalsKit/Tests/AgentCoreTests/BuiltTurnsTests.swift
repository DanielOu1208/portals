import Foundation
import Testing
@testable import AgentCore

@Suite struct BuiltTurnsTests {
    private let first = UUID()
    private let last = UUID()

    /// The stack on screen with none of its rows built: the chat a thread opened blank.
    @Test func blankWithTheStackOnScreenAndNothingBuilt() {
        let turns = BuiltTurns()
        #expect(turns.isBlank(hasTurns: true))
        // A new thread has no turn to show.
        #expect(!turns.isBlank(hasTurns: false))
    }

    /// Scrolled past the turns (a subagents line opened taller than the screen): nothing
    /// of the stack is on screen, and no row is missing there.
    @Test func notBlankWithTheStackOffScreen() {
        var turns = BuiltTurns()
        turns.stackInView = false
        #expect(!turns.isBlank(hasTurns: true))
    }

    @Test func notBlankUntilTheLastRowBuiltIsLetGo() {
        var turns = BuiltTurns()
        turns.built(first)
        turns.built(last)
        turns.letGo(first)
        #expect(!turns.isBlank(hasTurns: true))
        turns.letGo(last)
        #expect(turns.isBlank(hasTurns: true))
    }

    /// Built again before the stack let go of the one it had: still built once that one
    /// goes.
    @Test func aRowBuiltAgainBeforeTheOldOneGoesStaysBuilt() {
        var turns = BuiltTurns()
        turns.built(last)
        turns.built(last)
        turns.letGo(last)
        #expect(!turns.isBlank(hasTurns: true))
        turns.letGo(last)
        turns.letGo(last)
        #expect(turns.isBlank(hasTurns: true))
    }

    /// Two moves at most each time it goes blank (to the last turn, then to the one before
    /// it): moves that build nothing are not made again and again, and once a row is built
    /// the next blank starts over.
    @Test func twoMovesAtMostPerBlank() {
        var turns = BuiltTurns()
        var asked: [Int?] = []
        for _ in 0..<3 { asked.append(turns.nextMove(hasTurns: true)) }
        turns.built(last)
        asked.append(turns.nextMove(hasTurns: true))
        turns.letGo(last)
        asked.append(turns.nextMove(hasTurns: true))
        #expect(asked == [1, 2, nil, nil, 1])
    }
}
