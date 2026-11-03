import XCTest

/// The composer with a long message on an iPhone or an iPad (`ChatComposer`), in the
/// Portals app installed in the simulator (a build for the simulator with the launch
/// switches) against the scripted agent: typed line by line and wrapped past the
/// composer's tallest, then edited in the middle, deleted back, pasted, and put back as a
/// draft. 2026-10-22: "a bit glitchy … like the last line isnt show properly and
/// jumps around a bit sometimes". Notes and pictures of the screen go to
/// /private/tmp/portals-n8/live/composer/ui-<simulator>/. Run as the file's neighbours are:
///
///     xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj \
///       -scheme UITests -destination 'generic/platform=iOS Simulator' -derivedDataPath <dd>
///     xcodebuild test-without-building -xctestrun <dd>/Build/Products/UITests_*.xctestrun \
///       -destination id=<simulator> -only-testing:UITests/ComposerUITests
final class ComposerUITests: XCTestCase {
    private let folder = "/private/tmp/portals-n8/live/composer/ui-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    override func setUpWithError() throws {
        continueAfterFailure = true
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }

    private func launch(_ more: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        try? FileManager.default.removeItem(atPath: probePath)
        probeRead = 0
        app.launchEnvironment = more.merging([
            "PORTALS_FAKE": "greeting", "PORTALS_DEBUG_PROMPT": "Hi", "PORTALS_DEBUG_COMPOSER_PROBE": probePath,
        ]) { $1 }
        app.launch()
        return app
    }

    private var probePath: String {
        "\(folder)/caret-" + name.filter { $0.isLetter || $0.isNumber } + ".jsonl"
    }
    private var probeRead = 0

    /// What the probe saw of the caret since the last look: every frame it was not
    /// wholly in view, and every frame it moved with the text unchanged (scrolled).
    private struct Seen {
        var frames = 0
        var hidden = 0
        var scrolled = 0
        var lastIn = true
    }

    private func probe() -> Seen {
        let file = try? String(contentsOfFile: probePath, encoding: .utf8)
        XCTAssertNotNil(file, "no probe file: is the app a build that reads the launch switches?")
        let lines = (file ?? "").split(separator: "\n")
        var seen = Seen()
        var previous: (len: Int, caret: Double)?
        if probeRead > 0, probeRead <= lines.count,
           let last = try? JSONSerialization.jsonObject(with: Data(lines[probeRead - 1].utf8)) as? [String: Any],
           let len = last["len"] as? Int, let caret = last["caret"] as? [Double] {
            previous = (len, caret[0])
        }
        for line in lines.dropFirst(probeRead) {
            guard let frame = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let len = frame["len"] as? Int, let caret = frame["caret"] as? [Double], let isIn = frame["in"] as? Bool else { continue }
            seen.frames += 1
            if !isIn { seen.hidden += 1 }
            if let previous, previous.len == len, abs(previous.caret - caret[0]) > 0.5 { seen.scrolled += 1 }
            previous = (len, caret[0])
            seen.lastIn = isIn
        }
        probeRead = lines.count
        return seen
    }

    /// The caret's line stayed in view all through the step, and ended there.
    private func checkCaret(_ step: String) {
        let seen = probe()
        note("  \(step): \(seen.frames) frames, caret hidden in \(seen.hidden), scrolled in \(seen.scrolled), in view at the end \(seen.lastIn)")
        // Every step types or moves the caret: no frame seen means no probe.
        XCTAssertGreaterThan(seen.frames, 0, "\(step): the probe saw no frame")
        XCTAssertEqual(seen.hidden, 0, "\(step): the caret's line was cut or hidden in \(seen.hidden) frames")
        XCTAssertTrue(seen.lastIn, "\(step): the caret's line is not in view")
    }

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func field(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["composer-field"].firstMatch
    }

    private func ready(_ app: XCUIApplication) -> XCUIElement {
        let field = field(app)
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        // The scripted reply has ended.
        Thread.sleep(forTimeInterval: 4)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10), "no keyboard")
        Thread.sleep(forTimeInterval: 1)
        return field
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private func describe(_ app: XCUIApplication, _ step: String) {
        let field = field(app)
        let keyboard = app.keyboards.firstMatch
        let send = app.buttons["send"].firstMatch
        note("\(step): field \(field.frame) send \(send.frame) keyboard \(keyboard.exists ? keyboard.frame : .zero)")
    }

    /// Line by line past the composer's tallest, then wrapped.
    func testTypingLineByLine() {
        let app = launch()
        let field = ready(app)
        _ = probe()
        note("--- line by line")
        for line in 1...9 {
            if line > 1 {
                // Return, and a moment before the next key: the new line is in view
                // before anything is typed on it.
                field.typeText("\n")
                Thread.sleep(forTimeInterval: 0.5)
                checkCaret("return \(line)")
                shot("return-\(line)")
            }
            field.typeText("Line \(line)")
            Thread.sleep(forTimeInterval: 0.6)
            describe(app, "line \(line)")
            checkCaret("line \(line)")
            shot("lines-\(line)")
        }
        field.typeText(" and a long sentence that wraps over the width of the composer once and then twice more")
        Thread.sleep(forTimeInterval: 0.6)
        describe(app, "wrapped")
        checkCaret("wrapped")
        shot("lines-wrapped")
        for step in 1...3 {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12))
            Thread.sleep(forTimeInterval: 0.6)
            describe(app, "deleted \(step)")
            checkCaret("deleted \(step)")
            shot("lines-deleted-\(step)")
        }
    }

    /// Past the composer's tallest, a line put in the middle of what can be seen, then
    /// taken out again.
    func testEditingInTheMiddle() {
        let app = launch()
        let field = ready(app)
        field.typeText((1...10).map { "Line \($0)" }.joined(separator: "\n"))
        Thread.sleep(forTimeInterval: 0.8)
        _ = probe()
        let send = app.buttons["send"].firstMatch.frame
        // Three lines up from the bottom of the text, at the end of the line.
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: send.minX - 40, dy: send.minY - 3.5 * 22))
            .tap()
        Thread.sleep(forTimeInterval: 0.8)
        describe(app, "tapped")
        checkCaret("tapped")
        shot("middle-tapped")
        field.typeText(" and more\nA line put in")
        Thread.sleep(forTimeInterval: 0.8)
        describe(app, "put in")
        checkCaret("put in")
        shot("middle-put-in")
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 23))
        Thread.sleep(forTimeInterval: 0.8)
        describe(app, "taken out")
        checkCaret("taken out")
        shot("middle-taken-out")
        XCTAssertEqual(field.value as? String, (1...10).map { "Line \($0)" }.joined(separator: "\n"), "the text was not put back as it was")
    }

    /// A long text pasted from the edit menu.
    func testPastingALongText() {
        let app = launch()
        let field = ready(app)
        UIPasteboard.general.string = (1...30).map { "Pasted line \($0) of a long text copied from somewhere else" }.joined(separator: "\n")
        _ = probe()
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "no Paste in the edit menu")
        paste.tap()
        Thread.sleep(forTimeInterval: 1.2)
        describe(app, "pasted")
        checkCaret("pasted")
        shot("pasted")
        field.typeText("\n")
        Thread.sleep(forTimeInterval: 0.5)
        checkCaret("return after")
        field.typeText("And a last line typed")
        Thread.sleep(forTimeInterval: 0.8)
        describe(app, "typed after")
        checkCaret("typed after")
        shot("pasted-typed")
    }

    /// The arrow keys (an iPad's keyboard) take the caret up past what can be seen and
    /// back, and Shift-Up selects upward: the text follows the caret, or the selection's
    /// moving end, at once; what is typed up there shows.
    func testArrowKeys() throws {
        try XCTSkipUnless(isPad, "an iPad's check")
        let app = launch()
        let field = ready(app)
        field.typeText((1...12).map { "Line \($0)" }.joined(separator: "\n"))
        Thread.sleep(forTimeInterval: 0.8)
        _ = probe()
        for _ in 1...9 { app.typeKey(XCUIKeyboardKey.upArrow, modifierFlags: []) }
        Thread.sleep(forTimeInterval: 0.8)
        describe(app, "up")
        checkCaret("up")
        shot("keys-up")
        field.typeText("x")
        Thread.sleep(forTimeInterval: 0.5)
        checkCaret("typed up there")
        for _ in 1...9 { app.typeKey(XCUIKeyboardKey.downArrow, modifierFlags: []) }
        Thread.sleep(forTimeInterval: 0.8)
        checkCaret("down")
        shot("keys-down")
        // A selection made upward with Shift: its start moves, and is followed.
        for _ in 1...9 { app.typeKey(XCUIKeyboardKey.upArrow, modifierFlags: .shift) }
        Thread.sleep(forTimeInterval: 0.8)
        checkCaret("selected up")
        shot("keys-selected-up")
    }

    /// Typing fast past the composer's tallest, for the CPU it costs: the start and end
    /// of the typing go to the notes as Unix times, for a script that samples the app's
    /// CPU time meanwhile (`typing <start> <end>`).
    func testTypingFast() {
        let app = launch(["PORTALS_DEBUG_DRAFT": (1...8).map { "Draft line \($0)" }.joined(separator: "\n")])
        let field = ready(app)
        let text = (1...8).map { "Another line typed fast, number \($0), long enough to wrap once on a phone" }.joined(separator: "\n")
        let start = Date().timeIntervalSince1970
        field.typeText("\n" + text)
        let end = Date().timeIntervalSince1970
        note("typing \(start) \(end) chars \(text.count + 1)")
        shot("fast")
    }

    /// A long draft put back, as it is when the thread is opened again.
    func testDraftPutBack() {
        let draft = (1...12).map { "Draft line \($0)" }.joined(separator: "\n")
        let app = launch(["PORTALS_DEBUG_DRAFT": draft, "PORTALS_DEBUG_FOCUS": "1"])
        let field = field(app)
        XCTAssertTrue(field.waitForExistence(timeout: 30), "no composer")
        Thread.sleep(forTimeInterval: 5)
        describe(app, "draft")
        shot("draft")
        _ = probe()
        field.typeText("\n")
        Thread.sleep(forTimeInterval: 0.5)
        checkCaret("draft return")
        field.typeText("One more")
        Thread.sleep(forTimeInterval: 0.6)
        describe(app, "draft typed")
        checkCaret("draft typed")
        shot("draft-typed")
    }
}
