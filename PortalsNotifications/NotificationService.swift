import AgentCore
import Intents
import os
import UserNotifications

/// Puts the agent's avatar on its notifications, as Messages puts a contact's photo on
/// theirs: the notification becomes a message from the agent (a communication
/// notification), with the picture the app saved for it (`NotificationAvatars`).
///
/// The host marks its notifications for this (`mutable-content`) and names the agent
/// under `aeriportal.agent`, and itself under `aeriportal.host` when it was told its id.
/// A bridge seals the words to the key the app gave it (`aeriportal.sealed`); they are
/// opened first. Without a picture for the agent, or when anything fails, the
/// notification is shown as it came (opened, if it could be).
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// The system's handler, until it has been given the notification to show. It is
    /// answered once: from the donation's completion, or when time runs out, whichever
    /// comes first, on whatever thread that happens.
    private let pending = OSAllocatedUnfairLock<(handler: (UNNotificationContent) -> Void, original: UNNotificationContent)?>(
        uncheckedState: nil
    )

    private static let log = Logger(subsystem: "com.danielou.portals", category: "notifications")

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        // A bridge's words come sealed (docs/pairing-and-relay.md): from here on the
        // opened ones are what is shown, even if time runs out.
        let content = Self.opened(request.content)
        pending.withLockUnchecked { $0 = (contentHandler, content) }
        guard let message = Self.message(for: content) else {
            return finish(with: content)
        }
        let updated: UNNotificationContent
        do {
            updated = try content.updating(from: message)
        } catch {
            Self.log.error("Could not make a message of a notification: \(error.localizedDescription, privacy: .public)")
            return finish(with: content)
        }
        // Donated before the notification is shown, as Apple's guide to communication
        // notifications does.
        let interaction = INInteraction(intent: message, response: nil)
        interaction.direction = .incoming
        // Notification content is immutable, so handing it to another thread is safe.
        nonisolated(unsafe) let shown = updated
        interaction.donate { [self] error in
            if let error {
                Self.log.error("Could not donate a notification's message: \(error.localizedDescription, privacy: .public)")
            }
            finish(with: shown)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        let original = pending.withLockUnchecked { $0?.original }
        if let original { finish(with: original) }
    }

    private func finish(with content: UNNotificationContent) {
        let handler = pending.withLockUnchecked { state in
            defer { state = nil }
            return state?.handler
        }
        handler?(content)
    }

    /// The notification with the words its host sealed under `aeriportal.sealed`, opened
    /// with the key the app gave that host. As it came when nothing is sealed, or the
    /// seal does not open: then it says "Portals: New activity".
    static func opened(_ content: UNNotificationContent) -> UNNotificationContent {
        guard let details = content.userInfo["aeriportal"] as? [String: Any], details["sealed"] != nil else { return content }
        guard let keys = NotificationKeys.shared,
              let words = SealedNotification.open(userInfo: content.userInfo, keyFor: keys.key(for:)),
              let opened = content.mutableCopy() as? UNMutableNotificationContent else {
            log.error("Could not open a sealed notification")
            return content
        }
        opened.title = words.title
        opened.subtitle = words.subtitle ?? ""
        opened.body = words.body
        return opened
    }

    /// The notification as a message from its agent, or nil when there is no picture of
    /// the agent it names. With a host, the picture filed under that host is looked for
    /// first; the one under the agent's bare name is there only when no other host has
    /// an agent of that name.
    static func message(for content: UNNotificationContent) -> INSendMessageIntent? {
        guard let details = content.userInfo["aeriportal"] as? [String: Any],
              let agent = details["agent"] as? String, !agent.isEmpty,
              let avatars = NotificationAvatars.shared else { return nil }
        let host = (details["host"] as? String).flatMap { $0.isEmpty ? nil : HostID(rawValue: $0) }
        let files = [host.map { avatars.url(forAgent: agent, on: $0) }, avatars.url(forAgent: agent)].compactMap(\.self)
        guard let picture = files.lazy.compactMap({ try? Data(contentsOf: $0) }).first else { return nil }
        let image = INImage(imageData: picture)
        // The same agent name on two hosts is two people.
        let identifier = host.map { "\($0.rawValue)/\(agent)" } ?? agent
        let sender = INPerson(
            personHandle: INPersonHandle(value: identifier, type: .unknown),
            nameComponents: nil,
            displayName: content.title,
            image: image,
            contactIdentifier: nil,
            customIdentifier: identifier
        )
        // A conversation per thread, as the notifications are already grouped, named
        // after the thread: the agent's name, the thread's title under it, then what
        // happened. A named conversation needs more than one recipient (you and the
        // agent); with one it is shown as one-to-one, which leaves the title out.
        let thread = content.subtitle.isEmpty ? nil : INSpeakableString(spokenPhrase: content.subtitle)
        let you = INPerson(
            personHandle: INPersonHandle(value: "me", type: .unknown),
            nameComponents: nil,
            displayName: nil,
            image: nil,
            contactIdentifier: nil,
            customIdentifier: "me",
            isMe: true,
            suggestionType: .none
        )
        let message = INSendMessageIntent(
            recipients: thread == nil ? nil : [you, sender],
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: thread,
            conversationIdentifier: content.threadIdentifier,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        message.setImage(image, forParameterNamed: \.sender)
        return message
    }
}
