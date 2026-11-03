import Foundation

/// How closely Needs you, Running and Finished are set at the top of the sidebar: the
/// room above each group's title and under it, and the height of the threads' rows of
/// two lines in them, with `rowGap` between any two of those (a title and its first row
/// too).
///
/// Tighter than they were, on an iPhone and an iPad (2026-10-17: on the
/// phone they took a lot of the sidebar) and on a Mac too (2026-10-19), each with
/// its own measures. On a touch screen the rows stay at least a finger high (44 points),
/// as anything pressed there; on a Mac, where a pointer picks them, they keep room around
/// their two lines (about 32 points of text).
public struct GroupSpacing: Equatable, Sendable {
    /// Above a group's title: under the search row for the first, under the last row of
    /// the group before it for the others.
    public var titleTop: CGFloat
    /// Under a title, before the first row (and `rowGap`).
    public var titleBottom: CGFloat
    /// A thread's row of two lines: its title, and its agent and folder.
    public var rowHeight: CGFloat
    /// Between one row and the next, and between a title and its first row.
    public var rowGap: CGFloat

    public init(titleTop: CGFloat, titleBottom: CGFloat, rowHeight: CGFloat, rowGap: CGFloat) {
        self.titleTop = titleTop
        self.titleBottom = titleBottom
        self.rowHeight = rowHeight
        self.rowGap = rowGap
    }

    /// The other spacings to compare with in the simulator (`PORTALS_DEBUG_GROUPS`).
    public enum Variant: String, CaseIterable, Sendable {
        /// Tighter than the one chosen.
        case tighter
        /// Between the one chosen and how they were.
        case looser
        /// As they were before 2026-10-19.
        case before
    }

    /// On a Mac: the one chosen, or one to compare it with.
    public static func mac(_ variant: Variant? = nil) -> GroupSpacing {
        switch variant {
        case nil: GroupSpacing(titleTop: 14, titleBottom: 2, rowHeight: 42, rowGap: 2)
        case .tighter: GroupSpacing(titleTop: 10, titleBottom: 0, rowHeight: 38, rowGap: 1)
        case .looser: GroupSpacing(titleTop: 18, titleBottom: 3, rowHeight: 44, rowGap: 2)
        case .before: GroupSpacing(titleTop: 22, titleBottom: 4, rowHeight: 46, rowGap: 2)
        }
    }

    /// On an iPhone and an iPad: the one chosen, or one to compare it with.
    public static func touch(_ variant: Variant? = nil) -> GroupSpacing {
        switch variant {
        case nil: GroupSpacing(titleTop: 16, titleBottom: 2, rowHeight: 46, rowGap: 2)
        case .tighter: GroupSpacing(titleTop: 12, titleBottom: 0, rowHeight: 44, rowGap: 1)
        case .looser: GroupSpacing(titleTop: 20, titleBottom: 3, rowHeight: 48, rowGap: 2)
        case .before: GroupSpacing(titleTop: 26, titleBottom: 4, rowHeight: 50, rowGap: 2)
        }
    }

    /// How tall groups with `titles` titles and `rows` rows are, a title being `title`
    /// high with the room above and under it, and a row `row` high (never less than
    /// `rowHeight`): every title is as tall as the others and every row too, so the
    /// whole is known from one of each, and not from a lazy stack, whose height depends
    /// on which rows it has built.
    public func height(titles: Int, rows: Int, title: CGFloat, row: CGFloat) -> CGFloat {
        let items = titles + rows
        guard items > 0 else { return 0 }
        return CGFloat(titles) * title + CGFloat(rows) * max(row, rowHeight) + CGFloat(items - 1) * rowGap
    }
}
