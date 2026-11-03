import XCTest

/// The approval card's More options sheet: opened for one option, it opens on that
/// option, and its bar (`PanelChrome`, where on a Mac the window's cut Done and Back to
/// "D…" and "B…") has Back to the list, then Done, which closes it (2026-10-27). Against
/// the isolated Droid parity bridge (`DroidParityUIHarness`): the card is opened as a card
/// opens it for an option that needs confirming (`PORTALS_DEBUG_APPROVAL_OPTIONS`).
final class ApprovalOptionsUITests: DroidParityUIHarness {
    func testOpensOnTheOptionItWasOpenedForThenBackThenDone() throws {
        try XCTSkipIf(configuration.live, "needs the scripted approval's options")
        let app = launch(prompt: "droid-parity approval", environment: ["PORTALS_DEBUG_APPROVAL_OPTIONS": "proceed_always_file"])
        // The option's confirmation, not the list: the sheet was once made before the
        // option it opens on was set, and opened on the list.
        let confirm = app.buttons["approval-confirm-proceed_always_file"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 30), "More options did not open on the option")
        XCTAssertFalse(app.buttons["approval-option-proceed_always_file"].exists, "More options opened on the list")
        capture("More options on an option")
        let back = app.buttons["approval-options-close"]
        XCTAssertEqual(back.label, "Back")
        back.tap()
        XCTAssertTrue(app.buttons["approval-option-proceed_always_file"].waitForExistence(timeout: 5), "Back did not go back to the list")
        let done = app.buttons["approval-options-close"]
        XCTAssertEqual(done.label, "Done")
        done.tap()
        XCTAssertTrue(app.buttons["approval-option-proceed_always_file"].waitForNonExistence(timeout: 10), "Done did not close More options")
        XCTAssertTrue(app.buttons["approve-once"].exists, "the card is not answered by closing its options")
    }
}
