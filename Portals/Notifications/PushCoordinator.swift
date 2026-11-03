import AgentCore
import Observation
import os
import UIKit
import UserNotifications

/// The app's side of push notifications: asking for permission, holding the device's
/// address for them, deciding whether one is shown while the app is in front, and
/// passing on which thread a tapped one is about.
///
/// The hosts send them (the `aeriportal-push` Hermes plugin, portals-bridge). A
/// notification names its thread under `aeriportal.thread`, the id the thread has on its
/// host, and, from a host that was told its id when the app registered, the host under
/// `aeriportal.host` (`PushRoute`).
@Observable
final class PushCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCoordinator()

    /// Where Apple delivers this device's notifications, as hex; nil until registered.
    private(set) var deviceToken: String?
    /// The address this device last registered with, in this launch or an earlier one:
    /// the one hosts were given, and so the one a host is asked to stop notifying about
    /// a thread removed before this launch has registered (or ever does, with
    /// notifications switched off since).
    var lastDeviceToken: String? {
        deviceToken ?? UserDefaults.standard.string(forKey: Self.lastTokenKey)
    }
    private static var lastTokenKey: String { "PortalsLastDeviceToken" }
    /// What the Portals relay calls this device (`RelayRegistration`), for the bridges
    /// that send through it; nil until the relay has answered.
    private(set) var relayToken: String?
    /// The thread a tapped notification is about, until it has been opened.
    var requestedThread: PushRoute?
    /// The thread on screen while the app is in front. Notifications about it are not
    /// shown: you are looking at it.
    @ObservationIgnored var visibleThread: PushRoute?

    /// Call once at launch. A device that already allowed notifications registers
    /// again, since the address can change between launches.
    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task {
            if DebugLaunch.allowsPushQuietly {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge, .provisional])
            }
            let status = await center.notificationSettings().authorizationStatus
            if status == .authorized || status == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Asks to send notifications, the first time there is something to be told about.
    /// Does nothing once the question has been answered either way.
    func enable() async {
        let center = UNUserNotificationCenter.current()
        guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
        do {
            if try await center.requestAuthorization(options: [.alert, .sound, .badge]) {
                UIApplication.shared.registerForRemoteNotifications()
            }
        } catch {
            AppLog.push.error("Could not ask for notifications: \(String(describing: error), privacy: .public)")
        }
    }

    func registered(with token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        if deviceToken != hex { relayToken = nil }
        deviceToken = hex
        UserDefaults.standard.set(hex, forKey: Self.lastTokenKey)
        AppLog.push.notice("Registered for notifications")
        Task {
            let relayToken = await RelayRegistration.token(for: hex, environment: Self.environment, bundleID: Bundle.main.bundleIdentifier ?? "")
            // A newer address may have arrived meanwhile; its own registration answers for it.
            if let relayToken, deviceToken == hex { self.relayToken = relayToken }
        }
    }

    /// Which of Apple's servers this build's device address belongs to. It follows
    /// the build's push entitlement, which the same build setting fills in, not
    /// whether this is a debug build: a release build signed for development still
    /// gets sandbox addresses.
    static var environment: PushDevice.Environment {
        Bundle.main.object(forInfoDictionaryKey: "PortalsPushEnvironment") as? String == "production" ? .production : .sandbox
    }

    // MARK: UNUserNotificationCenterDelegate

    // Both callbacks use the completion-handler form on purpose. The system calls them
    // off the main thread, and the `async` form then answers from wherever it happens
    // to be running; UIKit aborts the app when a tapped notification is answered
    // anywhere but the main thread. Here the answer is always given on the main actor.

    /// A notification arrived with the app in front: show it unless it is about the
    /// thread on screen, or of a kind turned off in Settings (from a host that sends
    /// every kind: `NotificationChoices`). Hosts are compared only when both sides name one.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let route = PushRoute(userInfo: notification.request.content.userInfo)
        let isMuted = NotificationChoices.kind(of: notification.request.content.userInfo).map(NotificationChoices.muted.contains) ?? false
        nonisolated(unsafe) let answer = completionHandler
        Task { @MainActor in
            let visible = PushCoordinator.shared.visibleThread
            let isOnScreen = route.map { route in visible.map(route.matches) ?? false } ?? false
            let shows = !isOnScreen && !isMuted
            AppLog.push.notice("Notification for \(route?.thread.rawValue ?? "no thread", privacy: .public) while in front: \(shows ? "shown" : isMuted ? "turned off" : "not shown", privacy: .public)")
            answer(shows ? [.banner, .list, .sound] : [])
        }
    }

    /// A notification was tapped: open its thread.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let route = PushRoute(userInfo: response.notification.request.content.userInfo)
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            if let route {
                AppLog.push.notice("Notification tapped for \(route.thread.rawValue, privacy: .public) on \(route.host?.rawValue ?? "any host", privacy: .public)")
                PushCoordinator.shared.requestedThread = route
            }
            done()
        }
    }
}

/// Receives what only an app delegate is told: the device's notification address.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushCoordinator.shared.start()
        MacUpdater.start()
        return true
    }

    /// Quit, rather than ended by the system in the background: the next launch opens
    /// as it always did, not with the thread that was left on screen.
    func applicationWillTerminate(_ application: UIApplication) {
        Fleet.quitting()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushCoordinator.shared.registered(with: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // Expected in a simulator without an Apple account, and offline.
        AppLog.push.error("No notification address: \(error.localizedDescription, privacy: .public)")
    }
}
