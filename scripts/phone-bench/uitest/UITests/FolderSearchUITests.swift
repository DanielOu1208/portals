import XCTest

/// The folder sheet's search keeps the keyboard while it is typed in (2026-10-27:
/// "when we enter one character the keyboard disappears"): a query typed a letter at a
/// time, deleted, and a path typed as in a terminal (`~/cod/por`), the field keeps the
/// keyboard throughout, until a folder found is picked and the sheet goes. Against a
/// scratch bridge with the fake agent and `folder_search`, whose home has
/// `coding_projects/Portals` in it. Skipped unless its folder,
/// `/private/tmp/portals-folders/uitest-<simulator>/`, has `plan.txt`:
///
///     <bundle id of the Portals copy installed in the simulator>
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///
/// Writes pictures of the screen there. Run as the file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/FolderSearchUITests
final class FolderSearchUITests: XCTestCase {
    private let folder = "/private/tmp/portals-folders/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func launch() throws -> XCUIApplication {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the folder search")
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map(String.init)
        try XCTSkipUnless(lines.count >= 2, "plan.txt needs two lines")
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1], "PORTALS_DEBUG_FOLDERS": "fake"]
        app.launch()
        return app
    }

    /// The field has the keyboard, and the keyboard is up, a moment after `what`: long
    /// enough for the host to answer and the sheet to show what it found.
    private func assertTyping(in field: XCUIElement, of app: XCUIApplication, after what: String, line: UInt = #line) {
        Thread.sleep(forTimeInterval: 0.8)
        let focused = field.value(forKey: "hasKeyboardFocus") as? Bool ?? false
        // An iPad's keyboard folds to a bar of suggestions once keys come as from a
        // hardware keyboard, as XCTest types them: there the field's focus is what tells.
        let isUp = UIDevice.current.userInterfaceIdiom == .pad || app.keyboards.firstMatch.exists
        if !focused || !isUp { shot("lost-after-\(what.filter { $0.isLetter || $0.isNumber })") }
        XCTAssertTrue(focused, "the search field lost the keyboard after \(what)", line: line)
        XCTAssertTrue(isUp, "the keyboard went away after \(what)", line: line)
    }

    private func type(_ text: String, in field: XCUIElement, of app: XCUIApplication, line: UInt = #line) {
        for letter in text {
            field.typeText(String(letter))
            assertTyping(in: field, of: app, after: "typing \u{201C}\(letter)\u{201D} of \u{201C}\(text)\u{201D}", line: line)
        }
    }

    func testTheSearchFieldKeepsTheKeyboardUntilAFolderIsPicked() throws {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let app = try launch()
        // The first failure says why; what follows it would only fail for the same reason.
        continueAfterFailure = false

        let field = app.textFields["folder-search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no folder sheet with a search field")
        Thread.sleep(forTimeInterval: 1)
        field.tap()
        assertTyping(in: field, of: app, after: "a tap on the field")
        shot("1-empty")

        // A word, a letter at a time: the list gives way to what the host finds.
        type("portals", in: field, of: app)
        XCTAssertTrue(app.buttons["folder-hit-coding_projects/Portals"].waitForExistence(timeout: 5), "Portals not found for \u{201C}portals\u{201D}")
        shot("2-portals")

        // Deleted a letter at a time, back to the list.
        for left in (0 ..< 7).reversed() {
            field.typeText(XCUIKeyboardKey.delete.rawValue)
            assertTyping(in: field, of: app, after: "deleting down to \(left) letters")
        }
        // An empty field's value is its prompt.
        let left = field.value as? String ?? ""
        XCTAssertTrue(left.isEmpty || left == field.placeholderValue, "the field is not empty: \(left)")

        // A path, as typed in a terminal.
        type("~/cod/por", in: field, of: app)
        let portals = app.buttons["folder-hit-coding_projects/Portals"]
        XCTAssertTrue(portals.waitForExistence(timeout: 5), "Portals not found for ~/cod/por")
        assertTyping(in: field, of: app, after: "the path's folders came")
        shot("3-path")

        // A pick ends it: the sheet goes, and the thread starts in Portals.
        portals.tap()
        XCTAssertTrue(app.descendants(matching: .any)["folder-sheet"].waitForNonExistence(timeout: 10), "the sheet stayed after a pick")
        shot("4-picked")
    }

    /// Cancel, in the sheet's own frame (`PanelChrome`), closes it with the keyboard up.
    func testCancelClosesTheSheet() throws {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let app = try launch()
        continueAfterFailure = false

        let field = app.textFields["folder-search-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no folder sheet with a search field")
        Thread.sleep(forTimeInterval: 1)
        field.tap()
        field.typeText("por")
        assertTyping(in: field, of: app, after: "typing \u{201C}por\u{201D}")
        let cancel = app.buttons["folder-sheet-cancel"]
        XCTAssertTrue(cancel.exists, "no Cancel")
        // Once the sheet has held still for a second (two looks in a row): on an iPad it
        // moves up for the keyboard a moment after the first keys, and a tap while it
        // moves is the system's to drop.
        var frame = cancel.frame
        var still = 0
        for _ in 0 ..< 20 where still < 2 {
            Thread.sleep(forTimeInterval: 0.5)
            still = cancel.frame == frame ? still + 1 : 0
            frame = cancel.frame
        }
        cancel.tap()
        let gone = app.descendants(matching: .any)["folder-sheet"].waitForNonExistence(timeout: 10)
        if !gone { shot("cancel-stayed") }
        XCTAssertTrue(gone, "the sheet stayed after Cancel")
    }
}
