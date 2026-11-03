import CryptoKit
import Foundation
import Security

/// The words of a notification as a bridge seals them (docs/pairing-and-relay.md): the
/// JSON `{"title", "subtitle", "body"}` sealed with AES-256-GCM to the key the app gave
/// that host, under `aeriportal.sealed`. Apple and the relay see only "Portals: New
/// activity"; the notification extension opens the seal and shows these instead.
public struct SealedNotification: Decodable, Hashable, Sendable {
    public var title: String
    public var subtitle: String?
    public var body: String

    public init(title: String, subtitle: String? = nil, body: String) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
    }

    /// The words in `sealed` (base64 of nonce, ciphertext and tag: CryptoKit's combined
    /// box), or nil when `key` does not open it.
    public static func open(_ sealed: String, with key: Data) -> SealedNotification? {
        guard key.count == 32, let combined = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: combined),
              let words = try? AES.GCM.open(box, using: SymmetricKey(data: key)) else { return nil }
        return try? JSONDecoder().decode(SealedNotification.self, from: words)
    }

    /// The sealed words a notification's payload carries, opened with the key for the
    /// host it names (`keyFor`, usually `NotificationKeys.key(for:)`); nil when it
    /// carries none, or they cannot be opened.
    public static func open(userInfo: [AnyHashable: Any], keyFor: (HostID) -> Data?) -> SealedNotification? {
        guard let details = userInfo["aeriportal"] as? [String: Any],
              let sealed = details["sealed"] as? String,
              let host = (details["host"] as? String).flatMap({ $0.isEmpty ? nil : HostID(rawValue: $0) }),
              let key = keyFor(host) else { return nil }
        return open(sealed, with: key)
    }
}

/// The keys hosts seal notifications to, one per host, in the Keychain under the app
/// group the app shares with its notification extension, so the extension can open
/// them. Readable once the phone has been unlocked after a restart, as notifications
/// arrive on a locked phone; never leave this device.
public struct NotificationKeys: Sendable {
    private static let service = "com.danielou.portals.notification-key"

    /// The Keychain access group: the app group.
    public var accessGroup: String

    public init(accessGroup: String) {
        self.accessGroup = accessGroup
    }

    /// The keys of the app group this build names under `PortalsAppGroup` in its
    /// Info.plist; nil when it names none.
    public static var shared: NotificationKeys? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PortalsAppGroup") as? String, !group.isEmpty else { return nil }
        return NotificationKeys(accessGroup: group)
    }

    /// The key for `host`, or nil when there is none yet.
    public func key(for host: HostID) -> Data? {
        var query = item(host)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data, data.count == 32 else { return nil }
        return data
    }

    /// The key for `host`, made and kept the first time. nil when it cannot be kept, as
    /// in a build not signed for the app group: a key the extension could not read is
    /// worse than none.
    public func makeKey(for host: HostID) -> Data? {
        if let existing = key(for: host) { return existing }
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        var attributes = item(host)
        attributes[kSecValueData] = key
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess ? key : nil
    }

    /// Forgets the key of a host that was removed.
    public func removeKey(for host: HostID) {
        SecItemDelete(item(host) as CFDictionary)
    }

    private func item(_ host: HostID) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: Self.service,
            kSecAttrAccount: host.rawValue,
            kSecAttrAccessGroup: accessGroup,
            kSecUseDataProtectionKeychain: true,
        ]
    }
}
