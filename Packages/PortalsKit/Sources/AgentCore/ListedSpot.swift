import Foundation

/// A row's own note of where it is in its list and whether the list shows it, for a list
/// that keeps the places of the rows it shows (the Mac sidebar's thread rows, `RowHover`):
/// what the row tells the list, and when.
///
/// A lazy list lets a row go as it scrolls out of sight, and the row's place is forgotten
/// then. It may keep the row's view meanwhile, and show it again later where it was: a
/// place measured in the list's own space, which scrolling does not change, is then the
/// same as before, so nothing measures it anew, and the row would be drawn with no place
/// in the list, where a click opens nothing (2026-10-30: "some threads won't open
/// when clicking in the bottom half"). The row keeps its last place here, and gives it
/// back as it is shown again. A place measured while the row is out of sight is kept for
/// then, and not given: the list has let the row go, and would otherwise keep that place
/// with nothing drawn there.
public struct ListedSpot<Place: Equatable> {
    /// Where the row was last laid out, if it was.
    public private(set) var place: Place?
    /// Whether the list shows the row: between its appearing and its being let go.
    public private(set) var isShown = false

    public init() {}

    /// The row was laid out at `place`: the place to note in the list, if it shows the row.
    public mutating func laidOut(at place: Place) -> Place? {
        self.place = place
        return isShown ? place : nil
    }

    /// The list shows the row, for the first time or again: the place to note, if the row
    /// was laid out yet.
    public mutating func appeared() -> Place? {
        isShown = true
        return place
    }

    /// The list let the row go: its place is to be forgotten there, and kept here.
    public mutating func disappeared() {
        isShown = false
    }
}
