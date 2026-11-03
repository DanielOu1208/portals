import XCTest

/// Checks the bubble of a message another agent or a script sent into a thread
/// (`RelayedMessageRow`, a bubble on your side since 2026-10-20) in the Portals app
/// installed in the simulator (`com.danielou.portals`, a build for the simulator with the
/// launch switches), against the scripted agent: that it ends where your own message
/// ends and is as small as its text, that a long one opens and closes, and that its
/// height holds while a reply streams under it. Skipped unless its folder,
/// `/private/tmp/portals-relayed/uitest-<simulator>/`, is there; it writes its notes and
/// pictures of the screen there. Run with
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/RelayedUITests
final class RelayedUITests: XCTestCase {
    private let folder = "/private/tmp/portals-relayed/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private static let short = "[Portals: from the command line]\nRun the tests"
    private static let medium = "[Portals: from Claude Code · \"Fix the login\" (thread 01a1)]\n**Done.** The login works again. I ran `npm test` in `bridge/`:\n\n- 1,362 passed, **0 failed**\n- the fix is in `src/auth.ts`\n\nNext: _check it on the phone_."
    private static let long = "[Portals: from Codex · \"Review the bridge\" (thread 7f2e) on mbp16]\n## Review\nI read the whole of `bridge/src/sessions`. **Three things** to fix before the merge:\n\n1. `fileRead.ts` follows a link out of the folder when the real path is checked after the open.\n2. The queue drops a message sent while a steer is in flight.\n3. A thread renamed twice keeps the first title in the sidebar of the other Mac.\n\nAnd two smaller ones:\n\n- the log says *started* twice\n- `npm test` leaves a socket behind in `/tmp`\n\nI can fix all of them on a branch if you want."

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: folder), "no folder for the relayed checks")
        continueAfterFailure = true
    }

    private func launch(_ environment: [String: String]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = environment
        app.launch()
        return app
    }

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// A short one, then a message of yours: both end at the same right edge, and the
    /// relayed one is as small as its text.
    func testShortOneIsASmallBubbleOnTheRight() {
        let app = launch(["PORTALS_FAKE": "greeting", "PORTALS_DEBUG_PROMPT": Self.short, "PORTALS_DEBUG_THEN": "Thanks. Lint it too."])
        let row = app.descendants(matching: .any)["relayed-message"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no relayed row")
        let yours = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'You: '")).firstMatch
        XCTAssertTrue(yours.waitForExistence(timeout: 40), "no message of yours")
        Thread.sleep(forTimeInterval: 3)
        let window = app.windows.firstMatch.frame
        let bubble = row.frame
        note("short: row \(bubble) yours \(yours.frame) window \(window) label \(row.label)")
        XCTAssertEqual(bubble.maxX, yours.frame.maxX, accuracy: 1, "not on the right as yours is")
        XCTAssertGreaterThan(bubble.minX - window.minX, window.width / 2, "not as small as its text")
        XCTAssertTrue(row.label.hasPrefix("From the command line: Run the tests"), "label \(row.label)")
        shot("short")
    }

    /// A long one: cut short at first, taller once opened (its Show less further down),
    /// as it was once closed again. The row's own frame is no help here: the text cut
    /// short is all there for VoiceOver.
    func testLongOneOpensAndCloses() {
        let app = launch(["PORTALS_FAKE": "thinking", "PORTALS_DEBUG_PROMPT": Self.long])
        let row = app.descendants(matching: .any)["relayed-message"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no relayed row")
        Thread.sleep(forTimeInterval: 2)
        let window = app.windows.firstMatch.frame
        let more = app.buttons["relayed-message-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 5), "no Show all")
        // Where it is in the row, which the chat may scroll.
        let closed = more.frame.offsetBy(dx: 0, dy: -row.frame.minY)
        note("long closed: row \(row.frame) Show all \(closed) label \(more.label) window \(window)")
        XCTAssertGreaterThan(row.frame.minX - window.minX, 40, "not inset on the left")
        XCTAssertEqual(more.label, "Show all")
        shot("long-closed")
        more.tap()
        Thread.sleep(forTimeInterval: 1.5)
        let open = more.frame.offsetBy(dx: 0, dy: -row.frame.minY)
        note("long open: row \(row.frame) Show less \(open) label \(more.label)")
        XCTAssertEqual(more.label, "Show less")
        XCTAssertGreaterThan(open.minY, closed.minY + 40, "did not open")
        XCTAssertEqual(open.minX, closed.minX, accuracy: 1, "moved sideways")
        shot("long-open")
        more.tap()
        Thread.sleep(forTimeInterval: 1.5)
        let again = more.frame.offsetBy(dx: 0, dy: -row.frame.minY)
        note("long closed again: Show all \(again)")
        XCTAssertEqual(again.minY, closed.minY, accuracy: 1, "not as it was once closed again")
        XCTAssertEqual(more.label, "Show all")
    }

    /// Its height while the reply under it streams, slowly: the same at every look, while
    /// the reply's grows.
    func testHeightHoldsWhileAReplyStreamsUnderIt() {
        let app = launch(["PORTALS_FAKE": "greeting", "PORTALS_FAKE_PACE": "150", "PORTALS_DEBUG_PROMPT": Self.medium])
        let row = app.descendants(matching: .any)["relayed-message"]
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no relayed row")
        let reply = app.descendants(matching: .any)["reply-text"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "no reply")
        var heights: [CGFloat] = []
        var replyHeights: [CGFloat] = []
        for index in 0..<24 {
            heights.append(row.frame.height)
            replyHeights.append(reply.frame.height)
            if index == 6 { shot("streaming") }
            Thread.sleep(forTimeInterval: 0.25)
        }
        note("streaming: row heights \(heights.map { Int($0) }) reply heights \(replyHeights.map { Int($0) })")
        XCTAssertGreaterThan(Set(replyHeights).count, 1, "the reply did not grow while it was looked at")
        XCTAssertEqual(Set(heights).count, 1, "the row's height changed: \(heights)")
    }
}
