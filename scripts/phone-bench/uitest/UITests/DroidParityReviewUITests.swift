import XCTest

/// Targeted PR #2 cases. Settings may select another model; every live turn is Haiku.
final class DroidParityReviewUITests: DroidParityUIHarness {
    private func dismissModel(in app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.35)).tap()
        XCTAssertTrue(app.buttons["spec-model-settings"].waitForNonExistence(timeout: 5))
    }

    private func selectModel(_ name: String, in app: XCUIApplication) {
        app.buttons["model-chip"].tap()
        XCTAssertTrue(app.buttons["spec-model-settings"].waitForExistence(timeout: 5))
        let models = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Model", "model-chip")).firstMatch
        XCTAssertTrue(models.waitForExistence(timeout: 5))
        models.tap()
        let search = app.textFields["Search models"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText(name)
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        XCTAssertTrue(app.buttons["spec-model-settings"].waitForExistence(timeout: 5))
        dismissModel(in: app)
    }

    private func openSpec(in app: XCUIApplication) {
        app.buttons["model-chip"].tap()
        XCTAssertTrue(app.buttons["spec-model-settings"].waitForExistence(timeout: 5))
        app.buttons["spec-model-settings"].tap()
        XCTAssertTrue(app.buttons["spec-model-default"].waitForExistence(timeout: 5))
    }

    private func saveSpec(in app: XCUIApplication) {
        let save = app.buttons["spec-model-save"]
        XCTAssertTrue(save.isEnabled)
        save.tap()
        XCTAssertTrue(save.waitForNonExistence(timeout: 10))
        dismissModel(in: app)
    }

    func testFollowingSpecMaxSurvivesModelSwitches() throws {
        try XCTSkipUnless(configuration.live, "requires advertised real model efforts")
        let maximum = try XCTUnwrap(configuration.maxModelName, "launcher must identify a settings-only max-capable model")
        let nonMaximum = try XCTUnwrap(configuration.nonMaxModelName, "launcher must identify settings-only Haiku 4.5 without Max")
        let haiku = try XCTUnwrap(configuration.haikuModelName)
        let app = launch(prompt: "Reply exactly ready. Do not use tools.")
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        selectModel(maximum, in: app)
        openSpec(in: app)
        app.buttons["spec-model-default"].tap()
        app.descendants(matching: .any)["spec-model-effort"].tap()
        XCTAssertTrue(app.buttons["Max"].waitForExistence(timeout: 5))
        app.buttons["Max"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["spec-model-effort"].label.contains("Max"))
        captureDetailed("PR2 settings-only following Spec Max", in: app)
        saveSpec(in: app)
        // Haiku 5.5 also advertises Max. Preserve a supported explicit effort.
        selectModel(haiku, in: app)
        XCTAssertTrue(NSPredicate(format: "value CONTAINS[c] %@", "Haiku").evaluate(with: app.buttons["model-chip"]))
        openSpec(in: app)
        captureDetailed("PR2 supported Spec Max survives return to Haiku 5.5", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["spec-model-effort"].label.contains("Max"))
        saveSpec(in: app)
        // No inference occurs on either settings-only model.
        selectModel(nonMaximum, in: app)
        openSpec(in: app)
        let effort = app.descendants(matching: .any)["spec-model-effort"]
        XCTAssertFalse(effort.label.contains("Max"))
        effort.tap()
        XCTAssertFalse(app.buttons["Max"].exists)
        XCTAssertTrue(app.buttons["Medium"].waitForExistence(timeout: 5))
        app.buttons["Medium"].tap()
        captureDetailed("PR2 Spec effort revalidated for settings-only Haiku 4.5", in: app)
        saveSpec(in: app)
        openSpec(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["spec-model-effort"].label.contains("Medium"))
        saveSpec(in: app)
        selectModel(haiku, in: app)
        send("Reply exactly pr2-model-switch-ok. Do not use tools.", in: app)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "pr2-model-switch-ok")).firstMatch.waitForExistence(timeout: 90))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        captureDetailed("PR2 model updates and Haiku inference remain usable", in: app)
    }

    func testCompletedChecklistDoesNotReturnDuringNextTurn() throws {
        try XCTSkipIf(configuration.live || configuration.legacyKind != nil, "scripted Droid fixture only")
        let app = launch(prompt: "droid-parity")
        defer { app.terminate() }
        XCTAssertTrue(app.buttons["run-status-plan"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Droid parity sample complete."].waitForExistence(timeout: 45))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        XCTAssertFalse(app.buttons["run-status-plan"].exists)
        send("slow", in: app)
        XCTAssertTrue(app.buttons["stop"].waitForExistence(timeout: 10))
        for _ in 0..<3 {
            XCTAssertTrue(app.buttons["stop"].exists, "Must inspect a running next turn")
            XCTAssertFalse(app.buttons["run-status-plan"].exists)
            XCTAssertFalse(app.descendants(matching: .any)["run-status-checklist"].exists)
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        captureDetailed("PR2 next running turn has no previous completed checklist", in: app)
        app.buttons["stop"].tap()
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
    }

    private func legacyModes(_ kind: String) throws {
        try XCTSkipUnless(!configuration.live && configuration.legacyKind == kind, "requires isolated --legacy-modes \(kind), never a real provider")
        let app = launch(prompt: "ready")
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 30))
        app.buttons["mode-chip"].tap()
        let expected = [
            ("full", "Full access", "Edits files and runs commands without asking"),
            ("edits", "Accept edits", "Edits files without asking, and asks before running commands"),
            ("ask", "Ask first", "Asks before editing files or running commands"),
            ("plan", "Plan", "Plans first, and asks before carrying the plan out"),
            ("default", "Your settings", "As the agent's own settings at the desk say"),
        ]
        var previous = -CGFloat.infinity
        for (id, title, description) in expected {
            let row = app.buttons["mode-\(id)"]
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            XCTAssertTrue(row.label.contains(title), "\(kind): \(title)")
            XCTAssertTrue(row.label.contains(description), "\(kind): complete standalone description")
            XCTAssertGreaterThan(row.frame.minY, previous, "\(kind): original mode order")
            previous = row.frame.minY
        }
        XCTAssertFalse(app.buttons["mode-medium"].exists)
        captureDetailed("PR2 \(kind) retains pre-PR mode labels order descriptions", in: app)
    }

    func testCodexKeepsOriginalModeMenu() throws { try legacyModes("codex") }
    func testCursorKeepsOriginalModeMenu() throws { try legacyModes("cursor") }
}
