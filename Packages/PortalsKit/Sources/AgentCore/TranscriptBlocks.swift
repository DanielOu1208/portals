import Foundation

/// The transcript's turns in blocks of `size`, counted from the first turn: the chat
/// compares a block as a whole, so that a streamed word, which changes the last turn
/// only, does not have every turn of a long thread built and compared again
/// (`TranscriptBlock`, TranscriptTurn.swift). A turn added at the end changes the last
/// block alone; every earlier block keeps its turns, and its place (`index`).
///
/// Turns put before the first or taken off the front (an ongoing conversation's earlier
/// pages, or a page of its last turns that leaves the first ones out) keep their blocks
/// too, counted from `origin`, where the first turn stands (`ThreadState.turnOrigin`).
/// Counted from the first turn, every turn moved to another block, and every row of the
/// chat was made again as a page came in (scroll check, 2026-10-28).
public enum TranscriptBlocks {
    public static let size = 20

    /// The blocks of a transcript of `count` turns whose first stands at `origin`, each by
    /// its index and its turns.
    public static func ranges(count: Int, origin: Int = 0, size: Int = TranscriptBlocks.size) -> [(index: Int, turns: Range<Int>)] {
        guard count > 0, size > 0 else { return [] }
        var blocks: [(index: Int, turns: Range<Int>)] = []
        var start = 0
        while start < count {
            let place = origin + start
            let index = place >= 0 ? place / size : -((-place - 1) / size) - 1
            let end = min(count, (index + 1) * size - origin)
            blocks.append((index, start..<end))
            start = end
        }
        return blocks
    }
}
