import UIKit
import XCTest

/// Opt-in native message-action checks against message-actions-bridge.mts.
/// Set UITests.EnvironmentVariables.PORTALS_MESSAGE_ACTIONS_UI_PLAN in the generated
/// .xctestrun file to the fixture's JSON plan. With no plan these tests skip.
/// The plan may provide an output folder for optional screenshots/state evidence.
class MessageActionsUIHarness: XCTestCase {
    var planEnvironment: String { "PORTALS_MESSAGE_ACTIONS_UI_PLAN" }
    var fixtureName: String { "message-actions" }
    private struct Plan: Decodable {
        let fixture: String
        let control: String
        let bundleIdentifier: String
        let output: String?
    }
    private var plan: Plan!
    var control = ""
    var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone" }
    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let path = ProcessInfo.processInfo.environment[planEnvironment],
            FileManager.default.fileExists(atPath: path)
        else { throw XCTSkip("No isolated message-actions fixture plan configured.") }
        plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        XCTAssertEqual(plan.fixture, fixtureName)
        control = plan.control
    }
    func request(_ path: String) throws -> [String: Any] {
        let done = expectation(description: path)
        var result: Result<Data, Error>!
        var status = 0
        URLSession.shared.dataTask(with: URL(string: control + path)!) { data, response, error in
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
            result = error.map { .failure($0) } ?? .success(data!)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        let bytes = try result.get()
        XCTAssertEqual(status, 200, String(decoding: bytes, as: UTF8.self))
        return try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    }
    func waitState(_ description: String, _ matches: ([String: Any]) -> Bool) throws -> [String: Any] {
        var result = try request("/state")
        let until = Date().addingTimeInterval(15)
        while !matches(result) && Date() < until {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            result = try request("/state")
        }
        XCTAssertTrue(matches(result), description)
        return result
    }
    func save(_ state: [String: Any], _ name: String) throws {
        guard let output = plan.output else { return }
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]).write(
            to: URL(fileURLWithPath: output + "/" + name + "-state.json"))
    }
    func capture(_ name: String, _ app: XCUIApplication) throws {
        let shot = XCUIScreen.main.screenshot()
        if let output = plan.output {
            try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
            try shot.pngRepresentation.write(to: URL(fileURLWithPath: output + "/" + name + ".png"))
        }
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    func environment(_ f: [String: Any]) throws -> [String: String] {
        let hosts: [[String: Any]] = [
            [
                "id": f["hostID"]!, "name": "UI fixture", "url": f["url"]!, "user": "tester",
                "password": "correct horse battery",
            ]
        ]
        return [
            "PORTALS_DEBUG_HOSTS": String(decoding: try JSONSerialization.data(withJSONObject: hosts), as: UTF8.self),
            "PORTALS_DEBUG_AGENT": "claude", "PORTALS_DEV_CWD": f["cwd"] as! String,
            "PORTALS_DEBUG_FOLDER": f["cwd"] as! String, "PORTALS_DEBUG_PUSH": "1",
        ]
    }
    func launch(_ style: String, kind: String = "plain", draft: String? = nil) throws -> (
        XCUIApplication, [String: Any]
    ) {
        let f = try request("/reset?kind=" + kind)
        let app = XCUIApplication(bundleIdentifier: plan.bundleIdentifier)
        app.terminate()
        app.launchEnvironment = try environment(f)
        if let draft { app.launchEnvironment["PORTALS_DEBUG_DRAFT"] = draft }
        app.launchArguments = ["-appearance.mode", style]
        if kind == "attachments" {
            app.launchEnvironment["PORTALS_DEBUG_PROMPT"] = f["prompt"] as? String
            app.launchEnvironment["PORTALS_DEBUG_IMAGE"] = f["image"] as? String
            app.launchEnvironment["PORTALS_DEBUG_FILE"] = f["attachment"] as? String
        } else {
            app.launchEnvironment["PORTALS_DEBUG_OPEN_PLAN"] = (f["source"] as! String) + ":0.25"
        }
        app.launch()
        let prompt = f["prompt"] as! String
        let selected = app.textViews.matching(
            NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", prompt, prompt)
        ).firstMatch
        let opened = selected.waitForExistence(timeout: 40)
        if !opened { try capture(device + "-" + style + "-source-failure", app) }
        XCTAssertTrue(opened, "exact source transcript did not open")
        XCTAssertTrue(app.buttons["message-fork-actions"].firstMatch.waitForExistence(timeout: 20))
        return (app, f)
    }
    func action(_ name: String, _ app: XCUIApplication) {
        let actions = app.buttons["message-fork-actions"].firstMatch
        XCTAssertTrue(actions.waitForExistence(timeout: 10))
        if !actions.isHittable { app.swipeDown() }
        XCTAssertTrue(actions.isHittable)
        actions.tap()
        let item = app.buttons[name]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        XCTAssertTrue(item.isEnabled)
        item.tap()
    }
    func editCancel(_ app: XCUIApplication) -> XCUIElement {
        let identified = app.buttons["message-edit-cancel"]
        if identified.exists { return identified }
        return app.buttons["Cancel"].firstMatch
    }
    func composer(_ app: XCUIApplication) -> XCUIElement {
        let field = app.textFields["composer-field"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        return field
    }
    func replace(_ text: String, in field: XCUIElement, app: XCUIApplication) {
        field.tap()
        field.press(forDuration: 1.2)
        let selectAll = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All"))
            .firstMatch
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5), "iOS Select All was unavailable")
        selectAll.tap()
        field.typeText(text)
        XCTAssertEqual(field.value as? String, text)
    }
    func unchanged(_ s: [String: Any]) throws {
        let before = s["baseline"] as! [[String: Any]]
        let after = (s["snapshot"] as! [String: Any])["messages"] as! [[String: Any]]
        XCTAssertEqual(before.count, after.count)
        for (a, b) in zip(before, after) {
            XCTAssertEqual(a["role"] as? String, b["role"] as? String)
            XCTAssertEqual(a["text"] as? String, b["text"] as? String)
        }
    }
    func noRequests(_ s: [String: Any]) {
        XCTAssertEqual((s["forks"] as! [Any]).count, 0)
        XCTAssertEqual((s["calls"] as! [Any]).count, 0)
    }
    func selectedThread(_ id: String, _ app: XCUIApplication) {
        if UIDevice.current.userInterfaceIdiom == .pad {
            let tab = app.buttons["tab-" + id]
            XCTAssertTrue(tab.waitForExistence(timeout: 10))
            XCTAssertTrue(tab.isSelected)
        }
    }
    func returnToSource(_ f: [String: Any], _ app: XCUIApplication) {
        let id = f["source"] as! String
        if UIDevice.current.userInterfaceIdiom == .pad {
            app.buttons["tab-" + id].tap()
        } else {
            app.buttons["open-sidebar"].tap()
            let row = app.buttons.matching(identifier: "thread-row").matching(
                NSPredicate(format: "label BEGINSWITH %@", (f["title"] as! String) + ",")
            ).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
        }
    }
}

final class MessageActionsUITests: MessageActionsUIHarness {
    func direct(_ style: String) throws {
        var (app, f) = try launch(style)
        action("Fork from here", app)
        var state = try waitState("direct fork did not run") { ($0["forks"] as! [Any]).count == 1 }
        let fork = (state["forks"] as! [[String: Any]])[0]
        XCTAssertEqual(fork["id"] as? String, f["source"] as? String)
        XCTAssertEqual(fork["checkpoint"] as? String, "first")
        XCTAssertEqual(fork["before"] as? Bool, false)
        let prefix = fork["prefix"] as! [[String: Any]]
        XCTAssertEqual(prefix.count, 2)
        XCTAssertEqual(prefix[1]["text"] as? String, "Updated the welcome message.")
        XCTAssertEqual((state["calls"] as! [Any]).count, 0)
        try unchanged(state)
        XCTAssertFalse(app.buttons["message-fork-create"].exists)
        XCTAssertFalse(app.staticTexts["Fork from here"].exists)
        selectedThread(fork["newID"] as! String, app)
        let copiedReply = app.textViews.matching(
            NSPredicate(
                format: "label == %@ OR value == %@", "Updated the welcome message.", "Updated the welcome message.")
        ).firstMatch
        XCTAssertTrue(
            copiedReply.waitForExistence(timeout: 15), "selected assistant reply did not render in direct fork")
        try capture(device + "-" + style + "-direct-fork", app)
        try save(state, device + "-" + style + "-direct-fork")
        app.terminate()

    }
    func flow(_ style: String, includeDirect: Bool = true) throws {
        if includeDirect { try direct(style) }
        var state: [String: Any] = [:]
        var (app, f) = try launch(style, draft: "Prior source draft")
        XCTAssertEqual(composer(app).value as? String, "Prior source draft")
        action("Edit and send again", app)
        let cancel = editCancel(app)
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        XCTAssertTrue(cancel.isHittable)
        XCTAssertTrue(app.staticTexts["Editing message"].exists)
        XCTAssertEqual(composer(app).value as? String, f["prompt"] as? String)
        selectedThread(f["source"] as! String, app)
        state = try request("/state")
        noRequests(state)
        try unchanged(state)
        XCTAssertFalse(app.buttons["message-fork-create"].exists)
        try capture(device + "-" + style + "-editing-composer", app)
        cancel.tap()
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 5))
        XCTAssertEqual(composer(app).value as? String, "Prior source draft")
        state = try request("/state")
        noRequests(state)
        try unchanged(state)
        try save(state, device + "-" + style + "-edit-cancel")
        action("Edit and send again", app)
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        replace("Revised request", in: composer(app), app: app)
        app.buttons["send"].tap()
        state = try waitState("edited Send did not fork/send once") {
            ($0["forks"] as! [Any]).count == 1 && ($0["calls"] as! [Any]).count == 1
        }
        let editFork = (state["forks"] as! [[String: Any]])[0]
        let sent = (state["calls"] as! [[String: Any]])[0]
        XCTAssertEqual(editFork["before"] as? Bool, true)
        XCTAssertEqual((editFork["prefix"] as! [Any]).count, 0)
        XCTAssertEqual(sent["id"] as? String, editFork["newID"] as? String)
        XCTAssertEqual(sent["text"] as? String, "Revised request")
        XCTAssertEqual((sent["images"] as! [Any]).count, 0)
        XCTAssertEqual((sent["files"] as! [Any]).count, 0)
        try unchanged(state)
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 5))
        selectedThread(editFork["newID"] as! String, app)
        let completed = app.textViews.matching(
            NSPredicate(format: "label == %@ OR value == %@", "Stand-in reply", "Stand-in reply")
        ).firstMatch
        XCTAssertTrue(completed.waitForExistence(timeout: 15))
        try capture(device + "-" + style + "-edited-send", app)
        try save(state, device + "-" + style + "-edited-send")
        returnToSource(f, app)
        XCTAssertEqual(composer(app).value as? String, "Prior source draft")
        XCTAssertFalse(editCancel(app).exists)
        state = try request("/state")
        XCTAssertEqual((state["forks"] as! [Any]).count, 1)
        XCTAssertEqual((state["calls"] as! [Any]).count, 1)
        try unchanged(state)
        app.terminate()

        (app, f) = try launch(style, kind: "attachments")
        let originalText = f["prompt"] as! String
        let sealed = try request("/seal")
        let original = sealed["originalPayload"] as! [String: Any]
        XCTAssertEqual((original["images"] as! [Any]).count, 1)
        XCTAssertEqual((original["files"] as! [Any]).count, 1)
        action("Edit and send again", app)
        XCTAssertTrue(editCancel(app).waitForExistence(timeout: 10))
        XCTAssertEqual(composer(app).value as? String, originalText)
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "notes.txt")).firstMatch
                .exists)
        try capture(device + "-" + style + "-attachment-edit", app)
        replace("Revised attachment request", in: composer(app), app: app)
        app.buttons["send"].tap()
        state = try waitState("attachment edit Send did not fork/send once") {
            ($0["forks"] as! [Any]).count == 1 && ($0["calls"] as! [Any]).count == 1
        }
        let payload = (state["calls"] as! [[String: Any]])[0]
        let attachmentFork = (state["forks"] as! [[String: Any]])[0]
        XCTAssertEqual(payload["id"] as? String, attachmentFork["newID"] as? String)
        XCTAssertTrue((payload["text"] as! String).hasPrefix("Revised attachment request"))
        for key in ["images", "files"] {
            let expected = original[key] as! [[String: Any]]
            let actual = payload[key] as! [[String: Any]]
            XCTAssertEqual(actual.count, expected.count)
            for (a, b) in zip(expected, actual) {
                XCTAssertEqual(a["sha256"] as? String, b["sha256"] as? String)
                XCTAssertEqual(a["bytes"] as? Int, b["bytes"] as? Int)
                XCTAssertEqual(a["filename"] as? String, b["filename"] as? String)
            }
        }
        XCTAssertEqual(attachmentFork["before"] as? Bool, true)
        try unchanged(state)
        try capture(device + "-" + style + "-attachment-edited-send", app)
        try save(state, device + "-" + style + "-attachment-edited-send")
        app.terminate()
    }
    func testLightMessageActions() throws { try flow("light") }
    func testDarkMessageActions() throws { try flow("dark") }
    func testRemovedSourceDuringHeldEditSendDoesNotSend() throws {
        let (app, f) = try launch("light", draft: "Prior source draft")
        defer {
            _ = try? request("/release-fork")
            app.terminate()
        }
        action("Edit and send again", app)
        XCTAssertTrue(editCancel(app).waitForExistence(timeout: 10))
        replace("Revised held request", in: composer(app), app: app)
        _ = try request("/hold-fork")
        app.buttons["send"].tap()
        var state = try waitState("before-fork did not reach held provider") {
            let forks = $0["forks"] as! [[String: Any]]
            return forks.count == 1 && forks[0]["waiting"] as? Bool == true
        }
        XCTAssertEqual((state["calls"] as! [Any]).count, 0)
        let removed = try request("/remove-source")
        XCTAssertEqual(removed["removed"] as? Bool, true)
        XCTAssertGreaterThan(removed["after"] as! Int, removed["before"] as! Int)
        let prompt = f["prompt"] as! String
        let source = app.textViews.matching(NSPredicate(format: "label == %@ OR value == %@", prompt, prompt))
            .firstMatch
        let disappeared = source.waitForNonExistence(timeout: 20)
        try capture(device + "-held-source-removal-before-release", app)
        XCTAssertTrue(disappeared, "registry removal did not remove the exact source transcript")
        XCTAssertFalse(editCancel(app).exists)
        let sourceTab = app.buttons["tab-" + (f["source"] as! String)]
        XCTAssertTrue(sourceTab.waitForNonExistence(timeout: 5))
        _ = try request("/release-fork")
        state = try waitState("released fork was not adopted by scratch host") {
            let forks = $0["forks"] as! [[String: Any]]
            return forks.count == 1 && forks[0]["adopted"] as? Bool == true
        }
        let pause = expectation(description: "closed source cannot deliver edited prompt")
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { pause.fulfill() }
        wait(for: [pause], timeout: 3)
        state = try request("/state")
        XCTAssertEqual((state["calls"] as! [Any]).count, 0)
        XCTAssertEqual(state["sourceListed"] as? Bool, false)
        let original = (state["histories"] as! [String: Any])[f["source"] as! String]!
        XCTAssertEqual(
            try JSONSerialization.data(withJSONObject: original, options: [.sortedKeys]),
            try JSONSerialization.data(withJSONObject: state["baseline"]!, options: [.sortedKeys]))
        let fork = (state["forks"] as! [[String: Any]])[0]
        XCTAssertFalse(app.buttons["tab-" + (fork["newID"] as! String)].exists)
        try capture(device + "-held-source-removal-no-send", app)
        try save(state, device + "-held-source-removal-no-send")
        app.terminate()
    }
}
