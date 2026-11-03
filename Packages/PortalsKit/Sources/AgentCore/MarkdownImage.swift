import Foundation

/// An image in a reply: a Markdown image of a file on the host's Mac,
/// `![caption](/absolute/path.png)` or a path relative to the thread's folder, which the
/// app shows in the reply with the file a Portals bridge reads for it (`FileReading`,
/// feature `file_read`). Agents are told to write one on a line of its own; one inside
/// a list, a quote, a heading or a table is a link to it instead, and a remote one
/// (`http(s)`) is never loaded: it is a link to its address.
public struct MarkdownImage: Hashable, Sendable {
    /// The file as the agent named it: an absolute path, `~/…`, or one relative to the
    /// thread's folder. Never a URL with a scheme.
    public var path: String
    /// What the agent wrote between the brackets; nil when nothing.
    public var caption: String?

    public init(path: String, caption: String? = nil) {
        self.path = path
        let trimmed = caption?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.caption = trimmed.isEmpty ? nil : trimmed
    }

    /// The file's name, from its path.
    public var fileName: String {
        (path as NSString).lastPathComponent
    }

    /// What an image is called where it is not drawn: text selected or copied, a preview.
    public var name: String {
        caption.map { "[Image: \($0)]" } ?? "[Image]"
    }

    /// The scheme of the link an image becomes where it is not drawn as one (in a list, a
    /// quote, a table): opening it shows the image (`linkURL`, `init?(link:)`).
    public static let linkScheme = "portals-image"

    /// A link that opens this image.
    public var linkURL: URL? {
        var components = URLComponents()
        components.scheme = Self.linkScheme
        components.path = path
        return components.url
    }

    /// The image a link made by `linkURL` opens.
    public init?(link url: URL) {
        guard url.scheme == Self.linkScheme else { return nil }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
        guard !path.isEmpty else { return nil }
        self.init(path: path)
    }

    /// The image a Markdown image's address names, when it is a file: nil for an address
    /// with a scheme other than `file` (a remote image, `data:`).
    init?(address url: URL, caption: String?) {
        let path: String
        if url.isFileURL {
            path = url.path
        } else if url.scheme == nil {
            path = url.relativeString.removingPercentEncoding ?? url.relativeString
        } else {
            return nil
        }
        guard !path.isEmpty else { return nil }
        self.init(path: path, caption: caption)
    }

    /// Whether a Markdown image's address is a remote one, shown as a link.
    static func isRemote(_ url: URL) -> Bool {
        url.scheme == "http" || url.scheme == "https"
    }
}

extension MarkdownBlock {
    /// Whether the block is an image.
    public var isImage: Bool {
        if case .image = kind { true } else { false }
    }
}

extension Markdown {
    /// The blocks with each image of a file in a paragraph at the top level as a block of
    /// its own, the paragraph's text before and after it blocks of their own; every other
    /// image a link (a file's opens it, a remote one its address), its caption the link's
    /// text. Numbered again in order. Blocks with no image are given as they were.
    static func withImages(_ blocks: [MarkdownBlock]) -> [MarkdownBlock] {
        guard blocks.contains(where: { $0.hasImage }) else { return blocks }
        var result: [MarkdownBlock] = []
        for block in blocks {
            guard block.hasImage else {
                result.append(block)
                continue
            }
            switch block.kind {
            case .paragraph:
                for piece in split(block.text) {
                    switch piece {
                    case let .text(text): result.append(MarkdownBlock(id: 0, kind: .paragraph, text: text))
                    case let .image(image): result.append(MarkdownBlock(id: 0, kind: .image(image)))
                    }
                }
            case var .table(table):
                table.header = table.header.map(linkingImages)
                table.rows = table.rows.map { $0.map(linkingImages) }
                result.append(MarkdownBlock(id: 0, kind: .table(table)))
            default:
                result.append(MarkdownBlock(id: 0, kind: block.kind, text: linkingImages(block.text)))
            }
        }
        for index in result.indices { result[index].id = index }
        return result
    }

    private enum ImagePiece {
        case text(AttributedString)
        case image(MarkdownImage)
    }

    /// A paragraph cut at its images of files: the text around them, trimmed, and none
    /// of nothing but space. A remote image stays in the text as a link.
    private static func split(_ text: AttributedString) -> [ImagePiece] {
        var pieces: [ImagePiece] = []
        var pending = AttributedString()
        var image: (url: URL, caption: String)?
        func flushText() {
            let trimmed = pending.trimmingWhitespace()
            if !trimmed.characters.isEmpty { pieces.append(.text(trimmed)) }
            pending = AttributedString()
        }
        func flushImage() {
            guard let current = image else { return }
            if let made = MarkdownImage(address: current.url, caption: Self.caption(current.caption)) { pieces.append(.image(made)) }
            image = nil
        }
        for run in text.runs {
            let slice = text[run.range]
            if let url = run.imageURL, !MarkdownImage.isRemote(url), MarkdownImage(address: url, caption: nil) != nil {
                // A caption with marks in it comes as several runs of one image.
                if let current = image, current.url == url {
                    image?.caption += String(slice.characters)
                } else {
                    flushImage()
                    flushText()
                    image = (url, String(slice.characters))
                }
            } else {
                flushImage()
                pending.append(linkingImages(AttributedString(slice)))
            }
        }
        flushImage()
        flushText()
        return pieces
    }

    /// The text with each image a link with its caption: a file's opens it here
    /// (`MarkdownImage.linkScheme`), a remote one its address.
    private static func linkingImages(_ text: AttributedString) -> AttributedString {
        guard text.runs.contains(where: { $0.imageURL != nil }) else { return text }
        var linked = AttributedString()
        for run in text.runs {
            var piece = AttributedString(text[run.range])
            if let url = run.imageURL {
                let link = MarkdownImage.isRemote(url) ? url : MarkdownImage(address: url, caption: nil)?.linkURL
                // An image with no caption is drawn by the parser as an object mark; its
                // file's name says more.
                if caption(String(piece.characters)) == nil {
                    let name = MarkdownImage(address: url, caption: nil)?.fileName ?? url.lastPathComponent
                    piece = AttributedString(name.isEmpty ? "image" : name)
                }
                piece.imageURL = nil
                piece.link = link
            }
            linked.append(piece)
        }
        return linked
    }

    /// A caption as the parser gives it: none for the mark it puts for an empty one.
    private static func caption(_ text: String) -> String? {
        let trimmed = text.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private extension MarkdownBlock {
    var hasImage: Bool {
        switch kind {
        case let .table(table):
            (table.header + table.rows.flatMap(\.self)).contains { $0.runs.contains { $0.imageURL != nil } }
        default:
            text.runs.contains { $0.imageURL != nil }
        }
    }
}
