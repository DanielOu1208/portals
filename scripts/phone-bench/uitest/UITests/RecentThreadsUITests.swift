import XCTest

/// Recent threads across a net (`recent_threads`, docs/sync-plan.md), against scratch bridges
/// with the fake agent (scripts/sidebar-bench/bridge.mts; `recent-threads-tool.mts` plays a
/// third device). The app is started beforehand, with `simctl launch`, and stays as it
/// is between steps, so that two simulators can look at each other's marks while both run.
/// Skipped unless `step.txt` is in its folder (`RECENT_UITEST_FOLDER`, given as
/// `TEST_RUNNER_RECENT_UITEST_FOLDER`, then `uitest-<simulator>`), one command a line:
///
///     open North 3            the thread's row in its Mac's space
///     mac debug-2             that Mac's tab
///     expect-recent North 3   under Recent, within 40 seconds
///     expect-gone North 3     not under Recent, within 40 seconds
///     expect-order A | B | C  exactly these under Recent, in this order
///     expect-count 5          this many rows under Recent, scrolled through
///     expect-no-title         no Recent title, within 40 seconds
///     dismiss North 3         its swipe
///     archive North 3         its menu, the row in its Mac's space
///     off / on / count 25     Settings, Appearance
///     shot name               a picture of the screen
///
/// Writes notes.txt and the pictures there.
final class RecentThreadsUITests: XCTestCase {
    private let folder: String = {
        let environment = ProcessInfo.processInfo.environment
        return (environment["RECENT_UITEST_FOLDER"] ?? "/private/tmp/portals-recent") + "/uitest-" + (environment["SIMULATOR_UDID"] ?? "unknown")
    }()

    private func note(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/notes.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + text + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    /// The system's question about notifications, answered no, wherever it is.
    private func declineNotifications() {
        let decline = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Don’t Allow"]
        if decline.waitForExistence(timeout: 1) { decline.tap() }
    }

    private var app: XCUIApplication { XCUIApplication(bundleIdentifier: "com.danielou.portals") }

    private func any(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// The sidebar in sight: the chat, with its composer, begins to the right of it, beside it
    /// on a wide screen or slid aside.
    private var sidebarIsOut: Bool {
        // An iPad keeps chats behind the one in sight, each with its composer.
        let new = app.buttons["sidebar-new-thread"], composer = app.textFields.matching(identifier: "composer-field").firstMatch
        return new.exists && composer.exists && composer.frame.minX >= new.frame.maxX - 5
    }

    private func showSidebar() {
        declineNotifications()
        for _ in 0..<4 where !sidebarIsOut {
            let button = app.buttons["Agents and threads"]
            if button.waitForExistence(timeout: 10) {
                button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            }
            for _ in 0..<10 where !sidebarIsOut { Thread.sleep(forTimeInterval: 0.2) }
        }
        XCTAssertTrue(sidebarIsOut, "the sidebar did not show")
    }

    /// The rows in the groups on top at the moment, top to bottom.
    private func visibleGroupRows() -> [(row: XCUIElement, label: String)] {
        let groups = any("sidebar-groups")
        guard groups.exists else { return [] }
        let area = groups.frame
        return app.buttons.matching(identifier: "thread-row").allElementsBoundByIndex
            .filter { $0.exists && area.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) }
            .sorted { $0.frame.minY < $1.frame.minY }
            .map { ($0, $0.label) }
    }

    /// The labels under the groups, however many: the ones that do not fit are scrolled to,
    /// and the list goes back to the top after.
    private func allGroupLabels() -> [String] {
        var seen: [String] = []
        var still = 0
        let groups = any("sidebar-groups")
        while still < 2 {
            let before = seen.count
            for item in visibleGroupRows() where !seen.contains(item.label) { seen.append(item.label) }
            still = seen.count == before ? still + 1 : 0
            guard groups.exists else { break }
            // A short slow drag, held at its end: a swipe flings past rows on a phone.
            let from = groups.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            from.press(forDuration: 0.05, thenDragTo: groups.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)), withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        for _ in 0..<4 where groups.exists { groups.swipeDown(velocity: .fast) }
        return seen
    }

    /// The first row of the thread titled so, and not of "North 30" for "North 3".
    private func threadRow(_ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND (label == %@ OR label BEGINSWITH %@)", title, title + ",")).firstMatch
    }

    /// Row labels begin with the thread's title: "North 3, …".
    private func title(of label: String) -> String {
        label.components(separatedBy: ",").first ?? label
    }

    private func recentTitles() -> [String] { allGroupLabels().map(title(of:)) }

    private func waiting(_ what: String, timeout: TimeInterval = 40, until holds: () -> Bool) {
        let start = Date.now
        repeat {
            if holds() {
                note("  ok after \(String(format: "%.1f", Date.now.timeIntervalSince(start))) s: \(what)")
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date.now.timeIntervalSince(start) < timeout
        note("  FAILED: \(what); under Recent now: \(recentTitles())")
        XCTFail(what)
    }

    private func openSettings() {
        showSidebar()
        let button = app.buttons["host-settings"].exists ? app.buttons["host-settings"] : app.buttons["sidebar-connection"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "Settings' button")
        button.tap()
        let section = app.buttons["settings-section-appearance"]
        XCTAssertTrue(section.waitForExistence(timeout: 5), "Appearance in Settings")
        section.tap()
        let toggle = app.switches["shows-recent"]
        for _ in 0..<6 where !(toggle.exists && toggle.isHittable) { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(toggle.waitForExistence(timeout: 3), "the toggle")
    }

    private func closeSettings() {
        // On a phone a part of Settings has only the system's back button; the list has the
        // close button.
        let close = app.buttons["settings-close"]
        if !close.exists, app.navigationBars.buttons.firstMatch.exists { app.navigationBars.buttons.firstMatch.tap() }
        XCTAssertTrue(close.waitForExistence(timeout: 5), "Settings' close button")
        close.tap()
        sleep(1)
    }

    private func setShown(_ shown: Bool) {
        openSettings()
        let toggle = app.switches["shows-recent"]
        if (toggle.value as? String == "1") != shown {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
            sleep(1)
        }
        XCTAssertEqual(toggle.value as? String, shown ? "1" : "0", "the toggle")
        XCTAssertEqual(app.descendants(matching: .any)["recent-count"].exists, shown, "the number comes and goes with the toggle")
        shot(shown ? "settings-on" : "settings-off")
        closeSettings()
    }

    private func setCount(_ count: String) {
        openSettings()
        let picker = any("recent-count")
        XCTAssertTrue(picker.waitForExistence(timeout: 3), "the picker")
        picker.tap()
        // A menu's rows carry the number alone.
        let row = app.buttons[count].exists ? app.buttons[count] : app.descendants(matching: .any)[count]
        XCTAssertTrue(row.waitForExistence(timeout: 3), "the menu's \(count)")
        shot("settings-picker-\(count)")
        row.tap()
        sleep(1)
        closeSettings()
    }

    private func run(_ command: String, _ argument: String) {
        switch command {
        case "open":
            showSidebar()
            let row = threadRow(argument)
            XCTAssertTrue(row.waitForExistence(timeout: 15), "the row of \(argument)")
            row.tap()
            sleep(2)
            declineNotifications()
        case "mac":
            showSidebar()
            let tab = app.buttons["mac-tab-\(argument)"]
            XCTAssertTrue(tab.waitForExistence(timeout: 10), "the tab of \(argument)")
            tab.tap()
            sleep(1)
        case "expect-recent":
            showSidebar()
            waiting("\(argument) under Recent") { visibleGroupRows().contains { title(of: $0.label) == argument } || recentTitles().contains(argument) }
        case "expect-gone":
            showSidebar()
            waiting("\(argument) not under Recent") { !recentTitles().contains(argument) }
        case "expect-order":
            showSidebar()
            let wanted = argument.components(separatedBy: " | ")
            waiting("under Recent: \(wanted)") { recentTitles() == wanted }
        case "expect-count":
            showSidebar()
            guard let count = Int(argument) else { return XCTFail("a number") }
            waiting("\(count) rows under the groups") { allGroupLabels().count == count }
            note("  \(recentTitles())")
        case "expect-no-title":
            showSidebar()
            waiting("no Recent title") { !app.staticTexts["Recent"].exists && !any("sidebar-group-recent").exists }
        case "expect-title":
            showSidebar()
            waiting("a Recent title") { any("sidebar-group-recent").exists }
        case "dismiss":
            showSidebar()
            guard let item = visibleGroupRows().first(where: { title(of: $0.label) == argument }) else { return XCTFail("\(argument) is not there to dismiss") }
            item.row.swipeLeft(velocity: .fast)
            sleep(1)
        case "archive":
            showSidebar()
            let row = threadRow(argument)
            XCTAssertTrue(row.waitForExistence(timeout: 15), "the row of \(argument)")
            row.press(forDuration: 0.9)
            let archive = app.buttons["Archive"]
            XCTAssertTrue(archive.waitForExistence(timeout: 5), "Archive in its menu")
            archive.tap()
            sleep(1)
        case "off": setShown(false)
        case "on": setShown(true)
        case "count": setCount(argument)
        case "shot": shot(argument)
        case "list":
            showSidebar()
            note("  under the groups: \(recentTitles())")
        default: XCTFail("no such command: \(command)")
        }
    }

    func testStep() throws {
        let path = "\(folder)/step.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: path), "no step for recent threads")
        continueAfterFailure = false
        app.activate()
        declineNotifications()
        for line in try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            note("> \(line)")
            run(parts[0], parts.count > 1 ? parts[1] : "")
        }
    }
}
