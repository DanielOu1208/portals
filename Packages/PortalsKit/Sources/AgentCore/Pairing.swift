import Foundation

/// A Mac to add, as the Portals bridge's setup offers it: the `portals://pair` link its
/// QR code holds (docs/pairing-and-relay.md).
///
///     portals://pair?v=1&url=https%3A%2F%2Fmac.tailnet.ts.net%3A10010&user=dana&password=…&name=MacBook
///
/// Every value is percent-encoded. Parameters this version does not know are ignored.
public struct PairingLink: Hashable, Sendable {
    /// The newest version of the link this app reads.
    public static let version = 1

    /// What to run in Terminal on the Mac: it sets up the bridge and ends with the code
    /// that holds this link.
    public static let setupCommand = "npx portals-host setup"

    /// Where the phone reaches the bridge.
    public var url: URL
    public var username: String
    public var password: String
    /// The Mac's own name; nil when the link gives none.
    public var name: String?

    public init(url: URL, username: String, password: String, name: String? = nil) {
        self.url = url
        self.username = username
        self.password = password
        self.name = name
    }

    /// Why a link could not be read, in words for the person who scanned it.
    public enum Problem: Error, Equatable, Sendable, LocalizedError {
        /// Some other code or address, not a pairing link.
        case notALink
        /// Made by a newer setup than this app knows.
        case newerVersion
        /// A link without one of the parts every Mac needs.
        case missing(Part)
        /// An address the app cannot connect to.
        case badAddress

        public enum Part: Sendable {
            case address, username, password
        }

        public var errorDescription: String? {
            switch self {
            case .notALink: "This isn't a code from Portals setup."
            case .newerVersion: "Update Portals to add this host."
            case .missing(.address): "The code has no address for the host."
            case .missing(.username): "The code has no user name."
            case .missing(.password): "The code has no password."
            case .badAddress: "The code's address isn't one Portals can connect to."
            }
        }
    }

    /// Reads a link: the text of a QR code, or the URL the system opened the app with.
    public init(parsing text: String) throws {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "portals", components.host?.lowercased() == "pair",
              components.path.isEmpty || components.path == "/" else { throw Problem.notALink }
        // The first of a name counts.
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] where values[item.name] == nil {
            values[item.name] = item.value ?? ""
        }
        // A link without a version is the first one; one this app cannot count is newer.
        if let version = values["v"] {
            guard let number = Int(version), number <= Self.version else { throw Problem.newerVersion }
        }

        let trimmed = { (name: String) in values[name]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
        let address = trimmed("url")
        guard !address.isEmpty else { throw Problem.missing(.address) }
        guard let url = HostConfig.url(fromTyped: address) else { throw Problem.badAddress }
        let username = trimmed("user")
        guard !username.isEmpty else { throw Problem.missing(.username) }
        // As given: the setup made it, and a password may hold anything.
        guard let password = values["password"], !password.isEmpty else { throw Problem.missing(.password) }
        let name = trimmed("name")

        self.init(url: url, username: username, password: password, name: name.isEmpty ? nil : name)
    }

    /// The Mac `existing` already has at the link's address, if any.
    public func match(in existing: [HostConfig]) -> HostConfig? {
        existing.first { HostConfig.isSameAddress($0.url, url) }
    }

    /// The host the link adds: the one already at its address, signing in as the link
    /// says and keeping its name; otherwise a new one, called what the Mac calls itself.
    public func host(updating existing: [HostConfig]) -> HostConfig {
        guard var host = match(in: existing) else {
            return HostConfig(name: name ?? HostConfig.suggestedName(for: url), url: url, username: username)
        }
        host.url = url
        host.username = username
        return host
    }
}

extension HostConfig {
    /// Whether two addresses reach the same place: scheme and host in any case, a port
    /// left out the same as the scheme's usual one, and trailing slashes ignored.
    public static func isSameAddress(_ one: URL, _ other: URL) -> Bool {
        guard let key = addressKey(one) else { return false }
        return key == addressKey(other)
    }

    private static func addressKey(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : 0)
        var path = url.path()
        while path.hasSuffix("/") { path.removeLast() }
        return "\(scheme)://\(host):\(port)\(path)"
    }

    /// What to call a host that was given no name: the first label of its address ("mini"
    /// for mini.example.ts.net), or "My Mac".
    public static func suggestedName(for url: URL?) -> String {
        url?.host()?.split(separator: ".").first.map(String.init) ?? "My Mac"
    }
}
