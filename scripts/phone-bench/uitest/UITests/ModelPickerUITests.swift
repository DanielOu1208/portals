import XCTest

/// The model picker's search field is the app's search field (`SearchField`, the sidebar's
/// and the folder sheet's; 2026-10-27), and clearing it still brings the list back to the
/// model in use, not to its top (094093f5, 2026-10-26). Against the scripted backend
/// (`PORTALS_FAKE=namedModels`: seven Claude models), on a thread running the last of them,
/// so that the list's top and the model in use are not in sight together. Pictures of the
/// screen go to /private/tmp/portals-models/uitest-<simulator>/. Run as the file's
/// neighbours are (FolderSearchUITests).
final class ModelPickerUITests: XCTestCase {
    private let folder = "/private/tmp/portals-models/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// A model's row, by the name the picker shows.
    private func row(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    func testClearingTheSearchBringsTheListBackToTheModelInUse() throws {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = [
            "PORTALS_FAKE": "namedModels",
            "PORTALS_DEV_MODEL": "claude-opus-4-6", "PORTALS_DEV_PROVIDER": "anthropic",
            "PORTALS_DEBUG_MODEL_PICKER": "1",
        ]
        app.launch()
        continueAfterFailure = false

        // The shared field, named for tests.
        let field = app.textFields["model-search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no model picker with the app's search field")
        let inUse = row("Opus 4.6", in: app)
        let top = row("Opus 5.5", in: app)
        XCTAssertTrue(inUse.waitForExistence(timeout: 5), "no row for the model in use")
        Thread.sleep(forTimeInterval: 1)
        shot("1-opened")
        // As it opens: on the model in use, the top of the list out of sight.
        XCTAssertTrue(inUse.isHittable, "the model in use is not in sight as the picker opens")
        XCTAssertFalse(top.isHittable, "the list's top is in sight too: this test cannot tell them apart")

        field.tap()
        field.typeText("son")
        XCTAssertTrue(row("Sonnet 5.5", in: app).waitForExistence(timeout: 5), "the search did not find Sonnet")
        XCTAssertFalse(inUse.exists, "the search left the model in use")
        shot("2-searched")

        app.buttons["Clear"].tap()
        XCTAssertTrue(inUse.waitForExistence(timeout: 5), "the list did not come back")
        Thread.sleep(forTimeInterval: 1)
        shot("3-cleared")
        XCTAssertTrue(inUse.isHittable, "cleared, the list is not back on the model in use")
        XCTAssertFalse(top.isHittable, "cleared, the list went back to its top")
    }
}
