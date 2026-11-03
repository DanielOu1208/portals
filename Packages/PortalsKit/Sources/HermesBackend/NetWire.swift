import AgentCore
import Foundation

// The net on the wire (feature `net`, docs/gateway-protocol.md section 11): the methods
// a device calls, the lists and codes it is given, and `POST /net/join`, which a device
// joins with before it has a token.

extension BridgeWire.Feature {
    /// `net.list`, `net.invite`, `net.remove` and `net.join_with`, `net` in `gateway.ready`'s
    /// `bridge` block and in `poll.now`, and signing in with a member's token
    /// (`Authorization: Bearer`) on the WebSocket's upgrade and the push routes.
    public static let net = "net"
    /// `net.rename`, which names a Mac for the whole net, and `named` and `named_by` in a
    /// Mac's entry once its name was set so.
    public static let netRename = "net_rename"
    /// `net.rename` names a device too, and a device's entry carries `named` and `named_by`
    /// once it was renamed so (2026-10-28).
    public static let netRenameDevices = "net_rename_devices"
}

extension BridgeWire.Method {
    public static let netList = "net.list"
    public static let netInvite = "net.invite"
    public static let netRemove = "net.remove"
    public static let netJoinWith = "net.join_with"
    public static let netRename = "net.rename"
}

extension BridgeWire {
    public struct NetListParams: Encodable, Sendable {
        public init() {}
    }

    public struct NetRemoveParams: Encodable, Sendable {
        public var member: String
        /// The net the removal is for: refused by a Mac in another one. Left out when nil.
        public var net: String?

        public init(member: String, net: String? = nil) {
            self.member = member
            self.net = net
        }
    }

    public struct NetJoinWithParams: Encodable, Sendable {
        public var link: String

        public init(link: String) {
            self.link = link
        }
    }

    public struct NetRenameParams: Encodable, Sendable {
        public var member: String
        public var name: String
        /// The stamp of the name the device holds for the Mac; left out when it holds none.
        public var after: Int?
        /// The net the rename is for: refused by a Mac in another one. Left out when nil.
        public var net: String?

        public init(member: String, name: String, after: Int?, net: String? = nil) {
            self.member = member
            self.name = name
            self.after = after
            self.net = net
        }
    }

    /// One member as a Mac gives it; nil for one that does not fit, which costs only itself.
    public static func netMember(_ value: JSONValue) -> NetMember? {
        guard let id = value["id"]?.stringValue, id.wholeMatch(of: /[A-Za-z0-9-]{8,64}/) != nil,
              let kind = value["kind"]?.stringValue.flatMap(NetMember.Kind.init(rawValue:)),
              let name = value["name"]?.stringValue else { return nil }
        let url = value["url"]?.stringValue.flatMap(HostConfig.url(fromTyped:))
        // A name set from the app, a Mac's or a device's: its stamp and who set it, both or neither.
        let named = value["named"]?.intValue, namedBy = value["named_by"]?.stringValue
        let stamped = named != nil && namedBy != nil
        // A Mac without an address cannot be reached, and is listed as one all the same.
        return NetMember(
            id: id, kind: kind, name: name, url: kind == .mac ? url : nil,
            key: value["key"]?.stringValue, relay: value["relay"]?.stringValue, platform: value["platform"]?.stringValue,
            removed: value["removed"]?.boolValue ?? false, changed: value["changed"]?.intValue ?? 0, by: value["by"]?.stringValue,
            tokenTag: value["token_tag"]?.stringValue, named: stamped ? named : nil, namedBy: stamped ? namedBy : nil
        )
    }

    public static func netMembers(_ value: JSONValue?) -> [NetMember] {
        (value?.arrayValue ?? []).compactMap(netMember)
    }

    /// Where a Mac's list is, as `gateway.ready` and `poll.now` carry it: `{id, revision}`.
    public static func netRevision(_ value: JSONValue?) -> NetRevision? {
        guard let net = value?["id"]?.stringValue, !net.isEmpty, let revision = value?["revision"]?.intValue else { return nil }
        return NetRevision(net: net, revision: revision)
    }

    /// What `net.list` answers.
    public static func netList(_ value: JSONValue) throws -> NetList {
        guard let net = value["net"]?.stringValue, let here = value["here"]?.stringValue, let revision = value["revision"]?.intValue else {
            throw HermesConnectionError.refused("The host's answer is not a net's list.")
        }
        return NetList(net: net, here: here, you: value["you"]?.stringValue, revision: revision, members: netMembers(value["members"]))
    }

    /// What `net.invite` answers.
    public static func netInvite(_ value: JSONValue) throws -> NetInvite {
        guard let link = value["link"]?.stringValue, let code = value["code"]?.stringValue, let expires = value["expires_at"]?.doubleValue else {
            throw HermesConnectionError.refused("The host's answer is not a join code.")
        }
        return NetInvite(link: link, code: code, expiresAt: Date(timeIntervalSince1970: expires / 1000))
    }
}

// MARK: - Joining

/// Redeems a join code at the Mac that made it (`POST <url>/net/join`), with no sign-in:
/// the code is the credential. A device is given its token and the net's list.
public struct NetJoinClient: Sendable {
    private let loader: any HTTPLoader

    public init(loader: any HTTPLoader = URLSessionHTTPLoader()) {
        self.loader = loader
    }

    /// Joins `device` to the net of the Mac at `url` with `code`. Throws `NetError` with the
    /// Mac's sentence when it says no, and `.unavailable` for a bridge without the net.
    public func join(at url: URL, code: String, as device: NetDevice) async throws -> NetJoined {
        var request = URLRequest(url: url.appendingPathComponent("net/join"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let body: JSONValue = [
            "code": .string(code),
            "member": ["id": .string(device.id), "kind": "device", "name": .string(device.name), "platform": .string(device.platform)],
        ]
        request.httpBody = Data(try body.serialized().utf8)
        let (data, response) = try await loader.data(for: request)
        let answer = try? JSONValue.parse(String(decoding: data, as: UTF8.self))
        switch response.statusCode {
        case 200:
            guard let net = answer?["net"]?.stringValue, let token = answer?["token"]?.stringValue, !token.isEmpty else {
                throw NetError.refused("The host's answer is not a way into its net.")
            }
            return NetJoined(net: net, token: token, members: BridgeWire.netMembers(answer?["members"]))
        case 404:
            throw NetError.unavailable
        default:
            if let detail = answer?["detail"]?.stringValue, !detail.isEmpty { throw NetError.refused(detail) }
            throw HermesAuthError.unexpectedStatus(response.statusCode)
        }
    }
}
