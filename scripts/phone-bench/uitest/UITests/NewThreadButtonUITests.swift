import XCTest

/// New thread at the end of the sidebar's search line (2026-10-27: "lets also add a
/// new thread button inline with the search bar which will bring us to the new tab screen
/// wiht the 3 dropdowns, can we have this on mobile as well"), on a phone: the sidebar goes,
/// the new thread's screen has its three chips (Mac, agent, folder) within the screen's
/// width, and a thread sent after changing them starts there. And a folder's own New
/// thread, the phone's way before, still starts one in that folder with the agent picked.
/// Against two scratch bridges with three fake agents each, the first ("Mini") with
/// folders its threads worked in and folder_search over a home with
/// `work/client-onboarding-redesign` in it, a name long enough that the chips need a
/// second line on a phone. Skipped unless its folder,
/// `/private/tmp/portals-new-thread/uitest-<simulator>/`, has `plan.txt`:
///
///     <bundle id of the Portals copy installed in the simulator>
///     <PORTALS_DEBUG_HOSTS, one line of JSON, "Mini" first>
///     <the threads.json of Mini's bridge>
///
/// Writes pictures of the screen there. Run as the file's neighbours are (FolderSearchUITests),
/// against bridges started anew and the app installed anew: the threads and kept words an
/// earlier run leaves change the sidebar's folders and the drafts these find.
final class NewThreadButtonUITests: XCTestCase {
    private let folder = "/private/tmp/portals-new-thread/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")
    private var threadsFile = ""

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(folder)/\(name).png"))
    }

    private func launch() throws -> XCUIApplication {
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no plan for the new thread button")
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map(String.init)
        try XCTSkipUnless(lines.count >= 3, "plan.txt needs three lines")
        threadsFile = lines[2]
        let app = XCUIApplication(bundleIdentifier: lines[0])
        app.terminate()
        app.launchEnvironment = ["PORTALS_DEBUG_HOSTS": lines[1], "PORTALS_DEBUG_SIDEBAR": "1"]
        // The system's question about notifications, at the first launch.
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

    /// The sidebar is away: the chat, its composer with it, back across the screen.
    private func sidebarIsAway(_ app: XCUIApplication) -> Bool {
        let composer = app.textFields["composer-field"]
        return composer.exists && composer.frame.minX < app.frame.width / 3
    }

    /// Mini's bridge has a thread of `agent`'s working in a folder ending `folder` that
    /// none had before `before`.
    private func startedThread(agent: String, folder suffix: String, notIn before: Set<String>) -> Bool {
        for _ in 0 ..< 30 {
            if let data = FileManager.default.contents(atPath: threadsFile),
               let list = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let threads = list["threads"] as? [[String: Any]],
               threads.contains(where: { record in
                   !before.contains(record["id"] as? String ?? "") && record["agent"] as? String == agent
                       && (record["cwd"] as? String ?? "").hasSuffix(suffix)
               }) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    private func threadIDs() -> Set<String> {
        guard let data = FileManager.default.contents(atPath: threadsFile),
              let list = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let threads = list["threads"] as? [[String: Any]] else { return [] }
        return Set(threads.compactMap { $0["id"] as? String })
    }

    /// A menu's item: the one in sight, where the screen under the menu has one of that
    /// name too (the sidebar's tab of a Mac).
    private func item(_ label: String, in app: XCUIApplication) -> XCUIElement? {
        for _ in 0 ..< 10 {
            if let shown = app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex.last(where: \.isHittable) {
                return shown
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return nil
    }

    private func send(_ text: String, in app: XCUIApplication) {
        let composer = app.textFields["composer-field"]
        composer.tap()
        composer.typeText(text)
        app.buttons["send"].tap()
    }

    func testTheSearchLinesNewThreadOpensTheChipsAndStartsThereOnAPhone() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "a phone's")
        let app = try launch()
        let button = app.buttons["sidebar-new-thread"]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no New thread on the search's line")
        let search = app.textFields["Search threads"]
        XCTAssertTrue(search.exists, "no search field")
        // On the search's line, at its end, as high as it.
        XCTAssertEqual(button.frame.midY, search.frame.midY, accuracy: 4, "not on the search's line")
        XCTAssertGreaterThan(button.frame.minX, search.frame.maxX, "not at the search's end")
        XCTAssertEqual(button.label, "New thread")
        Thread.sleep(forTimeInterval: 1)
        shot("1-sidebar")
        let before = threadIDs()

        button.tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        XCTAssertTrue(sidebarIsAway(app), "the sidebar stayed")
        let mac = element("new-thread-mac", in: app)
        let agent = element("new-thread-agent", in: app)
        let folderChip = element("new-thread-folder", in: app)
        for (chip, name) in [(mac, "Mac"), (agent, "agent"), (folderChip, "folder")] {
            XCTAssertTrue(chip.waitForExistence(timeout: 10), "no \(name) chip on the new thread's screen")
            XCTAssertGreaterThanOrEqual(chip.frame.minX, 0, "the \(name) chip runs off the screen")
            XCTAssertLessThanOrEqual(chip.frame.maxX, app.frame.width, "the \(name) chip runs off the screen")
        }
        Thread.sleep(forTimeInterval: 0.6)
        shot("2-chips")

        // The Mac: Mini, chosen from the chip's menu.
        mac.tap()
        try XCTUnwrap(item("Mini", in: app), "no Mini in the Mac chip's menu").tap()
        XCTAssertTrue(element("new-thread-mac", in: app).waitForExistence(timeout: 5))
        // The agent: Fake agent 2, from the agent picker.
        element("new-thread-agent", in: app).tap()
        let second = app.buttons["agent-choice-fake-2"]
        XCTAssertTrue(second.waitForExistence(timeout: 5), "no Fake agent 2 in the agent picker")
        second.tap()
        XCTAssertTrue(second.waitForNonExistence(timeout: 5), "the agent picker stayed")
        // The folder: hermes-agent, from the chip's menu.
        element("new-thread-folder", in: app).tap()
        try XCTUnwrap(item("hermes-agent", in: app), "no hermes-agent in the folder chip's menu").tap()
        let chosen = element("new-thread-folder", in: app)
        XCTAssertTrue(chosen.waitForExistence(timeout: 5))
        for _ in 0 ..< 10 where chosen.value as? String != "hermes-agent" { Thread.sleep(forTimeInterval: 0.3) }
        XCTAssertEqual(chosen.value as? String, "hermes-agent", "the folder chip does not say hermes-agent")
        XCTAssertEqual(element("new-thread-agent", in: app).value as? String, "Fake agent 2", "the agent chip does not say Fake agent 2")
        XCTAssertEqual(element("new-thread-mac", in: app).value as? String, "Mini", "the Mac chip does not say Mini")
        shot("3-chosen")

        // Another folder, from the folder sheet that Other Folder… opens, found by its search.
        element("new-thread-folder", in: app).tap()
        try XCTUnwrap(item("Other Folder\u{2026}", in: app), "no Other Folder… in the folder chip's menu").tap()
        let folderSearch = app.textFields["folder-search-field"]
        XCTAssertTrue(folderSearch.waitForExistence(timeout: 10), "Other Folder… did not open the folder sheet")
        folderSearch.tap()
        folderSearch.typeText("onboard")
        let hit = app.buttons["folder-hit-work/client-onboarding-redesign"]
        XCTAssertTrue(hit.waitForExistence(timeout: 10), "the folder sheet did not find client-onboarding-redesign")
        hit.tap()
        XCTAssertTrue(element("folder-sheet", in: app).waitForNonExistence(timeout: 10), "the folder sheet stayed")
        let long = element("new-thread-folder", in: app)
        for _ in 0 ..< 20 where long.value as? String != "client-onboarding-redesign" { Thread.sleep(forTimeInterval: 0.3) }
        XCTAssertEqual(long.value as? String, "client-onboarding-redesign", "the folder chip does not say client-onboarding-redesign")
        XCTAssertEqual(element("new-thread-agent", in: app).value as? String, "Fake agent 2", "the agent changed with the folder")
        // Too long for one line beside the others on a phone: on a line of its own, whole,
        // within the screen.
        let agentChip = element("new-thread-agent", in: app)
        XCTAssertGreaterThan(long.frame.minY, agentChip.frame.maxY - 1, "the folder chip did not go to a line of its own")
        XCTAssertGreaterThanOrEqual(long.frame.minX, 0, "the folder chip runs off the screen")
        XCTAssertLessThanOrEqual(long.frame.maxX, app.frame.width, "the folder chip runs off the screen")
        Thread.sleep(forTimeInterval: 0.6)
        shot("4-wrapped")

        send("hello from the new thread button", in: app)
        XCTAssertTrue(startedThread(agent: "fake-2", folder: "/work/client-onboarding-redesign", notIn: before),
                      "no thread of Fake agent 2 in client-onboarding-redesign on Mini")
        shot("6-sent")
    }

    /// The chat's button that brings the sidebar out, tapped where it is (a tap on the
    /// element did nothing on a new thread, see BlankUITests), until the chat is aside.
    private func openSidebar(_ app: XCUIApplication) {
        let button = app.buttons["Agents and threads"]
        XCTAssertTrue(button.waitForExistence(timeout: 10), "no sidebar button over the chat")
        for _ in 0 ..< 3 where sidebarIsAway(app) {
            button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            for _ in 0 ..< 10 where sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        }
        XCTAssertFalse(sidebarIsAway(app), "the sidebar did not come out")
    }

    /// Whether the keyboard is up: a phone's, on screen.
    private func keyboardIsUp(_ app: XCUIApplication) -> Bool {
        let keyboard = app.keyboards.firstMatch
        return keyboard.exists && keyboard.frame.minY < app.frame.maxY - 1
    }

    /// Typed in the sidebar's search, New thread leaves no keyboard behind for the search
    /// field, gone with the sidebar (Codex's review of 22d91ef1).
    func testNewThreadFromASearchTakesTheSearchsKeyboardAway() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "a phone's")
        let app = try launch()
        let search = app.textFields["Search threads"]
        XCTAssertTrue(search.waitForExistence(timeout: 30), "no search field")
        Thread.sleep(forTimeInterval: 1)
        search.tap()
        search.typeText("thr")
        for _ in 0 ..< 25 where !keyboardIsUp(app) { Thread.sleep(forTimeInterval: 0.2) }
        shot("7-searching")
        XCTAssertTrue(keyboardIsUp(app), "no keyboard for the search")
        app.buttons["sidebar-new-thread"].tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        XCTAssertTrue(sidebarIsAway(app), "the sidebar stayed")
        Thread.sleep(forTimeInterval: 1)
        shot("7-after-search")
        XCTAssertFalse(search.value(forKey: "hasKeyboardFocus") as? Bool ?? false, "the search field kept the keyboard behind the chat")
        XCTAssertFalse(keyboardIsUp(app), "the keyboard stayed up over the new thread's chips")
    }

    /// A new thread left with words in it, then New thread from the same agent and folder:
    /// the words come back, and on a phone the keyboard is left to a tap there too (Codex's
    /// review of 22d91ef1: the kept draft asked for the composer's cursor itself).
    func testNewThreadBringingBackAKeptDraftLeavesTheKeyboardDown() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "a phone's")
        let app = try launch()
        let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS 'Thread 1'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "no Thread 1 in the sidebar")
        Thread.sleep(forTimeInterval: 1)
        row.tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        // A new thread from it, with words left in it.
        openSidebar(app)
        app.buttons["sidebar-new-thread"].tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        // Words of this run's own: a new thread's words are kept for the next with its
        // agent and folder across launches, so an earlier run's are there before them.
        let words = "kept \(UUID().uuidString.prefix(6))"
        let composer = app.textFields["composer-field"]
        composer.tap()
        composer.typeText(words)
        // Thread 1 again, then New thread: the new thread with its words, kept.
        openSidebar(app)
        row.tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        openSidebar(app)
        app.buttons["sidebar-new-thread"].tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        XCTAssertTrue(sidebarIsAway(app), "the sidebar stayed")
        Thread.sleep(forTimeInterval: 1)
        shot("8-kept-draft")
        let kept = composer.value as? String ?? ""
        XCTAssertTrue(kept.hasSuffix(words), "the kept words did not come back: \(kept)")
        XCTAssertFalse(keyboardIsUp(app), "the kept draft brought the keyboard up over the chips")
    }

    /// On an iPad beside its sidebar, as + over the tabs does: a new thread's screen with its
    /// chips, the sidebar still beside it.
    func testOnAWideIPadItOpensANewTabBesideTheSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's")
        let app = try launch()
        let button = app.buttons["sidebar-new-thread"]
        XCTAssertTrue(button.waitForExistence(timeout: 30), "no New thread on the search's line")
        Thread.sleep(forTimeInterval: 1)
        shot("ipad-1-sidebar")
        button.tap()
        let agent = element("new-thread-agent", in: app)
        XCTAssertTrue(agent.waitForExistence(timeout: 10), "no agent chip on the new thread's screen")
        XCTAssertTrue(element("new-thread-mac", in: app).exists, "no Mac chip")
        XCTAssertTrue(element("new-thread-folder", in: app).exists, "no folder chip")
        XCTAssertTrue(button.isHittable, "the sidebar went")
        XCTAssertTrue(element("tab-new-thread", in: app).waitForExistence(timeout: 5), "no new thread's tab, as + makes")
        Thread.sleep(forTimeInterval: 1)
        shot("ipad-2-new-tab")
    }

    func testAFoldersOwnNewThreadStillStartsThereOnAPhone() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "a phone's")
        let app = try launch()
        // The api folder's row, and the compose mark at its end.
        let name = app.staticTexts["api"].firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 30), "no api folder in the sidebar")
        Thread.sleep(forTimeInterval: 1)
        let compose = app.buttons.allElementsBoundByIndex.first { button in
            button.identifier != "sidebar-new-thread" && abs(button.frame.midY - name.frame.midY) < 12
                && button.frame.minX > name.frame.maxX && button.isHittable
        }
        let control = try XCTUnwrap(compose, "no New thread on the api folder's row")
        let before = threadIDs()
        control.tap()
        let third = app.buttons["agent-choice-fake-3"]
        XCTAssertTrue(third.waitForExistence(timeout: 5), "no agent picker for the folder")
        third.tap()
        for _ in 0 ..< 20 where !sidebarIsAway(app) { Thread.sleep(forTimeInterval: 0.2) }
        XCTAssertTrue(sidebarIsAway(app), "the sidebar stayed")
        // Its screen has the chips too now, on the folder and the agent picked.
        let folderChip = element("new-thread-folder", in: app)
        XCTAssertTrue(folderChip.waitForExistence(timeout: 10), "no folder chip")
        XCTAssertEqual(folderChip.value as? String, "api")
        XCTAssertEqual(element("new-thread-agent", in: app).value as? String, "Fake agent 3")
        shot("5-folder-new-thread")
        send("hello from the folder", in: app)
        XCTAssertTrue(startedThread(agent: "fake-3", folder: "/work/clients/acme/api", notIn: before),
                      "no thread of Fake agent 3 in api on Mini")
    }
}
