import SwiftUI

/// Uses the app's real schedule, with an injected clock instead of a wall-clock wait.
@main
struct NativeElapsedTests {
    static func main() {
        let began = Date(timeIntervalSince1970: 1_000)
        let modes: [TimelineScheduleMode] = [.normal, .lowFrequency]
        for mode in modes {
            let active = ElapsedSchedule(paused: false, now: { began }).entries(from: began, mode: mode)
            for second in 0..<100 {
                precondition(active.next() == began.addingTimeInterval(Double(second)), "active cadence")
            }

            let paused = ElapsedSchedule(paused: true, now: { began }).entries(from: began, mode: mode)
            precondition(paused.next() == began, "paused views need one current value")
            for _ in 0..<100 {
                precondition(paused.next() == nil, "paused schedule must stop")
            }

            // SwiftUI hands a resumed schedule the stale date it paused at (measured
            // 16.8s old on the simulator). The first date must be now, not a burst of
            // every skipped second.
            let stale = ElapsedSchedule(paused: false, now: { began }).entries(
                from: began.addingTimeInterval(-90), mode: mode)
            precondition(stale.next() == began, "resume must start now, not catch up")
            precondition(stale.next() == began.addingTimeInterval(1), "then one a second")

            // A pending future tick when the pause begins is kept, then nothing.
            let future = ElapsedSchedule(paused: true, now: { began }).entries(
                from: began.addingTimeInterval(5), mode: mode)
            precondition(future.next() == began.addingTimeInterval(5), "keep the pending tick")
            precondition(future.next() == nil, "and stop after it")

            // Retained views can leave and return many times. Each new iterator
            // starts now, not at the task's beginning or its last visible tick.
            for cycle in 1...20 {
                let now = began.addingTimeInterval(Double(cycle * 37) + 0.375)
                let stopped = ElapsedSchedule(paused: true, now: { now }).entries(from: now, mode: mode)
                precondition(stopped.next() == now)
                precondition(stopped.next() == nil)
                let resumed = ElapsedSchedule(paused: false, now: { now }).entries(
                    from: now.addingTimeInterval(-17), mode: mode)
                precondition(resumed.next() == now, "resume must not wait for an old periodic boundary")
                precondition(resumed.next() == now.addingTimeInterval(1))
                precondition(stopped.next() == nil, "an exhausted paused iterator must stay exhausted")
            }
        }
        print("PASS: elapsed cadence, finite pause, fresh resume and 20 retained-view cycles in both modes")
    }
}
