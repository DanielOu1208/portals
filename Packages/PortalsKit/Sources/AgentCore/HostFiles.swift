import Foundation

/// What a file on the host's Mac is read for (`FileReading`).
public enum FilePurpose: String, Hashable, Sendable {
    /// An image a reply shows: from anywhere on the host's Mac.
    case image
    /// A file to read (one a tool row names): from anywhere on the host's Mac. An image
    /// there is given as an image all the same.
    case text
}

/// A file the host read for the app.
public struct HostFile: Hashable, Sendable {
    public enum Content: Hashable, Sendable {
        /// An image's bytes and its type (`image/png`).
        case image(Data, type: String)
        case text(String)
        /// The file is the one the app holds (`unless`): nothing was sent.
        case unchanged
    }

    /// Its name.
    public var name: String
    /// Its real path on the host.
    public var path: String
    /// In bytes.
    public var size: Int
    /// Changes when the file does: what the app sends back as `unless`.
    public var etag: String
    public var content: Content

    public init(name: String, path: String, size: Int, etag: String, content: Content) {
        self.name = name
        self.path = path
        self.size = size
        self.etag = etag
        self.content = content
    }
}

public enum FileReadError: LocalizedError, Hashable, Sendable {
    /// The host does not read files for the app (Hermes, an older bridge).
    case unavailable
    /// The host would not give it: `reason` as it names it (`outside`, `missing`,
    /// `too_large`, `binary`, …), `message` its sentence for the person.
    case refused(reason: String, message: String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host cannot show files to the app. Update Portals on it."
        case let .refused(_, message): message
        }
    }

    /// The reason the host gave, for one it refused.
    public var reason: String? {
        if case let .refused(reason, _) = self { reason } else { nil }
    }
}

/// A host that reads a file on its Mac for the app (a Portals bridge's `file_read`): an
/// image a reply shows, or a file a tool row names.
public protocol FileReading: Sendable {
    /// Whether the host reads files, as of the last connection; nil before the first.
    var readsFiles: Bool? { get async }
    /// The file at `path` (absolute, or relative to the thread's folder) for `thread`.
    /// With `unless`, the etag of a copy the app holds, a file still the same comes back
    /// `.unchanged`. Throws `FileReadError`.
    func readFile(_ path: String, in thread: ThreadRef.ID, purpose: FilePurpose, unless: String?) async throws -> HostFile
}

/// A file to open in the app's viewer: where it is, and the line to show first.
public struct FileLocation: Hashable, Sendable {
    public var path: String
    /// One-based; nil for the top.
    public var line: Int?
    /// What it is opened for: an image a reply shows, or a file to read.
    public var purpose: FilePurpose

    public init(path: String, line: Int? = nil, purpose: FilePurpose = .text) {
        self.path = path
        self.line = line
        self.purpose = purpose
    }

    /// The file's name.
    public var name: String {
        (path as NSString).lastPathComponent
    }

    /// The file a link in a reply opens: an image's (`MarkdownImage.linkURL`), or one an
    /// agent wrote as a link to a path (`[main.ts](src/main.ts:12)`, `file:///…#L12`),
    /// with the line it names. nil for a link to anything else (a web page, mail).
    public init?(link url: URL) {
        if let image = MarkdownImage(link: url) {
            self.init(path: image.path, purpose: .image)
            return
        }
        let path: String
        if url.isFileURL {
            path = url.path
        } else if url.scheme == nil, url.host == nil {
            // Strip the real fragment before decoding: `%23` names a literal `#` in a file.
            let raw = String(url.relativeString.prefix { $0 != "#" })
            path = raw.removingPercentEncoding ?? raw
        } else if let scheme = url.scheme, scheme.contains("."), url.host == nil, Self.isLineNumber(url.absoluteString.dropFirst(scheme.count + 1)) {
            // A file at the folder's top with its line, `README.md:12`, which a URL reads as
            // the scheme `README.md`: no scheme people link to has a dot and only a number.
            path = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        } else {
            return nil
        }
        var (file, line) = Self.splitLine(path)
        // `#L12`, as code hosts write a line.
        if line == nil, let fragment = url.fragment, fragment.hasPrefix("L"), let number = Int(fragment.dropFirst().prefix { $0.isNumber }), number > 0 {
            line = number
        }
        guard !file.isEmpty, !file.hasSuffix("/") else { return nil }
        self.init(path: file, line: line)
    }

    /// `12` or `12:4`: what follows a file's name when a link gives its line.
    static func isLineNumber(_ text: Substring) -> Bool {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        return (1...2).contains(parts.count) && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }
    }

    /// `path:12` or `path:12:4` as a path and its line.
    public static func splitLine(_ text: String) -> (String, Int?) {
        var parts = text.split(separator: ":", omittingEmptySubsequences: false)
        var numbers: [Int] = []
        while parts.count > 1, let last = parts.last, let number = Int(last), number > 0, numbers.count < 2 {
            numbers.insert(number, at: 0)
            parts.removeLast()
        }
        return (parts.joined(separator: ":"), numbers.first)
    }
}

extension ToolRun {
    /// The file the row opens, at its first changed line when its diff says, else where
    /// a read of part of it began: nil for a row about no one file.
    public var fileLocation: FileLocation? {
        guard let path, !path.isEmpty else { return nil }
        return FileLocation(path: path, line: diff.flatMap(Self.firstChangedLine) ?? startLine)
    }

    /// The first line of the new file a unified diff's hunks start at (`@@ -a,b +c,d @@`).
    static func firstChangedLine(_ diff: String) -> Int? {
        for line in diff.split(separator: "\n", omittingEmptySubsequences: true) where line.hasPrefix("@@") {
            guard let plus = line.split(separator: " ").first(where: { $0.hasPrefix("+") }) else { continue }
            let start = plus.dropFirst().prefix { $0.isNumber }
            if let number = Int(start) { return max(number, 1) }
        }
        return nil
    }
}
