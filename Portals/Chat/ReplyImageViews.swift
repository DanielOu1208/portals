import AgentCore
import ImageIO
import os
import SwiftUI
import UIKit

// Images an agent shows in a reply, as a Markdown image of a file on its Mac
// (`![caption](/path.png)`, `MarkdownImage`), which a Portals bridge reads for the app
// (feature file_read, `FileReading`). Each is fetched once: kept decoded in memory while
// the app runs (as many as the device has room for, `ReplyImageMemory`), and its bytes on disk (a few dozen MB at most, the least lately shown let
// go first), so scrolling back and launching again show it without asking the Mac for it
// again. A copy on disk is checked once a launch, and one a reply being written names is
// checked at once, with the etag the Mac gave it: unchanged, the Mac sends nothing; an
// agent that made the file again is shown the new one.

/// An image as shown: decoded for the column, and how large it is.
nonisolated final class ReplyImage: @unchecked Sendable {
    let picture: UIImage
    /// In pixels, as the file has it.
    let pixelSize: CGSize
    let etag: String
    /// What its bitmap takes in memory, in bytes: its cost in `ReplyImages`'s cache.
    let cost: Int

    init(picture: UIImage, pixelSize: CGSize, etag: String) {
        self.picture = picture
        self.pixelSize = pixelSize
        self.etag = etag
        cost = picture.cgImage.map { $0.bytesPerRow * $0.height }
            ?? Int(picture.size.width * picture.scale * picture.size.height * picture.scale) * 4
    }

    var aspectRatio: CGFloat { pixelSize.height > 0 ? pixelSize.width / pixelSize.height : 1 }
}

/// The images replies show, in memory and on disk, and their fetching.
@MainActor
enum ReplyImages {
    /// The longest side an image is decoded at for the reply: a column twice over.
    static let displayPixels = 2048

    /// Decoded, by count and by bytes (`ReplyImageMemory`): a thread of screenshots does
    /// not keep hundreds of MB on a phone.
    private static let memory: NSCache<NSString, ReplyImage> = {
        let cache = NSCache<NSString, ReplyImage>()
        cache.countLimit = ReplyImageMemory.countLimit
        #if targetEnvironment(macCatalyst)
        let isMac = true
        #else
        let isMac = false
        #endif
        cache.totalCostLimit = ReplyImageMemory.costLimit(physicalMemory: ProcessInfo.processInfo.physicalMemory, isMac: isMac)
        return cache
    }()

    /// Kept in memory, at the cost of its bitmap's bytes.
    private static func remember(_ image: ReplyImage, for key: String) {
        memory.setObject(image, forKey: key as NSString, cost: image.cost)
    }

    /// When each image was last checked with the Mac, since launch.
    private static var checked: [String: Date] = [:]
    /// How long an image checked counts as checked for a reply being written.
    private static let freshFor: TimeInterval = 5
    /// What the Mac said no to since launch, by key.
    private static var refusals: [String: FileReadError] = [:]
    /// Loads under way, by key: two views of one image wait on one fetch.
    private static var loading: [String: Task<ReplyImage, any Error>] = [:]
    /// What is known of an image's shape before it is decoded, for its place in the reply.
    private static var shapes: [String: CGSize] = [:]
    /// What a reply's picture said as the Mac last would not give it, by key, until it is
    /// shown: a picture built again (scrolled back to) says it from its first frame, rather
    /// than keeping a picture's place for a moment and its turn shrinking by it.
    static var failures: [String: String] = [:]

    static func key(scope: String, path: String) -> String { scope + "\n" + path }

    /// The image when it is in memory now.
    static func cached(_ key: String) -> ReplyImage? {
        memory.object(forKey: key as NSString)
    }

    /// The copies on disk, in the app's caches folder. Its index is read off the main
    /// thread (`ReplyImageStore.prepare`), the first time an image is asked for.
    static let disk = ReplyImageStore(folder: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "ReplyImages", directoryHint: .isDirectory))

    /// Its size in pixels when known before it is shown: from the copy on disk, once the
    /// disk's index is read (asked for here, off the main thread, the first time).
    static func knownSize(_ key: String) -> CGSize? {
        if let image = cached(key) { return image.pixelSize }
        if let shape = shapes[key] { return shape }
        guard disk.isReady else {
            Task.detached(priority: .userInitiated) { await disk.prepare() }
            return nil
        }
        let shape = disk.size(for: key)
        shapes[key] = shape
        return shape
    }

    /// Reads the index of the copies on disk, off the main thread, so that the pictures a
    /// chat shows first already have their sizes (`knownSize`) for the place they keep.
    static func prepareSizes() {
        guard !disk.isReady else { return }
        Task.detached(priority: .userInitiated) { await disk.prepare() }
    }

    /// The copy held, in memory or on disk, to show at once while the Mac is asked
    /// whether it is still the file (`load`).
    static func held(_ key: String) async -> ReplyImage? {
        if let image = cached(key) { return image }
        guard let image = await fromDisk(key) else { return nil }
        remember(image, for: key)
        return image
    }

    /// The copy on disk, decoded off the main thread.
    private static func fromDisk(_ key: String) async -> ReplyImage? {
        guard let stored = await disk.stored(for: key) else { return nil }
        return await decode(stored.data, etag: stored.etag, maxPixels: displayPixels)
    }

    /// The image, from memory, from disk or from the Mac. `fresh`, for one a reply being
    /// written names: checked with the Mac even when it is held, and asked again when the
    /// Mac said no before (the agent may have made the file since).
    /// `force`, as the reply that names it ends: asked of the Mac whatever was checked or
    /// refused before, after a fetch under way (begun, maybe, before the agent wrote the file again).
    static func load(_ key: String, path: String, fresh: Bool, force: Bool = false, read: @escaping (String, FilePurpose, String?) async throws -> HostFile) async throws -> ReplyImage {
        if force, let running = loading[key] { _ = try? await running.value }
        if !force, let image = cached(key), isChecked(key, fresh: fresh) {
            return image
        }
        // Said no to once this launch: not asked again for a reply already written.
        if !fresh, !force, let refusal = refusals[key] { throw refusal }
        if let running = loading[key] { return try await running.value }
        let task = Task<ReplyImage, any Error> {
            defer { loading[key] = nil }
            let held: ReplyImage? = if let image = cached(key) { image } else { await fromDisk(key) }
            if let held, !force, isChecked(key, fresh: fresh) {
                remember(held, for: key)
                return held
            }
            do {
                let file: HostFile
                do {
                    file = try await read(path, .image, held?.etag)
                } catch let refusal as FileReadError {
                    if refusal.reason != nil { refusals[key] = refusal }
                    throw refusal
                }
                checked[key] = .now
                refusals[key] = nil
                switch file.content {
                case .unchanged:
                    if let held {
                        remember(held, for: key)
                        return held
                    }
                    throw FileReadError.refused(reason: "unreadable", message: "The image could not be read.")
                case let .image(data, _):
                    guard let image = await decode(data, etag: file.etag, maxPixels: displayPixels) else {
                        throw FileReadError.refused(reason: "not_image", message: "\(file.name) could not be shown.")
                    }
                    remember(image, for: key)
                    shapes[key] = image.pixelSize
                    await disk.store(data, for: key, etag: file.etag, size: image.pixelSize)
                    return image
                case .text:
                    throw FileReadError.refused(reason: "not_image", message: "\(file.name) is not an image.")
                }
            } catch {
                // Out of reach, or the file is gone: the copy held is better than nothing.
                if let held, !(error is CancellationError) {
                    remember(held, for: key)
                    return held
                }
                throw error
            }
        }
        loading[key] = task
        return try await task.value
    }

    /// Whether the copy held needs no word from the Mac: checked since launch, and for a
    /// reply being written, a moment ago.
    private static func isChecked(_ key: String, fresh: Bool) -> Bool {
        guard let at = checked[key] else { return false }
        return !fresh || Date.now.timeIntervalSince(at) < freshFor
    }

    /// The longest side an image opened on its own is decoded at (`ImageLightbox`), as the
    /// file viewer's: whole, for zooming in.
    static let wholePixels = 6000

    /// Whether the picture shown is smaller than its file: decoded for the column from a
    /// larger one, so that one opened on its own has more to show.
    static func isReduced(_ image: ReplyImage) -> Bool {
        max(image.pixelSize.width, image.pixelSize.height) > CGFloat(displayPixels)
    }

    /// The image `shown` is, decoded whole (up to `wholePixels`) for a closer look: from the
    /// copy on disk when it is that one, or else from the Mac. Nil when it cannot be had,
    /// or when the Mac's file is not that one any more (the agent made it again): the
    /// picture shown stays as it is.
    static func whole(_ key: String, path: String, of shown: ReplyImage, read: @escaping (String, FilePurpose, String?) async throws -> HostFile) async -> UIImage? {
        if let stored = await disk.stored(for: key), stored.etag == shown.etag {
            return await decode(stored.data, etag: stored.etag, maxPixels: wholePixels)?.picture
        }
        guard let file = try? await read(path, .image, nil), file.etag == shown.etag, case let .image(data, _) = file.content else { return nil }
        return await decode(data, etag: file.etag, maxPixels: wholePixels)?.picture
    }

    /// Decodes an image off the main thread, no larger than `maxPixels` on its longer side.
    nonisolated static func decode(_ data: Data, etag: String, maxPixels: Int) async -> ReplyImage? {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            var width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
            var height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
            // Turned as the file says it is to be shown.
            if let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue, orientation >= 5 { swap(&width, &height) }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            let size = width > 0 && height > 0 ? CGSize(width: width, height: height) : CGSize(width: image.width, height: image.height)
            return ReplyImage(picture: UIImage(cgImage: image), pixelSize: size, etag: etag)
        }.value
    }
}

/// An image a reply shows: as wide as the column (never wider than its own pixels), never
/// taller than about a screen, rounded as the app's other pictures are. Its caption is not
/// written under it (2026-10-20: "When images are attached, it shouldn't say"
/// the caption); VoiceOver reads it as the image's name. Its place is held at its final
/// height as soon as that is known, so the reply does not jump when it comes. Tapped, it
/// opens on its own over the window (`ImageLightbox`); held, it opens, copies, saves and
/// shares.
struct ReplyImageView: View {
    let image: MarkdownImage
    /// The reply is being written: the file may be new, so it is checked with the Mac.
    var isBeingWritten = false

    @Environment(\.chatFiles) private var files

    static let maxHeight: CGFloat = 560
    static let corner: CGFloat = 14
    /// How tall a picture whose shape is not known yet is taken to be: its place in the
    /// reply (`ReplyImageBox`), and its turn's height before the turn is laid out
    /// (`TranscriptHeights`). Screenshots shown in a column come to 150 to 560 points.
    static let typicalHeight: CGFloat = 360

    var body: some View {
        if let files, files.isAvailable, let scope = files.scope {
            let key = ReplyImages.key(scope: scope, path: image.path)
            // One view for one file: a reply that names another file in its place (its
            // text put right as it is written) starts afresh, with nothing of the first.
            LoadedImage(image: image, key: key, fresh: isBeingWritten, files: files)
                .id(key)
        } else {
            // A host that reads no files (Hermes, an older bridge): its caption, as a link is.
            ImageLinkLabel(image: image)
        }
    }
}

/// The caption of an image the app cannot fetch, drawn as a link would be.
private struct ImageLinkLabel: View {
    let image: MarkdownImage

    var body: some View {
        Label {
            Text(image.caption ?? image.fileName)
                .underline()
        } icon: {
            Image(systemName: "photo")
        }
        .font(.app.body)
        .foregroundStyle(.secondary)
        .accessibilityLabel(image.caption.map { "Image: \($0)" } ?? "Image \(image.fileName)")
    }
}

private struct LoadedImage: View {
    let image: MarkdownImage
    let key: String
    let fresh: Bool
    let files: ChatFiles

    @Environment(\.imageLightbox) private var lightbox

    @State private var shown: ReplyImage?
    @State private var failure: String?
    @State private var shape: CGSize?
    /// It was shown while its reply was being written: once the reply ends, the Mac is
    /// asked once more, whatever it said then (the agent may have made or changed the file),
    /// and only once, not each time the row comes back into view.
    @State private var recheck = ReplyImageRecheck()

    init(image: MarkdownImage, key: String, fresh: Bool, files: ChatFiles) {
        self.image = image
        self.key = key
        self.fresh = fresh
        self.files = files
        // One in memory is drawn in the first frame: a row the lazy chat built again (scrolled
        // back to) shows no placeholder for a frame before it.
        let cached = ReplyImages.cached(key)
        _shown = State(initialValue: cached)
        _failure = State(initialValue: cached == nil ? ReplyImages.failures[key] : nil)
        // Its size, when known, from the first frame: the place kept for it is then as
        // large as the picture, and its turn is measured at its height from the start.
        _shape = State(initialValue: cached == nil ? ReplyImages.knownSize(key) : nil)
    }

    var body: some View {
        picture
            .frame(maxWidth: .infinity, alignment: .leading)
            .task(id: key + (fresh ? "\nfresh" : "")) { await load() }
    }

    /// What VoiceOver says of it: its caption, or else its file's name.
    private var label: String {
        image.caption.map { "Image: \($0)" } ?? "Image \(image.fileName)"
    }

    @ViewBuilder
    private var picture: some View {
        if let shown {
            Button {
                openWhole(shown)
            } label: {
                ReplyImageBox(size: shown.pixelSize) {
                    Image(uiImage: shown.picture)
                        .resizable()
                        .clipShape(.rect(cornerRadius: ReplyImageView.corner, style: .continuous))
                }
            }
            .buttonStyle(.plain)
            .contextMenu { ReplyImageMenu(picture: shown.picture, name: image.fileName, open: { openWhole(shown) }) }
            .accessibilityLabel(label)
            .accessibilityHint("Opens it on its own")
            .accessibilityIdentifier("reply-image")
        } else if let failure {
            // Small: what it says is all there is to show.
            Label(failure, systemImage: "photo.badge.exclamationmark")
                .font(.app.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Theme.grid * 1.5)
                .padding(.vertical, Theme.grid)
                .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: ReplyImageView.corner, style: .continuous))
                .accessibilityElement(children: .combine)
                .accessibilityLabel(image.caption.map { "\($0): \(failure)" } ?? failure)
                .accessibilityIdentifier("reply-image-refused")
        } else {
            // The size the picture will have, when its shape is known: the turn takes its
            // height now, rather than growing by it as the picture comes. Not known yet (a
            // picture new to the device, or the copies on disk not looked at yet), a typical
            // picture's place, rather than a sliver its turn grew by up to 530 points from.
            ReplyImageBox(size: shape) {
                RoundedRectangle(cornerRadius: ReplyImageView.corner, style: .continuous)
                    .fill(Color(uiColor: .tertiarySystemFill))
                    .overlay { ProgressView() }
            }
            .accessibilityIdentifier("reply-image-placeholder")
        }
    }

    /// Opens it on its own over the window, at once with the picture shown here, and the
    /// file decoded whole in its place once read, when this one was decoded smaller. In
    /// the file viewer where there is no window's lightbox (a preview).
    private func openWhole(_ shown: ReplyImage) {
        guard let lightbox else { return files.open(FileLocation(path: image.path, purpose: .image)) }
        let key = key
        let path = image.path
        let files = files
        var whole: (@MainActor () async -> UIImage?)?
        if ReplyImages.isReduced(shown) {
            whole = {
                await ReplyImages.whole(key, path: path, of: shown) { path, purpose, unless in
                    try await files.read(path, purpose, unless)
                }
            }
        }
        lightbox.show(ImageLightbox.Shown(picture: shown.picture, pixelSize: shown.pixelSize, label: label, whole: whole))
    }

    /// Shows the picture, saying in the scroll log what took its place before: a place
    /// kept at a size other than the picture's moves the chat under it.
    private func show(_ picture: ReplyImage) {
        let before = shown != nil ? "an older copy" : shape.map { "a place of \(Int($0.width))x\(Int($0.height))" } ?? "a place of no known size"
        AppLog.scroll.notice("image \(image.fileName, privacy: .public) \(Int(picture.pixelSize.width), privacy: .public)x\(Int(picture.pixelSize.height), privacy: .public) shown, after \(before, privacy: .public)")
        shown = picture
        ReplyImages.failures[key] = nil
    }

    /// How often, and how far apart, an image a reply being written names is asked for
    /// again when the Mac said no: the agent may write the file just after naming it.
    private static let retries = 5
    private static let retryAfter: Duration = .seconds(2)

    private func load() async {
        // The reply has just ended: asked once more, as for a reply being written.
        let ended = recheck.begin(isBeingWritten: fresh)
        if shown == nil { shape = ReplyImages.knownSize(key) }
        // The copy held shows at once; the Mac is asked after whether it is still the file.
        if let held = await ReplyImages.held(key), shown !== held { show(held) }
        if shown == nil, shape == nil { shape = ReplyImages.knownSize(key) }
        var tries = 0
        while !Task.isCancelled {
            do {
                let loaded = try await ReplyImages.load(key, path: image.path, fresh: fresh || ended, force: ended && tries == 0) { path, purpose, unless in
                    try await files.read(path, purpose, unless)
                }
                if ended { recheck.made() }
                failure = nil
                if shown !== loaded { show(loaded) }
                return
            } catch is CancellationError {
                return
            } catch {
                // Said no to, or out of reach: asked all the same. What the Mac said is
                // kept (`ReplyImages.load`), and what it did not is asked again as usual.
                if ended { recheck.made() }
                if shown == nil {
                    let said = (error as? LocalizedError)?.errorDescription ?? "The image could not be shown."
                    failure = said
                    // Only what the Mac said no to, as `ReplyImages.load` keeps it: one out
                    // of reach for a moment is likely to be shown when its turn is built
                    // again, and keeps a picture's place meanwhile.
                    if (error as? FileReadError)?.reason != nil { ReplyImages.failures[key] = said }
                }
                guard fresh, tries < Self.retries else { return }
                tries += 1
                try? await Task.sleep(for: Self.retryAfter)
            }
        }
    }
}

/// A reply's picture, or the place kept for it: as wide as the column allows, never wider
/// than its pixels nor than `ReplyImageView.maxHeight` allows, and exactly as tall as its
/// shape then makes it, whatever height is offered. A frame up to `maxHeight` tall took
/// more when a layout offered the chat's rows more height than they needed: the picture
/// centred in blank above and below it (2026-10-25: "a lot of extra padding on the
/// top and bottom"), its turn measured hundreds of points taller, then not, and the chat's
/// height moving by that under a scroll left blank under its end. A place kept for a
/// picture, a shape without a height of its own, came to almost nothing, and its turn grew
/// by the picture's height as it came. A place for a picture whose shape is not known is as
/// wide as the column and `ReplyImageView.typicalHeight` tall, whatever height is offered.
struct ReplyImageBox: Layout {
    /// The picture's size in pixels; nil when not known yet.
    let size: CGSize?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let size else {
            let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ReplyImageView.typicalHeight
            return CGSize(width: max(1, width), height: ReplyImageView.typicalHeight)
        }
        let ratio = size.height > 0 ? size.width / size.height : 1
        let widest = min(max(size.width, 44), ReplyImageView.maxHeight * ratio)
        let offered = proposal.width.map { $0.isFinite ? $0 : widest } ?? widest
        let width = max(1, min(offered, widest))
        return CGSize(width: width, height: (width / ratio).rounded())
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
        }
    }
}

/// What an image's menu offers: open it on its own (a reply's), copy it, save it, share
/// it. The image open on its own offers the same but for Open (`LightboxCanvasView`).
struct ReplyImageMenu: View {
    let picture: UIImage
    let name: String
    var open: (() -> Void)?

    var body: some View {
        if let open {
            Button("Open", systemImage: "arrow.up.left.and.arrow.down.right", action: open)
        }
        Button("Copy", systemImage: "doc.on.doc") {
            UIPasteboard.general.image = picture
        }
        #if !targetEnvironment(macCatalyst)
        Button("Save to Photos", systemImage: "square.and.arrow.down") {
            UIImageWriteToSavedPhotosAlbum(picture, nil, nil, nil)
        }
        #endif
        ShareLink(item: Image(uiImage: picture), preview: SharePreview(name, image: Image(uiImage: picture))) {
            Label("Share…", systemImage: "square.and.arrow.up")
        }
    }
}
