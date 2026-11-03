import XCTest

/// Checks the foot of a chat whose agent started threads, and the threads it started
/// (n14/foot, Dana's asks of 2026-10-27): the closed line counts what works with no
/// "tasks" in it and has one small icon for the subagents and one for the workflows at
/// work; a managed thread opened from it is not put in the sidebar's Running or Recent;
/// and its chat has a back button that opens the thread that started it.
///
/// Against a scratch bridge with the fake agent, where the starting thread runs `crew
/// long` and has started threads (`portals start` with `PORTALS_THREAD`), one of them at
/// work. Skipped unless its folder, `/private/tmp/n14-foot/uitest-<simulator>/`, has
/// `plan.txt`:
///
///     <bundle id of the Portals copy installed in the simulator>
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///     <title of the starting thread>
///     <id of the started thread to open, one at work>
///     <words of its title or its first message>
///     <optional: the kinds the starting thread's closed line has an icon for, "Subagents,Workflows">
///     <optional: the id of the starting thread, for testTakeOverFromATab>
///
/// Writes notes.txt and pictures of the screen there. `testClosedLineOverTime` instead
/// opens the starting thread and takes a picture of the closed line every `PORTALS_SHOT_EVERY`
/// seconds (15), `PORTALS_SHOTS` times (8), as its kinds end one after the other; with
/// `PORTALS_STOP_WORKFLOW`, it stops the crew's workflow after the first, which leaves
/// the subagents at work alone (the crew's workflow outlasts its agents). Both from the
/// test runner's environment (`TEST_RUNNER_PORTALS_…` for xcodebuild).
///
/// `testTakeOverFromTheFootLine` takes the started thread over from its row on the line
/// and hides it again (2026-10-27: Show in sidebar is "Take over thread" now);
/// `testTakeOverFromATab`, on an iPad, does from its tab's menu what Show in Its Folder
/// could not, a managed thread being in no folder.
///
/// `testFinishedCommandClearsByItself` opens the thread the plan's third line names (words
/// of its first message), whose agent left a command running in the background and goes
/// on replying (the fake agent's `bgcommand slow`): once the command is done, it shows so
/// for a moment and leaves the line by itself, the turn still running (2026-10-27:
/// "completed background tasks just clear by themselves even before the turn ends"). With
/// the thread's id on the plan's seventh line, it is opened as the app starts
/// (`PORTALS_DEBUG_OPEN_PLAN`), not from the sidebar, which may list a new thread late. With
/// `crew slow`, the agents and the workflow that ended stay: the title counts one fewer.
final class ManagedThreadUITests: XCTestCase {
    private let folder = "/private/tmp/n14-foot/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// The kinds the closed line has a small icon for, as VoiceOver reads them after its title.
    private static let kinds = ["Subagents", "Workflows"]

    private func kinds(in label: String) -> Set<String> {
        Set(Self.kinds.filter { label.contains(", \($0)") })
    }

    /// The closed line is one line, inside the screen's width.
    private func checkOneLine(_ line: XCUIElement, in app: XCUIApplication) {
        XCTAssertLessThanOrEqual(line.frame.maxX, app.frame.maxX, "the line runs past the screen: \(line.frame)")
        XCTAssertLessThan(line.frame.height, 40, "the line takes more than one line: \(line.frame)")
    }

    private func plan() throws -> [String] {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the managed threads")
        // Empty lines kept: the sixth may be, with a seventh after it.
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        try XCTSkipUnless(lines.count >= 5, "plan.txt needs five lines")
        return lines
    }

    private func launch(_ lines: [String]) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1]]
        app.launch()
        return app
    }

    /// The composer slid aside with the chat: the sidebar is out.
    private func sidebarIsOut(_ app: XCUIApplication) -> Bool {
        let composer = app.textFields["composer-field"]
        return composer.exists && composer.frame.minX > app.frame.width / 3
    }

    /// Opens the sidebar by its button's place (an element tap on it does nothing on the
    /// new thread the app opens to, see BlankUITests).
    private func openSidebar(_ app: XCUIApplication) {
        let button = app.buttons["Agents and threads"]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "the chat's sidebar button")
        for _ in 0..<3 where !sidebarIsOut(app) {
            button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            for _ in 0..<10 where !sidebarIsOut(app) { Thread.sleep(forTimeInterval: 0.2) }
        }
        XCTAssertTrue(sidebarIsOut(app), "the sidebar did not open")
        Thread.sleep(forTimeInterval: 0.8)
    }

    /// The sidebar's group titles and thread rows, top to bottom, for the notes.
    private func listSidebar(_ app: XCUIApplication, _ heading: String) {
        note("== \(heading)")
        var lines: [(CGFloat, String)] = []
        for title in ["Needs you", "Running", "Recent"] {
            let text = app.staticTexts[title]
            if text.exists { lines.append((text.frame.minY, "[\(title)]")) }
        }
        let rows = app.buttons.matching(identifier: "thread-row")
        for index in 0..<rows.count {
            let row = rows.element(boundBy: index)
            if row.exists, row.frame.minX < app.frame.width / 2 { lines.append((row.frame.minY, "  row: \(row.label)")) }
        }
        for line in lines.sorted(by: { $0.0 < $1.0 }) { note("\(Int(line.0)) \(line.1)") }
    }

    /// The sidebar's rows for a thread whose title or first message has `words`, in the
    /// sidebar itself (its left part), not in the chat.
    private func sidebarRows(_ words: String, in app: XCUIApplication) -> [XCUIElement] {
        let rows = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", words))
        return (0..<rows.count).map { rows.element(boundBy: $0) }.filter { $0.exists && $0.frame.minX < app.frame.width / 2 }
    }

    /// Back to the chat from the sidebar slid out over it, by a tap on its part still in sight.
    private func closeSidebar(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        for _ in 0..<10 where sidebarIsOut(app) { Thread.sleep(forTimeInterval: 0.2) }
        Thread.sleep(forTimeInterval: 0.6)
    }

    private func openThread(titled title: String, in app: XCUIApplication) {
        openSidebar(app)
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(title)")
        row.tap()
        Thread.sleep(forTimeInterval: 3)
    }

    func testManagedThreadFromTheFootLine() throws {
        let lines = try plan()
        continueAfterFailure = true
        let app = launch(lines)
        let parent = lines[2], child = lines[3], childTitle = lines[4]

        openSidebar(app)
        listSidebar(app, "sidebar before")
        shot("10-sidebar-before")
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", parent)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "no row for \(parent)")
        row.tap()
        Thread.sleep(forTimeInterval: 3)

        // The line, closed: its title and what VoiceOver hears of its icons.
        let line = app.buttons["foot-line"]
        XCTAssertTrue(line.waitForExistence(timeout: 10), "no line at the foot of the chat")
        note("line: \(line.label)")
        XCTAssertFalse(line.label.contains("tasks"), "the line still says tasks: \(line.label)")
        if lines.count > 5 {
            let expected = Set(lines[5].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
            XCTAssertEqual(kinds(in: line.label), expected, "the kinds' icons: \(line.label)")
        }
        checkOneLine(line, in: app)
        XCTAssertFalse(app.buttons["parent-thread"].exists, "a back button on a thread no agent started")
        shot("11-parent-closed-line")

        // Opened, then the started thread's row.
        line.tap()
        Thread.sleep(forTimeInterval: 0.8)
        shot("12-parent-opened-line")
        let inLine = app.buttons["started-thread-\(child)"]
        XCTAssertTrue(inLine.waitForExistence(timeout: 5), "no row for the started thread in the line")
        note("opening: \(inLine.label)")
        inLine.tap()
        Thread.sleep(forTimeInterval: 3)

        // Its chat, with the back button.
        let back = app.buttons["parent-thread"]
        XCTAssertTrue(back.waitForExistence(timeout: 10), "no back button over the managed thread")
        note("back: \(back.label)")
        XCTAssertTrue(back.label.contains(parent), "the back button does not name the starting thread: \(back.label)")
        shot("13-managed-thread-with-back")

        // The sidebar: the managed thread, a tab now and at work, in neither Running nor Recent.
        openSidebar(app)
        listSidebar(app, "sidebar with the managed thread open")
        let listed = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", childTitle))
        let shown = (0..<listed.count).map { listed.element(boundBy: $0) }.filter { $0.exists && $0.frame.minX < app.frame.width / 2 }
        XCTAssertTrue(shown.isEmpty, "the managed thread is in the sidebar: \(shown.map(\.label))")
        shot("14-sidebar-managed-open")

        // Back to the chat, by a tap on its part still in sight, then the back button.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        for _ in 0..<10 where sidebarIsOut(app) { Thread.sleep(forTimeInterval: 0.2) }
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(back.waitForExistence(timeout: 5), "the back button went")
        back.tap()
        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.buttons["parent-thread"].exists, "a back button on the starting thread")
        XCTAssertTrue(app.buttons["foot-line"].waitForExistence(timeout: 5), "not back on the starting thread: no foot line")
        note("back on: \(app.buttons["foot-line"].label)")
        shot("15-back-on-parent")
    }

    func testTakeOverFromTheFootLine() throws {
        let lines = try plan()
        continueAfterFailure = true
        let app = launch(lines)
        let child = lines[3], words = lines[4]
        openThread(titled: lines[2], in: app)
        let line = app.buttons["foot-line"]
        XCTAssertTrue(line.waitForExistence(timeout: 10), "no line at the foot of the chat")
        line.tap()
        Thread.sleep(forTimeInterval: 0.8)

        // Its row's action, by its one name, and its undo.
        let takeOver = app.buttons["started-thread-share-\(child)"]
        XCTAssertTrue(takeOver.waitForExistence(timeout: 5), "no Take over thread on the started thread's row")
        XCTAssertEqual(takeOver.label, "Take over thread", "the action's name on the row")
        shot("30-take-over-offered")
        takeOver.tap()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(takeOver.label, "Hide from sidebar", "its undo's name, once taken over")
        note("taken over: \(app.buttons["started-thread-\(child)"].label)")
        shot("31-taken-over")

        // In the sidebar now, on every device.
        openSidebar(app)
        listSidebar(app, "sidebar with the thread taken over")
        XCTAssertFalse(sidebarRows(words, in: app).isEmpty, "the thread taken over is not in the sidebar")
        shot("32-sidebar-taken-over")

        // Hidden again: out of the sidebar, its action offered again.
        closeSidebar(app)
        if !takeOver.exists { line.tap() }
        XCTAssertTrue(takeOver.waitForExistence(timeout: 5), "no Hide from sidebar on the started thread's row")
        takeOver.tap()
        Thread.sleep(forTimeInterval: 2)
        XCTAssertEqual(takeOver.label, "Take over thread", "the action's name once hidden again")
        openSidebar(app)
        listSidebar(app, "sidebar with the thread hidden again")
        XCTAssertTrue(sidebarRows(words, in: app).isEmpty, "the thread hidden again is still in the sidebar")
        shot("33-sidebar-hidden-again")
    }

    /// On an iPad beside its sidebar, where the threads are tabs: the managed thread's tab
    /// menu takes it over, where it offered Show in Its Folder.
    func testTakeOverFromATab() throws {
        let lines = try plan()
        try XCTSkipUnless(lines.count > 6, "plan.txt needs the starting thread's id on its seventh line")
        continueAfterFailure = true
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1], "PORTALS_DEBUG_OPEN_PLAN": "\(lines[6]),\(lines[3]):6"]
        app.launch()
        let words = lines[4]
        let tab = app.descendants(matching: .any)["tab-\(lines[3])"]
        XCTAssertTrue(tab.waitForExistence(timeout: 40), "no tab for the managed thread")
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue(sidebarRows(words, in: app).isEmpty, "the managed thread is in the sidebar before it is taken over")
        tab.press(forDuration: 1.2)
        let takeOver = app.buttons["Take Over Thread"]
        XCTAssertTrue(takeOver.waitForExistence(timeout: 5), "no Take Over Thread in the tab's menu")
        XCTAssertFalse(app.buttons["Show in Its Folder"].exists, "the tab's menu still offers Show in Its Folder")
        shot("40-tab-menu")
        takeOver.tap()
        Thread.sleep(forTimeInterval: 2)
        listSidebar(app, "sidebar after Take Over Thread from the tab")
        XCTAssertFalse(sidebarRows(words, in: app).isEmpty, "the thread taken over from its tab is not in the sidebar")
        shot("41-taken-over-from-tab")
        // Now in its folder, its tab's menu goes there as any thread's.
        tab.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Show in Its Folder"].waitForExistence(timeout: 5), "no Show in Its Folder once taken over")
        shot("42-tab-menu-taken-over")
    }

    func testFinishedCommandClearsByItself() throws {
        let lines = try plan()
        continueAfterFailure = true
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1]]
        if lines.count > 6, !lines[6].isEmpty { app.launchEnvironment["PORTALS_DEBUG_OPEN_PLAN"] = "\(lines[6]):1" }
        app.launch()
        if lines.count <= 6 || lines[6].isEmpty {
            openSidebar(app)
            let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", lines[2])).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 60), "no row for \(lines[2])")
            row.tap()
        }
        let line = app.buttons["foot-line"]
        XCTAssertTrue(line.waitForExistence(timeout: 30), "no line at the foot of the chat")
        note("at first: \(line.label)")
        XCTAssertTrue(line.label.contains("working"), "opened too late to see the command at work: \(line.label)")
        shot("50-command-working")

        // Done: a moment on the line, as done ("1 command done", or with a crew "5 done").
        var doneAt: Date?
        var doneLabel = ""
        for _ in 0..<600 {
            if line.exists, line.label.contains("done") {
                doneAt = .now
                doneLabel = line.label
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTAssertNotNil(doneAt, "the command never showed as done: \(line.exists ? line.label : "no line")")
        note("done: \(doneLabel)")
        shot("51-command-done")

        // Then gone by itself, the turn still running: the line with it when it was alone,
        // else one fewer in the title.
        var clearedAt: Date?
        for _ in 0..<60 {
            if !line.exists || line.label != doneLabel {
                clearedAt = .now
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        Thread.sleep(forTimeInterval: 0.6)
        note("after: \(line.exists ? line.label : "no line")")
        shot("52-command-cleared")
        XCTAssertNotNil(clearedAt, "the finished command is still on the line: \(line.exists ? line.label : "")")
        if let doneAt, let clearedAt {
            let moment = clearedAt.timeIntervalSince(doneAt)
            note("cleared after \(String(format: "%.1f", moment)) s")
            XCTAssertGreaterThan(moment, 1.5, "it left at once, with no moment as done")
        }
        XCTAssertTrue(app.buttons["stop"].exists, "the turn had ended: the check is for one still running")
    }

    /// The sidebar with the starting thread (the plan's third line) under Running after its
    /// own turn, a thread started from it working on (2026-10-27: "when there is a
    /// thread, subagent, or workflow working i think the parent thread should also be
    /// working").
    func testStarterRunningWhileItsThreadWorks() throws {
        let lines = try plan()
        continueAfterFailure = true
        let app = launch(lines)
        openSidebar(app)
        let rows = sidebarRows(lines[2], in: app)
        XCTAssertFalse(rows.isEmpty, "no row for \(lines[2])")
        let running = app.staticTexts["Running"]
        XCTAssertTrue(running.waitForExistence(timeout: 10), "no Running in the sidebar")
        let recent = app.staticTexts["Recent"]
        let end = recent.exists && recent.frame.minY > running.frame.minY ? recent.frame.minY : .greatestFiniteMagnitude
        let underRunning = rows.contains { $0.frame.minY > running.frame.minY && $0.frame.minY < end }
        listSidebar(app, "sidebar with the starter's thread at work")
        XCTAssertTrue(underRunning, "the starting thread is not under Running")
        shot("60-starter-running")
    }

    func testClosedLineOverTime() throws {
        let lines = try plan()
        continueAfterFailure = true
        let app = launch(lines)
        openThread(titled: lines[2], in: app)
        let environment = ProcessInfo.processInfo.environment
        let every = environment["PORTALS_SHOT_EVERY"].flatMap(Double.init) ?? 15
        let count = environment["PORTALS_SHOTS"].flatMap(Int.init) ?? 8
        var shown = Set(Self.kinds)
        var stopped = false
        for index in 0..<count {
            let line = app.buttons["foot-line"]
            XCTAssertTrue(line.waitForExistence(timeout: 5), "no line at the foot of the chat")
            note("t\(index): \(line.exists ? line.label : "no line")")
            shot(String(format: "20-closed-%02d", index))
            guard line.exists else { continue }
            checkOneLine(line, in: app)
            // A crew's kinds end and never start again: an icon gone stays gone, and the
            // workflow's goes once it is stopped.
            let now = kinds(in: line.label)
            XCTAssertTrue(now.isSubset(of: shown), "an icon came back: \(line.label)")
            if stopped { XCTAssertFalse(now.contains("Workflows"), "the stopped workflow's icon stayed: \(line.label)") }
            shown = now
            if index == 0, environment["PORTALS_STOP_WORKFLOW"] != nil {
                line.tap()
                let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'subagent-stop-crew-review'")).firstMatch
                XCTAssertTrue(stop.waitForExistence(timeout: 5), "no Stop for the workflow")
                stop.tap()
                Thread.sleep(forTimeInterval: 1)
                line.tap()
                stopped = true
                note("stopped the workflow")
            }
            Thread.sleep(forTimeInterval: every)
        }
    }
}
