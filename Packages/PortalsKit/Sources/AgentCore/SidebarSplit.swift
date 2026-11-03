import Foundation

/// How the sidebar's two scrolling lists share their room: Needs you, Running and Recent on
/// top, a Mac's space below, the divider between them dragged up or down (2026-11-02: "can u make the sidebar split resizeable? like between running and folders
/// that split").
///
/// Never dragged, or set back, the top hugs its rows up to half the room, and a short list
/// gives what it does not use to the space below. Once dragged, the divider stays where it
/// was put, whether or not the rows fill it (2026-11-02: "for short lists its ok if
/// theres empty space under running"): a short list has space under it, and more rows than
/// fit scroll. With no rows at all the top goes, and comes back at the height it was set to.
///
/// What is kept is a share of the room, nil while it is not set, so that a resized window
/// or a turned iPad keeps the proportion. The minimums are in points, applied as the share
/// is used, so that nothing can be dragged out of reach; on a short window the space below
/// keeps its minimum before the top does.
public struct SidebarSplit: Equatable, Sendable {
    /// Where the share is kept, on each device: no value is not set.
    public static let settingKey = "sidebar.groupsShare"
    /// How much of the room a top that is not set may take, hugging its rows.
    public static let huggingShare: CGFloat = 0.5

    /// What the two lists share: the sidebar's height without the search, the footer, the
    /// Macs' tabs and the divider.
    public var room: CGFloat
    /// The least the top is dragged to: about a title and a row.
    public var topMinimum: CGFloat
    /// The least left below: about three rows.
    public var bottomMinimum: CGFloat

    public init(room: CGFloat, topMinimum: CGFloat, bottomMinimum: CGFloat) {
        self.room = room
        self.topMinimum = topMinimum
        self.bottomMinimum = bottomMinimum
    }

    /// `height` as far as the minimums let it go.
    public func clamped(_ height: CGFloat) -> CGFloat {
        min(max(height, topMinimum), max(0, room - bottomMinimum))
    }

    /// How tall the top is at rest: `rows` is what its rows and drafts need, nil with none.
    /// A share that is not a number is taken for one not set, and any other that is out of
    /// range for the nearest there is.
    public func height(share: Double?, rows: CGFloat?) -> CGFloat {
        guard let rows else { return 0 }
        guard let share, !share.isNaN else { return min(rows, room * Self.huggingShare) }
        return clamped(room * min(max(CGFloat(share), 0), 1))
    }

    /// The share to keep for a top `height` high; nil with no room to be a share of.
    public func share(of height: CGFloat) -> Double? {
        guard room > 0 else { return nil }
        return Double(clamped(height) / room)
    }
}
