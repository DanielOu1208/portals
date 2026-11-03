import Foundation

/// Where a sidebar drag lands among row middles, with a small hold at the boundary
/// between adjacent slots so the line does not flicker under a resting pointer.
/// Unmeasured rows keep their logical places: the end of the measured rows need not
/// be the end of the list.
public enum SidebarLanding {
    public static func slot(at y: CGFloat, middles: [CGFloat?], previous: Int?, hold: CGFloat) -> Int {
        let measured = middles.enumerated().compactMap { index, middle in middle.map { (index: index, middle: $0) } }
        let slot = measured.first { y < $0.middle }?.index ?? measured.last.map { $0.index + 1 } ?? 0
        guard let previous, previous >= 0, previous <= middles.count, abs(previous - slot) == 1,
              let middle = middles[min(previous, slot)] else { return slot }
        let isPast = slot > previous ? y >= middle + hold : y <= middle - hold
        return isPast ? slot : previous
    }
}
