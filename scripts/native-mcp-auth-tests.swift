import AgentCore
import Foundation

// Only the slide's two input fields are needed by the actual SwipeGuard.
final class SidebarSlide {
    var distance: CGFloat = 0
    var movedAt = Date.distantPast
}

/* PRODUCTION_GUARD */

// Every system-browser request is intercepted. This binary cannot launch a browser.
final class UIApplication {
    enum OpenExternalURLOptionsKey { case universalLinksOnly }
    static let shared = UIApplication()
    var opened = 0
    func open(_ url: URL, options: [OpenExternalURLOptionsKey: Bool]) {
        precondition(url.host == "signin.example.test")
        opened += 1
    }
}

final class CardActions {
    struct Card {
        var serverName = "test-server"
        var id = "test-attempt"
    }
    let slide = SidebarSlide()
    let card = Card()
    let url = URL(string: "https://signin.example.test/authorize")!
    var code = " test-code "
    var isPasting = true
    var requests = 0
    var swipeGuard: SwipeGuard { SwipeGuard(slide) }

    func onAction(_ action: MCPAuthAction) {
        if case let .submit(_, _, value) = action { precondition(value == "test-code") }
        requests += 1
    }
    func onRetry() { requests += 1 }
    /* PRODUCTION_CLEAR */
    func start() { /* PRODUCTION_START */ }
    func open() { /* PRODUCTION_OPEN */ }
    func submit() { /* PRODUCTION_SUBMIT */ }
    func cancel() { /* PRODUCTION_CANCEL */ }
    func retry() { /* PRODUCTION_RETRY */ }
}

@main
struct NativeMCPAuthTests {
    static func main() {
        let actions: [(String, (CardActions) -> () -> Void, Bool)] = [
            ("Start", CardActions.start, true),
            ("Open", CardActions.open, false),
            ("Submit", CardActions.submit, true),
            ("Cancel", CardActions.cancel, true),
            ("List Retry", CardActions.retry, false),
        ]
        var checks = 0
        for (name, action, clearsInput) in actions {
            for state in ["idle", "moving", "just ended", "settled"] {
                let card = CardActions()
                UIApplication.shared.opened = 0
                if state == "moving" { card.slide.distance = 30 }
                if state == "just ended" { card.slide.movedAt = .now }
                if state == "settled" { card.slide.movedAt = .now.addingTimeInterval(-1) }
                action(card)()
                let accepted = state == "idle" || state == "settled"
                let calls = card.requests + UIApplication.shared.opened
                precondition(calls == (accepted ? 1 : 0), "\(name): \(state) action count")
                let cleared = accepted && clearsInput
                precondition(card.code == (cleared ? "" : " test-code "), "\(name): \(state) input lifetime")
                precondition(card.isPasting == !cleared, "\(name): \(state) focus lifetime")
                checks += 1
            }
        }
        var defaultCalls = 0
        SwipeGuard() { defaultCalls += 1 }
        precondition(defaultCalls == 1)
        print("PASS: \(checks) production auth-action/swipe cases, plus default guard. No OS browser or network used.")
    }
}
