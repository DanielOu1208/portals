extension BridgeWire {
    /// A bridge's optional thread scope. Ordinary Hermes still receives profile only.
    public struct CommandsCatalogParams: Encodable, Sendable {
        public var profile: String?
        public var sessionID: String

        public init(profile: String?, sessionID: String) {
            self.profile = profile
            self.sessionID = sessionID
        }

        enum CodingKeys: String, CodingKey {
            case profile
            case sessionID = "session_id"
        }
    }
}
