import XCTest

/// A command's answer and a refused command each close with their x, now
/// that the close action reaches the rows as one object for the thread's life
/// (`CommandAnswerCloser`) rather than a closure made in the chat's body. Runs against the
/// Portals debug build installed in the simulator, with the scripted agent (`commands`).
/// Skipped unless its folder, `/private/tmp/portals-commands/uitest-<simulator>/`, is there;
/// it writes pictures of the screen there. Run as `RelayedUITests` says, with
/// `-only-testing:UITests/CommandCloseUITests`.
final class CommandCloseUITests: XCTestCase {
    private let folder = "/private/tmp/portals-commands/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: folder), "no folder for the command checks")
        continueAfterFailure = true
    }

    private func launch(_ prompt: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_FAKE": "commands", "PORTALS_DEBUG_PROMPT": prompt]
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    func testAnAnswerClosesWithItsX() {
        let app = launch("/status")
        let close = app.buttons["close-command-answer"]
        XCTAssertTrue(close.waitForExistence(timeout: 30), "no close button on the answer")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '12,480 of 400,000'")).firstMatch.exists, "no answer text")
        shot("status-answer")
        close.tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: close)
        waitForExpectations(timeout: 5)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '12,480 of 400,000'")).firstMatch.exists, "answer still shown")
        shot("status-closed")
    }

    func testARefusedCommandClosesWithItsX() {
        let app = launch("/nope")
        let failed = app.descendants(matching: .any)["command-failed"]
        XCTAssertTrue(failed.waitForExistence(timeout: 30), "no refused command row")
        let close = app.buttons["close-command-answer"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "no close button on the refusal")
        shot("refused")
        close.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: failed)
        waitForExpectations(timeout: 5)
        shot("refused-closed")
    }
}
