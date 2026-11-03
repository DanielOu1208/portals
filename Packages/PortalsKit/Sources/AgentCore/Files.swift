import Foundation

/// A file of any kind attached to a message, as it goes to the host: its bytes and name.
/// A Portals bridge saves it in the thread's folder, where the agent reads it.
public struct FileAttachment: Identifiable, Hashable, Sendable {
    public var id: UUID
    public var data: Data
    /// The name it had where it was picked; the host keeps only the name, never a folder.
    public var filename: String

    /// The largest file a message takes, and how many go with one (a Portals bridge's own limits).
    public static let sizeLimit = 25 * 1024 * 1024
    public static let perMessage = 10

    public init(id: UUID = UUID(), data: Data, filename: String) {
        self.id = id
        self.data = data
        self.filename = filename
    }

    /// What the transcript keeps of it.
    public var reference: AttachedFile {
        AttachedFile(id: id, filename: filename, size: data.count)
    }
}

/// The bytes of the files sent lately, for sending a message again ("Try again"), as the
/// app keeps no copies on disk: those of the last message whole, and of earlier ones
/// while all of them together stay under `limit`. A message whose files were let go is
/// not sent again without them (the composer gets its words back instead).
public struct SentFileBytes: Sendable {
    /// How much is kept besides the last message's files.
    public static let limit = 64 * 1024 * 1024

    private var files: [(id: UUID, data: Data)] = []

    public init() {}

    /// Keeps the files of a message just sent, the newest.
    public mutating func keep(_ sent: [FileAttachment]) {
        guard !sent.isEmpty else { return }
        files.removeAll { old in sent.contains { $0.id == old.id } }
        files.append(contentsOf: sent.map { (id: $0.id, data: $0.data) })
        var total = files.reduce(0) { $0 + $1.data.count }
        let newest = files.count - sent.count
        var dropped = 0
        while total > Self.limit, dropped < newest {
            total -= files[dropped].data.count
            dropped += 1
        }
        files.removeFirst(dropped)
    }

    /// The bytes of a file sent lately; nil once let go.
    public func data(for id: UUID) -> Data? {
        files.last { $0.id == id }?.data
    }
}

/// A file a sent message carried, as the transcript keeps it: its name, not its bytes.
public struct AttachedFile: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var filename: String
    /// In bytes, when this copy sent it.
    public var size: Int?
    /// Where the host saved it, when the host's copy of the message says.
    public var path: String?

    public init(id: UUID = UUID(), filename: String, size: Int? = nil, path: String? = nil) {
        self.id = id
        self.filename = filename
        self.size = size
        self.path = path
    }
}

/// A message as a Portals bridge stores it and the agent reads it: the words, then
/// the paths of any files attached under one line of their own, then an `@image:` line
/// for each image.
public enum SentText {
    /// The line before the paths of a message's files. Fixed: the bridge writes it.
    public static let filesHeading = "Files attached in Portals (saved on this Mac):"

    /// What a stored message is made of: the words, the names of its images, and the
    /// paths of its files.
    public static func parse(_ stored: String) -> (text: String, images: [String], files: [String]) {
        var lines = stored.components(separatedBy: "\n")
        let images = lines.filter { $0.hasPrefix("@image:") }.map { String($0.dropFirst("@image:".count)) }
        lines.removeAll { $0.hasPrefix("@image:") }
        // Only a list that runs to the end of the message, a path a line, is the bridge's.
        if let heading = lines.lastIndex(of: filesHeading) {
            let rest = lines[(heading + 1)...]
            if !rest.isEmpty, rest.allSatisfy({ $0.hasPrefix("- ") && $0.count > 2 }) {
                var text = lines[..<heading].joined(separator: "\n")
                while text.hasSuffix("\n") { text.removeLast() }
                return (text, images, rest.map { String($0.dropFirst(2)) })
            }
        }
        return (lines.joined(separator: "\n"), images, [])
    }

    /// The name of a file the host saved, from its path.
    public static func name(ofPath path: String) -> String {
        (path as NSString).lastPathComponent
    }
}

/// A host that takes files of any kind with a message (a Portals bridge's `files`).
/// Elsewhere only images go.
public protocol FileAttaching: Sendable {
    /// Whether the host takes them, as of the last connection; nil before the first.
    var attachesFiles: Bool? { get async }
}
