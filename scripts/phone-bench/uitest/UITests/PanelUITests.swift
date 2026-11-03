import XCTest

/// The panel over the chat (`ThreadPanel`, 2026-10-31 and 2026-11-01): opened from its
/// button, the changes opened as one diff, and closed by a tap beside it on a phone or its own
/// close button anywhere; what runs in the background stays at the foot of the chat. Against a
/// scratch bridge with the fake agent (`PORTALS_FAKE_USAGE=1`, its General folder a git checkout
/// with changes: the changes line and the usage are asserted). Skipped unless
/// its folder, `/private/tmp/portals-panel/uitest-<simulator>/`, has `plan.txt`:
///
///     <PORTALS_DEBUG_HOSTS, one line of JSON>
///
/// Writes notes.txt and pictures of the screen there.
final class PanelUITests: XCTestCase {
    private let folder = "/private/tmp/portals-panel/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

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
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let decline = springboard.alerts.buttons["Don’t Allow"]
        if decline.waitForExistence(timeout: 4) { decline.tap() }
    }

    /// How many times the states host has been asked this, as it counts them
    /// (`panel-states-bridge.mts`).
    private func asks(_ method: String) -> Int {
        let lines = (try? String(contentsOfFile: "/private/tmp/portals-panel/states-asks.txt", encoding: .utf8)) ?? ""
        return lines.split(separator: "\n").filter { $0 == method }.count
    }

    /// Says how the states host should be, as `panel-states-bridge.mts` reads it.
    private func setStatesMode(_ mode: String) throws {
        try mode.write(to: URL(fileURLWithPath: "/private/tmp/portals-panel/states-mode.txt"), atomically: true, encoding: .utf8)
    }

    func testPanel() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = [
            "PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "diff crew long",
        ]
        app.launch()
        declineNotifications()

        let button = app.buttons["thread-panel-button"]
        let card = app.descendants(matching: .any)["thread-panel"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        // The turn runs and its crew starts, at the foot of the chat.
        sleep(6)
        shot("1-closed")
        XCTAssertTrue(app.descendants(matching: .any)["foot-line"].exists, "the foot line stays in the chat")
        let place = button.frame
        button.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 3), "the card opens")
        sleep(3)
        shot("2-open")

        // The fake agent's usage, heard; the host, on its one line.
        let usage = card.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '% left'"))
        XCTAssertGreaterThan(usage.count, 0, "the usage part")
        note("usage windows: \(usage.count)")
        XCTAssertTrue(card.descendants(matching: .any)["thread-panel-device"].exists, "the host's line")
        // At the default text size all of it fits: nothing to scroll.
        XCTAssertEqual(card.scrollViews.count, 0, "the card hugs its rows")
        // Open in is for a Mac alone (2026-11-01).
        XCTAssertFalse(app.descendants(matching: .any)["thread-panel-open-in"].exists, "no Open in off a Mac")

        // Its ✕ just where the button was.
        let close = app.buttons["thread-panel-close"]
        XCTAssertTrue(close.exists, "the close button")
        XCTAssertEqual(close.frame.midX, place.midX, accuracy: 1, "the close button where the button was")
        XCTAssertEqual(close.frame.midY, place.midY, accuracy: 1, "the close button where the button was")
        XCTAssertEqual(close.frame.width, place.width, accuracy: 1, "the close button as wide as the button")

        // The changes, as one diff, and their line says the branch to VoiceOver.
        let changes = app.buttons["thread-panel-changes"]
        XCTAssertTrue(changes.waitForExistence(timeout: 3), "the changes line")
        XCTAssertTrue(changes.label.hasPrefix("On "), "the changes line's label says the branch: \(changes.label)")
        changes.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "the diff opens")
        shot("4-changes")
        done.tap()
        sleep(1)

        // Too narrow for it beside the column (an iPad's chat needs 1030 points): a tap beside
        // it closes it, on a phone or an iPad. Wider, it may be beside the column, and stay.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.85)).tap()
        sleep(1)
        shot("5-after-tap-beside")
        if app.frame.width < 1030 {
            XCTAssertFalse(card.exists, "a tap beside it closes it")
        }
        if !card.exists {
            XCTAssertTrue(button.waitForExistence(timeout: 2), "its button is back")
            button.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 3), "it opens again")
            sleep(1)
        }
        XCTAssertFalse(button.exists, "its button gone while it is open")
        close.tap()
        sleep(1)
        shot("6-closed")
        XCTAssertFalse(card.exists, "its close button closes it")
        XCTAssertTrue(button.exists, "its button is back")
        note("done")
    }

    /// Usage the plain fake agent never gives, from `panel-states-bridge.mts`, whose line goes
    /// in `plan-states.txt` beside `plan.txt`: more windows than the screen holds, so its rows
    /// scroll with the ✕ in reach; how old numbers, a full window and one past its reset read;
    /// and a failed `usage.read`, its sentence beside the numbers until the next answer. Each
    /// of those takes the host's minute.
    func testUsageStates() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let mode = URL(fileURLWithPath: "/private/tmp/portals-panel/states-mode.txt")
        try "ok".write(to: mode, atomically: true, encoding: .utf8)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello"]
        app.launch()
        declineNotifications()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        sleep(4)
        button.tap()
        let card = app.descendants(matching: .any)["thread-panel"]
        XCTAssertTrue(card.waitForExistence(timeout: 3), "the card opens")
        func labelled(_ text: String) -> XCUIElement {
            card.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        XCTAssertTrue(labelled("5-hour used up").waitForExistence(timeout: 10), "a full window reads as used up")
        shot("7-states")
        XCTAssertFalse(labelled("Runs out in 1m").exists, "a full window is not about to run out")
        XCTAssertTrue(labelled("Monthly has reset").exists, "a window past its reset says so")
        XCTAssertFalse(labelled("Monthly 30% left").exists, "and not its old percent")
        XCTAssertTrue(labelled("Weekly Fable 70% left").exists, "a kept window")
        XCTAssertTrue(labelled("Weekly Fable 70% left").label.contains("As of"), "says when it was heard: \(labelled("Weekly Fable 70% left").label)")
        XCTAssertTrue(labelled("Weekly Sonnet").exists, "a window with no number to it")

        // More than the screen holds: they scroll, the ✕ staying where it is.
        XCTAssertLessThanOrEqual(card.frame.maxY, app.frame.maxY + 1, "the card stays on screen")
        let rows = card.scrollViews.firstMatch
        XCTAssertTrue(rows.exists, "its rows scroll")
        let device = card.descendants(matching: .any)["thread-panel-device"]
        let close = app.buttons["thread-panel-close"]
        let closePlace = close.frame
        for _ in 0 ..< 12 where !device.isHittable {
            rows.swipeUp()
            sleep(1)
        }
        shot("8-states-scrolled")
        XCTAssertTrue(device.isHittable, "the host's line can be scrolled to")
        XCTAssertEqual(close.frame, closePlace, "the close button does not scroll")
        XCTAssertTrue(close.exists, "the close button stays")

        // A failed ask: the numbers stay, with the host's sentence.
        try "fail".write(to: mode, atomically: true, encoding: .utf8)
        let failure = labelled("Its sign-in has expired")
        XCTAssertTrue(failure.waitForExistence(timeout: 130), "the failure shows")
        shot("9-failed")
        XCTAssertTrue(labelled("Weekly").exists, "the numbers stay")
        // The plan's as well as the kept window's.
        XCTAssertGreaterThan(card.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'As of'")).count, 1, "and say how old they are")

        try "ok".write(to: mode, atomically: true, encoding: .utf8)
        let gone = NSPredicate(format: "exists == false")
        let cleared = expectation(for: gone, evaluatedWith: failure)
        wait(for: [cleared], timeout: 130)
        shot("10-answered")
        close.tap()
        sleep(1)
        XCTAssertFalse(card.exists, "its close button closes it")
        note("done")
    }

    /// What the changes say of what is missing, from the repository in `panel-states-bridge.mts`,
    /// read by the host's real git: more files than the host lists, one too long and one binary
    /// among them; and then one binary file alone, which has no count to show.
    func testDiffStates() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let gitMode = URL(fileURLWithPath: "/private/tmp/portals-panel/states-git.txt")
        try "many".write(to: gitMode, atomically: true, encoding: .utf8)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello"]
        app.launch()
        declineNotifications()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        sleep(4)
        button.tap()
        let changes = app.buttons["thread-panel-changes"]
        XCTAssertTrue(changes.waitForExistence(timeout: 10), "the changes line")
        XCTAssertTrue(changes.label.contains("351 files uncommitted"), "the line says all of them: \(changes.label)")
        shot("12-changes-line")
        changes.tap()

        func said(_ text: String) -> XCUIElement {
            app.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
        }
        XCTAssertTrue(said("Showing 300 of 351 files").waitForExistence(timeout: 20), "the list says how many of how many")
        shot("13-many-files")
        XCTAssertTrue(said("Some of these diffs were left out or cut short.").exists, "the list's note")
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'too long'")).firstMatch.exists, "nothing of length")
        let rows = app.buttons.matching(identifier: "turn-diff-file")
        let binary = rows.matching(NSPredicate(format: "label BEGINSWITH '0-binary.dat'")).firstMatch
        XCTAssertTrue(binary.exists, "the binary file's row")
        XCTAssertFalse(binary.label.contains("added"), "no count on its row: \(binary.label)")
        let long = rows.matching(NSPredicate(format: "label BEGINSWITH '0-too-long.txt'")).firstMatch
        XCTAssertTrue(long.label.contains("added"), "a counted file has its count: \(long.label)")
        XCTAssertLessThan(rows.count, 300, "the rows are built as they come into view")

        long.tap()
        XCTAssertTrue(said("Not shown: this file's diff was left out.").waitForExistence(timeout: 5), "a file left out says so")
        shot("14-left-out")
        XCTAssertFalse(said("Too long to keep: the turn's diffs passed what is kept of one.").exists, "and nothing of a turn")

        let back = app.buttons["turn-diff-back"]
        back.tap()
        // Back from a file far down the list comes back to it, not to the top.
        for _ in 0 ..< 6 { app.swipeUp(velocity: .fast) }
        sleep(1)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(back.waitForExistence(timeout: 5), "the file's diff")
        let name = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'file-'")).firstMatch.label
        XCTAssertTrue(name.hasPrefix("file-"), "a file down the list: \(name)")
        note("back from \(name)")
        back.tap()
        let again = rows.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(again.waitForExistence(timeout: 3) && again.isHittable, "back at that row: \(name)")
        shot("13b-back-in-place")
        app.buttons["Done"].tap()
        sleep(1)

        // One binary file, alone: its line and its diff have no count.
        try "binary".write(to: gitMode, atomically: true, encoding: .utf8)
        sleep(3)
        let close = app.buttons["thread-panel-close"]
        close.tap()
        sleep(1)
        button.tap()
        let one = NSPredicate(format: "label CONTAINS '1 file uncommitted'")
        wait(for: [expectation(for: one, evaluatedWith: changes)], timeout: 20)
        XCTAssertFalse(changes.label.contains("added"), "no count on the line: \(changes.label)")
        XCTAssertFalse(said("+0").exists, "and no +0")
        shot("15-binary-line")
        changes.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10), "the diff opens")
        XCTAssertTrue(app.descendants(matching: .any)["turn-diff-lines"].waitForExistence(timeout: 5), "its lines")
        XCTAssertFalse(said("+0").exists, "its diff has no count either")
        shot("16-binary-diff")
        app.buttons["Done"].tap()
        sleep(1)
        close.tap()
        sleep(1)
        note("done")
    }

    /// A thread opened from the list, whose chat was not told a folder as a new thread's is:
    /// its files are named from the thread's folder all the same, where that is the
    /// repository's top. Run after testDiffStates or testClosingAsksNothing, which leave a thread.
    func testChangesOfAThreadFromTheList() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try "many".write(to: URL(fileURLWithPath: "/private/tmp/portals-panel/states-git.txt"), atomically: true, encoding: .utf8)
        sleep(1)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello"]
        app.launch()
        declineNotifications()
        XCTAssertTrue(app.buttons["thread-panel-button"].waitForExistence(timeout: 20), "the panel's button")
        sleep(5)
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_OPEN_EACH": "1:1"]
        app.launch()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        sleep(5)
        button.tap()
        let changes = app.buttons["thread-panel-changes"]
        XCTAssertTrue(changes.waitForExistence(timeout: 10), "the changes line")
        changes.tap()
        let rows = app.buttons.matching(identifier: "turn-diff-file")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 20), "the list")
        shot("17-from-the-list")
        XCTAssertTrue(rows.firstMatch.label.hasPrefix("0-binary.dat"), "named from the thread's folder: \(rows.firstMatch.label)")
        app.buttons["Done"].tap()
        note("done")
    }

    /// Why the changes could not be read, the host's sentence, can be read: all of it, not one
    /// line of it cut short.
    func testChangesFailure() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        try setStatesMode("git-fail")
        defer { try? setStatesMode("ok") }
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello"]
        app.launch()
        declineNotifications()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        sleep(4)
        button.tap()
        let sentence = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'git could not read this repository'")).firstMatch
        XCTAssertTrue(sentence.waitForExistence(timeout: 10), "the host's sentence")
        let label = app.staticTexts["Changes"]
        XCTAssertTrue(label.exists, "its line")
        note("sentence \(sentence.frame) label \(label.frame)")
        shot("18-changes-failed")
        XCTAssertGreaterThan(sentence.frame.height, label.frame.height * 2.5, "more than a line or two of it")
        note("done")
    }

    /// Closing the panel asks nothing, however long it stood open: what it shows was asked for
    /// while it was open. On an iPad it is open from the launch, kept from the last; on a phone
    /// it is opened from its button, a preload before it.
    func testClosingAsksNothing() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello", "PORTALS_DEBUG_SIDEBAR_WIDTH": "200"]
        app.launch()
        declineNotifications()
        let card = app.descendants(matching: .any)["thread-panel"]
        let button = app.buttons["thread-panel-button"]
        // Unless the last run left it open, which is kept (not by a launch argument, which
        // would hold it open).
        if button.waitForExistence(timeout: 20) {
            sleep(4)
            button.tap()
        }
        XCTAssertTrue(card.waitForExistence(timeout: 5), "the card")
        if isPad {
            sleep(2)
            app.terminate()
            app.launch()
        }
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the card")
        // Past the 30 seconds an answer stands, not yet the minute to its next ask.
        sleep(50)
        let before = asks("usage.read")
        XCTAssertGreaterThan(before, 0, "it asked as it opened")
        app.buttons["thread-panel-close"].tap()
        sleep(4)
        note("usage.read \(before) open, \(asks("usage.read")) closed")
        XCTAssertEqual(asks("usage.read"), before, "closing asks nothing")
        note("done")
    }

    /// With no window to be seen (`PORTALS_DEBUG_WINDOWS_HIDDEN`), a host connecting asks nothing
    /// for the panel of a tab already open, and a turn ending beside an open panel asks nothing.
    func testHiddenAsksNothing() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        // A tab to come back to.
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "hello"]
        app.launch()
        declineNotifications()
        XCTAssertTrue(app.buttons["thread-panel-button"].waitForExistence(timeout: 20), "the panel's button")
        sleep(5)
        app.terminate()

        // The control: the tab comes back, and the host is asked for its panel.
        var before = asks("usage.read")
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_RESTORE_TABS": "1"]
        app.launch()
        XCTAssertTrue(app.buttons["thread-panel-button"].waitForExistence(timeout: 20), "the tab back")
        sleep(6)
        XCTAssertGreaterThan(asks("usage.read"), before, "seen, it asks")
        app.terminate()

        before = asks("usage.read")
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_RESTORE_TABS": "1", "PORTALS_DEBUG_WINDOWS_HIDDEN": "1"]
        app.launch()
        XCTAssertTrue(app.buttons["thread-panel-button"].waitForExistence(timeout: 20), "the tab back")
        sleep(6)
        note("usage.read \(before) then \(asks("usage.read")) hidden")
        XCTAssertEqual(asks("usage.read"), before, "a host connecting asks nothing unseen")
        app.terminate()

        // A turn that ends beside an open panel.
        let gitBefore = asks("git.status")
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "slow", "PORTALS_DEBUG_WINDOWS_HIDDEN": "1"]
        app.launch()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        button.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread-panel"].waitForExistence(timeout: 5), "the card")
        // "slow" ends in under a minute.
        sleep(50)
        note("git.status \(gitBefore) then \(asks("git.status")) hidden")
        shot("19-hidden-turn-ended")
        XCTAssertEqual(asks("git.status"), gitBefore, "a turn ending asks nothing unseen")
        note("done")
    }

    /// What says the host is out of reach stays over the column the panel beside it moves, and
    /// clear of the panel: on a 13-inch iPad on its side.
    func testBannerMovesWithTheColumn() throws {
        let planPath = "\(folder)/plan-states.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel's states")
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "the panel is beside the column only where the tabs are")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launchArguments = ["-threadPanel.open", "YES"]
        let sidebar: CGFloat = 200
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_SIDEBAR_WIDTH": "\(Int(sidebar))"]
        app.launch()
        declineNotifications()
        let composer = app.descendants(matching: .any)["composer-field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the composer")
        let card = app.descendants(matching: .any)["thread-panel"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), "the panel beside the column")
        try setStatesMode("down")
        defer { try? setStatesMode("ok") }
        let banner = app.descendants(matching: .any)["connection-banner"]
        XCTAssertTrue(banner.waitForExistence(timeout: 20), "the banner")
        sleep(1)
        shot("20-banner-beside")
        note("banner \(banner.frame) composer \(composer.frame) card \(card.frame)")
        XCTAssertLessThan(composer.frame.midX, (sidebar + app.frame.maxX) / 2 - 1, "the column has moved left")
        XCTAssertEqual(banner.frame.midX, composer.frame.midX, accuracy: 1, "the banner over the column")
        XCTAssertLessThanOrEqual(banner.frame.maxX, card.frame.minX, "clear of the panel")
        note("done")
    }

    /// A new thread's start stays over the composer's column when the panel beside it moves
    /// that column left: on a 13-inch iPad on its side, with the sidebar narrowed to leave room
    /// for both and little else.
    func testStartMovesWithTheColumn() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel")
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "the panel is beside the column only where the tabs are")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        app.launchArguments = ["-threadPanel.open", "YES"]
        let sidebar: CGFloat = 200
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_SIDEBAR_WIDTH": "\(Int(sidebar))"]
        app.launch()
        declineNotifications()
        let composer = app.descendants(matching: .any)["composer-field"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "the composer")
        let start = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'What should'")).firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 5), "the new thread's start")
        XCTAssertTrue(app.descendants(matching: .any)["thread-panel"].waitForExistence(timeout: 5), "the panel beside the column")
        sleep(2)
        shot("11-start-beside")
        note("start \(start.frame) composer \(composer.frame) window \(app.frame)")
        XCTAssertLessThan(composer.frame.midX, (sidebar + app.frame.maxX) / 2 - 1, "the column has moved left")
        XCTAssertEqual(start.frame.midX, composer.frame.midX, accuracy: 1, "the start over the column")
        note("done")
    }

    /// Closed by its ✕, pressed again in the same place after a moment (2026-11-01:
    /// "when i close it and i click again it doesnt open again"): real presses at the place,
    /// not the element, so that whatever is over the button takes them.
    func testReopen() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the panel")
        continueAfterFailure = true
        let hosts = try String(contentsOfFile: planPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let app = XCUIApplication(bundleIdentifier: "com.danielou.portals")
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": hosts, "PORTALS_DEBUG_AGENT": "fake", "PORTALS_DEBUG_PROMPT": "diff crew long"]
        app.launch()
        declineNotifications()
        let button = app.buttons["thread-panel-button"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the panel's button")
        sleep(4)
        let card = app.descendants(matching: .any)["thread-panel"]
        let close = app.buttons["thread-panel-close"]
        func pressAtButton() {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: place.midX, dy: place.midY)).tap()
        }
        let place = button.frame
        note("button at \(place)")
        pressAtButton()
        let firstOpens = close.waitForExistence(timeout: 3)
        note("first press opens: \(firstOpens)")
        XCTAssertTrue(firstOpens, "the first press opens it")
        let delays = [3.0, 0, 0, 0, 0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.6, 1]
        var rounds = 0
        for delay in delays {
            if !close.exists { pressAtButton(); _ = close.waitForExistence(timeout: 3) }
            guard close.exists else {
                XCTFail("could not get it open before \(delay)")
                note("could not get it open before \(delay)")
                continue
            }
            rounds += 1
            close.tap()
            let closedAt = Date()
            Thread.sleep(forTimeInterval: delay)
            let cardAfterClose = close.exists
            if cardAfterClose { note("the card was still there before the press") }
            pressAtButton()
            let pressedAfter = Date().timeIntervalSince(closedAt)
            let opened = close.waitForExistence(timeout: 2)
            note("waited \(delay): the press done \(String(format: "%.2f", pressedAfter)) s after the close's, opened \(opened)")
            XCTAssertTrue(opened, "pressed again \(delay) s after closing")
            if !opened {
                shot("stuck-\(delay)")
                let tree = app.debugDescription
                try? tree.write(toFile: "\(folder)/stuck-\(delay).txt", atomically: true, encoding: .utf8)
            }
        }
        XCTAssertEqual(rounds, delays.count, "every round ran")
        note("done")
    }
}
