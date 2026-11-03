import UIKit
import XCTest

/// Opens threads by tapping their rows in the sidebar, as on an iPhone, in the
/// Portals copy already running in the simulator, for scripts/blank-bench.sh (a thread
/// opened blank until scrolled by hand). Skipped unless the bench left its plan:
///
///     <bundle id>
///     <step> <step> …
///
/// in `/private/tmp/portals-blank-repro/uitest-<simulator>/plan.txt`, each step one of
///
///     tap:<title>          the sidebar, then the row whose label has <title>
///     away:<seconds>       Settings in front for that long, then the app again
///     away-tap:<s>:<title> the same, then the sidebar and the row at once
///     drag                 a short drag down the chat and back, by hand
///     shot                 a picture of the screen, kept as shot-<n>.jpg
///     wait:<seconds>       nothing
///
/// with `dwell` seconds (the plan's third line, 2.5 by default) after each opening. Writes
/// "<unix time> <step>" to marks.txt as each step is taken. After each dwell, a picture of
/// the screen (the simulator's, which asks the app nothing) is looked at for text in the
/// chat's middle (`ink`: the share of its pixels off their row's mean by more than 12%);
/// one with almost none is kept as `blank-<n>.jpg`.
final class BlankUITests: XCTestCase {
    private let folder = "/private/tmp/portals-blank-repro/uitest-" + (ProcessInfo.processInfo.environment["SIMULATOR_UDID"] ?? "unknown")

    private func mark(_ text: String) {
        let url = URL(fileURLWithPath: "\(folder)/marks.txt")
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let line = String(format: "%.3f %@\n", Date().timeIntervalSince1970, text)
        try? (old + line).write(to: url, atomically: true, encoding: .utf8)
    }

    func testOpenFromSidebar() throws {
        let planPath = "\(folder)/plan.txt"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: planPath), "no blank-bench plan")
        continueAfterFailure = true
        let lines = try String(contentsOfFile: planPath, encoding: .utf8).split(separator: "\n").map(String.init)
        let app = XCUIApplication(bundleIdentifier: lines[0].trimmingCharacters(in: .whitespaces))
        let steps = lines.count > 1 ? lines[1].split(separator: " ").map(String.init) : []
        let dwell = lines.count > 2 ? Double(lines[2]) ?? 2.5 : 2.5
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        app.activate()
        let sidebarButton = app.buttons["Agents and threads"]
        XCTAssertTrue(sidebarButton.waitForExistence(timeout: 30), "the chat's sidebar button")

        func open(_ title: String) {
            guard sidebarButton.waitForExistence(timeout: 5) else {
                mark("no-sidebar-button")
                XCTFail("no sidebar button for \(title)")
                return
            }
            guard openSidebar() else {
                mark("sidebar-not-open \(title)")
                XCTFail("the sidebar did not open for \(title)")
                return
            }
            let row = app.buttons.matching(NSPredicate(format: "identifier == 'thread-row' AND label CONTAINS %@", title)).firstMatch
            // Past the agent's few most recent threads: behind its Show more.
            if !row.waitForExistence(timeout: 3) {
                let more = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'show-more-'")).firstMatch
                if more.exists, more.label.hasPrefix("Show") && !more.label.contains("fewer") { more.tap() }
            }
            guard row.waitForExistence(timeout: 5) else {
                mark("no-row \(title)")
                XCTFail("no row for \(title)")
                // Back to the chat: tap its edge.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                return
            }
            usleep(300_000)
            mark("open \(title)")
            row.tap()
            usleep(UInt32(dwell * 1_000_000))
            look(title)
        }

        // The sidebar's button tapped where it is, and the chat seen slid aside for the
        // sidebar (the composer moved right). The button tapped as an element did nothing
        // on a new thread's screen, where the app opens (2026-10-22, iOS 27 simulator),
        // so every row tapped after it landed on that empty chat, and every look read as
        // blank; a tap at its place opens the sidebar, as a finger does.
        func openSidebar() -> Bool {
            let composer = app.textFields["composer-field"]
            func isOpen() -> Bool { composer.exists && composer.frame.minX > app.frame.width / 3 }
            for attempt in 0..<3 {
                if attempt > 0 { mark("sidebar tapped again") }
                sidebarButton.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                for _ in 0..<10 {
                    if isOpen() { return true }
                    usleep(200_000)
                }
            }
            return isOpen()
        }

        var kept = 0
        func look(_ what: String) {
            let shot = XCUIScreen.main.screenshot()
            let ink = Self.ink(of: shot.image)
            mark(String(format: "ink %.4f %@", ink, what))
            if ink < 0.002, kept < 40 {
                kept += 1
                try? shot.image.jpegData(compressionQuality: 0.5)?.write(to: URL(fileURLWithPath: "\(folder)/blank-\(kept).jpg"))
                mark("kept blank-\(kept).jpg")
            }
            XCTAssertGreaterThanOrEqual(ink, 0.002, "blank or unmeasurable chat after \(what)")
        }

        func away(_ seconds: Double) {
            mark("away \(seconds)")
            settings.activate()
            usleep(UInt32(seconds * 1_000_000))
            app.activate()
            mark("back")
        }

        for step in steps {
            let parts = step.split(separator: ":", maxSplits: 2).map(String.init)
            switch parts[0] {
            case "tap" where parts.count == 2:
                open(parts[1].replacingOccurrences(of: "_", with: " "))
            case "away" where parts.count == 2:
                away(Double(parts[1]) ?? 3)
                usleep(UInt32(dwell * 1_000_000))
                look("back")
            case "away-tap" where parts.count == 3:
                away(Double(parts[1]) ?? 3)
                open(parts[2].replacingOccurrences(of: "_", with: " "))
            case "drag":
                // A short drag down the chat and back, as a hand scrolling a little.
                let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
                let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
                mark("drag")
                top.press(forDuration: 0.05, thenDragTo: bottom, withVelocity: .slow, thenHoldForDuration: 0.1)
                bottom.press(forDuration: 0.05, thenDragTo: top, withVelocity: .slow, thenHoldForDuration: 0.1)
                usleep(1_000_000)
                look("drag")
            case "shot":
                // A picture of the screen as it is, kept whatever it shows.
                kept += 1
                try? XCUIScreen.main.screenshot().image.jpegData(compressionQuality: 0.5)?
                    .write(to: URL(fileURLWithPath: "\(folder)/shot-\(kept).jpg"))
                mark("kept shot-\(kept).jpg")
            case "wait" where parts.count == 2:
                usleep(UInt32((Double(parts[1]) ?? 1) * 1_000_000))
            default:
                mark("unknown \(step)")
                XCTFail("unknown step \(step)")
            }
        }
        mark("done")
    }

    /// The share of the pixels in the chat's middle (from 18% to 78% of the screen's
    /// height) whose brightness is more than 12% off their row's mean: text, rows, cards.
    private static func ink(of image: UIImage) -> Double {
        guard let cgImage = image.cgImage else { return -1 }
        let width = cgImage.width, height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return -1 }
        var off = 0, all = 0
        for row in stride(from: Int(Double(height) * 0.18), to: Int(Double(height) * 0.78), by: 2) {
            let start = row * width
            var sum = 0
            for column in 0..<width { sum += Int(pixels[start + column]) }
            let mean = sum / max(width, 1)
            for column in stride(from: 0, to: width, by: 2) {
                if abs(Int(pixels[start + column]) - mean) > 30 { off += 1 }
                all += 1
            }
        }
        return all == 0 ? -1 : Double(off) / Double(all)
    }
}
