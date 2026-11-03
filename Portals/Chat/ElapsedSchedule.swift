import SwiftUI

/// A second at a time while visible; one current value, then no dates, while paused.
/// Never a date in the past: SwiftUI hands a resumed schedule the date it paused at,
/// and firing every skipped second at once would be the catch-up burst this avoids.
struct ElapsedSchedule: TimelineSchedule {
    var paused: Bool
    var now: @Sendable () -> Date = { Date() }

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next: Date? = max(startDate, now())
        return AnyIterator { [paused] in
            guard let date = next else { return nil }
            next = paused ? nil : date.addingTimeInterval(1)
            return date
        }
    }
}
