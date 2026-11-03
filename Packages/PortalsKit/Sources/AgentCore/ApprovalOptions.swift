import Foundation

/// An exact provider outcome, with its scope explained before the user chooses it.
public struct ApprovalOption: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var description: String
    public var effects: [ApprovalEffect]
    public var requiresConfirmation: Bool?
    public var requiresEditedPlan: Bool?

    public init(id: String, label: String, description: String, effects: [ApprovalEffect] = [], requiresConfirmation: Bool = false, requiresEditedPlan: Bool = false) {
        self.id = id
        self.label = label
        self.description = description
        self.effects = effects
        self.requiresConfirmation = requiresConfirmation ? true : nil
        self.requiresEditedPlan = requiresEditedPlan ? true : nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, description, effects
        case requiresConfirmation = "requires_confirmation"
        case requiresEditedPlan = "requires_edited_plan"
    }

    /// New outcomes need explicit client support, never a guessed legacy allow.
    public var isSupported: Bool {
        Self.supported.contains(id)
    }

    public var editsPlan: Bool { id == "proceed_edit" || requiresEditedPlan == true }
    public var isOnce: Bool { id == "proceed_once" }
    public var isCancel: Bool { id == "cancel" }

    private static let supported: Set<String> = [
        "proceed_once", "proceed_always", "proceed_always_file",
        "proceed_auto_run", "proceed_auto_run_low", "proceed_auto_run_medium", "proceed_auto_run_high",
        "proceed_new_session", "proceed_new_session_low", "proceed_new_session_medium", "proceed_new_session_high",
        "proceed_edit", "proceed_always_tools", "proceed_always_server", "proceed_report_false_positive", "cancel",
    ]
}

public struct ApprovalEffect: Codable, Hashable, Sendable {
    public var scope: String
    public var text: String

    public init(scope: String, text: String) {
        self.scope = scope
        self.text = text
    }
}

/// Only normalized, safe display fields. Arbitrary raw permission data is not retained.
public struct ApprovalDetail: Codable, Hashable, Sendable {
    public var toolID: String?
    public var name: String
    public var type: String
    public var command: String?
    public var path: String?
    public var diff: String?
    public var server: String?
    public var tool: String?
    public var impact: String?
    public var violationType: String?
    public var reason: String?
    public var operation: String?
    public var target: String?
    public var findings: [Finding]?

    public struct Finding: Codable, Hashable, Sendable {
        public var title: String
        public var message: String
        public var severity: String?
    }

    private enum CodingKeys: String, CodingKey {
        case name, type, command, path, diff, server, tool, impact, reason, operation, target, findings
        case toolID = "tool_id"
        case violationType = "violation_type"
    }
}

extension PendingRequest {
    public func offeredOption(_ id: String, editedPlan: String? = nil) -> ApprovalOption? {
        guard case let .approval(approval) = kind,
              let option = approval.options?.first(where: { $0.id == id && $0.isSupported }) else { return nil }
        if option.editsPlan && (editedPlan ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        return option
    }
}

public enum ApprovalAnswerError: LocalizedError {
    case invalidOption
    public var errorDescription: String? { "That approval choice is no longer offered, or its edited plan is empty." }
}
