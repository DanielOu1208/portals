import XCTest

/// Against a scratch host with Deployment checklist (a title match), Release decisions
/// (an older message match), and Review notes (a user message match). The plan contains
/// the installed app's bundle id and its debug hosts JSON, one per line.
final class MessageSearchUITests: XCTestCase {
    func testMessageMatchesFollowTitlesAndOpenTheirThread() throws {
        let environment = ProcessInfo.processInfo.environment
        let plan = environment["MESSAGE_SEARCH_UI_PLAN"] ?? "/tmp/message-search-ui/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: plan), "no message search plan")
        let lines = try String(contentsOfFile: plan, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertGreaterThanOrEqual(lines.count, 2)
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1], "PORTALS_DEBUG_SIDEBAR": "1"]
        app.launch()
        let field = app.textFields["Search threads"]
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        field.tap()
        field.typeText("de")
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertFalse(app.staticTexts["In messages"].exists)
        field.typeText("ploy")
        let heading = app.staticTexts["In messages"]
        XCTAssertTrue(heading.waitForExistence(timeout: 15))
        let title = app.staticTexts["Deployment checklist"].firstMatch
        let message = app.staticTexts["Release decisions"].firstMatch
        XCTAssertTrue(title.exists)
        XCTAssertTrue(message.exists)
        XCTAssertLessThan(title.frame.minY, heading.frame.minY)
        XCTAssertLessThan(heading.frame.minY, message.frame.minY)
        XCTAssertEqual(app.staticTexts.matching(identifier: "Deployment checklist").count, 1)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'You: '")).firstMatch.exists)
        // A runner may capture this settled screen with simctl before the tap below.
        if lines.count > 2 {
            try Data().write(to: URL(fileURLWithPath: lines[2] + "/ready"))
            for _ in 0..<100 {
                if FileManager.default.fileExists(atPath: lines[2] + "/continue") { break }
                Thread.sleep(forTimeInterval: 0.2)
            }
        }
        message.tap()
        let composer = app.descendants(matching: .any)["composer-field"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let header = app.descendants(matching: .any)["chat-header"].firstMatch
        let selectedThread = NSPredicate(format: "label CONTAINS %@", "Release decisions")
        expectation(for: selectedThread, evaluatedWith: header)
        waitForExpectations(timeout: 10)
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertLessThan(composer.frame.minX, app.frame.width / 3)
        }
    }
}
