import Testing
@testable import Wash

@Suite struct WashPacerTests {
    @Test func movesByTheDisplayLinkAndDrawsAStillWashOnce() {
        var pacer = WashPacer<Int>()
        let moving = pacer.step(isMoving: true, isSeen: true)
        #expect(moving == .run)
        let first = pacer.shouldDraw(1, at: 1, isSeen: true), next = pacer.shouldDraw(1, at: 2, isSeen: true)
        #expect(first && next)
        let still = pacer.step(isMoving: false, isSeen: true)
        #expect(still == .drawOnce)
        let once = pacer.shouldDraw(2, at: 2, isSeen: true)
        // SwiftUI updating the view for something else: the same picture is not drawn again.
        let again = pacer.shouldDraw(2, at: 2, isSeen: true)
        #expect(once && !again)
    }

    /// Covered or in the background, nothing is drawn, even as its state changes; on
    /// return the picture is drawn again, though the state is the one drawn before.
    @Test func drawsNothingUnseenAndAgainOnReturn() {
        var pacer = WashPacer<Int>()
        let shown = pacer.shouldDraw(3, at: 5, isSeen: true)
        let away = pacer.step(isMoving: true, isSeen: false)
        let changedAway = pacer.shouldDraw(4, at: 6, isSeen: false)
        #expect(shown && away == .pause && !changedAway)
        let back = pacer.step(isMoving: false, isSeen: true)
        let redrawn = pacer.shouldDraw(3, at: 5, isSeen: true)
        #expect(back == .drawOnce && redrawn)
    }

    /// A frame that could not be drawn (no drawable) is drawn at the next chance.
    @Test func drawsAgainAfterAFrameThatFailed() {
        var pacer = WashPacer<Int>()
        _ = pacer.shouldDraw(7, at: 1, isSeen: true)
        pacer.forget()
        let retried = pacer.shouldDraw(7, at: 1, isSeen: true)
        #expect(retried)
    }
}
