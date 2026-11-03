import XCTest

/// The composer's `@` menu (docs/plans/2026-10-26-file-mentions.md, section 8) in the Portals
/// app installed in the simulator (a build for the simulator with the launch switches),
/// against a scratch bridge with the scripted agent whose General folder holds `src/main.ts`,
/// `src/medium.ts` (84,000 bytes), `logs/big.log` (303,000), `my folder/note.txt` and the
/// like, and whose agent stands in for Claude Code's mention limit. Skipped unless its
/// folder, `/private/tmp/n14-mentions/uitest-<simulator>/`, is there, holding `hosts.json`
/// (`PORTALS_DEBUG_HOSTS` for the scratch bridge); it writes pictures of the screen there,
/// and reads what the scripted agent was given from `/private/tmp/n14-mentions/prompts.jsonl`.
/// Run as the file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/MentionsUITests
final class MentionsUITests: XCTestCase {
    private let folder = "/private/tmp/n14-mentions/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")
    private let prompts = "/private/tmp/n14-mentions/prompts.jsonl"

    override func setUpWithError() throws {
        try XCTSkipUnless(FileManager.default.fileExists(atPath: "\(folder)/hosts.json"), "no scratch bridge for the mention checks")
        continueAfterFailure = true
        // A scratch simulator's first send asks to notify: declined, so it covers nothing.
        addUIInterruptionMonitor(withDescription: "notifications") { alert in
            let decline = alert.buttons["Don’t Allow"]
            guard decline.exists else { return false }
            decline.tap()
            return true
        }
    }

    private func launch() throws -> XCUIApplication {
        let hosts = try String(contentsOfFile: "\(folder)/hosts.json", encoding: .utf8)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts]
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func field(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["composer-field"].firstMatch
    }

    /// The composer emptied of a draft an earlier run left in it, the caret at its end.
    private func clear(_ field: XCUIElement) {
        let left = (field.value as? String)?.count ?? 0
        if left > 0 { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: left)) }
    }

    /// The last prompt the scripted agent was given, as the scratch bridge wrote it down.
    private func lastPrompt() -> String {
        let text = (try? String(contentsOfFile: prompts, encoding: .utf8)) ?? ""
        return text.split(separator: "\n").last.map(String.init) ?? ""
    }

    /// With touch, on a phone: the menu at `@`, a query, a file picked, a folder gone into, a
    /// large file's note, the message sent with its mentions, its chips, a chip opened.
    func testAFileIsMentionedByTouch() throws {
        let app = try launch()
        let field = field(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        field.tap()
        clear(field)
        field.typeText("Look at @")
        let menu = app.descendants(matching: .any)["mention-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "no @ menu at @")
        XCTAssertTrue(app.buttons["docs"].waitForExistence(timeout: 5), "the top level is not listed")
        shot("phone-1-menu-top-level")

        field.typeText("ma")
        let main = app.buttons["main.ts, in src"]
        XCTAssertTrue(main.waitForExistence(timeout: 10), "main.ts is not offered for ma")
        shot("phone-2-menu-query")
        main.tap()
        XCTAssertEqual(field.value as? String, "Look at @src/main.ts ")
        XCTAssertFalse(menu.exists, "the menu stayed open after a pick")
        shot("phone-3-token")

        field.typeText("and @sr")
        let src = app.buttons["src"]
        XCTAssertTrue(src.waitForExistence(timeout: 10), "the src folder is not offered")
        src.tap()
        XCTAssertEqual(field.value as? String, "Look at @src/main.ts and @src/")
        XCTAssertTrue(app.buttons["This folder, src"].waitForExistence(timeout: 10), "no row for the folder itself")
        let medium = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'medium.ts, in src. Large file'")).firstMatch
        XCTAssertTrue(medium.waitForExistence(timeout: 10), "medium.ts has no note")
        shot("phone-4-into-folder")
        medium.tap()
        XCTAssertEqual(field.value as? String, "Look at @src/main.ts and @src/medium.ts ")
        shot("phone-5-two-tokens")

        app.buttons["send"].tap()
        let sent = NSPredicate(format: "self CONTAINS 'Look at @src/main.ts and @src/medium.ts'")
        for _ in 0 ..< 40 where !sent.evaluate(with: lastPrompt()) { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertTrue(lastPrompt().contains(#""mentions":["src/main.ts","src/medium.ts"]"#), "the bridge got: \(lastPrompt())")
        // The message is one element to VoiceOver, its note in its label.
        let message = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'You: Look at'")).firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10), "no sent message")
        XCTAssertTrue(message.label.contains("medium.ts: Large file"), "no note on the large file sent: \(message.label)")
        shot("phone-6-sent-chips")

        // Anything the app asks now is answered (the interruption monitor runs on a touch).
        app.swipeDown(velocity: .slow)
        // The chip of main.ts, after "Look at " on the bubble's first line.
        let bubble = app.textViews.matching(NSPredicate(format: "value BEGINSWITH 'Look at'")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "no sent message")
        let line = bubble.frame.height > 30 ? 11.0 : bubble.frame.height / 2
        bubble.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 95, dy: line)).tap()
        let opened = app.buttons["file-viewer-done"].waitForExistence(timeout: 10)
        XCTAssertTrue(opened, "the chip did not open the file: the message's text is at \(bubble.frame)")
        shot("phone-7-chip-opened")
    }

    /// With a keyboard, on an iPad: the arrows move through the rows and Tab picks the one
    /// they are on. Return and Escape are not checked here: XCUITest's `typeKey` gives the
    /// app neither on an iPad simulator (the composer's own Return, which sends with a
    /// keyboard attached, does not send either), while the arrows and Tab arrive.
    func testTheKeyboardWorksTheMenu() throws {
        let app = try launch()
        let field = field(in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        field.tap()
        clear(field)
        field.typeText("See @")
        let menu = app.descendants(matching: .any)["mention-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "no @ menu at @")
        XCTAssertTrue(app.buttons["docs"].waitForExistence(timeout: 5), "the top level is not listed")
        // docs, logs, my folder, src, README.md: the fifth row.
        for _ in 0 ..< 4 { app.typeKey(.downArrow, modifierFlags: []) }
        app.typeKey(.upArrow, modifierFlags: [])
        app.typeKey(.downArrow, modifierFlags: [])
        shot("ipad-1-arrows")
        app.typeKey(.tab, modifierFlags: [])
        XCTAssertEqual(field.value as? String, "See @README.md ")

        field.typeText("and @plan")
        XCTAssertTrue(app.buttons["plan.md, in docs"].waitForExistence(timeout: 10), "plan.md is not offered")
        app.typeKey(.tab, modifierFlags: [])
        XCTAssertEqual(field.value as? String, "See @README.md and @docs/plan.md ")
        shot("ipad-2-tab-picked")
        clear(field)
    }
}
