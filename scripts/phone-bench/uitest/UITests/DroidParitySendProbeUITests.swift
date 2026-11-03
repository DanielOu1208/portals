import XCTest

/// Only the temporary diagnostic app, never a substitute for a normal-app pass.
final class DroidParitySendProbeUITests: DroidParityUIHarness {
    private struct Event: Decodable {
        let at: Double
        let event: String
        let thread: String
        let probe: String?
        let status: String?
    }

    private enum ProbeError: Error { case unknownDelivery }

    private func events() -> [Event] {
        guard let path = configuration.auditFile,
              let body = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        return body.split(separator: "\n").compactMap {
            try? JSONDecoder().decode(Event.self, from: Data($0.utf8))
        }
    }

    private func receipts(_ marker: String) -> [Event] {
        events().filter { $0.event == "prompt_received" && $0.probe == marker }
    }

    private func wait(_ seconds: TimeInterval, until condition: @escaping () -> Bool) -> Bool {
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        return XCTWaiter.wait(for: [expected], timeout: seconds) == .completed
    }

    private func requireDiagnostic() throws {
        try XCTSkipUnless(configuration.live && configuration.auditFile != nil
            && configuration.bundleIdentifier == "com.danielou.portals.parity.sendprobe",
            "requires the isolated sendprobe app and private live audit bridge")
    }

    func testDiagnosticPreflightBootAndInitialTouch() throws {
        try requireDiagnostic()
        let app = launch(prompt: "Reply exactly probe-ready. Do not use tools.")
        defer { app.terminate() }
        XCTAssertTrue(app.staticTexts["turn-footer"].waitForExistence(timeout: 90))
        let field = app.textFields["composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        captureDetailed("Send probe preflight initial composer touch", in: app)
        print("SEND_PROBE_PREFLIGHT initialTouchAt=\(Date().timeIntervalSince1970)")
    }

    private func semanticProbe(round: Int, condition: String, marker: String, thread: String,
                               lastKeyAt: TimeInterval, fieldBefore: CGRect, fieldAfter: CGRect,
                               eligible: Bool, in app: XCUIApplication) throws -> Bool {
        let field = app.textFields["composer-field"]
        let send = app.buttons["send"]
        XCTAssertTrue(send.exists && send.isEnabled)
        let previousEnd = events().last { $0.thread == thread && $0.event == "turn_end" }?.at
        let buttonFrame = send.frame
        let tapAt = Date().timeIntervalSince1970
        // No screenshots or hierarchy collection before this timing-critical action.
        send.tap()
        let tapReturnedAt = Date().timeIntervalSince1970
        _ = wait(5) { !self.receipts(marker).isEmpty && !(field.value as? String ?? "").contains(marker) }
        let received = receipts(marker)
        let draft = field.value as? String ?? ""
        let retained = draft.contains(marker)
        let row: [String: Any] = [
            "round": round, "condition": condition, "marker": marker, "thread": thread,
            "eligible": eligible, "lastKeystrokeObservedAt": lastKeyAt, "tapCalledAt": tapAt,
            "tapReturnedAt": tapReturnedAt, "sinceLastKeystroke": tapAt - lastKeyAt,
            "previousTurnEndAt": previousEnd.map { $0 / 1000 as Any } ?? NSNull(),
            "sincePreviousTurnEnd": previousEnd.map { tapAt - $0 / 1000 as Any } ?? NSNull(),
            "fieldBefore": String(describing: fieldBefore), "fieldAfter": String(describing: fieldAfter),
            "grew": fieldAfter.height > fieldBefore.height, "sendFrame": String(describing: buttonFrame),
            "receiptCount": received.count, "receiptAt": received.first.map { $0.at / 1000 as Any } ?? NSNull(),
            "draftRetainsMarker": retained, "deliveredAndCleared": received.count == 1 && !retained,
        ]
        let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        let root = URL(fileURLWithPath: configuration.auditFile!).deletingLastPathComponent()
        try data.write(to: root.appendingPathComponent("send-probe-r\(round)-\(condition).json"), options: .withoutOverwriting)
        print("SEND_PROBE \(String(decoding: data, as: UTF8.self))")
        captureDetailed("Timed Send r\(round) \(condition) after tap \(marker)", in: app)
        if received.isEmpty && retained {
            // Known undelivered draft only: discard it, never resend the same marker.
            field.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: draft.count))
            XCTAssertFalse((field.value as? String ?? "").contains(marker))
            return false
        }
        guard received.count == 1 && !retained else { throw ProbeError.unknownDelivery }
        XCTAssertTrue(wait(90) {
            self.events().contains { $0.thread == thread && $0.event == "turn_end" && $0.at > received[0].at }
        })
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 10))
        return true
    }

    private func pair(round: Int) throws -> [String] {
        let seed = "parity-probe-\(UUID().uuidString.lowercased())"
        let app = launch(prompt: "Write exactly 200 numbered lines, each line only its number and ready. Do not use tools. This is a timing seed identified by \(seed); do not print that identifier.")
        defer { app.terminate() }
        let stop = app.buttons["stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 90))
        let field = app.textFields["composer-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let a = "parity-probe-\(UUID().uuidString.lowercased())"
        field.tap()
        field.typeText("Reply exactly done. No tools. \(a)")
        let aKey = Date().timeIntervalSince1970
        let prefilledWhileRunning = stop.exists
        XCTAssertTrue(stop.waitForNonExistence(timeout: 90))
        guard let thread = receipts(seed).first?.thread else { throw ProbeError.unknownDelivery }
        var failures: [String] = []
        let aFrame = field.frame
        let deliveredA = try semanticProbe(round: round, condition: "stop-to-send", marker: a, thread: thread,
            lastKeyAt: aKey, fieldBefore: aFrame, fieldAfter: aFrame, eligible: prefilledWhileRunning, in: app)
        if !deliveredA || !prefilledWhileRunning { failures.append("r\(round) stop-to-send delivered=\(deliveredA) eligible=\(prefilledWhileRunning)") }

        let b = "parity-probe-\(UUID().uuidString.lowercased())"
        field.tap()
        field.typeText("Reply exactly done. No tools.\n\(b)")
        let before = field.frame
        field.typeText("\nend")
        let bKey = Date().timeIntervalSince1970
        let after = field.frame
        let grew = after.height > before.height
        let deliveredB = try semanticProbe(round: round, condition: "last-line-growth", marker: b, thread: thread,
            lastKeyAt: bKey, fieldBefore: before, fieldAfter: after, eligible: grew, in: app)
        if !deliveredB || !grew { failures.append("r\(round) last-line-growth delivered=\(deliveredB) eligible=\(grew)") }
        return failures
    }

    func testFiveTimedSemanticSendPairs() throws {
        try requireDiagnostic()
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PORTALS_PARITY_PROBE_PREFLIGHT_VERIFIED"] == "1",
            "host must first verify a boot record and window-touch record in diagnostic JSONL")
        var failures: [String] = []
        for round in 1...5 { failures += try pair(round: round) }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
    }
}
