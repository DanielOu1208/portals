import Foundation

/// A message of this device's given back to its thread's composer (a steer a Stop took
/// back before the agent read it): its words, with what was attached to it that this
/// device still has.
public struct GivenBack: Hashable, Sendable {
    public var words: String
    /// The paths it mentioned from the `@` menu.
    public var mentions: [String]
    public var images: [ImageAttachment]
    public var files: [FileAttachment]
    /// All that was attached to it is with it.
    public var whole: Bool

    public init(words: String, mentions: [String], images: [ImageAttachment], files: [FileAttachment], whole: Bool) {
        self.words = words
        self.mentions = mentions
        self.images = images
        self.files = files
        self.whole = whole
    }

    /// `text` with the words given back ahead of it.
    public static func text(_ words: String, before text: String) -> String {
        [words, text].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

/// Where the words typed in each thread's composer are kept by its draft's key (the
/// app's `ComposerDrafts`).
@MainActor
public protocol ComposerWordsKeeping: AnyObject {
    func text(for key: String) -> String
    func set(_ text: String, for key: String)
}

/// A thread's composer while it is open: its controller.
@MainActor
public protocol GivenBackTaking: AnyObject {
    /// The key its draft is kept under (`ComposerWordsKeeping`).
    var draftKey: String { get }
    /// Puts `message` in the composer, ahead of what is there, words and attachments at once.
    func take(_ message: GivenBack)
}

/// Messages given back whose attachments had to be read from disk first, delivered to
/// wherever the thread's draft is by the time they are read: the controller that asked
/// may have been closed meanwhile (its host edited, or it was let go out of sight), and
/// another opened on the same thread in its place. One open there takes the message
/// whole. With none, its words go into the draft kept on this device at once, and its
/// attachments wait, while the app runs, for the next composer opened there.
@MainActor
public final class GivenBackMessages {
    private struct Taker {
        weak var taker: (any GivenBackTaking)?
    }

    private let words: any ComposerWordsKeeping
    private var takers: [Taker] = []
    /// By draft key: messages whose words are in the kept draft already, and whose
    /// attachments wait for a composer.
    private var waiting: [String: [GivenBack]] = [:]

    public init(words: any ComposerWordsKeeping) {
        self.words = words
    }

    /// `taker` is open: what is given back to its draft from now on goes to it. What waits
    /// there already is for it to take (`waiting(for:)`).
    public func opened(_ taker: any GivenBackTaking) {
        takers.removeAll { $0.taker == nil || $0.taker === taker }
        takers.append(Taker(taker: taker))
    }

    /// `taker` is closed for good.
    public func closed(_ taker: any GivenBackTaking) {
        takers.removeAll { $0.taker == nil || $0.taker === taker }
    }

    /// Gives `message` back to the draft kept under `key`.
    public func give(_ message: GivenBack, to key: String) {
        if let taker = takers.last(where: { $0.taker?.draftKey == key })?.taker {
            return taker.take(message)
        }
        words.set(GivenBack.text(message.words, before: words.text(for: key)), for: key)
        waiting[key, default: []].append(message)
    }

    /// What was given back to the draft kept under `key` while no composer was open there,
    /// the oldest first, taken out: its words are in the kept draft already.
    public func waiting(for key: String) -> [GivenBack] {
        waiting.removeValue(forKey: key) ?? []
    }
}
