import XCTest

final class ModePickerUITests: XCTestCase {
    private func launch(largeText: Bool = false) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_FAKE": "plan"]
        if !largeText { app.launchEnvironment["PORTALS_DEBUG_MODE_PICKER"] = "1" }
        if largeText {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        }
        app.launch()
        return app
    }

    func testModeRowsAreCompact() {
        continueAfterFailure = false
        let app = launch()
        let settings = app.buttons["mode-default"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        XCTAssertEqual(settings.label, "Your settings (Full access)")
        XCTAssertLessThan(settings.frame.width, 320, "the popover fits its names")
        for id in ["full", "edits", "ask", "plan", "default"] {
            let row = app.buttons["mode-\(id)"]
            XCTAssertTrue(row.isHittable)
            XCTAssertGreaterThanOrEqual(row.frame.height, 44)
            XCTAssertLessThan(row.frame.height, 60)
        }
        XCTAssertFalse(app.staticTexts["As the agent's own settings at the desk say"].exists)
        XCTAssertTrue(settings.isSelected)
        app.buttons["mode-ask"].tap()
        app.buttons["mode-chip"].tap()
        XCTAssertTrue(app.buttons["mode-ask"].isSelected)
    }

    func testLargeModeRowsScroll() {
        continueAfterFailure = false
        let app = launch(largeText: true)
        let chip = app.buttons["mode-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 20))
        chip.tap()
        let full = app.buttons["mode-full"]
        XCTAssertTrue(full.waitForExistence(timeout: 20))
        XCTAssertGreaterThanOrEqual(full.frame.height, 44)
        let settings = app.buttons["mode-default"]
        if !settings.isHittable {
            let rows = app.scrollViews.containing(.button, identifier: "mode-full").firstMatch
            XCTAssertTrue(rows.exists, "large text scrolls where all rows cannot fit")
            for _ in 0..<6 where !settings.isHittable { rows.swipeUp() }
        }
        XCTAssertTrue(settings.isHittable)
        XCTAssertEqual(settings.label, "Your settings (Full access)")
    }
}
