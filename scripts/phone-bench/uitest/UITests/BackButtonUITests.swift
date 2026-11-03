import XCTest

/// The back button over a thread an agent started (2026-10-28): only on a tab opened
/// from the foot of its starter's chat, and going back closes that tab; a thread opened any
/// other way has none. Against a scratch bridge with the fake agent, where one thread started
/// another (`portals start` with `PORTALS_THREAD`), on an iPad, which shows the tabs. Skipped
/// unless its folder, `/private/tmp/portals-back-button/uitest-<simulator>/`, has `plan.txt`:
///
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///     <id of the starting thread>
///     <id of the thread it started>
///
/// Writes pictures of the screen there.
final class BackButtonUITests: XCTestCase {
    private let folder = "/private/tmp/portals-back-button/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: "\(folder)/plan.txt"), "no plan for the back button checks")
        continueAfterFailure = true
    }

    private func plan() throws -> [String] {
        try String(contentsOfFile: "\(folder)/plan.txt", encoding: .utf8).split(separator: "\n").map(String.init)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func launch(_ hosts: String, opening thread: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_OPEN_PLAN": "\(thread):1"]
        app.launch()
        return app
    }

    func test1FromTheFootTheButtonShowsAndGoingBackClosesTheTab() throws {
        let lines = try plan()
        let parent = lines[1], child = lines[2]
        let app = launch(lines[0], opening: parent)
        XCTAssertTrue(app.descendants(matching: .any)["tab-\(parent)"].waitForExistence(timeout: 20), "the starting thread is not on screen")
        // Once it has settled on screen, as ManagedThreadUITests does.
        Thread.sleep(forTimeInterval: 3)
        shot("0-starting-thread")
        // With nothing at work the foot line is not there: the turn's footer lists the
        // threads it started, in a popover, and opens one the same way.
        let list = app.buttons["turn-footer-threads"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), "no list of started threads under the starting thread's turn")
        XCTAssertFalse(app.buttons["parent-thread"].exists, "a back button on the starting thread")
        list.tap()
        let inLine = app.buttons["started-thread-\(child)"]
        XCTAssertTrue(inLine.waitForExistence(timeout: 5), "no row for the started thread in the list")
        inLine.tap()
        let back = app.buttons["parent-thread"]
        XCTAssertTrue(back.waitForExistence(timeout: 10), "no back button over the thread opened from the foot")
        XCTAssertTrue(app.descendants(matching: .any)["tab-\(child)"].waitForExistence(timeout: 5), "the started thread is no tab")
        shot("1-from-the-foot")
        back.tap()
        XCTAssertTrue(app.buttons["turn-footer-threads"].waitForExistence(timeout: 10), "not back on the starting thread")
        let tabGone = NSPredicate(format: "exists == false")
        expectation(for: tabGone, evaluatedWith: app.descendants(matching: .any)["tab-\(child)"])
        waitForExpectations(timeout: 5)
        XCTAssertFalse(app.buttons["parent-thread"].exists, "a back button on the starting thread")
        shot("2-back")
    }

    func test2OpenedAnotherWayTheThreadHasNoButton() throws {
        let lines = try plan()
        let child = lines[2]
        let app = launch(lines[0], opening: child)
        XCTAssertTrue(app.descendants(matching: .any)["tab-\(child)"].waitForExistence(timeout: 20), "the started thread is not on screen")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(app.buttons["parent-thread"].exists, "a back button over a thread not opened from its starter's foot")
        shot("3-opened-another-way")
    }
}
