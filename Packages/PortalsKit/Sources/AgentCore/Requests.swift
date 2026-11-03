import Foundation

/// How the user can answer "may I run this?".
public enum ApprovalChoice: String, Codable, Hashable, Sendable, CaseIterable {
    /// Run it this time.
    case once
    /// Run it, and anything like it, for the rest of this thread.
    case session
    /// Run it, and anything like it, from now on.
    case always
    case deny
}

public struct ApprovalRequest: Codable, Hashable, Sendable {
    /// What the agent wants to run. The backend redacts secrets before sending it.
    public var command: String
    /// Why it needs asking ("delete in root path").
    public var reason: String?
    /// The answers the backend accepts for this request, in its order.
    public var choices: [ApprovalChoice]
    /// A plan to approve (Claude Code's plan mode), whose text is `command`. nil (also in
    /// requests saved before plans had cards) is any other approval.
    public var plan: PlanApproval?
    /// The host takes what to do instead with a no (`RequestAnswer.declined`) to any
    /// approval, and tells the agent. nil (also in requests saved before) is false; a
    /// plan takes one wherever it has a card.
    public var takesNote: Bool?
    public var options: [ApprovalOption]?
    public var planContent: String?
    public var details: [ApprovalDetail]?

    public init(
        command: String, reason: String? = nil, choices: [ApprovalChoice] = ApprovalChoice.allCases, plan: PlanApproval? = nil,
        takesNote: Bool = false, options: [ApprovalOption]? = nil, planContent: String? = nil, details: [ApprovalDetail]? = nil
    ) {
        self.command = command
        self.reason = reason?.isEmpty == false ? reason : nil
        self.choices = choices.isEmpty ? [.once, .deny] : choices
        self.plan = plan
        self.takesNote = takesNote ? true : nil
        self.options = options
        self.planContent = planContent
        self.details = details
    }
}

/// What approving a plan does: the work starts, in this mode when the host says.
public struct PlanApproval: Codable, Hashable, Sendable {
    public var startsIn: ThreadMode?

    public init(startsIn: ThreadMode? = nil) {
        self.startsIn = startsIn
    }

    public func startDescription(agentName: String, mode: ModeState?) -> String? {
        guard let startsIn else { return nil }
        let effective = startsIn == .settings ? (mode?.defaultsTo ?? .settings) : startsIn
        if let option = mode?.option(for: effective) { return "Then: \(option.description)" }
        return "Then \(agentName) \(effective.meaning)."
    }
}

public struct ClarifyQuestion: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var text: String
    /// Suggested answers; a typed answer is always allowed too.
    public var choices: [String]
    public var allowsMultiple: Bool
    /// A word or two naming the question ("Auth method"), when the agent gives one.
    public var header: String?
    /// What a choice means, by choice, where the agent says.
    public var descriptions: [String: String]?

    public init(
        id: String, text: String, choices: [String] = [], allowsMultiple: Bool = false, header: String? = nil,
        descriptions: [String: String]? = nil
    ) {
        self.id = id
        self.text = text
        self.choices = choices
        self.allowsMultiple = allowsMultiple
        self.header = header
        self.descriptions = descriptions
    }
}

/// Something the agent is blocked on until the user answers.
public struct PendingRequest: Identifiable, Codable, Hashable, Sendable {
    public enum Kind: Codable, Hashable, Sendable {
        case approval(ApprovalRequest)
        /// One to five questions, answered together.
        case clarify([ClarifyQuestion])
    }

    public var id: String
    public var kind: Kind
    /// The subagent that asks it (from a bridge with `subagents`), which may run on after
    /// the turn: the turn's end does not take the question back.
    public var subagent: String?
    /// Every question needs a nonblank answer; absent in older saved requests.
    public var requiresAllAnswers: Bool?
    /// Asked without waiting (Codex's questions, from a bridge with `async_questions`): the
    /// agent went on, and takes the answer as the user's next message. nil (also in
    /// requests saved before) is false.
    public var askedAhead: Bool?

    public init(id: String, kind: Kind, subagent: String? = nil, requiresAllAnswers: Bool = false, askedAhead: Bool = false) {
        self.id = id
        self.kind = kind
        self.subagent = subagent
        self.requiresAllAnswers = requiresAllAnswers ? true : nil
        self.askedAhead = askedAhead ? true : nil
    }

    /// Asked by a subagent, or without waiting: it stays open after the turn, until
    /// answered or withdrawn.
    public var outlivesTurn: Bool { subagent != nil || askedAhead == true }

    public func acceptsClarification(_ answers: [String: String]) -> Bool {
        guard case let .clarify(questions) = kind else { return false }
        let answered = questions.filter { !(answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return requiresAllAnswers == true ? answered.count == questions.count : !answered.isEmpty
    }

    /// What was asked, in one string, for the transcript.
    public var prompt: String {
        switch kind {
        case let .approval(approval): approval.command
        case let .clarify(questions): questions.map(\.text).joined(separator: "\n")
        }
    }
}

public enum RequestAnswer: Hashable, Sendable {
    case approval(ApprovalChoice)
    /// An exact offered provider outcome, never combined with a legacy choice.
    case option(String, editedPlan: String? = nil, note: String? = nil)
    /// No, and what to do instead ("keep planning: use SQLite").
    case declined(note: String)
    /// Answers by question id. A question left out was skipped.
    case clarify([String: String])
    /// Dismissed without answering: an approval is denied, questions are skipped.
    case cancelled

    /// The answer in words, for the transcript.
    public func summary(for request: PendingRequest) -> String {
        if case let .option(id, _, note) = self {
            guard case let .approval(approval) = request.kind,
                  let option = approval.options?.first(where: { $0.id == id }) else { return "Answered" }
            if let note, !note.isEmpty { return "\(option.label): \(note)" }
            return option.label
        }
        if case let .approval(approval) = request.kind, approval.plan != nil {
            switch self {
            case .approval(.deny), .cancelled: return "Kept planning"
            case let .declined(note): return "Kept planning: \(note)"
            case .approval: return "Started"
            case .clarify: return "Answered"
            case .option: return "Answered"
            }
        }
        switch self {
        case let .declined(note): return "Denied: \(note)"
        case .approval(.once): return "Allowed once"
        case .approval(.session): return "Allowed for this thread"
        case .approval(.always): return "Always allowed"
        case .approval(.deny): return "Denied"
        case let .clarify(answers):
            guard case let .clarify(questions) = request.kind else { return "Answered" }
            let given = questions.compactMap { answers[$0.id] }.filter { !$0.isEmpty }
            return given.isEmpty ? "Skipped" : given.joined(separator: "\n")
        case .cancelled:
            if case .approval = request.kind { return "Denied" }
            return "Skipped"
        case .option: return "Answered"
        }
    }
}

/// A request and how it ended, as the transcript keeps it.
public struct RequestRecord: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case approval, question
    }

    public var id: String
    public var kind: Kind
    /// The command, or the questions.
    public var prompt: String
    /// "Allowed once", "Denied", the typed answer, or why it was withdrawn.
    public var answer: String
    /// Who answered for you, when an agent did: the one that started the thread. nil
    /// (also in transcripts saved before) is you, or nobody.
    public var answeredBy: String?
    /// Questions asked without waiting (`PendingRequest.askedAhead`): part of the
    /// conversation, as the agent asked them in its reply, they stay in view where other
    /// answered requests fold with the work, and their answer given on the card is
    /// shown here, not as a message of its own (`UserMessage.cardAnswer`). nil (also in
    /// transcripts saved before) is false.
    public var askedAhead: Bool?

    public init(id: String, kind: Kind, prompt: String, answer: String, answeredBy: String? = nil, askedAhead: Bool = false) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.answer = answer
        self.answeredBy = answeredBy
        self.askedAhead = askedAhead ? true : nil
    }

    public init(_ request: PendingRequest, answer: String, answeredBy: String? = nil) {
        let kind: Kind = if case .approval = request.kind { .approval } else { .question }
        self.init(id: request.id, kind: kind, prompt: request.prompt, answer: answer, answeredBy: answeredBy, askedAhead: request.askedAhead == true)
    }
}
