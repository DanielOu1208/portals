import XCTest

/// A visual given up on (`WidgetFailure`) and its Try again (2026-10-22: "have try
/// again but the button shouldnt reprompt the prompt that started the thread should just
/// prompt to retry visual"), in the Portals app installed in the simulator (a build with
/// DEBUG, for the launch switches) against the scripted agent's page whose script never
/// ends (`PORTALS_FAKE=widgets`, "stuck"). Notes and pictures go to
/// /private/tmp/portals-n8/live/visuals/ui (made if missing). Run as the file's neighbours
/// are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/VisualsUITests
///
/// For the dark look, `xcrun simctl ui <simulator> appearance dark` first.
final class VisualsUITests: XCTestCase {
    private let folder = "/private/tmp/portals-n8/live/visuals/ui"

    override func setUpWithError() throws {
        continueAfterFailure = true
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }

    private func launch(prompt: String) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_FAKE": "widgets", "PORTALS_DEBUG_PROMPT": prompt]
        app.launch()
        return app
    }

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        let look = ProcessInfo.processInfo.environment["PORTALS_UITEST_LOOK"] ?? "look"
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name)-\(look).png"))
    }

    private func any(_ app: XCUIApplication, _ identifier: String) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(identifier: identifier)
    }

    /// The scripted reply's last words, once per reply: a second reply would mean the
    /// message was sent again.
    private func replies(_ app: XCUIApplication) -> Int {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "gives up on it after a while", "gives up on it after a while")).count
    }

    /// The page whose script never ends is given up on ("Visual stopped responding", about
    /// 13 s after it is drawn: 10 s of loading, 3 s to answer): a card in its place with
    /// Try again. Try again draws the visual again, the orb over it, sending nothing (still
    /// one reply); it is given up on again and the card comes back. Its source is a menu
    /// away.
    func testTryAgainDrawsOnlyTheVisualAgain() {
        let app = launch(prompt: "stuck")
        let card = any(app, "widget-given-up").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 60), "never given up on")
        shot("given-up")
        XCTAssertTrue(card.label.contains("Visual stopped responding"), "card says: \(card.label)")
        let repliesBefore = replies(app)
        note("replies before Try again: \(repliesBefore)")

        // The source, a menu away.
        any(app, "widget-menu").firstMatch.tap()
        let show = app.buttons["Show Source"]
        XCTAssertTrue(show.waitForExistence(timeout: 5), "no Show Source")
        show.tap()
        let source = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "for (;;)")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 5), "source not shown")
        shot("source-shown")

        let tryAgain = any(app, "widget-try-again").firstMatch
        XCTAssertTrue(tryAgain.exists, "no Try again")
        tryAgain.tap()
        let tappedAt = Date()
        // The card goes, the visual drawn again in its place.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: any(app, "widget-given-up").firstMatch)
        waitForExpectations(timeout: 5)
        shot("tried-again")
        XCTAssertTrue(any(app, "widget-expand").firstMatch.exists, "the visual is not back")
        // The orb in the room a visual being drawn has (120 points under its title line),
        // not over the words below a page that measured a line before it stopped.
        let expand = any(app, "widget-expand").firstMatch.frame
        let after = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "gives up on it after a while")).firstMatch.frame
        note("drawn again: title line at \(expand.midY), the words after it at \(after.minY)")
        XCTAssertGreaterThanOrEqual(after.minY - expand.maxY, 120, "the visual drawn again is too short for its orb")

        // Given up on again: the card comes back, and nothing was sent.
        XCTAssertTrue(any(app, "widget-given-up").firstMatch.waitForExistence(timeout: 40), "not given up on again")
        note(String(format: "given up on again %.1f s after Try again", Date().timeIntervalSince(tappedAt)))
        shot("given-up-again")
        XCTAssertEqual(any(app, "widget-given-up").count, 1, app.debugDescription)
        XCTAssertEqual(replies(app), repliesBefore, "a message went to the agent")
        // Still the one message sent at launch.
        Thread.sleep(forTimeInterval: 3)
        XCTAssertEqual(replies(app), repliesBefore, "a message went to the agent")
        if replies(app) != repliesBefore { note(app.debugDescription) }
        // The page's process keeps a core busy for as long as the app runs (WebKit gives no
        // way to end it): not left running after the test.
        app.terminate()
    }

    /// Try again is offered three times (2026-10-22: "maybe after like 3 tries"):
    /// given up on a fourth time, the card says it was tried three times, with no button,
    /// and still nothing went to the agent.
    func testTryAgainStopsAfterThreeTries() {
        let app = launch(prompt: "stuck")
        XCTAssertTrue(any(app, "widget-given-up").firstMatch.waitForExistence(timeout: 60), "never given up on")
        let repliesBefore = replies(app)
        for attempt in 1...3 {
            let tryAgain = any(app, "widget-try-again").firstMatch
            XCTAssertTrue(tryAgain.waitForExistence(timeout: 5), "no Try again on attempt \(attempt)")
            tryAgain.tap()
            let gone = NSPredicate(format: "exists == false")
            expectation(for: gone, evaluatedWith: any(app, "widget-given-up").firstMatch)
            waitForExpectations(timeout: 5)
            XCTAssertTrue(any(app, "widget-given-up").firstMatch.waitForExistence(timeout: 40), "not given up on again after attempt \(attempt)")
            note("given up on again after attempt \(attempt)")
        }
        shot("tried-out")
        XCTAssertFalse(any(app, "widget-try-again").firstMatch.exists, "Try again still offered after three tries")
        XCTAssertTrue(any(app, "widget-tried-out").firstMatch.exists, "the card does not say it was tried")
        XCTAssertEqual(replies(app), repliesBefore, "a message went to the agent")
        app.terminate()
    }

    /// A visual whose page's process keeps ending while it is shown ("Visual could not be
    /// drawn", three endings within two minutes): Try again draws it again and, its
    /// process left alone, it stays drawn. Needs the processes ended from outside, as the
    /// night run's live/visuals/kill-webcontent.sh does for the simulator it is given
    /// (start it with the test); skipped unless `PORTALS_UITEST_KILLS` is set (pass it as
    /// `TEST_RUNNER_PORTALS_UITEST_KILLS=1`).
    func testTryAgainAfterItsProcessKeptEnding() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PORTALS_UITEST_KILLS"] != nil, "nothing ends the page's process")
        let app = launch(prompt: "savings")
        let card = any(app, "widget-given-up").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 90), "never given up on")
        shot("ended-given-up")
        XCTAssertTrue(card.label.contains("Visual could not be drawn"), "card says: \(card.label)")
        // The killer stops 40 s after it started.
        Thread.sleep(forTimeInterval: 30)
        any(app, "widget-try-again").firstMatch.tap()
        XCTAssertTrue(any(app, "widget-expand").firstMatch.waitForExistence(timeout: 5), "the visual is not back")
        // Drawn: the page's own words, which only its script writes ("After ten years:
        // $…"), reach the screen.
        let drawn = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ OR value BEGINSWITH %@", "$", "$")).firstMatch
        XCTAssertTrue(drawn.waitForExistence(timeout: 15), "the visual was not drawn again")
        // Past the look at a page still loading (10 s) and its answer (3 s).
        Thread.sleep(forTimeInterval: 15)
        shot("ended-tried-again")
        XCTAssertFalse(any(app, "widget-given-up").firstMatch.exists, "given up on again with its process left alone")
    }

    /// Opens a visual expanded and closes it, three times, slowly enough to see each move,
    /// for a screen recording made from outside (the night run's live/visuals/expand-rec.sh,
    /// `simctl io recordVideo`), stepped through frame by frame for a flash as the page moves
    /// into the expanded view and back (`WidgetHostView.pageArrived`). Skipped unless
    /// `PORTALS_UITEST_EXPAND` is set (to the prompt: "savings", "chart").
    func testExpandAndCloseForARecording() throws {
        let prompt = ProcessInfo.processInfo.environment["PORTALS_UITEST_EXPAND"] ?? ""
        try XCTSkipIf(prompt.isEmpty, "no recording asked for")
        let app = launch(prompt: prompt)
        let expand = any(app, "widget-expand").firstMatch
        XCTAssertTrue(expand.waitForExistence(timeout: 40), "no visual")
        Thread.sleep(forTimeInterval: 4)
        for round in 1...3 {
            note("expand \(round) at \(Date().timeIntervalSince1970)")
            expand.tap()
            let done = any(app, "widget-done").firstMatch
            XCTAssertTrue(done.waitForExistence(timeout: 5), "not expanded")
            Thread.sleep(forTimeInterval: 2)
            if round == 1 { shot("expanded") }
            note("close \(round) at \(Date().timeIntervalSince1970)")
            done.tap()
            Thread.sleep(forTimeInterval: 2.5)
        }
        shot("closed")
    }
}
