import AgentCore
import Foundation

func CACurrentMediaTime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

final class Layer {
    func removeAllAnimations() {}
}

final class Label {
    var alpha = 1.0
    var text = ""
    let layer = Layer()
}

enum UIView {
    struct Options: OptionSet {
        let rawValue: Int
        static let beginFromCurrentState = Options(rawValue: 1)
    }

    static func animate(
        withDuration duration: Double, delay: Double, options: Options,
        animations: () -> Void, completion: @escaping (Bool) -> Void
    ) {
        animations()
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + delay) { completion(true) }
    }
}

final class Window {
    var reducesMotion = true
    var dropsTitles = false
    var isOutOfSight = false
    var window: Int? = 1
    let label = Label()
    var line = ThoughtLine()
    var pace = ThoughtPace()
    var shownID: UUID?
    var started = false
    var rendered: String?
    var renderedWords: String?
    var lastCalm: TimeInterval?
    var calmWait: DispatchWorkItem?

    func startLink() {}
    func stopLink() {}

    // Label storage and the animation clock are stood in. Lifecycle, delayed dispatch,
    // line parsing, pacing and render reach are the actual production implementations.
    func put(_ words: String, sliding: Bool = false) {
        guard words != rendered else { return }
        rendered = words
        renderedWords = words
        label.text = words
    }

    /* PRODUCTION */
}

@main struct Main {
    static func main() async throws {
        var failures = 0
        func check(_ condition: Bool, _ name: String) {
            print("\(condition ? "PASS" : "FAIL") \(name)")
            if !condition { failures += 1 }
        }
        let view = Window()
        let id = UUID()
        let started = Date.now
        view.show(Reasoning(text: "First thought", startedAt: started), id: id)
        check(view.label.text == "First thought", "first Reduce Motion chunk is rendered")
        view.show(Reasoning(text: "First thought second chunk", startedAt: started), id: id)
        check(view.calmWait != nil, "second chunk schedules the real main-queue calm callback")
        view.show(nil, id: nil)
        check(view.shownID == nil, "tool phase clears the shown thought identity")
        check(view.calmWait == nil, "ending a thought cancels pending calm work")
        try await Task.sleep(for: .milliseconds(400))
        check(view.label.text.isEmpty && view.label.alpha == 1, "fade completion empties the thought room")
        try await Task.sleep(for: .milliseconds(800))
        check(view.label.text.isEmpty, "room stays empty after the old calm deadline")
        view.stop()
        if failures > 0 { exit(1) }
    }
}
