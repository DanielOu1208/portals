import AgentCore
import Foundation

enum MCPAuthWire {
    static let method = "mcp.auth"

    static func params(_ action: MCPAuthAction, sessionID: String, profile: String) -> JSONValue {
        var params: [String: JSONValue] = ["session_id": .string(sessionID), "profile": .string(profile)]
        switch action {
        case .list:
            params["action"] = "list"
        case let .start(server):
            params["action"] = "start"
            params["server_name"] = .string(server)
        case let .submit(server, authID, code):
            params["action"] = "submit"
            params["server_name"] = .string(server)
            params["auth_id"] = .string(authID)
            params["code"] = .string(code)
        case let .cancel(server, authID):
            params["action"] = "cancel"
            params["server_name"] = .string(server)
            params["auth_id"] = .string(authID)
        }
        return .object(params)
    }

    /// The cards of an answer. A row that cannot be read (no id, a status from a later
    /// bridge, a second row for a server) is left out, so the others are still shown; only
    /// an answer with no list at all fails.
    static func cards(_ result: JSONValue) throws -> [MCPAuthCard] {
        guard let rows = result["servers"]?.arrayValue else { throw MCPAuthError.failed }
        var servers: Set<String> = []
        return rows.compactMap { row in
            guard let id = row["auth_id"]?.stringValue, !id.isEmpty,
                  let server = row["server_name"]?.stringValue, !server.isEmpty, !servers.contains(server),
                  let name = row["status"]?.stringValue, let status = MCPAuthCard.Status(rawValue: name) else {
                return nil
            }
            servers.insert(server)
            return MCPAuthCard(id: id, serverName: server, status: status, url: row["url"]?.stringValue.flatMap(URL.init(string:)))
        }
    }
}
