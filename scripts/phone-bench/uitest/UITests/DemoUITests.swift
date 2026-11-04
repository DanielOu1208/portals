import XCTest

/// The demo (`Demo`), opened by its switch since the welcome stopped offering it (2026-11-03),
/// gone through as a reviewer would: the tour's reply streaming; its approval card,
/// allowed; its question card, answered; the code block and the visual; Codex's review at
/// work on the line at the chat's foot, opened, and back; the sidebar with the Demo host; a
/// new thread with a message typed, which the scripted agent answers; a notification choice
/// turned off in Settings; Settings' Net with End the demo, which goes back to the welcome;
/// a second demo, where the choice is on again as it was before the first, ended from the
/// sidebar's foot; a third, the choice turned off and the app killed, after which it is on
/// again too. In the Portals app installed in the
/// simulator (a debug build, for the launch switch that starts it with no host), with no
/// host at all. Skipped unless its folder, `/private/tmp/portals-demo/uitest-<simulator>/`,
/// has `plan.txt` naming the app's bundle id. Pictures of each step, and notes, go in a
/// folder of each run's own there, `run-<unix time>/`. Run as the file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/DemoUITests
final class DemoUITests: XCTestCase {
    private let folder = "/private/tmp/portals-demo/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")
    /// This run's own folder in it, for its pictures and notes.
    private lazy var run = "\(folder)/run-\(Int(Date().timeIntervalSince1970))"

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(run)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(run)/\(name).png"))
        note("shot \(name)")
    }

    /// Static text whose words contain `words`.
    private func text(_ app: XCUIApplication, containing words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    func testTheDemoFromTheWelcomeAndBack() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the demo")
        continueAfterFailure = true
        try FileManager.default.createDirectory(atPath: run, withIntermediateDirectories: true)
        let bundle = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: bundle.isEmpty ? "com.danielou.portals" : bundle)
        app.terminate()
        // No host, and the demo by its switch: the welcome no longer offers it.
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": "[]", "PORTALS_DEBUG_DEMO": "1"]
        app.launch()
        // Each new demo is a new launch, the switch still set; the welcome is what's left when one ends.
        let backAtWelcome = app.buttons["welcome-scan"]

        // The tour: its message sent, the reply streaming.
        let welcome = text(app, containing: "Welcome to the Portals demo")
        XCTAssertTrue(welcome.waitForExistence(timeout: 20), "the tour's reply did not come")
        Thread.sleep(forTimeInterval: 1.5)
        shot("02-tour-streaming")

        // The approval card, allowed once.
        let allow = app.buttons["approve-once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "no approval card")
        Thread.sleep(forTimeInterval: 0.8)
        shot("03-approval")
        allow.tap()

        // The question card: the recommended fix.
        let choice = app.buttons.matching(NSPredicate(format: "identifier == 'clarify-choice' AND label CONTAINS 'Round to cents'")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 30), "no question card")
        Thread.sleep(forTimeInterval: 0.8)
        shot("04-question")
        choice.tap()
        let send = app.buttons["clarify-send"]
        if send.waitForExistence(timeout: 2), send.isEnabled { send.tap() }

        // The end of the tour, with Codex at work on the line at the chat's foot.
        let end = text(app, containing: "End the demo, in Settings")
        XCTAssertTrue(end.waitForExistence(timeout: 60), "the tour did not end")
        let footLine = app.buttons["foot-line"]
        XCTAssertTrue(footLine.waitForExistence(timeout: 10), "no line at the chat's foot for Codex's review")
        note("foot line: \(footLine.label)")
        XCTAssertTrue(footLine.label.contains("working"), "Codex's review is not at work on the line: \(footLine.label)")
        shot("05-foot-line")

        // Codex's thread, from the line at the foot, and back.
        footLine.tap()
        let review = app.buttons["started-thread-demo-review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5), "no row for Codex's thread on the line")
        note("review row: \(review.label)")
        Thread.sleep(forTimeInterval: 0.6)
        shot("06-foot-line-open")
        review.tap()
        XCTAssertTrue(text(app, containing: "Please review my fix in src/cart.js").waitForExistence(timeout: 10), "Codex's thread did not open")
        // Its review before, from Claude Code's turn before the tour.
        XCTAssertTrue(text(app, containing: "Please review my change to src/checkout.js").exists, "Codex's thread lost its turn before")
        Thread.sleep(forTimeInterval: 2)
        shot("07-codex-thread")
        let back = app.buttons["parent-thread"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "no way back to the tour")
        back.tap()
        XCTAssertTrue(welcome.waitForExistence(timeout: 10), "not back in the tour")
        // The tour's turn before it is kept.
        XCTAssertTrue(text(app, containing: "Make the Pay button wait").exists, "the tour's turn before it is gone")

        // The code block and the visual, drawn: its bars' counts are in its page.
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 10), "no visual")
        let drawn = app.webViews.staticTexts["13 of 13"]
        if !drawn.waitForExistence(timeout: 15) {
            app.swipeDown()
            _ = drawn.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(drawn.exists, "the visual was not drawn")
        Thread.sleep(forTimeInterval: 1.2)
        shot("08-code-and-visual")

        // The sidebar: the Demo host's tab, its project, End the demo at its foot.
        openSidebar(app)
        // By its words: the foot's own identifier covers its buttons'.
        XCTAssertTrue(app.buttons["End the demo"].waitForExistence(timeout: 5), "no End the demo in the sidebar")
        Thread.sleep(forTimeInterval: 0.6)
        shot("09-sidebar")

        // A new thread, a message typed, the scripted agent's answer.
        let newThread = app.buttons["sidebar-new-thread"]
        XCTAssertTrue(newThread.waitForExistence(timeout: 5), "no New thread in the sidebar")
        newThread.tap()
        let field = app.descendants(matching: .any)["composer-field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no composer")
        field.tap()
        field.typeText("What can you do?")
        app.buttons["send"].tap()
        XCTAssertTrue(text(app, containing: "This is the demo, so I can only follow a script").waitForExistence(timeout: 30), "the new thread got no answer")
        Thread.sleep(forTimeInterval: 2)
        shot("10-new-thread")

        // Settings' Net: the Demo host, and End the demo.
        openSidebar(app)
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "no Settings in the sidebar")
        settings.tap()
        let notifications = app.buttons["settings-section-notifications"]
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Settings did not open")
        shot("11-settings")

        // A notification choice turned off in the demo, which offers no Turn On.
        notifications.tap()
        let needsYou = app.switches["notify-needs-you"]
        XCTAssertTrue(needsYou.waitForExistence(timeout: 5), "no notification choices")
        XCTAssertFalse(app.buttons["allow-notifications"].exists, "the demo offers to turn on notifications")
        let before = needsYou.value as? String
        needsYou.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertNotEqual(needsYou.value as? String, before, "the choice did not change")
        note("needs you: \(before ?? "?") then \(needsYou.value as? String ?? "?")")
        shot("12-settings-notifications")
        app.navigationBars.buttons.firstMatch.tap()

        let net = app.buttons["settings-section-net"]
        XCTAssertTrue(net.waitForExistence(timeout: 5), "not back at Settings' list")
        net.tap()
        let endDemo = app.buttons["settings-end-demo"]
        XCTAssertTrue(endDemo.waitForExistence(timeout: 5), "no End the demo in Settings")
        XCTAssertFalse(app.buttons["add-host"].exists, "Add a host is offered in the demo")
        Thread.sleep(forTimeInterval: 0.6)
        shot("13-settings-net")
        endDemo.tap()

        // Back at the welcome, as it was.
        XCTAssertTrue(backAtWelcome.waitForExistence(timeout: 10), "not back at the welcome")
        Thread.sleep(forTimeInterval: 0.6)
        shot("14-welcome-again")

        // A second demo: the choice is as it was before the first.
        app.terminate()
        app.launch()
        XCTAssertTrue(welcome.waitForExistence(timeout: 20), "the second tour did not begin")
        openSidebar(app)
        app.buttons["Settings"].tap()
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Settings did not open again")
        notifications.tap()
        XCTAssertTrue(needsYou.waitForExistence(timeout: 5), "no notification choices the second time")
        XCTAssertEqual(needsYou.value as? String, before, "the choice changed in the demo outlasted it")
        shot("15-choice-put-back")
        app.navigationBars.buttons.firstMatch.tap()
        let close = app.buttons["settings-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "no Done in Settings")
        close.tap()

        // Ended from the sidebar's foot this time.
        let endFromSidebar = app.buttons["End the demo"]
        if !endFromSidebar.waitForExistence(timeout: 3) || !endFromSidebar.isHittable { openSidebar(app) }
        XCTAssertTrue(endFromSidebar.waitForExistence(timeout: 5), "no End the demo in the sidebar")
        endFromSidebar.tap()
        XCTAssertTrue(backAtWelcome.waitForExistence(timeout: 10), "not back at the welcome from the sidebar")
        Thread.sleep(forTimeInterval: 0.6)
        shot("16-welcome-from-sidebar")

        // A third, the choice turned off and the app killed in it: the next launch puts the
        // settings back before anything reads them.
        app.terminate()
        app.launch()
        XCTAssertTrue(welcome.waitForExistence(timeout: 20), "the third tour did not begin")
        openSidebar(app)
        app.buttons["Settings"].tap()
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Settings did not open the third time")
        notifications.tap()
        XCTAssertTrue(needsYou.waitForExistence(timeout: 5), "no notification choices the third time")
        needsYou.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 1)
        XCTAssertNotEqual(needsYou.value as? String, before, "the choice did not change the third time")
        app.terminate()
        app.launch()
        XCTAssertTrue(welcome.waitForExistence(timeout: 20), "the tour after the relaunch did not begin")
        openSidebar(app)
        app.buttons["Settings"].tap()
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Settings did not open after the relaunch")
        notifications.tap()
        XCTAssertTrue(needsYou.waitForExistence(timeout: 5), "no notification choices after the relaunch")
        XCTAssertEqual(needsYou.value as? String, before, "the choice changed in a demo the app was killed in outlasted it")
        shot("17-choice-put-back-after-kill")
        note("done")
    }

    /// Slides the chat aside, by the sidebar button's place (an element tap on it does
    /// nothing on a new thread, see BlankUITests), until the composer has moved with it.
    private func openSidebar(_ app: XCUIApplication) {
        let button = app.buttons["Agents and threads"]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "the chat's sidebar button")
        let composer = app.descendants(matching: .any)["composer-field"].firstMatch
        func isOut() -> Bool { composer.exists && composer.frame.minX > app.frame.width / 3 }
        for _ in 0..<3 where !isOut() {
            button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            for _ in 0..<10 where !isOut() { Thread.sleep(forTimeInterval: 0.2) }
        }
        XCTAssertTrue(isOut(), "the sidebar did not open")
    }
}
