import Foundation

/// A call the thread's agent made about the agents it had set to work, other than
/// starting one (Codex's wait, close, message): one short line naming them, in place of
/// the tool's name and label ("Waited for Darwin and Euclid"). The subagents line keeps
/// the rest of what they did and said, so it is not shown here again.
public struct SubagentCall: Codable, Hashable, Sendable {
    public enum Action: String, Codable, Hashable, Sendable {
        /// Waited for them to answer.
        case wait
        /// Closed them: they are done with.
        case close
        /// Sent them a message.
        case message
        /// Gave them more to do.
        case followUp
        /// Picked them up again.
        case resume
        /// Stopped what they were doing.
        case interrupt
        /// Looked at which there are.
        case list
    }

    public var action: Action
    /// Their names, as the subagents line calls them ("Darwin"), in the order they
    /// started; empty when the host named none.
    public var agents: [String]

    public init(_ action: Action, agents: [String] = []) {
        self.action = action
        self.agents = agents
    }

    /// The line: "Waited for Darwin and Euclid", "Waiting for Darwin and Euclid" while it
    /// runs, "Closed Darwin", "Sent Euclid a message".
    public func words(running: Bool) -> String {
        let named = Self.list(agents)
        switch action {
        case .wait:
            return "\(running ? "Waiting" : "Waited") for \(named ?? "the agents")"
        case .close:
            return "\(running ? "Closing" : "Closed") \(named ?? "an agent")"
        case .message:
            return "\(running ? "Sending" : "Sent") \(named ?? "an agent") a message"
        case .followUp:
            return "\(running ? "Giving" : "Gave") \(named ?? "an agent") more to do"
        case .resume:
            return "\(running ? "Resuming" : "Resumed") \(named ?? "an agent")"
        case .interrupt:
            return "\(running ? "Stopping" : "Stopped") \(named ?? "an agent")"
        case .list:
            return running ? "Looking at the agents" : "Looked at the agents"
        }
    }

    /// The most names said before the rest are counted.
    private static let named = 3

    /// "Darwin", "Darwin and Euclid", "Darwin, Euclid and Hume", "Darwin, Euclid and 2
    /// more"; nil for none.
    static func list(_ names: [String]) -> String? {
        switch names.count {
        case 0: return nil
        case 1: return names[0]
        case ...named: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        default: return names.prefix(named - 1).joined(separator: ", ") + " and \(names.count - (named - 1)) more"
        }
    }
}
