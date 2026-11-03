import AgentCore
import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

/// A file dragged onto the composer: a copy of it where the app can read it.
struct DroppedFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            // The system's copy goes when this returns: one is kept, under the file's own
            // name, in a folder of its own.
            let folder = FileManager.default.temporaryDirectory.appending(path: "dropped-\(UUID().uuidString)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appending(path: received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return DroppedFile(url: copy)
        }
    }
}

/// Files picked or dropped, read into what a message takes: a picture as an image (made
/// small, and shown), anything else as a file of its own, as it is.
enum FileIntake {
    struct Taken {
        var images: [ImageAttachment] = []
        var files: [FileAttachment] = []
        /// What could not be attached, each as a sentence.
        var problems: [String] = []
    }

    /// - Parameters:
    ///   - imageSlots: how many more images the message takes; pictures past that go as files.
    ///   - fileSlots: how many more files it takes.
    ///   - takesFiles: the host takes files of any kind; one that does not takes pictures only.
    static func read(_ urls: [URL], imageSlots: Int, fileSlots: Int, takesFiles: Bool) async -> Taken {
        var taken = Taken()
        for url in urls {
            guard !Task.isCancelled else { break }
            // A file chosen in the Files picker is read under its own permission.
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentTypeKey])
            if values?.isDirectory == true {
                taken.problems.append("\(name) is a folder. Only files can be attached.")
                continue
            }
            if let size = values?.fileSize, size > FileAttachment.sizeLimit {
                taken.problems.append("\(name) is larger than \(sizeLimit).")
                continue
            }
            let data = await Task.detached(priority: .userInitiated, operation: { try? Data(contentsOf: url, options: .mappedIfSafe) }).value
            guard !Task.isCancelled else { break }
            guard let data else {
                taken.problems.append("\(name) could not be read.")
                continue
            }
            let type = values?.contentType ?? UTType(filenameExtension: url.pathExtension)
            if type?.conforms(to: .image) == true, taken.images.count < imageSlots,
               let image = await ImageAttachment.prepared(from: data, name: url.deletingPathExtension().lastPathComponent) {
                guard !Task.isCancelled else { break }
                taken.images.append(image)
                continue
            }
            guard !Task.isCancelled else { break }
            guard takesFiles else {
                taken.problems.append("\(name) was not attached: this host takes images only.")
                continue
            }
            guard data.count <= FileAttachment.sizeLimit else {
                taken.problems.append("\(name) is larger than \(sizeLimit).")
                continue
            }
            // Pictures after it may still fit among the images.
            guard taken.files.count < fileSlots else {
                let full = "At most \(FileAttachment.perMessage) files go with one message."
                if !taken.problems.contains(full) { taken.problems.append(full) }
                continue
            }
            taken.files.append(FileAttachment(data: data, filename: name))
        }
        return taken
    }

    private static var sizeLimit: String {
        Int64(FileAttachment.sizeLimit).formatted(.byteCount(style: .binary))
    }
}

/// A file by its name, with a symbol for what kind it is and its size when known: in the
/// composer before it is sent, and in the message after.
struct FileChip: View {
    let name: String
    var size: Int?

    var body: some View {
        HStack(spacing: Theme.grid) {
            Image(systemName: Self.symbol(for: name))
                .font(.app.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.app.footnote.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let size {
                    Text(Int64(size).formatted(.byteCount(style: .file)))
                        .font(.app.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, Theme.grid * 1.5)
        .padding(.vertical, Theme.grid)
        .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("File \(name)")
    }

    /// A symbol for the kind of file, by its name's ending.
    static func symbol(for name: String) -> String {
        let ending = (name as NSString).pathExtension.lowercased()
        // TypeScript, which the system's types take for a video (an MPEG transport stream).
        if ["ts", "tsx", "mts", "cts"].contains(ending) { return "chevron.left.forwardslash.chevron.right" }
        guard let type = UTType(filenameExtension: ending) else { return "doc" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .spreadsheet) || type.conforms(to: .commaSeparatedText) { return "tablecells" }
        if type.conforms(to: .sourceCode) || type.conforms(to: .json) || type.conforms(to: .xml) { return "chevron.left.forwardslash.chevron.right" }
        if type.conforms(to: .text) { return "doc.text" }
        return "doc"
    }
}

/// The files sent with a message, above its text.
struct SentFiles: View {
    let files: [AttachedFile]

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.grid / 2) {
            ForEach(files) { file in
                FileChip(name: file.filename, size: file.size)
            }
        }
    }
}
