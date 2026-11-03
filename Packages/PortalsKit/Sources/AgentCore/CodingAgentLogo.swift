import Foundation

/// The mark a coding agent wears on its avatar: its maker's logo. Only the agents an
/// Portals bridge runs have one; Hermes agents keep their avatar alone.
public enum CodingAgentLogo: String, Codable, Hashable, Sendable, CaseIterable {
    /// Claude Code: Anthropic's Claude spark.
    case claude
    /// Codex: the OpenAI Blossom. OpenAI publishes no mark of Codex's own to download.
    case codex
    /// Pi: the Pi logo, in its three colours.
    case pi
    /// Cursor: the Cursor cube.
    case cursor
    /// Droid: Factory's mark.
    case droid

    /// The logo of `agent` on a host of `hostKind`; nil for every other agent. `kind` is
    /// what the bridge says the agent is (`Agent.kind`), and decides: a Hermes profile
    /// keeps its own name, which on a bridge that runs no Pi can be `pi`. A bridge that
    /// says no kind names its own agents `claude`, `codex`, `pi` and `cursor`, and there
    /// the name decides; a Hermes host's agent of one of those names is someone else's.
    public static func logo(for agent: Agent.ID, kind: String?, hostKind: HostKind?) -> CodingAgentLogo? {
        guard hostKind == .bridge else { return nil }
        return CodingAgentLogo(rawValue: kind ?? agent.name)
    }

    /// Whose logo it is, as the look editor names it.
    public var brand: String {
        switch self {
        case .claude: "Claude"
        case .codex: "OpenAI"
        case .pi: "Pi"
        case .cursor: "Cursor"
        case .droid: "Factory"
        }
    }
}
