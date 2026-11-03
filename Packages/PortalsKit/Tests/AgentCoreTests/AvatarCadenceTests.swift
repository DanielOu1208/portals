import Foundation
import Testing
@testable import AgentCore

@Suite struct AvatarCadenceTests {
    private let cadence = AvatarCadence(busy: 1.0 / 30, rest: 1.0 / 8)
    private let blinks = [1.4, 4.0, 4.24, 9.0]
    private let length = 0.18

    private func next(_ now: Double, atRest: Bool = true) -> Double {
        cadence.next(after: now, atRest: atRest, blinks: blinks, blinkLength: length)
    }

    @Test func somethingMovingIsDrawnAtTheFullRate() {
        #expect(next(2.0, atRest: false) == 2.0 + 1.0 / 30)
        // Also in the middle of a long quiet stretch.
        #expect(next(6.0, atRest: false) == 6.0 + 1.0 / 30)
    }

    @Test func atRestBetweenBlinksAFewFramesASecond() {
        #expect(next(2.0) == 2.0 + 1.0 / 8)
        #expect(next(5.0) == 5.0 + 1.0 / 8)
    }

    /// A blink is short: every frame of it is drawn, from its very start.
    @Test func aBlinkIsDrawnInFull() {
        // Coming up before the next quiet frame: the next frame is its start.
        #expect(next(1.35) == 1.4)
        // Under way, and at its last moment.
        #expect(next(1.4) == 1.4 + 1.0 / 30)
        #expect(next(1.5) == 1.5 + 1.0 / 30)
        #expect(next(1.57) == 1.57 + 1.0 / 30)
        // Over: back to the quiet rate.
        #expect(next(1.6) == 1.6 + 1.0 / 8)
    }

    /// Drawn from its start, a blink comes back a hair before it as dates round: the
    /// next frame is still ahead, never the same moment again.
    @Test func aBlinkStartedALittleEarlyMovesOn() {
        #expect(next(1.4 - 1e-7) == 1.4 - 1e-7 + 1.0 / 30)
        #expect(next(1.4 - 1e-7) > 1.4 - 1e-7)
    }

    @Test func aDoubleBlinkIsDrawnInFullToo() {
        #expect(next(4.1) == 4.1 + 1.0 / 30)
        // Between the two, the second is under way already or starts at once.
        #expect(next(4.2) == 4.24)
        #expect(next(4.3) == 4.3 + 1.0 / 30)
        #expect(next(4.45) == 4.45 + 1.0 / 8)
    }

    @Test func pastTheLastBlinkItStaysQuiet() {
        #expect(next(20) == 20 + 1.0 / 8)
        #expect(cadence.next(after: 3, atRest: true, blinks: [], blinkLength: length) == 3 + 1.0 / 8)
    }

    /// No stretch at rest goes longer than the quiet gap without a frame, and no blink
    /// is skipped.
    @Test func walkingTheClockMissesNoBlink() {
        var now = 0.0
        var drawnInBlink = Set<Double>()
        var longestGap = 0.0
        while now < 10 {
            let after = next(now)
            longestGap = max(longestGap, after - now)
            if let blink = blinks.first(where: { $0 <= after && after < $0 + length }) { drawnInBlink.insert(blink) }
            now = after
        }
        #expect(drawnInBlink == Set(blinks))
        #expect(longestGap <= 1.0 / 8 + 1e-9)
    }

    /// The avatar holds still between blinks, so the app's cadence draws nothing new
    /// there: at rest the frame after a blink is the next blink's first, when it comes
    /// within the longest wait, and each blink is still drawn in full.
    @Test func atRestTheAppsCadenceWaitsForTheNextBlink() {
        let app = AvatarCadence()
        func next(_ now: Double, atRest: Bool = true) -> Double {
            app.next(after: now, atRest: atRest, blinks: blinks, blinkLength: length)
        }
        #expect(next(1.6) == 4.0)
        #expect(next(2.0) == 4.0)
        #expect(next(4.0) == 4.0 + 1.0 / 30)
        #expect(next(4.2) == 4.24)
        // Five seconds to the next blink: one frame on the way, three seconds on.
        #expect(next(4.5) == 7.5)
        #expect(next(7.5) == 9.0)
        // Past the last blink: a frame every three seconds.
        #expect(next(20) == 23)
        // Anything moving: the full rate, from its first frame.
        #expect(next(2.0, atRest: false) == 2.0 + 1.0 / 30)
    }

    /// Walking the app's cadence at rest from a blink's end: every blink drawn in full,
    /// and between blinks only the frame that opens the eyes again and, in the one
    /// stretch longer than three seconds, one more.
    @Test func walkingTheAppsCadenceDrawsTheBlinksAndLittleElse() {
        let app = AvatarCadence()
        var now = 0.0
        var drawnInBlink = Set<Double>()
        var between = 0
        while now < 10 {
            now = app.next(after: now, atRest: true, blinks: blinks, blinkLength: length)
            if let blink = blinks.first(where: { $0 <= now && now < $0 + length }) {
                drawnInBlink.insert(blink)
            } else if now < 10 {
                between += 1
            }
        }
        #expect(drawnInBlink == Set(blinks))
        // After each of the four blinks, its last frame; and once more in the five
        // seconds between 4.24 and 9.0.
        #expect(between == 5)
    }
}
