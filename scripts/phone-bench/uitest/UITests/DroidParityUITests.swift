import XCTest

/// Opt-in: PORTALS_PARITY_UI_CONFIG points to the private ui.json printed by
/// droid-parity-bridge.mts. Uses only a separately built .parity app, never the normal app.
final class DroidParityUITests: DroidParityUIHarness {
    private func openModePicker(in app: XCUIApplication, atSymbol: Bool = false) {
        let chip = app.buttons["mode-chip"]
        print("MODE_HIT before symbol=\(atSymbol) frame=\(chip.frame) hittable=\(chip.isHittable) keyboards=\(app.keyboards.count)")
        if atSymbol {
            chip.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5)).tap()
        } else {
            chip.tap()
        }
        let opened = app.buttons["mode-ask"].waitForExistence(timeout: 5)
        print("MODE_HIT after symbol=\(atSymbol) opened=\(opened) frame=\(chip.frame) hittable=\(chip.isHittable) keyboards=\(app.keyboards.count)")
        capture(atSymbol ? "Mode symbol tap" : "Mode button tap")
        XCTAssertTrue(opened, "mode tap focused the composer or failed to open the picker")
    }

    func testModeSymbolCenterOpensPicker() throws {
        let app = launch(prompt: "Reply with exactly parity-ready.")
        XCTAssertTrue(app.buttons["mode-chip"].waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 60))
        openModePicker(in: app, atSymbol: true)
    }

    func testModeMediumAndInheritedDefault() throws {
        let app = launch(prompt: "Reply with exactly parity-ready.")
        let chip = app.buttons["mode-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 60))
        openModePicker(in: app)
        for id in ["ask", "edits", "medium", "full", "plan", "default"] {
            XCTAssertTrue(app.buttons["mode-\(id)"].waitForExistence(timeout: 5), "missing \(id)")
        }
        XCTAssertTrue(contains("Reversible development actions", in: app).exists)
        capture("Droid autonomy descriptions")
        app.buttons["mode-medium"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(NSPredicate(format: "value CONTAINS %@", "Medium").evaluate(with: chip))
        chip.tap()
        app.buttons["mode-default"].tap()
        XCTAssertTrue(NSPredicate(format: "value CONTAINS %@", "Default").evaluate(with: chip))
        if !configuration.live {
            XCTAssertTrue(NSPredicate(format: "value CONTAINS %@", "Medium").evaluate(with: chip))
        }
        chip.tap()
        app.buttons["mode-ask"].tap()
        XCTAssertTrue(NSPredicate(format: "value CONTAINS %@", "Off").evaluate(with: chip))
        capture("Droid Off selected")
    }

    func testModelAndAttachCentersDoNotFocusComposer() throws {
        let app = launch(prompt: "Reply with exactly parity-ready.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 60))
        let model = app.buttons["model-chip"]
        print("CONTROL_HIT model frame=\(model.frame) hittable=\(model.isHittable)")
        model.tap()
        let reset = app.buttons["Reset to the agent's own"]
        XCTAssertTrue(reset.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("Model center tap opens picker")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)).tap()
        XCTAssertTrue(reset.waitForNonExistence(timeout: 5))
        let attach = app.buttons["attach"]
        print("CONTROL_HIT attach frame=\(attach.frame) hittable=\(attach.isHittable)")
        attach.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Photo Library")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        capture("Attach center tap opens menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)).tap()
        let field = app.textFields["composer-field"]
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        print("CONTROL_HIT composer keyboard=\(app.keyboards.count)")
        capture("Text field still starts typing")
    }

    func testEstimatedContextAndCompactKeepsConversation() throws {
        try XCTSkipUnless(configuration.live, "requires real Droid context and compaction")
        let app = launch(prompt: "Remember this verification word: pear. Reply with exactly remembered.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        let ring = app.buttons["context-ring"]
        XCTAssertTrue(ring.waitForExistence(timeout: 10))
        XCTAssertTrue(NSPredicate(format: "value CONTAINS[c] %@", "estimated").evaluate(with: ring))
        app.buttons["mode-chip"].tap()
        app.buttons["mode-ask"].tap()
        send("/context", in: app)
        XCTAssertTrue(contains("context (estimated)", in: app).waitForExistence(timeout: 30))
        XCTAssertTrue(contains("tokens used", in: app).exists)
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        ring.tap()
        let compact = app.buttons["context-compact"]
        XCTAssertTrue(compact.waitForExistence(timeout: 5))
        XCTAssertTrue(compact.isEnabled)
        XCTAssertTrue(contains("Estimated context", in: app).exists)
        capture("Droid estimated context and Compact")
        compact.tap()
        XCTAssertTrue(app.descendants(matching: .any)["compaction"].waitForExistence(timeout: 120))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        capture("Droid compacted in the same thread")
        send("What verification word did I ask you to remember? Reply with that word only.", in: app)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES[c] %@", "^pear[.!]?$")).firstMatch.waitForExistence(timeout: 90))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        capture("Droid remembers after compaction")
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "PORTALS_DEBUG_PROMPT")
        app.launchEnvironment["PORTALS_DEBUG_OPEN_LATEST"] = "1"
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["compaction"].waitForExistence(timeout: 60))
        XCTAssertTrue(NSPredicate(format: "value CONTAINS %@", "Off").evaluate(with: app.buttons["mode-chip"]))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES[c] %@", "^pear[.!]?$")).firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(NSPredicate(format: "value CONTAINS[c] %@", "estimated").evaluate(with: app.buttons["context-ring"]))
        capture("Compaction, Off and memory survive app reopen")
    }

    func testEveryQuestionRequiresAnAnswerAndBackPreservesIt() throws {
        let prompt = configuration.live
            ? "Use AskUser now with exactly two single-choice questions. First: Which language should the parity sample use? Choices Swift and Python. Second: Which checks should the parity sample include? Choices Unit tests and UI tests. Wait for my answers, then say done. Do not use other tools."
            : "droid-parity ask"
        let app = launch(prompt: prompt)
        let next = app.buttons["clarify-next"]
        XCTAssertTrue(next.waitForExistence(timeout: 90))
        XCTAssertFalse(next.isEnabled)
        app.buttons["Swift"].tap()
        let send = app.buttons["clarify-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertFalse(send.isEnabled)
        app.buttons["UI tests"].tap()
        XCTAssertTrue(send.isEnabled)
        app.buttons["clarify-skip"].tap()
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        app.buttons["Python"].tap()
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled, "second answer was lost when going back")
        capture("Both Droid answers retained")
        send.tap()
        XCTAssertTrue(send.waitForNonExistence(timeout: 10))
    }

    func testLiveCustomAnswerAndMultipleSelections() throws {
        try XCTSkipUnless(configuration.live, "requires real Droid question choices")
        let app = launch(prompt: "Use AskUser now with exactly two questions. First ask which language, single choice Swift or Python. Second ask which checks to include, multi-select Unit tests and UI tests. Wait for every answer, then say done. Do not use other tools.")
        let other = app.buttons["clarify-other"]
        XCTAssertTrue(other.waitForExistence(timeout: 90))
        print("OTHER_HIT before frame=\(other.frame) hittable=\(other.isHittable)")
        captureDetailed("Other before tap", in: app)
        other.tap()
        let custom = app.descendants(matching: .any)["clarify-custom-answer"]
        let appeared = custom.waitForExistence(timeout: 5)
        print("OTHER_HIT after appeared=\(appeared) keyboards=\(app.keyboards.count)")
        captureDetailed(appeared ? "Other custom field appeared" : "Other field missing after 5 seconds", in: app)
        XCTAssertTrue(appeared)
        custom.tap()
        custom.typeText("Rust")
        let next = app.buttons["clarify-next"]
        XCTAssertTrue(next.isEnabled)
        next.tap()
        app.buttons["Unit tests"].tap()
        app.buttons["UI tests"].tap()
        let submit = app.buttons["clarify-send"]
        XCTAssertTrue(submit.isEnabled)
        capture("Live custom answer and multiple selections")
        submit.tap()
        XCTAssertTrue(submit.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 60))
    }

    func testLiveRequiredQuestionCanBeCancelled() throws {
        try XCTSkipUnless(configuration.live, "requires a real required Droid question")
        let app = launch(prompt: "Use AskUser with one required question, choosing Swift or Python. Wait for my answer, then say done. Do not use other tools.")
        let cancel = app.buttons["clarify-skip"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 90))
        cancel.tap()
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 60))
        capture("Live required questionnaire cancelled explicitly")
    }

    func testStopErrorAndNextTurnRecover() throws {
        try XCTSkipIf(configuration.live, "failure is synthetic, no real command runs")
        let app = launch(prompt: "droid-parity")
        XCTAssertTrue(app.buttons["run-status"].waitForExistence(timeout: 30))
        app.buttons["stop"].tap()
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        send("fail", in: app)
        XCTAssertTrue(contains("The fake agent failed on purpose.", in: app).waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        send("hello again", in: app)
        XCTAssertTrue(contains("You said: hello again.", in: app).waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        capture("Stopped and failed turns leave the composer usable")
    }

    func testRichApprovalExplainsPersistentScopeBeforeConfirming() throws {
        try XCTSkipIf(configuration.live, "persistent grant confirmation is synthetic only")
        let app = launch(prompt: "droid-parity approval")
        let more = app.buttons["approval-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 30))
        XCTAssertTrue(app.descendants(matching: .any)["approval-details"].exists)
        more.tap()
        let option = app.buttons["approval-option-proceed_always_file"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        let confirm = app.buttons["approval-confirm-proceed_always_file"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        XCTAssertTrue(contains("Saved across sessions: hello.txt only.", in: app).exists)
        XCTAssertFalse(contains("Scripted option:", in: app).exists, "choosing an option must not approve it")
        capture("Persistent approval scope before confirmation")
        app.buttons["Back"].tap()
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["approve-once"].waitForExistence(timeout: 5))
        more.tap()
        app.buttons["approval-option-proceed_always_file"].tap()
        app.buttons["approval-confirm-proceed_always_file"].tap()
        XCTAssertTrue(contains("Scripted option: proceed_always_file. Nothing executed.", in: app).waitForExistence(timeout: 15))
    }

    func testLimitedApprovalDoesNotInventBroadOptions() throws {
        try XCTSkipIf(configuration.live, "requires deterministic offered options")
        let app = launch(prompt: "droid-parity approval limited")
        let deny = app.buttons["approve-deny"]
        XCTAssertTrue(deny.waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["approve-once"].exists)
        XCTAssertFalse(app.buttons["approval-more"].exists)
        capture("Only offered approval outcomes")
        deny.tap()
        XCTAssertTrue(contains("Scripted option: cancel. Nothing executed.", in: app).waitForExistence(timeout: 15))
    }

    func testEditedSpecPlanReturnsMarkdownWithoutStarting() throws {
        try XCTSkipIf(configuration.live, "proceed_edit has not been observed in the live CLI")
        let app = launch(prompt: "droid-parity plan")
        let more = app.buttons["approval-more"]
        XCTAssertTrue(more.waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["plan-start"].exists)
        more.tap()
        let replacement = app.buttons["approval-option-proceed_new_session_high"]
        XCTAssertTrue(replacement.waitForExistence(timeout: 5))
        replacement.tap()
        XCTAssertTrue(contains("New SDK session; same visible thread. High autonomy.", in: app).waitForExistence(timeout: 5))
        capture("New session approval explains High autonomy")
        app.buttons["Back"].tap()
        app.buttons["approval-option-proceed_edit"].tap()
        let editor = app.textViews["approval-edited-plan"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String)?.contains("# Parity plan") == true)
        editor.tap()
        editor.typeText("\n3. Parity edit stays in planning.")
        capture("Edited Spec Markdown")
        app.buttons["approval-confirm-proceed_edit"].tap()
        XCTAssertTrue(contains("Scripted option: proceed_edit. Nothing executed.", in: app).waitForExistence(timeout: 15))
        XCTAssertTrue(contains("Parity edit stays in planning.", in: app).exists)
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 5))
    }

    /// Since 2026-10-23 Spec mode plans with the thread's own model and level: the model
    /// picker has no Spec model of its own.
    func testModelPickerOffersNoSpecModel() throws {
        let app = launch(prompt: "Reply exactly ready. Do not use tools.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: configuration.live ? 90 : 30))
        app.buttons["model-chip"].tap()
        XCTAssertTrue(app.buttons["Reset to the agent's own"].waitForExistence(timeout: 10))
        capture("Model picker without a Spec model")
        XCTAssertFalse(app.buttons["spec-model-settings"].exists)
    }

    func testLiveSpecPlanCanBeInspectedAndDeclined() throws {
        try XCTSkipUnless(configuration.live, "requires real Droid Spec approval")
        let app = launch(prompt: "Reply with exactly ready. Do not use tools.")
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        app.buttons["mode-chip"].tap()
        app.buttons["mode-plan"].tap()
        send("Use ExitSpecMode to propose a minimal plan for adding one line to a new README in this scratch repository. Do not write files or run commands. Wait for my approval.", in: app)
        let keep = app.buttons["plan-keep"]
        XCTAssertTrue(keep.waitForExistence(timeout: 90))
        XCTAssertTrue(app.buttons["plan-start"].exists)
        capture("Live Droid Spec approval")
        if app.buttons["approval-more"].exists {
            app.buttons["approval-more"].tap()
            print("LIVE_SPEC_EDIT offered=\(app.buttons["approval-option-proceed_edit"].exists)")
            capture("Live offered Spec outcomes, no persistent grant selected")
            app.buttons["Done"].tap()
        }
        keep.tap()
        XCTAssertTrue(keep.waitForNonExistence(timeout: 15))
        capture("Live Spec kept in planning")
    }

    private func planScreenshot(_ state: String) throws {
        capture("Droid plan status \(state)")
        if let directory = ProcessInfo.processInfo.environment["PORTALS_PARITY_SCREENSHOTS"], directory.hasPrefix("/") {
            let root = URL(fileURLWithPath: directory)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: root.appendingPathComponent("plan-status-simulator-\(state).png"))
        }
    }

    func testTodoChecklistInRunStatusAndNoIdleBar() throws {
        try XCTSkipIf(configuration.live, "deterministic activity scenario requires the scripted bridge")
        let app = launch(prompt: "droid-parity subagents")
        let toggle = app.buttons["run-status"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 30))
        XCTAssertFalse(toggle.label.contains("Step 2 of 3"))
        let tasks = app.buttons["run-status-plan"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 5))
        XCTAssertTrue(tasks.label.contains("Step 2 of 3"))
        XCTAssertTrue(tasks.label.contains("Implement progress"))
        XCTAssertTrue(app.staticTexts["live-tool-output"].waitForExistence(timeout: 5))
        try planScreenshot("collapsed")
        tasks.tap()
        XCTAssertTrue(app.descendants(matching: .any)["run-status-checklist"].waitForExistence(timeout: 5))
        for row in ["Completed: Inspect bridge", "In progress: Implement progress", "Pending: Run tests"] {
            XCTAssertTrue(contains(row, in: app).waitForExistence(timeout: 5))
        }
        try planScreenshot("expanded")
        let subagents = app.descendants(matching: .any)["foot-line"]
        XCTAssertTrue(subagents.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(subagents.frame.minY, tasks.frame.minY)
        try planScreenshot("subagents")
        toggle.tap()
        XCTAssertTrue(app.descendants(matching: .any)["run-status-checklist"].waitForNonExistence(timeout: 5))
        tasks.tap()
        XCTAssertTrue(app.descendants(matching: .any)["run-status-checklist"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["stop"].exists)
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 45))
        XCTAssertTrue(toggle.waitForNonExistence(timeout: 5))
        XCTAssertTrue(tasks.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["current-plan"].exists)
        XCTAssertFalse(app.buttons["current-plan-toggle"].exists)
        try planScreenshot("idle")
    }

    func testExecuteOutputArrivesBeforeCompletionWithoutDuplication() throws {
        try XCTSkipIf(configuration.live, "deterministic activity scenario requires the scripted bridge")
        let app = launch(prompt: "droid-parity")
        let status = app.buttons["run-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 30))
        XCTAssertFalse(status.label.contains("Step 2 of 3"))
        XCTAssertTrue(app.buttons["run-status-plan"].label.contains("Step 2 of 3"))
        XCTAssertTrue(app.staticTexts["live-tool-output"].waitForExistence(timeout: 5), "live output remains visible alongside the separate tasks header")
        XCTAssertTrue(app.buttons["stop"].exists)
        status.tap()
        XCTAssertTrue(contains("parity-first", in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(contains("printf", in: app).exists)
        XCTAssertTrue(app.buttons["stop"].exists, "first output arrived only after the turn ended")
        XCTAssertTrue(contains("parity-second", in: app).waitForExistence(timeout: 20))
        capture("Droid cumulative Execute output")
        XCTAssertTrue(contains("Droid parity sample complete.", in: app).waitForExistence(timeout: 45))
        let output = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "parity-first\nparity-second"))
        XCTAssertEqual(output.count, 1, "expected exactly one cumulative output block")
        XCTAssertEqual(output.firstMatch.label.components(separatedBy: "parity-first").count - 1, 1, "output snapshot was appended instead of replaced")
    }
}
