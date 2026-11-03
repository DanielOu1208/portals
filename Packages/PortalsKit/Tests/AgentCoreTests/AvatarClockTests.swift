import Foundation
import Testing
@testable import AgentCore

@Suite struct AvatarClockTests {
    /// A day, by the time of day, and the system's uptime then.
    private let day = Date(timeIntervalSinceReferenceDate: 800_000_000)
    private let up = 1000.0
    /// The app's: rest frames at most 3 s apart.
    private let cadence = AvatarCadence()
    private let blinks: [Double] = []

    /// An avatar at the welcome, as `AgentAvatarDirector` drives it: its first frame at
    /// `up`, its idle mood begun then (an intro of no length, no loop).
    private func welcome() -> AvatarPacing {
        var pacing = AvatarPacing(clock: AvatarClock(start: 0), cadence: cadence)
        let time = pacing.clock.time(at: up)
        pacing.began(length: 0, loops: false, at: time)
        pacing.lastChange = time
        return pacing
    }

    private func gap(_ pacing: inout AvatarPacing, entry: Date, now: Date, uptime: Double) -> TimeInterval {
        pacing.nextDate(after: entry, now: now, uptime: uptime, stillPose: true, blinks: blinks, blinkLength: 0.18)
            .timeIntervalSince(entry)
    }

    /// The first reading is where the clock starts; then it goes as the uptime does.
    @Test func itsTimeGoesAsTheUptime() {
        var clock = AvatarClock(start: 12)
        #expect(!clock.hasStarted)
        #expect(clock.time(at: 500) == 12)
        #expect(clock.hasStarted)
        #expect(clock.time(at: 503.5) == 15.5)
    }

    /// Drawn while paused, it is drawn at the time it paused at; resumed, it goes on from
    /// there, not ahead of it or behind something already drawn. Paused twice, it stays
    /// paused from the first.
    @Test func whatIsDrawnWhilePausedIsAtThePause() {
        var clock = AvatarClock(start: 0)
        _ = clock.time(at: 100)
        clock.pause(at: 110)
        clock.pause(at: 115)
        #expect(clock.isPaused)
        // A change of mood drawn 30 s into the pause: at 10 s on its clock.
        #expect(clock.time(at: 140) == 10)
        clock.resume(at: 160)
        #expect(!clock.isPaused)
        #expect(clock.time(at: 160) == 10)
        #expect(clock.time(at: 161) == 11)
        // Not paused: resuming changes nothing.
        clock.resume(at: 170)
        #expect(clock.time(at: 171) == 21)
    }

    /// Set to a time, it reads that time from then on (the director's re-anchoring).
    @Test func setItReadsTheTimeGiven() {
        var clock = AvatarClock(start: 30)
        _ = clock.time(at: 10)
        clock.set(5, at: 700)
        #expect(clock.time(at: 700) == 5)
        #expect(clock.time(at: 702) == 7)
    }

    /// The welcome settles, the app goes away, the time of day is set back an hour (by hand,
    /// or put right by the network) and the app comes back: the avatar is at rest still, its
    /// next frame seconds away, not a thirtieth of a second. Timed by the time of day it
    /// found its mood begun an hour in its future and drew 30 frames a second until then.
    @Test func theTimeOfDaySetBackLeavesItAtRest() {
        var pacing = welcome()
        // Five seconds on, settled: its next frame is a rest's gap away.
        #expect(gap(&pacing, entry: day + 5, now: day + 5, uptime: up + 5) == 3)
        #expect(pacing.isAtRest(at: pacing.clock.time(at: up + 5), stillPose: true))
        pacing.clock.pause(at: up + 6)
        // Back four seconds of uptime later, the time of day an hour earlier: the timeline
        // starts again from that day's now.
        let back = day + 10 - 3600
        pacing.clock.resume(at: up + 10)
        #expect(pacing.clock.time(at: up + 10) == 6)
        #expect(pacing.isAtRest(at: 6, stillPose: true))
        #expect(gap(&pacing, entry: back, now: back, uptime: up + 10) == 3)
        // And so on, a frame every three seconds.
        #expect(gap(&pacing, entry: back + 3, now: back + 3, uptime: up + 13) == 3)
    }

    /// Set forward, the time of day changes nothing either.
    @Test func theTimeOfDaySetForwardLeavesItAtRest() {
        var pacing = welcome()
        let ahead = day + 5 + 7200
        #expect(gap(&pacing, entry: ahead, now: ahead, uptime: up + 5) == 3)
    }

    /// Set back while the timeline runs on, its next date was made before: the entry is
    /// taken as drawn now, and the dates still go forward (the timeline waits, drawing
    /// nothing, until `AgentAvatarView` starts it again on the system's notice).
    @Test func anEntryMadeBeforeTheTimeOfDayWentBackIsNow() {
        var pacing = welcome()
        let entry = day + 8
        let now = day + 8 - 3600
        let next = pacing.nextDate(after: entry, now: now, uptime: up + 8, stillPose: true, blinks: blinks, blinkLength: 0.18)
        #expect(next > entry)
        #expect(next.timeIntervalSince(entry) <= AvatarCadence.minimumStep + 1e-9)
    }

    /// Something moving is drawn at the full rate whatever the time of day: a mood just
    /// begun, a change not yet glided home, a mood that loops.
    @Test func somethingMovingIsDrawnAtTheFullRate() {
        var pacing = welcome()
        #expect(abs(gap(&pacing, entry: day + 0.5, now: day + 0.5, uptime: up + 0.5) - 1.0 / 30) < 1e-6)
        pacing.lastChange = pacing.clock.time(at: up + 20)
        #expect(abs(gap(&pacing, entry: day + 20.2, now: day + 20.2, uptime: up + 20.2) - 1.0 / 30) < 1e-6)
        var looping = welcome()
        looping.began(length: 0, loops: true, at: 0)
        #expect(abs(gap(&looping, entry: day + 30, now: day + 30, uptime: up + 30) - 1.0 / 30) < 1e-6)
    }

    /// An entry asked for a little ahead of its time (as the one before it is drawn) is
    /// timed from its own date, as before.
    @Test func anEntryAskedForAheadIsTimedFromItsDate() {
        var pacing = welcome()
        // At 4.5 s of its clock, an entry due at 5.5: the frame after it is 3 s after that.
        #expect(gap(&pacing, entry: day + 5.5, now: day + 4.5, uptime: up + 4.5) == 3)
    }
}
