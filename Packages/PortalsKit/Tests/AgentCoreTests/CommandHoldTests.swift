import Testing
@testable import AgentCore

@Suite struct CommandHoldTests {
    @Test func heldAloneItShowsAfterTheDelay() {
        var hold = CommandHoldState()
        #expect(!hold.isShown && !hold.isWaiting)
        hold.modifiersChanged(to: .commandAlone)
        #expect(hold.isWaiting && !hold.isShown)
        hold.delayEnded()
        #expect(hold.isShown && !hold.isWaiting)
        hold.modifiersChanged(to: .none)
        #expect(!hold.isShown && !hold.isWaiting)
    }

    @Test func letGoBeforeTheDelayNothingShows() {
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.modifiersChanged(to: .none)
        hold.delayEnded()
        #expect(!hold.isShown)
    }

    @Test func aKeyWithItShowsNothingUntilItIsLetGo() {
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.keyPressed(with: .commandAlone)
        hold.delayEnded()
        #expect(!hold.isShown && !hold.isWaiting)
        // ⌘ still held after ⌘C: no hints for it, however long.
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(!hold.isShown)
        // Let go, and held again.
        hold.modifiersChanged(to: .none)
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
    }

    @Test func aKeyAfterTheyShowTakesThemAway() {
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        hold.keyPressed(with: .commandAlone)
        #expect(!hold.isShown)
    }

    @Test func aKeyWithNothingHeldSaysItWasLetGoUnheard() {
        // ⌘ let go in a menu: the monitor did not hear it, and the hints still show.
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        hold.keyPressed(with: .none)
        #expect(!hold.isShown && !hold.isWaiting)
        // The next ⌘ is not lost to it.
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
    }

    @Test func askedWhatIsHeldStillAloneChangesNothing() {
        // `CommandHold` asks while the hints show, and as the delay ends.
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.modifiersChanged(to: .commandAlone)
        #expect(hold.isWaiting)
        hold.delayEnded()
        hold.modifiersChanged(to: .commandAlone)
        #expect(hold.isShown)
        // Let go unheard, it goes, and the next ⌘ is a new one.
        hold.modifiersChanged(to: .none)
        #expect(!hold.isShown)
        hold.modifiersChanged(to: .commandAlone)
        hold.modifiersChanged(to: .none)
        hold.delayEnded()
        #expect(!hold.isShown)
    }

    @Test func anotherModifierShowsNothing() {
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .others)
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(!hold.isShown)
        hold.modifiersChanged(to: .none)
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
        hold.modifiersChanged(to: .others)
        #expect(!hold.isShown)
        // Back to ⌘ alone from ⌘⇧: not until every modifier is let go.
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(!hold.isShown)
    }

    @Test func typingWithNothingHeldChangesNothing() {
        var hold = CommandHoldState()
        hold.keyPressed(with: .none)
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
    }

    @Test func losingTheKeyboardClearsThem() {
        // ⌘-Tab away: no key comes up.
        var hold = CommandHoldState()
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
        hold.focusChanged()
        #expect(!hold.isShown && !hold.isWaiting)
        // While waiting too: the delay ending shows nothing.
        hold.modifiersChanged(to: .commandAlone)
        hold.focusChanged()
        hold.delayEnded()
        #expect(!hold.isShown)
    }

    @Test func comingBackWithItStillHeldShowsNothing() {
        // ⌘-Tab back, ⌘ still down from the switcher: no change of modifiers says so, and
        // its release clears nothing that is shown.
        var hold = CommandHoldState()
        hold.focusChanged()
        hold.delayEnded()
        #expect(!hold.isShown)
        hold.modifiersChanged(to: .none)
        #expect(!hold.isShown)
        hold.modifiersChanged(to: .commandAlone)
        hold.delayEnded()
        #expect(hold.isShown)
    }
}
