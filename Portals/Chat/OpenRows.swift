import Observation
import SwiftUI

/// Which of a chat's folds and rows are open: a turn's steps, a tool call's details, the
/// reasoning, a command's whole answer, a failed visual's source, a running turn's to-dos. The chat keeps this, not the rows themselves: the
/// transcript builds a turn only while it is near the screen and lets go of one far
/// away, and with it whatever its rows held. A step opened, scrolled far past and come
/// back to was closed again.
@MainActor @Observable
final class OpenRows {
    enum Row: Hashable {
        /// A turn's folded steps, by the fold's id.
        case steps(UUID)
        /// A tool call's details, or the reasoning, by the item's id.
        case item(UUID)
        /// The whole of a command's answer, by the item's id.
        case answer(UUID)
        /// A visual given up on, shown as its source: by its turn, the piece of the
        /// turn's text it is in and its block there (`WidgetKey` without the source, which
        /// a visual given up on no longer changes).
        case visualSource(turn: UUID, segment: Int, block: Int)
        /// The running turn's to-do list under its status line (`TodoPlanSection`), by the turn.
        case plan(UUID)
    }

    private var chosen: [Row: Bool] = [:]

    var hasChoices: Bool { !chosen.isEmpty }

    /// The ids of the items whose rows were opened or closed here: every row is one of a
    /// turn's items, or a fold named for the first item in it, or a visual's source, which
    /// is named for its turn and gives the turn's own id.
    var chosenItems: Set<UUID> {
        Set(chosen.keys.map { row in
            switch row {
            case let .steps(id), let .item(id), let .answer(id), let .plan(id): id
            case let .visualSource(turn, _, _): turn
            }
        })
    }

    func isOpen(_ row: Row) -> Bool? { chosen[row] }

    func set(_ row: Row, open: Bool) { chosen[row] = open }
}

extension EnvironmentValues {
    /// The chat's `OpenRows`; nil outside a chat, where a row keeps its own.
    @Entry var openRows: OpenRows? = nil
}

/// Whether a row is open: kept in the chat's `OpenRows` when the row is in a chat, in the
/// row itself otherwise.
@MainActor @propertyWrapper
struct RowOpen: DynamicProperty {
    let row: OpenRows.Row?
    @Environment(\.openRows) private var rows
    @State private var here: Bool

    init(_ row: OpenRows.Row?, initially open: Bool = DebugLaunch.expandsWork) {
        self.row = row
        _here = State(initialValue: open)
    }

    var wrappedValue: Bool {
        get {
            guard let row, let rows else { return here }
            return rows.isOpen(row) ?? here
        }
        nonmutating set {
            guard let row, let rows else {
                here = newValue
                return
            }
            rows.set(row, open: newValue)
        }
    }
}
