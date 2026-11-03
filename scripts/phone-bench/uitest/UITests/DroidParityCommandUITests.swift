import XCTest

final class DroidParityCommandUITests: DroidParityUIHarness {
    private func menu(prefix: String = "/parity-", in app: XCUIApplication) -> XCUIElement {
        let field = app.textFields["composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(prefix)
        let menu = app.descendants(matching: .any)["command-menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 30))
        return menu
    }

    private func command(_ name: String, in menu: XCUIElement) -> XCUIElement {
        menu.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "/\(name),")).firstMatch
    }

    func testLiveProjectCommandsFollowEachThreadAndExpandArguments() throws {
        try XCTSkipUnless(configuration.live && configuration.secondCwd != nil, "requires --live --fixtures")
        let app = launch(prompt: "Reply exactly ready. Do not use tools.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        var choices = menu(in: app)
        XCTAssertTrue(command("parity-a", in: choices).exists)
        XCTAssertFalse(command("parity-b", in: choices).exists)
        let arguments = command("parity-args", in: choices)
        XCTAssertTrue(arguments.exists)
        XCTAssertTrue(arguments.label.contains("Project A"))
        XCTAssertEqual(choices.staticTexts.matching(NSPredicate(format: "label == %@", "Skill")).count, 0)
        captureDetailed("Droid project A command menu", in: app)
        arguments.tap()
        let field = app.textFields["composer-field"]
        XCTAssertTrue((field.value as? String)?.hasPrefix("/parity-args") == true)
        field.typeText((field.value as? String ?? "").hasSuffix(" ") ? "amber" : " amber")
        app.buttons["send"].tap()
        let answer = app.staticTexts.matching(identifier: "reply-text").matching(NSPredicate(format: "label CONTAINS %@", "parity-a-amber")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 90))
        XCTAssertTrue(contains("/parity-args amber", in: app).exists)
        captureDetailed("Droid custom command literal argument expansion", in: app)
        app.terminate()
        let second = launch(prompt: "Reply exactly ready. Do not use tools.", environment: ["PORTALS_DEV_CWD": configuration.secondCwd!])
        XCTAssertTrue(second.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        choices = menu(in: second)
        XCTAssertTrue(command("parity-b", in: choices).exists)
        XCTAssertFalse(command("parity-a", in: choices).exists)
        XCTAssertTrue(command("parity-args", in: choices).label.contains("Project B"))
        captureDetailed("Droid project B menu does not leak project A commands", in: second)
    }

    func testLivePersonalCommandStaysAcrossProjectThreads() throws {
        try XCTSkipUnless(configuration.live && configuration.personalCommand != nil && configuration.secondCwd != nil, "requires authenticated --scratch-home --fixtures")
        for (cwd, expected) in [(configuration.cwd, "portals-project-a-citrus"), (configuration.secondCwd!, "portals-personal-citrus")] {
            let app = launch(prompt: "Reply exactly ready. Do not use tools.", environment: ["PORTALS_DEV_CWD": cwd])
            XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
            let choices = menu(prefix: "/\(configuration.personalCommand!)", in: app)
            let personal = command(configuration.personalCommand!, in: choices)
            XCTAssertTrue(personal.exists)
            captureDetailed("Temporary personal command appears in each project", in: app)
            personal.tap()
            let field = app.textFields["composer-field"]
            field.typeText((field.value as? String ?? "").hasSuffix(" ") ? "citrus" : " citrus")
            app.buttons["send"].tap()
            let answer = app.staticTexts.matching(identifier: "reply-text").matching(NSPredicate(format: "label CONTAINS %@", expected)).firstMatch
            XCTAssertTrue(answer.waitForExistence(timeout: 90))
            captureDetailed("Personal command project precedence \(expected)", in: app)
            app.terminate()
        }
    }

    func testLiveCostRenameContextAndSlashCompact() throws {
        try XCTSkipUnless(configuration.live, "requires real Droid commands")
        let app = launch(prompt: "Remember this verification word: pear. Reply exactly remembered. Do not use tools.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        send("/cost", in: app)
        XCTAssertTrue(contains("Droid session usage (last observed)", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(contains("Factory credits:", in: app).exists)
        captureDetailed("Droid cost reports observed usage honestly", in: app)
        send("/rename parity-command-renamed", in: app)
        XCTAssertTrue(contains("Renamed this thread", in: app).waitForExistence(timeout: 20))
        let renamed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "chat-header", "parity-command-renamed")).firstMatch
        XCTAssertTrue(renamed.waitForExistence(timeout: 20))
        send("/context", in: app)
        XCTAssertTrue(contains("Context", in: app).waitForExistence(timeout: 30))
        captureDetailed("Droid slash context breakdown", in: app)
        send("/compact Preserve the verification word and thread title.", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["compaction"].waitForExistence(timeout: 120))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 60))
        send("Reply only with the verification word you remember. Do not use tools.", in: app)
        let pear = app.staticTexts.matching(identifier: "reply-text").matching(NSPredicate(format: "label CONTAINS %@", "pear")).firstMatch
        XCTAssertTrue(pear.waitForExistence(timeout: 90))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "compaction").count, 1)
        captureDetailed("Droid slash Compact keeps memory and one marker", in: app)
    }
}
