import XCTest

/// Checks the foot of a chat whose agent started a thread on another Mac (`Fleet`'s
/// `StartedThread.agentName`, review-relay 7f3839ab): opened, the line at the chat's foot
/// and the turn footer's list both name the other Mac, "Fake agent on mini · Working".
/// Against two linked scratch bridges with the fake agent: one the app knows as MBP16, where
/// the starting thread is, and one it knows as mini, where the thread it started works on
/// (a slow reply). Skipped unless its folder,
/// `/private/tmp/portals-started/uitest-<simulator>/`, has `plan.txt`:
///
///     <bundle id of the Portals copy installed in the simulator>
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///     <title of the starting thread>
///     <id of the thread it started on the other Mac>
///
/// Writes notes.txt and pictures of the screen there.
final class StartedFooterUITests: XCTestCase {
    private let folder = "/private/tmp/portals-started/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    func testThreadOnAnotherMacSaysWhichMac() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the started-threads footer")
        continueAfterFailure = true
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map(String.init)
        try XCTSkipUnless(lines.count >= 4, "plan.txt needs four lines")
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1]]
        app.launch()
        let title = lines[2], started = lines[3]

        // The sidebar, by its button's place (an element tap on it does nothing on the new
        // thread the app opens to, see BlankUITests), then the starting thread's row.
        let sidebarButton = app.buttons["Agents and threads"]
        XCTAssertTrue(sidebarButton.waitForExistence(timeout: 30), "the chat's sidebar button")
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", title)).firstMatch
        // Out: the chat slid aside, its composer with it. (The sidebar's rows are there
        // to be found while it is behind the chat too.)
        let composer = app.textFields["composer-field"]
        func isOut() -> Bool { composer.exists && composer.frame.minX > app.frame.width / 3 }
        for _ in 0..<3 where !isOut() {
            sidebarButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            for _ in 0..<10 where !isOut() { Thread.sleep(forTimeInterval: 0.2) }
        }
        XCTAssertTrue(isOut(), "the sidebar did not open")
        _ = row.waitForExistence(timeout: 5)
        XCTAssertTrue(row.exists, "no row for \(title)")
        shot("sidebar")
        row.tap()
        Thread.sleep(forTimeInterval: 3)
        shot("chat")

        // The line at the chat's foot: the threads at work, opened.
        let line = app.buttons["foot-line"]
        XCTAssertTrue(line.waitForExistence(timeout: 10), "no line at the foot of the chat")
        note("line: \(line.label)")
        line.tap()
        let inLine = app.buttons["started-thread-\(started)"]
        XCTAssertTrue(inLine.waitForExistence(timeout: 5), "no row for the started thread in the line")
        note("line row: \(inLine.label)")
        XCTAssertTrue(inLine.label.contains("Fake agent on mini"), "the line's row does not say which Mac: \(inLine.label)")
        XCTAssertTrue(inLine.label.contains("Working"), "the line's row does not say it works: \(inLine.label)")
        Thread.sleep(forTimeInterval: 0.6)
        shot("line-open")
        // Closed again, unless it went with the thread's work done (the line shows only
        // threads at work once the turn's footer lists them all).
        if line.exists { line.tap() }
        Thread.sleep(forTimeInterval: 0.6)

        // The turn footer's "1 thread", its popover.
        let link = app.buttons["turn-footer-threads"]
        XCTAssertTrue(link.waitForExistence(timeout: 5), "no thread count in the turn footer")
        link.tap()
        let inList = app.buttons.matching(identifier: "started-thread-\(started)").firstMatch
        XCTAssertTrue(inList.waitForExistence(timeout: 5), "no row for the started thread in the footer's list")
        note("footer list row: \(inList.label)")
        XCTAssertTrue(inList.label.contains("Fake agent on mini"), "the footer's row does not say which Mac: \(inList.label)")
        Thread.sleep(forTimeInterval: 0.6)
        shot("footer-list")
    }
}
