import AgentCore
import Foundation
import os
import Security

/// Sign-in passwords in the Keychain, one item per host, and the token this device signs
/// in to the Macs of its net with. They stay on this device and can be read once it has
/// been unlocked after a restart, so the app can reconnect from the background.
nonisolated struct KeychainCredentialStore: CredentialStore {
    /// Under the app's name before it was Portals, so the passwords saved then are found.
    private static let service = "com.danielou.aeriportal.host-password"
    /// The net's token: one item, whatever net the device is in.
    private static let netService = "com.danielou.portals.net-token"

    func password(for host: HostID) -> String? {
        var query = item(host)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func setPassword(_ password: String?, for host: HostID) {
        let status = save(password, in: item(host))
        if status != errSecSuccess {
            AppLog.chat.error("Could not save the host password: \(status)")
        }
    }

    func netToken() -> String? {
        var query = netItem
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func setNetToken(_ token: String?) {
        let status = save(token, in: netItem)
        if status != errSecSuccess {
            AppLog.chat.error("Could not save the net's token: \(status)")
        }
    }

    func leftNetToken(for net: String) -> String? {
        var query = leftNetItem(net)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func setLeftNetToken(_ token: String?, for net: String) {
        let status = save(token, in: leftNetItem(net))
        if status != errSecSuccess {
            AppLog.chat.error("Could not save the token of a net left behind: \(status)")
        }
    }

    /// Puts `secret` in the item, or removes the item for nil or empty.
    private func save(_ secret: String?, in item: [CFString: Any]) -> OSStatus {
        guard let secret, !secret.isEmpty else {
            SecItemDelete(item as CFDictionary)
            return errSecSuccess
        }
        let values: [CFString: Any] = [
            kSecValueData: Data(secret.utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(item as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = item
            attributes.merge(values) { _, new in new }
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        return status
    }

    private func item(_ host: HostID) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: host.rawValue]
    }

    private var netItem: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.netService, kSecAttrAccount: "device"]
    }

    /// The token of a net the device switched away from (`NetLeftBehind`), by that net's id.
    private func leftNetItem(_ net: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.netService, kSecAttrAccount: "left-\(net)"]
    }
}
