import XCTest

final class DroidParityBackgroundUITests: DroidParityUIHarness {
    private struct Event: Decodable {
        let event: String
        let thread: String
        let id: String?
        let probe: String?
        let status: String?
        let background: Bool?
        let stoppable: Bool?
    }

    private func events(for marker: String) -> [Event] {
        guard let path = configuration.auditFile,
              let body = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        let rows = body.split(separator: "\n").compactMap {
            try? JSONDecoder().decode(Event.self, from: Data($0.utf8))
        }
        guard let thread = rows.last(where: { $0.event == "prompt_received" && $0.probe == marker })?.thread else { return [] }
        return rows.filter { $0.thread == thread }
    }

    private func task(background: Bool) throws {
        try XCTSkipUnless(configuration.live && configuration.auditFile != nil && configuration.secondCwd != nil, "requires --live --fixtures --audit")
        let marker = background ? "parity-probe-background-task" : "parity-probe-awaited-task"
        let prompt = """
        Use Task exactly once with subagent_type parity-ui-helper, await \(background ? "false" : "true"), \
        and description "Scratch fruit report". Its task: Read only \(configuration.cwd)/hello.txt, \
        then write a 600-word plain-text report about the fruit named there. Begin with parity-child-report: \
        and finish with parity-child-done. Use no other tools, files or network. \
        \(background ? "After launching, reply only launched. Do not poll or call TaskOutput or TaskStop." : "After the awaited report, reply only done.") \
        This is \(marker).
        """
        let app = launch(prompt: prompt)
        defer { app.terminate() }
        let line = app.buttons["foot-line"]
        let appeared = line.waitForExistence(timeout: 90)
        captureDetailed("Droid \(marker) subagents line", in: app)
        XCTAssertTrue(appeared)
        if background { XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 30)) }
        line.tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "subagent-row-")).firstMatch
        if !row.waitForExistence(timeout: 2) {
            captureDetailed("Droid \(marker) line tap did not expose row", in: app)
            print("TASK_UI marker=\(marker) lineTapRetried=true")
            line.tap()
        }
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "subagent-stop-")).count, 0)
        row.tap()
        XCTAssertTrue(app.buttons["subagent-detail-done"].waitForExistence(timeout: 10))
        print("TASK_UI marker=\(marker) observedWorking=\(app.staticTexts["Status, Working"].exists)")
        XCTAssertFalse(app.buttons["subagent-detail-stop"].exists, "Droid cannot stop an individual child")
        captureDetailed("Droid \(marker) child detail no individual Stop", in: app)
        let report = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "parity-child-report:")).firstMatch
        XCTAssertTrue(report.waitForExistence(timeout: 120))
        captureDetailed("Droid \(marker) child report beginning", in: app)
        // The prompt's sentence-ending period may be included in the final marker.
        let ending = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "(?s).*parity-child-done[.]?\\s*")).firstMatch
        // Selectable text exposes report paragraphs separately; the tail may be offscreen.
        for _ in 0..<12 {
            if ending.exists { break }
            app.collectionViews.allElementsBoundByIndex.last?.swipeUp()
        }
        XCTAssertTrue(ending.exists)
        XCTAssertFalse(app.buttons["subagent-detail-stop"].exists)
        captureDetailed("Droid \(marker) completed child report", in: app)
        let recorded = events(for: marker).filter { $0.event == "subagent" }
        let working = recorded.filter { $0.status == "running" && $0.background == background }
        XCTAssertFalse(working.isEmpty, "Expected actual child-session metadata, not just a Task row")
        XCTAssertTrue(working.allSatisfy { $0.stoppable == false })
        let completed = recorded.filter { $0.status == "completed" }
        XCTAssertFalse(completed.isEmpty, "A launch receipt is not child completion")
        XCTAssertEqual(Set(working.compactMap(\.id)), Set(completed.compactMap(\.id)))
        print("TASK_UI marker=\(marker) childIDs=\(Set(completed.compactMap(\.id)))")
        app.buttons["subagent-detail-done"].tap()
    }

    func testLiveAwaitedTaskHasChildReportAndNoIndividualStop() throws {
        try task(background: false)
    }

    func testLiveBackgroundTaskCompletesFromNotificationWithoutPolling() throws {
        try task(background: true)
    }

    func testLiveBackgroundExecuteUpdatesItsOriginalRow() throws {
        try XCTSkipUnless(configuration.live && configuration.auditFile != nil, "requires --live --audit")
        let marker = "parity-probe-background-execute"
        let command = "sleep 20; printf 'parity-background-complete\\n'"
        let app = launch(prompt: "Use Execute exactly once with command \(command), riskLevel low, summary Scratch background timer, and fireAndForget true. After launch reply only launched. Do not poll, use other tools, change files, or run any other command. This is \(marker).")
        defer { app.terminate() }
        let once = app.buttons["approve-once"]
        let launched = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            once.exists || self.events(for: marker).contains { $0.event == "tool.start" }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [launched], timeout: 90), .completed)
        if once.waitForExistence(timeout: 2) {
            XCTAssertTrue(contains(command, in: app).exists, "Only approve the exact harmless scratch command")
            captureDetailed("Droid exact background command one-time approval", in: app)
            once.tap()
        }
        let status = app.buttons["run-status"]
        if status.waitForExistence(timeout: 5) {
            status.tap()
        } else if app.buttons["steps-fold"].exists {
            app.buttons["steps-fold"].tap()
        }
        // The VStack identifier also reaches output descendants. Count only its
        // actual Terminal disclosure buttons, not the disclosed text and images.
        let rows = app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH %@", "tool-row", "Terminal"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        let before = rows.count
        captureDetailed("Droid background Execute original row", in: app)
        // The disclosed output is a sibling of the row's accessible button.
        let outputs = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND NOT label CONTAINS %@", "parity-background-complete", "printf"))
        let output = outputs.firstMatch
        if !output.exists {
            rows.firstMatch.tap()
        }
        XCTAssertTrue(output.waitForExistence(timeout: 90))
        XCTAssertEqual(rows.count, before, "Completion inserted a second tool row")
        XCTAssertEqual(outputs.count, 1)
        let recorded = events(for: marker)
        let starts = recorded.filter { $0.event == "tool.start" }.compactMap(\.id)
        let ends = recorded.filter { $0.event == "tool.end" }.compactMap(\.id)
        XCTAssertEqual(Set(starts).count, 1)
        XCTAssertEqual(Set(ends), Set(starts), "Final output must replace the original Execute identity")
        XCTAssertGreaterThanOrEqual(ends.count, 2, "Expected launch receipt and later completion")
        print("EXECUTE_UI originalRows=\(before) finalRows=\(rows.count) startIDs=\(starts) endIDs=\(ends)")
        captureDetailed("Droid background Execute completed same row once", in: app)
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "PORTALS_DEBUG_PROMPT")
        app.launchEnvironment["PORTALS_DEBUG_OPEN_LATEST"] = "1"
        app.launch()
        let restoredSteps = app.buttons["steps-fold"]
        XCTAssertTrue(restoredSteps.waitForExistence(timeout: 60))
        restoredSteps.tap()
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(rows.count, 1, "Full app reopen must restore one original Terminal row")
        if !output.exists { rows.firstMatch.tap() }
        XCTAssertTrue(output.waitForExistence(timeout: 10))
        XCTAssertEqual(outputs.count, 1, "Restored output must appear once")
        print("EXECUTE_UI reopenedRows=\(rows.count) reopenedOutputs=\(outputs.count)")
        captureDetailed("Droid background Execute one row after full app reopen", in: app)
    }
}
