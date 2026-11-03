import Testing
@testable import AgentCore

/// An image shown while its reply was written is asked of the Mac once more as the reply
/// ends, and only then: not each time it scrolls back into view.
@Suite struct ReplyImageRecheckTests {
    /// Whether each load, its reply being written or not, asks the Mac whatever it said,
    /// with the check `made` after each load that asked.
    private func forced(_ loads: [Bool], makingIt: Bool = true) -> [Bool] {
        var recheck = ReplyImageRecheck()
        return loads.map { isBeingWritten in
            let force = recheck.begin(isBeingWritten: isBeingWritten)
            if force, makingIt { recheck.made() }
            return force
        }
    }

    @Test func askedOnceAsTheReplyEndsNotOnEveryReappearance() {
        // Shown, and shown again, while the reply is written: checked the usual way. The
        // reply ends: asked once more, whatever was said. Scrolled away and back, again and
        // again: as any ended reply's image.
        #expect(forced([true, true, false, false, false, false]) == [false, false, true, false, false, false])
    }

    @Test func aCheckStoppedBeforeItAskedIsMadeOnTheNextLoad() {
        // The reply ended as the image went out of view: those loads never asked.
        #expect(forced([true, false, false], makingIt: false) == [false, true, true])
        var recheck = ReplyImageRecheck()
        _ = recheck.begin(isBeingWritten: true)
        _ = recheck.begin(isBeingWritten: false)
        let again = recheck.begin(isBeingWritten: false)
        #expect(again)
        recheck.made()
        let after = recheck.begin(isBeingWritten: false)
        #expect(!after)
    }

    @Test func anImageOnlyEverSeenEndedIsNeverForced() {
        #expect(forced([false, false, false]) == [false, false, false])
    }

    @Test func aReplyWrittenAgainIsCheckedAgainAtItsNewEnd() {
        #expect(forced([true, false, false, true, false, false]) == [false, true, false, false, true, false])
    }
}
