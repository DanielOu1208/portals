import Testing
@testable import AgentCore

@Suite struct FocusWithAppTests {
    /// Focus that goes with the app and comes back with it is not you starting to type.
    @Test func focusComingBackWithTheAppIsNotTyping() {
        var focus = FocusWithApp()
        focus.lost(appActive: false)
        #expect(focus.leftWithApp)
        let cameBack = focus.gained()
        #expect(!cameBack)
        #expect(!focus.leftWithApp)
        // Then you click away and back into it: that is typing.
        focus.lost(appActive: true)
        let clicked = focus.gained()
        #expect(clicked)
    }

    /// Focus moved elsewhere on purpose while the app was not in use does not come back:
    /// once the app has been in use a moment without it, the next focus is typing, and
    /// nothing is left saying it may come back (the avatar listening).
    @Test func focusThatDoesNotComeBackIsLetGo() {
        var focus = FocusWithApp()
        focus.lost(appActive: false)
        let back = focus.appBecameActive()
        focus.settled(back, composing: false)
        #expect(!focus.leftWithApp)
        let typed = focus.gained()
        #expect(typed)
        // Come back with the app before the moment is over: nothing is let go.
        focus.lost(appActive: false)
        let again = focus.appBecameActive()
        _ = focus.gained()
        focus.settled(again, composing: true)
        #expect(!focus.leftWithApp)
    }

    /// Left and back again within a return's moment: that older moment settles nothing,
    /// so the focus coming back with this return is still not typing.
    @Test func anOlderReturnSettlesNothing() {
        var focus = FocusWithApp()
        focus.lost(appActive: false)
        let first = focus.appBecameActive()
        _ = focus.gained()
        // Away again at 0.8 s, back at 0.95 s; the first return's moment ends at 1 s.
        focus.lost(appActive: false)
        let second = focus.appBecameActive()
        focus.settled(first, composing: false)
        #expect(focus.leftWithApp)
        let cameBack = focus.gained()
        #expect(!cameBack)
        focus.settled(second, composing: true)
        #expect(!focus.leftWithApp)
        // Away and not back yet when a return's moment ends: nothing either.
        focus.lost(appActive: false)
        focus.settled(second, composing: false)
        #expect(focus.leftWithApp)
    }

    /// A Mac's panel over the chat (a visual expanded) takes the focus while it is open and
    /// gives it back as it closes: that is not you starting to type, whichever of the panel
    /// opening and the focus going is said first.
    @Test func focusGivenBackByAPanelIsNotTyping() {
        var focus = FocusWithApp()
        focus.coverOpened()
        focus.lost(appActive: true)
        _ = focus.coverClosed()
        let givenBack = focus.gained()
        #expect(!givenBack)
        // The focus said gone first, the panel open after.
        focus.lost(appActive: true)
        focus.coverOpened()
        _ = focus.coverClosed()
        let givenBackAgain = focus.gained()
        #expect(!givenBackAgain)
        // Given back before the panel is said closed.
        focus.lost(appActive: true)
        focus.coverOpened()
        let early = focus.gained()
        #expect(!early)
        _ = focus.coverClosed()
        // Then you click away and back into it: that is typing.
        focus.lost(appActive: true)
        let clicked = focus.gained()
        #expect(clicked)
        // Nothing says the focus went with the app (the avatar listening).
        #expect(!focus.leftWithApp)
    }

    /// Focus that does not come back as the panel closes was not the panel's: once a moment
    /// has passed, the next focus is typing.
    @Test func focusNotGivenBackByAPanelIsLetGo() {
        var focus = FocusWithApp()
        focus.lost(appActive: true)
        focus.coverOpened()
        let closed = focus.coverClosed()
        focus.coverSettled(closed)
        let typed = focus.gained()
        #expect(typed)
    }

    /// The focus kept through a sheet (an iPhone's), and lost afterwards on purpose: the next
    /// focus is typing.
    @Test func focusKeptThroughAPanelChangesNothing() {
        var focus = FocusWithApp()
        focus.coverOpened()
        let closed = focus.coverClosed()
        focus.coverSettled(closed)
        focus.lost(appActive: true)
        let typed = focus.gained()
        #expect(typed)
        // Lost on purpose a moment after the panel closed, before its moment ended.
        focus.coverOpened()
        let again = focus.coverClosed()
        focus.lost(appActive: true)
        focus.coverSettled(again)
        let typedAgain = focus.gained()
        #expect(typedAgain)
    }

    /// Closed and opened again within a closing's moment: that older moment settles nothing,
    /// so the focus given back as the second closes is still not typing.
    @Test func anOlderClosingSettlesNothing() {
        var focus = FocusWithApp()
        focus.coverOpened()
        focus.lost(appActive: true)
        let first = focus.coverClosed()
        // Opened again at once, before the focus came back.
        focus.coverOpened()
        focus.coverSettled(first)
        #expect(focus.isCovered)
        let second = focus.coverClosed()
        focus.coverSettled(first)
        let givenBack = focus.gained()
        #expect(!givenBack)
        focus.coverSettled(second)
        #expect(!focus.isCovered)
    }
}
