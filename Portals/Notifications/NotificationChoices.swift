import AgentCore
import Foundation

/// Which notifications the user wants, from Settings' Notifications: when an agent needs
/// an answer, and when one is done. Both on until turned off. A host that takes it
/// (`push_muting`) is told the kinds turned off, and sends this device none of them; while
/// the app is in front, one from a host that does not take it is not shown either
/// (`PushCoordinator`).
enum NotificationChoices {
    /// "When an agent needs you": approvals and questions.
    nonisolated static let needsYouKey = "notifications.needsYou"
    /// "When an agent is done": turns that finished or failed.
    nonisolated static let doneKey = "notifications.done"

    /// The kinds turned off.
    nonisolated static var muted: Set<NotificationKind> {
        let defaults = UserDefaults.standard
        var muted: Set<NotificationKind> = []
        if defaults.object(forKey: needsYouKey) as? Bool == false { muted.formUnion(NotificationKind.needsYou) }
        if defaults.object(forKey: doneKey) as? Bool == false { muted.formUnion(NotificationKind.done) }
        return muted
    }

    /// The kind a notification's payload names (`aeriportal.kind`), if it is one the app knows.
    nonisolated static func kind(of userInfo: [AnyHashable: Any]) -> NotificationKind? {
        ((userInfo["aeriportal"] as? [String: Any])?["kind"] as? String).flatMap(NotificationKind.init(rawValue:))
    }
}
