import Testing
@testable import AgentCore

@Suite struct TranscriptBlocksTests {
    @Test func turnsAreSplitIntoBlocksFromTheFirst() {
        let blocks = TranscriptBlocks.ranges(count: 45, size: 20)
        #expect(blocks.map(\.index) == [0, 1, 2])
        #expect(blocks.map(\.turns) == [0..<20, 20..<40, 40..<45])
    }

    @Test func aTurnAddedAtTheEndChangesTheLastBlockAlone() {
        let before = TranscriptBlocks.ranges(count: 39, size: 20)
        let after = TranscriptBlocks.ranges(count: 40, size: 20)
        #expect(before.map(\.turns) == [0..<20, 20..<39])
        #expect(after.map(\.turns) == [0..<20, 20..<40])
        let next = TranscriptBlocks.ranges(count: 41, size: 20)
        #expect(next.map(\.index) == [0, 1, 2])
        #expect(next.map(\.turns) == [0..<20, 20..<40, 40..<41])
    }

    @Test func turnsPutBeforeOrTakenOffTheFrontKeepTheirBlocks() {
        // 30 turns, the last of 60 that were held: the first 30 were taken off the front.
        let trimmed = TranscriptBlocks.ranges(count: 30, origin: 30, size: 20)
        #expect(trimmed.map(\.index) == [1, 2])
        #expect(trimmed.map(\.turns) == [0..<10, 10..<30])
        // 30 earlier turns put before them: the turns held before stay in blocks 1 and 2.
        let paged = TranscriptBlocks.ranges(count: 60, origin: 0, size: 20)
        #expect(paged.map(\.index) == [0, 1, 2])
        #expect(paged.map(\.turns) == [0..<20, 20..<40, 40..<60])
        // And below 0, as more pages come before.
        let further = TranscriptBlocks.ranges(count: 90, origin: -30, size: 20)
        #expect(further.map(\.index) == [-2, -1, 0, 1, 2])
        #expect(further.map(\.turns) == [0..<10, 10..<30, 30..<50, 50..<70, 70..<90])
    }

    @Test func noTurnsNoBlocks() {
        #expect(TranscriptBlocks.ranges(count: 0).isEmpty)
        #expect(TranscriptBlocks.ranges(count: 1).map(\.turns) == [0..<1])
    }
}
