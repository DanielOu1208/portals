import XCTest

/// Opt-in checks against file-undo-bridge.mts. Set the runner's
/// PORTALS_FILE_UNDO_UI_PLAN to its plan; without an isolated fixture these skip.
final class FileUndoUITests: MessageActionsUIHarness {
    override var planEnvironment: String { "PORTALS_FILE_UNDO_UI_PLAN" }
    override var fixtureName: String { "file-undo" }
    private func actual(_ state: [String: Any]) -> Int {
        (state["rewinds"] as! [[String: Any]]).filter { $0["dryRun"] as? Bool == false }.count
    }

    func preview(_ app: XCUIApplication, _ f: [String: Any], _ name: String) throws {
        action("Undo file changes…", app)
        let apply = app.buttons["file-undo-confirm"]
        XCTAssertTrue(apply.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "enabled == true")
        expectation(for: ready, evaluatedWith: apply)
        waitForExpectations(timeout: 15)
        let path = app.descendants(matching: .any).matching(identifier: "file-undo-path").firstMatch
        XCTAssertTrue(path.exists)
        XCTAssertTrue(path.label.contains("feature.txt"))
        XCTAssertFalse(path.label.contains(f["cwd"] as! String))
        XCTAssertTrue(app.staticTexts["feature.txt"].exists)
        XCTAssertTrue(app.staticTexts["Sources"].exists)
        XCTAssertTrue(app.staticTexts["+3"].exists)
        XCTAssertTrue(app.staticTexts["−2"].exists)
        XCTAssertFalse(app.buttons["file-undo-review"].exists)
        XCTAssertFalse(app.buttons["file-undo-refresh"].exists)
        XCTAssertFalse(app.buttons["Refresh preview"].exists)
        XCTAssertEqual(apply.label, "Undo Changes")
        XCTAssertTrue(apply.isHittable)
        let title = app.staticTexts["Undo changes"]
        XCTAssertTrue(title.exists)
        XCTAssertLessThan(apply.frame.maxY - title.frame.minY, min(620, app.frame.height * 0.8))
        XCTAssertTrue(app.frame.contains(apply.frame))
        XCTAssertTrue(app.frame.contains(path.frame))
        do {
            let maximumWidth = min(650, app.frame.width - 4)
            let nativeSheets = app.sheets.allElementsBoundByIndex.filter {
                $0.frame.width >= 300 && $0.frame.width <= maximumWidth
            }
            let titleBounds = title.frame
            let applyBounds = apply.frame
            let candidates =
                nativeSheets.isEmpty
                ? app.descendants(matching: .other).allElementsBoundByIndex.filter {
                    let frame = $0.frame
                    return frame.width >= 300 && frame.width <= maximumWidth && frame.contains(titleBounds)
                        && frame.contains(applyBounds)
                } : nativeSheets
            XCTAssertFalse(candidates.isEmpty, "native fitted sheet bounds were not exposed")
            let bounds = candidates.map(\.frame).max { $0.height < $1.height }!
            let limit = min(620, apply.frame.maxY - title.frame.minY + 96)
            XCTAssertLessThanOrEqual(bounds.height, limit, "native sheet has blank height beyond its content")
            try save(
                [
                    "x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height,
                    "contentHeightLimit": limit, "nativeSheetRole": !nativeSheets.isEmpty,
                ], name + "-bounds")
        }
        let state = try request("/state")
        XCTAssertEqual(actual(state), 0)
        XCTAssertEqual(state["content"] as? String, "after\n")
        try unchanged(state)
        try capture(name, app)
    }
    func flow(_ style: String) throws {
        var (app, f) = try launch(style, kind: "undo")
        let prefix = device + "-" + style + "-undo"
        try preview(app, f, prefix + "-compact-preview")
        app.buttons["file-undo-cancel"].tap()
        var state = try request("/state")
        XCTAssertEqual(actual(state), 0)
        XCTAssertEqual(state["content"] as? String, "after\n")
        try unchanged(state)
        try save(state, prefix + "-cancelled")
        try preview(app, f, prefix + "-fresh-preview")
        app.buttons["file-undo-confirm"].tap()
        XCTAssertTrue(app.buttons["file-undo-cancel"].waitForNonExistence(timeout: 15))
        state = try waitState("single confirmation did not restore exactly once") {
            self.actual($0) == 1 && $0["content"] as? String == "before\n"
        }
        try unchanged(state)
        XCTAssertEqual((state["calls"] as! [Any]).count, 0)
        let messages = (state["snapshot"] as! [String: Any])["messages"] as! [[String: Any]]
        XCTAssertEqual((messages[0]["checkpoint"] as! [String: Any])["can_undo_files"] as? Bool, false)
        try capture(prefix + "-restored", app)
        try save(state, prefix + "-restored")
        app.terminate()

        (app, f) = try launch(style, kind: "undo")
        try preview(app, f, prefix + "-stale-before")
        _ = try request("/mutate")
        app.buttons["file-undo-confirm"].tap()
        let message = app.staticTexts["file-undo-error"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        let updated = NSPredicate(format: "label == %@", "Files changed. Review this updated preview.")
        expectation(for: updated, evaluatedWith: message)
        waitForExpectations(timeout: 10)
        XCTAssertLessThan(message.frame.height, 32)
        let confirm = app.buttons["file-undo-confirm"]
        XCTAssertTrue(confirm.isEnabled)
        state = try request("/state")
        XCTAssertEqual(actual(state), 0)
        XCTAssertEqual((state["rewinds"] as! [Any]).count, 3)
        XCTAssertEqual(state["content"] as? String, "manual change after preview\n")
        try unchanged(state)
        try capture(prefix + "-auto-refreshed", app)
        try save(state, prefix + "-stale-safe")
        let pause = expectation(description: "no automatic restore retry")
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { pause.fulfill() }
        wait(for: [pause], timeout: 3)
        state = try request("/state")
        XCTAssertEqual(actual(state), 0)
        XCTAssertEqual((state["rewinds"] as! [Any]).count, 3)
        confirm.tap()
        XCTAssertTrue(app.buttons["file-undo-cancel"].waitForNonExistence(timeout: 15))
        state = try request("/state")
        XCTAssertEqual(actual(state), 1)
        XCTAssertEqual(state["content"] as? String, "before\n")
        try unchanged(state)
        try save(state, prefix + "-new-explicit-tap")
        app.terminate()
    }
    func testLightCompactUndo() throws { try flow("light") }
    func testDarkCompactUndo() throws { try flow("dark") }
    func testAmbiguousRestoreDoesNotRetry() throws {
        let (app, f) = try launch("light", kind: "ambiguous")
        try preview(app, f, device + "-undo-ambiguous-before")
        app.buttons["file-undo-confirm"].tap()
        let message = app.staticTexts["file-undo-error"]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        XCTAssertTrue(message.label.contains("could not be confirmed"))
        XCTAssertFalse(app.buttons["file-undo-confirm"].isEnabled)
        var state = try request("/state")
        XCTAssertEqual(actual(state), 1)
        XCTAssertEqual((state["rewinds"] as! [Any]).count, 3)
        XCTAssertEqual(state["content"] as? String, "partial\n")
        try unchanged(state)
        let pause = expectation(description: "ambiguous restore not retried")
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { pause.fulfill() }
        wait(for: [pause], timeout: 3)
        state = try request("/state")
        XCTAssertEqual(actual(state), 1)
        XCTAssertEqual((state["rewinds"] as! [Any]).count, 3)
        try capture(device + "-undo-ambiguous-blocked", app)
        try save(state, device + "-undo-ambiguous-blocked")
        app.terminate()
    }
}
