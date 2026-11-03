import XCTest

/// The divider between the sidebar's groups and a Mac's space, dragged up and down (2026-11-02: "can u make the sidebar split resizeable? like between running and folders
/// that split", "for short lists its ok if theres empty space under running"), on an iPhone
/// and an iPad simulator, reading the frames. Against scratch bridges with the fake agent
/// (scripts/sidebar-bench/bridge.mts, started with [pinned] 0: a pinned thread at rest is in
/// the top half, under Pinned, and the heights here are for none), the app installed anew
/// for each test. Skipped unless
/// its folder, `/private/tmp/portals-prs/scratch/split/uitest-<simulator>/`, has `plan.txt`:
///
///     <bundle id of the Portals copy installed in the simulator>
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///
/// Writes pictures of the screen and `results.txt` there. A file `need-turn` it makes there
/// asks whoever runs it for a turn in a thread of the first bridge, from another device.
final class SidebarSplitUITests: XCTestCase {
    private let folder = "/private/tmp/portals-prs/scratch/split/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")
    private var bundle = ""
    private var hosts = ""
    /// Three of a Mac's space's rows, as `AgentSidebar.spaceMinimum` has them.
    private let spaceMinimum: CGFloat = 3 * 44 + 2 * 2

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func note(_ line: String) {
        let path = "\(folder)/results.txt"
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let file = FileHandle(forWritingAtPath: path) else { return }
        file.seekToEndOfFile()
        file.write(Data((line + "\n").utf8))
        file.closeFile()
    }

    private func readPlan() throws {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let path = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: path), "no plan for the split")
        let lines = try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n").map(String.init)
        try XCTSkipUnless(lines.count >= 2, "plan.txt needs two lines")
        bundle = lines[0]
        hosts = lines[1]
    }

    private func launch(arguments: [String] = [], opensSidebar: Bool = true) -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: bundle)
        app.terminate()
        app.launchArguments = arguments
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts]
        if opensSidebar { app.launchEnvironment["PORTALS_DEBUG_SIDEBAR"] = "1" }
        addUIInterruptionMonitor(withDescription: "notifications") { alert in
            guard alert.buttons["Don\u{2019}t Allow"].exists else { return false }
            alert.buttons["Don\u{2019}t Allow"].tap()
            return true
        }
        app.launch()
        continueAfterFailure = false
        return app
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func handle(in app: XCUIApplication) -> XCUIElement { element("sidebar-split", in: app) }
    private func groups(in app: XCUIApplication) -> XCUIElement { element("sidebar-groups", in: app) }
    private func space(in app: XCUIApplication) -> XCUIElement { element("sidebar-space", in: app) }

    /// The handle's line: the middle of its hit area.
    private func line(in app: XCUIApplication) -> CGFloat { handle(in: app).frame.midY }

    private func waitForHandle(in app: XCUIApplication, timeout: TimeInterval = 25) {
        XCTAssertTrue(handle(in: app).waitForExistence(timeout: timeout), "no handle")
        settle()
    }

    /// Long enough for a height's animation, and for a saved list to give way to the host's.
    private func settle(_ seconds: TimeInterval = 1) { Thread.sleep(forTimeInterval: seconds) }

    /// Presses the handle and moves `distance` down, or up, and lets go.
    private func drag(_ distance: CGFloat, in app: XCUIApplication, hold: TimeInterval = 0.2, from offset: CGFloat = 0) {
        let start = handle(in: app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .withOffset(CGVector(dx: 0, dy: offset))
        let end = start.withOffset(CGVector(dx: 0, dy: distance))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: hold)
        settle()
    }

    private func report(_ step: String, in app: XCUIApplication) {
        let top = groups(in: app).frame, below = space(in: app).frame, grip = handle(in: app).frame
        note("\(name) \(step): groups y \(top.minY) h \(top.height), handle y \(grip.minY) h \(grip.height) w \(grip.width), space y \(below.minY) h \(below.height)")
    }

    private func expectHeight(_ expected: CGFloat, _ step: String, in app: XCUIApplication, within: CGFloat = 1.5) {
        report(step, in: app)
        let height = groups(in: app).frame.height
        XCTAssertLessThanOrEqual(abs(height - expected), within, "\(step): groups \(height), expected \(expected)")
    }

    /// One title and one row, under the handle's line: never dragged less.
    func testAShortList() throws {
        try readPlan()
        var app = launch()
        waitForHandle(in: app)
        let hugging = groups(in: app).frame.height
        report("hugging", in: app)
        shot("short-1-hugging")
        XCTAssertLessThan(hugging, 110, "one title and one row")

        // A press that wobbles a few points is a tap, and sets nothing: a double tap with
        // a shaky finger still sets it back, and a short list goes on hugging.
        drag(4, in: app)
        expectHeight(hugging, "a shaky tap", in: app)

        // Dragged down: the divider stays where it was put, with space under the rows.
        drag(150, in: app)
        expectHeight(hugging + 150, "dragged down", in: app)
        shot("short-2-dragged-down")

        // Kept across a relaunch, the rows still not filling it.
        app = launch()
        waitForHandle(in: app)
        expectHeight(hugging + 150, "relaunched", in: app)
        shot("short-3-relaunched")

        // Up from where it is, straight away; to the least, a title and a row.
        drag(-40, in: app)
        expectHeight(hugging + 110, "up a little", in: app)
        drag(-3000, in: app)
        expectHeight(hugging, "top limit", in: app, within: 3)
        shot("short-4-top-limit")

        // Down as far as it goes: three of the space's rows left.
        drag(3000, in: app)
        report("bottom limit", in: app)
        XCTAssertLessThanOrEqual(abs(space(in: app).frame.height - spaceMinimum), 1.5)
        shot("short-5-bottom-limit")

        // A double tap: back to hugging, and still so after a relaunch.
        handle(in: app).doubleTap()
        settle()
        expectHeight(hugging, "double tap", in: app)
        shot("short-6-set-back")
        app = launch()
        waitForHandle(in: app)
        expectHeight(hugging, "relaunched set back", in: app)

        // A row arriving during a drag: the divider stays with the finger. The bridge's
        // turn comes while it is held (`need-turn`).
        FileManager.default.createFile(atPath: "\(folder)/need-turn", contents: nil)
        drag(120, in: app, hold: 6)
        expectHeight(hugging + 120, "a row came during the drag", in: app)
        shot("short-7-row-arrived")
    }

    /// Bad values saved: the launch arguments stand in for what is kept.
    func testABadSavedValue() throws {
        try readPlan()
        var app = launch(arguments: ["-sidebar.groupsShare", "<real>40</real>"])
        waitForHandle(in: app)
        report("share 40", in: app)
        XCTAssertLessThanOrEqual(abs(space(in: app).frame.height - spaceMinimum), 1.5)
        app = launch(arguments: ["-sidebar.groupsShare", "<real>-3</real>"])
        waitForHandle(in: app)
        report("share -3", in: app)
        XCTAssertLessThan(groups(in: app).frame.height, 110)
        app = launch(arguments: ["-sidebar.groupsShare", "not a number"])
        waitForHandle(in: app)
        report("share words", in: app)
        XCTAssertLessThan(groups(in: app).frame.height, 110, "hugging")
    }

    /// More rows than fit.
    func testManyRows() throws {
        try readPlan()
        var app = launch()
        waitForHandle(in: app)
        settle(2)
        let start = groups(in: app).frame.height
        let room = start + space(in: app).frame.height
        report("hugging", in: app)
        shot("many-1-half")
        XCTAssertLessThanOrEqual(abs(start - room / 2), 1.5, "half the room, not set")

        drag(120, in: app)
        expectHeight(start + 120, "down 120", in: app)
        shot("many-2-down")

        // The groups scrolled to their end, then the divider down: nothing past their end.
        let list = groups(in: app)
        for _ in 0 ..< 6 { list.swipeUp(velocity: .fast) }
        settle()
        shot("many-3-scrolled-end")
        drag(40, in: app)
        expectHeight(start + 160, "down 40 at the end", in: app)
        shot("many-4-grown-at-end")

        drag(-3000, in: app)
        report("top limit", in: app)
        let least = groups(in: app).frame.height
        XCTAssertLessThan(least, 110, "a title and a row")
        shot("many-5-top-limit")

        drag(3000, in: app)
        report("bottom limit", in: app)
        XCTAssertLessThanOrEqual(abs(space(in: app).frame.height - spaceMinimum), 1.5)
        shot("many-6-bottom-limit")

        // Held at the end of a drag: where it is is where the finger is.
        drag(-200, in: app)
        let kept = groups(in: app).frame.height
        report("up 200", in: app)
        app = launch()
        waitForHandle(in: app)
        expectHeight(kept, "relaunched", in: app)

        // A turned iPad keeps the proportion.
        if UIDevice.current.userInterfaceIdiom == .pad {
            let share = groups(in: app).frame.height / (groups(in: app).frame.height + space(in: app).frame.height)
            XCUIDevice.shared.orientation = .landscapeLeft
            settle(2)
            report("turned", in: app)
            let turned = groups(in: app).frame.height / (groups(in: app).frame.height + space(in: app).frame.height)
            XCTAssertLessThanOrEqual(abs(turned - share), 0.01)
            shot("many-7-turned")
            XCUIDevice.shared.orientation = .portrait
            settle(2)
            expectHeight(kept, "turned back", in: app)
        }

        handle(in: app).doubleTap()
        settle()
        expectHeight(start, "double tap", in: app)
        shot("many-8-set-back")
    }

    /// A host with nothing on top: no divider. A turn from another device brings the groups,
    /// hugging; set, then dismissed, they go with the divider, however it was set, and the
    /// next turn brings them back at the set height. On a touch screen only (a swipe
    /// dismisses a row of Recent).
    func testNoRows() throws {
        try readPlan()
        let app = launch()
        XCTAssertTrue(space(in: app).waitForExistence(timeout: 25))
        settle(6)
        XCTAssertFalse(handle(in: app).exists, "no handle with no rows")
        note("\(name) none: groups h \(groups(in: app).frame.height), space h \(space(in: app).frame.height)")
        shot("none-1-empty")

        FileManager.default.createFile(atPath: "\(folder)/need-turn", contents: nil)
        waitForHandle(in: app, timeout: 30)
        settle(4)
        let hugging = groups(in: app).frame.height
        report("a row came", in: app)
        shot("none-2-a-row")

        drag(150, in: app)
        expectHeight(hugging + 150, "set", in: app)

        groups(in: app).descendants(matching: .any)["thread-row"].firstMatch.swipeLeft(velocity: .fast)
        settle(2)
        shot("none-3-dismissed")
        XCTAssertFalse(handle(in: app).exists, "no handle once the row is dismissed")
        note("\(name) dismissed: groups h \(groups(in: app).frame.height), space h \(space(in: app).frame.height)")

        FileManager.default.createFile(atPath: "\(folder)/need-turn", contents: nil)
        waitForHandle(in: app, timeout: 30)
        settle(4)
        expectHeight(hugging + 150, "came back", in: app)
        shot("none-4-back-at-set-height")
    }

    /// Right at the handle's edges: the Macs' tabs below take their taps, and the row above
    /// does just past it. Two hosts, for two tabs.
    func testTheEdges() throws {
        try readPlan()
        let app = launch()
        waitForHandle(in: app)
        settle(3)
        let tabs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'mac-tab-'"))
        XCTAssertGreaterThanOrEqual(tabs.count, 2, "two Macs' tabs")
        let grip = handle(in: app).frame
        report("start", in: app)
        for index in 0 ..< tabs.count {
            let tab = tabs.element(boundBy: index)
            note("\(name) tab \(index) \(tab.identifier): y \(tab.frame.minY) h \(tab.frame.height) selected \(tab.isSelected); handle ends \(grip.maxY)")
        }
        shot("edges-1")

        // A tab's top edge, by a point: under the handle's hit area where they meet.
        for index in [1, 0] {
            let tab = tabs.element(boundBy: index)
            let frame = tab.frame
            let spot = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.minY + 1))
            spot.tap()
            settle()
            note("\(name) tapped tab \(index) one point in: selected \(tab.isSelected)")
            XCTAssertTrue(tab.isSelected, "tab \(index)'s top edge")
        }

        // In the room above the tabs, still the handle's.
        let before = groups(in: app).frame.height
        drag(40, in: app, from: min(grip.height / 2, tabs.element(boundBy: 0).frame.minY - grip.midY) - 1.5)
        expectHeight(before + 40, "drag from the handle's lower end", in: app)
        // And its upper end.
        drag(-40, in: app, from: -(grip.height / 2 - 2))
        expectHeight(before, "drag from the handle's upper end", in: app)

        // A row just above the handle takes its tap, and opens its thread.
        let above = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: grip.midX, dy: grip.minY - 2))
        let shownBefore = element("composer-field", in: app).exists ? element("composer-field", in: app).frame.minX : -1
        above.tap()
        settle(2)
        shot("edges-2-row-tapped")
        note("\(name) row above tapped: composer x \(shownBefore) to \(element("composer-field", in: app).exists ? element("composer-field", in: app).frame.minX : -1)")
    }

    /// The phone's sidebar still opens and closes with a swipe on the chat, and a drag of the
    /// divider does neither.
    func testThePhonesSwipe() throws {
        try readPlan()
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "a phone's")
        let app = launch(opensSidebar: false)
        let composer = app.textFields["composer-field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 25))
        settle(2)
        let width = app.frame.width
        XCTAssertLessThan(composer.frame.minX, width / 3, "the chat across the screen")

        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.45))
        middle.press(forDuration: 0.01, thenDragTo: middle.withOffset(CGVector(dx: width * 0.7, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        settle()
        waitForHandle(in: app)
        note("\(name) opened: composer x \(composer.frame.minX)")
        XCTAssertGreaterThan(composer.frame.minX, width / 2, "the sidebar out")
        shot("phone-1-opened")

        let before = groups(in: app).frame.height
        drag(100, in: app)
        expectHeight(before + 100, "dragged", in: app)
        XCTAssertGreaterThan(composer.frame.minX, width / 2, "still out")

        // Sideways on the handle: neither the divider nor the sidebar.
        let grip = handle(in: app).coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        grip.press(forDuration: 0.1, thenDragTo: grip.withOffset(CGVector(dx: 120, dy: 2)), withVelocity: XCUIGestureVelocity(600), thenHoldForDuration: 0.1)
        settle()
        expectHeight(before + 100, "a swipe sideways on the handle", in: app)

        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.45))
        edge.press(forDuration: 0.01, thenDragTo: edge.withOffset(CGVector(dx: -width * 0.7, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        settle()
        note("\(name) closed: composer x \(composer.frame.minX)")
        XCTAssertLessThan(composer.frame.minX, width / 3, "the sidebar away")
        shot("phone-2-closed")
    }

    /// An iPad's pointer: a hover, and a drag with the button held.
    func testAnIPadsPointer() throws {
        try readPlan()
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's")
        try XCTSkipUnless(XCUIDevice.shared.supportsPointerInteraction, "no pointer here")
        let app = launch()
        waitForHandle(in: app)
        settle(2)
        let before = groups(in: app).frame.height
        report("start", in: app)
        groups(in: app).hover()
        handle(in: app).hover()
        settle()
        shot("pointer-1-hover")
        // The first pointer drag after a launch is often lost in a simulator.
        for attempt in 1 ... 3 {
            let start = handle(in: app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            start.click(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 90)))
            settle()
            report("pointer drag \(attempt)", in: app)
            if abs(groups(in: app).frame.height - before - 90) <= 1.5 { break }
        }
        expectHeight(before + 90, "pointer drag", in: app)
        shot("pointer-2-dragged")
        handle(in: app).doubleClick()
        settle()
        expectHeight(before, "double click", in: app)
    }
}
