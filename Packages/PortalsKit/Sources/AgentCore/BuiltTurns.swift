import Foundation

/// Which rows of a chat its lazy stack has built (its turns, and the messages waiting
/// under them), to tell a chat the stack left blank (docs/blank-open.md).
///
/// A long thread could open blank until scrolled by hand: the chat at the end of the
/// stack's guess at its height, which its rows do not reach, where the stack built none
/// of them, and moving to the end marker after the stack landed in the same place. A move
/// to a turn makes the stack build it. The chat (`ChatScreen`) notes here each row the
/// stack builds and lets go of, and whether the stack itself reaches into the screen, and
/// asks which move to make: at most two each time it goes blank, so moves that build
/// nothing are not made again and again.
///
/// Built rather than in view: a stack on screen that works builds the rows there, and a
/// turn many screens tall (a long reply streaming) is built while a fraction of it in
/// view, or a frame that never changes, says nothing.
public struct BuiltTurns: Sendable {
    /// How many times each row is built: the stack can build a row again before it lets
    /// go of the one it had.
    private var built: [UUID: Int] = [:]
    /// Whether the stack reaches into the screen (its end below the top of the view).
    /// Under it, a subagents line opened taller than the screen fills the view with no row
    /// in it, which is not blank. On until the chat says otherwise: the stack is most of a
    /// chat.
    public var stackInView = true
    /// Moves made for this blank.
    private var moves = 0
    /// The moves made for one blank at most: to the last turn, then to the one before it.
    /// A move to the last turn where the stack's guess already put the chat does not move
    /// it, and builds nothing (seen on 2026-10-19).
    public static let movesPerBlank = 2

    public init() {}

    public var isEmpty: Bool { built.isEmpty }

    /// The stack built this row.
    public mutating func built(_ id: UUID) {
        built[id, default: 0] += 1
        moves = 0
    }

    /// The stack let go of this row.
    public mutating func letGo(_ id: UUID) {
        guard let count = built[id] else { return }
        built[id] = count > 1 ? count - 1 : nil
    }

    /// Turns to show, the stack on screen, and none of its rows built.
    public func isBlank(hasTurns: Bool) -> Bool {
        hasTurns && stackInView && built.isEmpty
    }

    /// Which move to make now for a blank chat, 1 for the first: nil when it is not blank,
    /// or once `movesPerBlank` have been made with no row built since.
    public mutating func nextMove(hasTurns: Bool) -> Int? {
        guard isBlank(hasTurns: hasTurns), moves < Self.movesPerBlank else { return nil }
        moves += 1
        return moves
    }
}
