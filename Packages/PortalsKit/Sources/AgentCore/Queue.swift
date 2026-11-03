import Foundation

/// What a message sent while the agent works does, as the user set it: handed to the
/// running turn where the agent can take it in (steer), or kept for a turn of its own
/// once the running one ends (queue). An agent that cannot take a message in queues it
/// either way.
public enum WhenBusy: String, CaseIterable, Codable, Hashable, Sendable {
    case steer, queue

    /// The setting's key in the app's defaults.
    public static let settingKey = "whenBusy"

    /// What a message sent while the agent works does on a host: as the user set it on
    /// one that keeps the messages waiting (`QueueControlling.listsQueue`); elsewhere it
    /// steers, as it always did, since such a host is never told to queue it.
    public func on(hostListingQueue listsQueue: Bool?) -> WhenBusy {
        listsQueue == true ? self : .steer
    }
}

/// A message waiting on the host for the running turn to end (a Portals bridge's
/// `queue`), seen the same on every device.
public struct QueuedMessage: Identifiable, Hashable, Sendable {
    public var id: String
    /// As the host stores it (`SentText`).
    public var text: String
    /// Sent by another thread or agent through the host's fleet.
    public var fromFleet: Bool
    /// Where the agent will take it in. Nil is a legacy bridge queue without placement controls.
    public var placement: WhenBusy?
    /// Who sent it through the fleet, as the host says (`senders`).
    public var from: MessageSender?
    /// The answers given on a card, waiting to go to the agent (`UserMessage.cardAnswer`).
    public var cardAnswer: String?
    /// The id the device that sent it gave it, as a host with `message_ids` says: this
    /// device's own, when it is one of its ids, whose send may have lost its answer.
    public var messageID: UUID?

    public init(
        id: String, text: String, fromFleet: Bool = false, placement: WhenBusy? = nil, from: MessageSender? = nil, cardAnswer: String? = nil,
        messageID: UUID? = nil
    ) {
        self.id = id
        self.text = text
        self.fromFleet = fromFleet
        self.placement = placement
        self.from = from
        self.cardAnswer = cardAnswer
        self.messageID = messageID
    }

    /// The words alone, and how many files and images go with them.
    public var parts: (text: String, attachments: Int) {
        let parsed = SentText.parse(text)
        return (parsed.text, parsed.images.count + parsed.files.count)
    }
}

public enum QueuePlaceOutcome: String, Hashable, Sendable {
    case moved, queued, gone
}

/// What the host did with a waiting message it was asked to hand to the running turn.
public enum QueueSteerOutcome: String, Hashable, Sendable {
    /// The running turn has it.
    case steered
    /// The agent cannot take it in now: it waits on.
    case queued
    /// It was not waiting any more: its turn began, or it was taken off the list.
    case gone
}

/// A host that keeps the messages waiting for a running turn where every device sees
/// them, and lets one be taken off the list or handed to the turn (a Portals
/// bridge's `queue`).
public protocol QueueControlling: Sendable {
    /// Whether the host lists them, as of the last connection; nil before the first.
    var listsQueue: Bool? { get async }
    /// Takes a waiting message off the list: it is never sent. False when it was not waiting.
    func removeQueued(_ id: String, in thread: ThreadRef.ID) async throws -> Bool
    func steerQueued(_ id: String, in thread: ThreadRef.ID) async throws -> QueueSteerOutcome
    /// Changes a listed message's placement. Queue events, not an optimistic local edit,
    /// confirm its new position on every device.
    func placeQueued(_ id: String, at placement: WhenBusy, in thread: ThreadRef.ID) async throws -> QueuePlaceOutcome
}

extension QueueControlling {
    public func placeQueued(_ id: String, at placement: WhenBusy, in thread: ThreadRef.ID) async throws -> QueuePlaceOutcome { .queued }
}

/// What sending a message came to.
public struct SendReceipt: Hashable, Sendable {
    public var outcome: SendOutcome
    /// The message's id on the host's list of messages waiting, when it was queued there.
    public var queueID: String?
    /// The files the message mentions that its agent may not read in (`FileMentionSending`),
    /// for the note on the sent message's chip; empty from a host that does not say.
    public var largeMentions: [LargeFileMention]

    public init(_ outcome: SendOutcome, queueID: String? = nil, largeMentions: [LargeFileMention] = []) {
        self.outcome = outcome
        self.queueID = queueID
        self.largeMentions = largeMentions
    }
}
