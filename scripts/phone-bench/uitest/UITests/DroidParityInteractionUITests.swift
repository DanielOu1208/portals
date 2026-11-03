import XCTest

final class DroidParityInteractionUITests: DroidParityUIHarness {
    private struct Receipt: Decodable {
        let event: String
        let probe: String?
    }

    private func receipts(for marker: String) -> Int {
        guard let path = configuration.auditFile,
              let body = try? String(contentsOfFile: path, encoding: .utf8) else { return 0 }
        return body.split(separator: "\n").compactMap {
            try? JSONDecoder().decode(Receipt.self, from: Data($0.utf8))
        }.count { $0.event == "prompt_received" && $0.probe == marker }
    }

    func testLiveMultilineSendTargetsAfterCustomAnswers() throws {
        try XCTSkipUnless(configuration.live && configuration.auditFile != nil, "requires --live --audit")
        let app = launch(prompt: "Use AskUser now with exactly two questions. First ask which language, single choice Swift or Python. Second ask which checks to include, multi-select Unit tests and UI tests. Wait for every answer, then say done. Do not use other tools.")
        defer { app.terminate() }
        let other = app.buttons["clarify-other"]
        XCTAssertTrue(other.waitForExistence(timeout: 90))
        print("OTHER_HIT before frame=\(other.frame) hittable=\(other.isHittable)")
        captureDetailed("Probe Other before tap", in: app)
        other.tap()
        let custom = app.descendants(matching: .any)["clarify-custom-answer"]
        let appeared = custom.waitForExistence(timeout: 5)
        print("OTHER_HIT after appeared=\(appeared) keyboards=\(app.keyboards.count)")
        captureDetailed(appeared ? "Probe Other custom field" : "Probe Other missing after 5 seconds", in: app)
        XCTAssertTrue(appeared)
        custom.tap()
        custom.typeText("Rust")
        app.buttons["clarify-next"].tap()
        app.buttons["Unit tests"].tap()
        app.buttons["UI tests"].tap()
        app.buttons["clarify-send"].tap()
        let firstReply = app.staticTexts.matching(identifier: "reply-text").matching(NSPredicate(format: "label CONTAINS[c] %@", "done")).firstMatch
        XCTAssertTrue(firstReply.waitForExistence(timeout: 90))
        XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 30))

        let field = app.textFields["composer-field"]
        var pending: String?
        var failedTargets: [String] = []
        for method in ["semantic", "arrow-center", "frame-center"] {
            let marker = pending ?? "parity-probe-\(UUID().uuidString.lowercased())"
            if pending == nil {
                field.tap()
                field.typeText("Reply exactly \(marker). Do not use tools or change any file. This is only a multiline composer test.")
            }
            let send = app.buttons["send"]
            XCTAssertTrue(send.waitForExistence(timeout: 5))
            XCTAssertTrue(send.isEnabled)
            let frame = send.frame
            let arrow = send.images["arrow.up"]
            let keyboard = app.keyboards.firstMatch
            print("SEND_HIT method=\(method) marker=\(marker) field=\(field.frame) send=\(frame) hittable=\(send.isHittable) keyboard=\(keyboard.exists ? String(describing: keyboard.frame) : "none") arrowExposed=\(arrow.exists)")
            captureDetailed("Send \(method) before tap \(marker)", in: app)
            let before = receipts(for: marker)
            switch method {
            case "semantic":
                send.tap()
            case "arrow-center":
                if arrow.exists {
                    arrow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                } else {
                    // The image-only label is not always a separate AX element.
                    // Retain the screenshot to verify the glyph coincides with this point.
                    send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
            default:
                app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
            }
            let reply = app.staticTexts.matching(identifier: "reply-text").matching(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
            _ = reply.waitForExistence(timeout: 5)
            let received = receipts(for: marker) > before
            let cleared = !(field.value as? String ?? "").contains(marker)
            print("SEND_HIT result method=\(method) marker=\(marker) draftCleared=\(cleared) received=\(received)")
            captureDetailed("Send \(method) after tap \(marker)", in: app)
            if received {
                XCTAssertTrue(cleared, "Bridge received a prompt but the draft stayed populated")
                XCTAssertTrue(reply.waitForExistence(timeout: 90))
                XCTAssertTrue(app.buttons["stop"].waitForNonExistence(timeout: 30))
                pending = nil
            } else if cleared {
                XCTFail("Draft cleared without a receipt; do not replay an unknown send")
                return
            } else {
                failedTargets.append(method)
                pending = marker
            }
        }
        XCTAssertNil(pending, "No target delivered the pending draft")
        XCTAssertTrue(failedTargets.isEmpty, "Targets that did not deliver: \(failedTargets)")
    }
}
