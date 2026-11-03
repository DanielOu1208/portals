import AgentCore
import SwiftUI
import UIKit

// Opening a file on the host's Mac in the app (feature file_read): a file a tool row names
// (a read, a write, an edit) or a reply links to (an image in a list or a quote too),
// read-only, as text with its lines numbered and the line the row is about in view, or
// an image as an image. The Mac gives a file from anywhere on it, and says why when it
// gives none (not a file, not text, too large), which the viewer shows. An
// image a reply shows opens on its own over the window instead (`ImageLightbox`).

/// The chat's way to the files of its thread: what the replies' images and the tool rows
/// read through, and the file open over the chat. One a chat, kept while it shows.
@MainActor @Observable
final class ChatFiles {
    /// Observed, and given when the chat is made: a row built before it was set (the
    /// screen's first pass, for a thread shown at once) is redrawn when it is.
    var chat: ThreadController?
    /// The file open in the viewer.
    var opened: Opened?

    init(chat: ThreadController? = nil) {
        self.chat = chat
    }

    struct Opened: Hashable, Identifiable {
        let id = UUID()
        let location: FileLocation
    }

    /// The host reads files for the app, and the thread is on it.
    var isAvailable: Bool { chat?.readsFiles == true && chat?.fileScope != nil }
    /// Where the thread's images are kept apart from other threads'.
    var scope: String? { chat?.fileScope }

    func read(_ path: String, _ purpose: FilePurpose, _ unless: String?) async throws -> HostFile {
        guard let chat else { throw FileReadError.unavailable }
        return try await chat.readFile(path, purpose: purpose, unless: unless)
    }

    func open(_ location: FileLocation) {
        opened = Opened(location: location)
    }
}

extension EnvironmentValues {
    /// The chat's files (`showsFilesHere`); nil outside a chat, where images are their captions.
    @Entry var chatFiles: ChatFiles? = nil
}

extension View {
    /// Gives the chat's replies and rows its thread's files, opens a file over the chat (a
    /// sheet, a panel on a Mac), and a link in a reply to a file on the Mac in it.
    func showsFilesHere(_ chat: ThreadController) -> some View {
        modifier(ShowsFilesHere(chat: chat))
    }
}

private struct ShowsFilesHere: ViewModifier {
    let chat: ThreadController
    /// Made with its chat: the rows of a thread shown at once (one still in memory, the one
    /// on screen at launch) are built in the screen's first pass, before any onAppear.
    @State private var files: ChatFiles
    @Environment(\.imageLightbox) private var lightbox

    init(chat: ThreadController) {
        self.chat = chat
        _files = State(initialValue: ChatFiles(chat: chat))
    }

    func body(content: Content) -> some View {
        @Bindable var files = files
        let picturesOpen = lightbox?.isOpen == true
        content
            .environment(\.chatFiles, files)
            .environment(\.openURL, OpenURLAction { url in
                // A link to a file on the Mac (an image's, `[main.ts](src/main.ts:12)`)
                // opens it here; any other goes where it goes.
                guard files.isAvailable, let location = FileLocation(link: url) else { return .systemAction }
                files.open(location)
                return .handled
            })
            .onChange(of: ObjectIdentifier(chat)) {
                files.chat = chat
                files.opened = nil
            }
            .onDebugLaunch(DebugLaunch.openFile != nil, after: .seconds(2)) {
                for _ in 0..<60 where !files.isAvailable { try? await Task.sleep(for: .milliseconds(500)) }
                if files.isAvailable, let location = DebugLaunch.openFile { files.open(location) }
            }
            .sheetOrPanel($files.opened, width: 900, height: 760) { opened, close in
                FileViewerPanel(location: opened.location, files: files, onDone: close)
            }
            // A reply's image opened on its own over the window (`ImageLightbox`) is open
            // over the chat as a panel is: the composer's focus, which the chat takes from it
            // as it opens and gives back as it closes (`ChatScreen`), is not you starting to
            // type, and the chat stays where it was.
            .transformPreference(PanelOpenKey.self) { if picturesOpen { $0 = true } }
    }
}

// MARK: - The viewer

private struct FileViewerPanel: View {
    let location: FileLocation
    let files: ChatFiles
    let onDone: () -> Void

    @State private var state: LoadState = .loading

    enum LoadState {
        case loading
        case image(UIImage, HostFile)
        case text(lines: [Substring], HostFile)
        case failed(String, symbol: String)
    }

    var body: some View {
        PanelChrome(title: location.name, doneIdentifier: "file-viewer-done", onDone: onDone) {
            VStack(spacing: 0) {
                header
                Divider()
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(Theme.pageBackground)
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.pageBackground)
        .task(id: location) { await load() }
    }

    /// Where the file is, and what can be done with it.
    private var header: some View {
        HStack(spacing: Theme.grid) {
            Text(shownPath)
                .font(.app.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: Theme.grid)
            if case let .text(_, file) = state {
                if case let .text(text) = file.content {
                    Menu {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                        ShareLink(item: text, preview: SharePreview(file.name)) { Label("Share…", systemImage: "square.and.arrow.up") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More")
                    .plainMenuOnMac()
                }
            } else if case let .image(picture, file) = state {
                Menu {
                    ReplyImageMenu(picture: picture, name: file.name)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
                .plainMenuOnMac()
            }
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid)
    }

    private var shownPath: String {
        switch state {
        case let .image(_, file), let .text(_, file): file.path
        default: location.path
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            ProgressView()
        case let .image(picture, _):
            ZoomableImage(picture: picture)
                .accessibilityLabel("Image \(location.name)")
                .accessibilityIdentifier("file-viewer-image")
        case let .text(lines, _):
            FileTextView(lines: lines, line: location.line)
        case let .failed(message, symbol):
            ContentUnavailableView {
                Label("Cannot show \(location.name)", systemImage: symbol)
            } description: {
                Text(message)
            }
            .accessibilityIdentifier("file-viewer-refused")
        }
    }

    private func load() async {
        do {
            let file = try await files.read(location.path, location.purpose, nil)
            switch file.content {
            case let .image(data, _):
                // Whole, for zooming in; decoded off the main thread.
                let longest = 6000
                guard let image = await ReplyImages.decode(data, etag: file.etag, maxPixels: longest) else {
                    state = .failed("\(file.name) could not be shown.", symbol: "photo.badge.exclamationmark")
                    return
                }
                state = .image(image.picture, file)
            case let .text(text):
                let lines = await Task.detached(priority: .userInitiated) { FileTextView.lines(of: text) }.value
                state = .text(lines: lines, file)
            case .unchanged:
                state = .failed("The host sent nothing.", symbol: "doc")
            }
        } catch is CancellationError {
        } catch let error as FileReadError {
            state = .failed(error.errorDescription ?? "The file could not be read.", symbol: Self.symbol(for: error.reason))
        } catch {
            state = .failed("The host could not be reached: \(error.localizedDescription)", symbol: "wifi.exclamationmark")
        }
    }

    private static func symbol(for reason: String?) -> String {
        switch reason {
        case "outside": "lock"
        case "missing", "no_thread": "questionmark.folder"
        case "too_large": "externaldrive"
        case "binary", "not_image": "doc.questionmark"
        default: "exclamationmark.triangle"
        }
    }
}

/// A file's text, read-only, monospaced, each line numbered; long lines wrap under their
/// number. Opened at `line`, which is marked, when it is given.
struct FileTextView: View {
    let lines: [Substring]
    let line: Int?

    /// The longest line drawn whole: a minified file's one line of a megabyte is cut.
    nonisolated static let lineLimit = 2000

    nonisolated static func lines(of text: String) -> [Substring] {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > 1, lines.last?.isEmpty == true { lines.removeLast() }
        return lines.map { $0.count > lineLimit ? $0.prefix(lineLimit) + "…" : $0 }
    }

    var body: some View {
        let gutter = CGFloat(String(lines.count).count) * 9 + Theme.grid
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 1.5) {
                            Text(String(index + 1))
                                .foregroundStyle(.tertiary)
                                .frame(width: gutter, alignment: .trailing)
                            Text(lines[index].isEmpty ? " " : String(lines[index]))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.app.footnote.monospaced())
                        .padding(.horizontal, Theme.grid * 1.5)
                        .padding(.vertical, 1)
                        .background(index + 1 == line ? Color.yellow.opacity(0.22) : .clear)
                        .id(index + 1)
                    }
                }
                .padding(.vertical, Theme.grid)
                .textSelection(.enabled)
            }
            .onAppear {
                if let line, line > 1 { proxy.scrollTo(min(line, lines.count), anchor: .center) }
            }
        }
        .accessibilityIdentifier("file-viewer-text")
    }
}

/// An image to look at whole: fitted at first, pinched or double-tapped in.
private struct ZoomableImage: UIViewRepresentable {
    let picture: UIImage

    func makeUIView(context: Context) -> ZoomView {
        ZoomView(picture: picture)
    }

    func updateUIView(_ view: ZoomView, context: Context) {}
}

/// The picture of `ZoomableImage`, and of a reply's image opened over the window
/// (`ImageLightbox`): fitted to the view at first, never larger than its pixels; pinched
/// or double-tapped in, double-tapped back out. Fitted again whenever the view changes
/// size (turned, a Mac's window resized).
final class ZoomView: UIScrollView, UIScrollViewDelegate {
    let imageView: UIImageView
    /// The size it is fitted by, in pixels: the file's, which a picture decoded smaller
    /// (a reply's) is drawn at all the same, so that a sharper one put in its place
    /// (`show`) takes the same room.
    private let pixelSize: CGSize
    private var fittedFor: CGSize = .zero
    private let doubleTap = UITapGestureRecognizer()
    private let singleTap = UITapGestureRecognizer()
    private let tapGate = TapGate()

    /// A single tap, which waits to be sure it is not a double one: while zoomed in it
    /// zooms back out, fitted it calls this. Nothing while nil (the file viewer's).
    var onTap: (() -> Void)? {
        didSet { singleTap.isEnabled = onTap != nil }
    }

    init(picture: UIImage, pixelSize: CGSize? = nil) {
        imageView = UIImageView(image: picture)
        self.pixelSize = pixelSize ?? picture.size
        super.init(frame: .zero)
        delegate = self
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        backgroundColor = .clear
        addSubview(imageView)
        doubleTap.addTarget(self, action: #selector(zoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        singleTap.addTarget(self, action: #selector(tapped))
        singleTap.require(toFail: doubleTap)
        tapGate.view = self
        singleTap.delegate = tapGate
        singleTap.isEnabled = false
        addGestureRecognizer(singleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Whether it is at its fitted size, not zoomed in.
    var isFitted: Bool { zoomScale <= minimumZoomScale * 1.01 }

    /// Shows `picture` in place of the one shown, at the same size and zoom: the same
    /// image, decoded sharper.
    func show(_ picture: UIImage) {
        imageView.image = picture
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = pixelSize
        guard bounds.size != fittedFor, bounds.width > 0, bounds.height > 0, size.width > 0, size.height > 0 else {
            center()
            return
        }
        fittedFor = bounds.size
        // Fitted, never larger than its pixels at first.
        let fit = min(bounds.width / size.width, bounds.height / size.height, 1)
        minimumZoomScale = fit
        maximumZoomScale = max(fit * 6, 2)
        zoomScale = fit
        imageView.frame = CGRect(origin: .zero, size: CGSize(width: size.width * fit, height: size.height * fit))
        contentSize = imageView.frame.size
        center()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { center() }

    /// Kept in the middle while it is smaller than the view.
    private func center() {
        let horizontal = max((bounds.width - contentSize.width) / 2, 0)
        let vertical = max((bounds.height - contentSize.height) / 2, 0)
        contentInset = UIEdgeInsets(top: vertical, left: horizontal, bottom: vertical, right: horizontal)
    }

    @objc private func zoom(_ tap: UITapGestureRecognizer) {
        if !isFitted {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let point = tap.location(in: imageView)
            let scale = min(maximumZoomScale, minimumZoomScale * 3)
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }

    @objc private func tapped() {
        if isFitted {
            onTap?()
        } else {
            setZoomScale(minimumZoomScale, animated: true)
        }
    }

    /// A touch that stops the picture gliding after a pan is not a tap.
    private final class TapGate: NSObject, UIGestureRecognizerDelegate {
        weak var view: ZoomView?

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            view.map { !$0.isDecelerating && !$0.isDragging } ?? true
        }
    }
}

// MARK: - From a tool row

/// Open File for a tool row that names one file, in its menu and under its details: only
/// where the host reads files for the app.
struct OpenFileButton: View {
    let run: ToolRun

    @Environment(\.chatFiles) private var files

    var body: some View {
        if let files, files.isAvailable, let location = run.fileLocation {
            Button {
                files.open(location)
            } label: {
                Label("Open \(location.name)", systemImage: "doc.text.magnifyingglass")
                    .font(.app.footnote.weight(.medium))
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("open-file")
        }
    }
}

extension View {
    /// The row's menu offers to open the file it is about.
    func opensFileInMenu(_ run: ToolRun) -> some View {
        modifier(OpensFileInMenu(run: run))
    }
}

private struct OpensFileInMenu: ViewModifier {
    let run: ToolRun
    @Environment(\.chatFiles) private var files

    func body(content: Content) -> some View {
        if let files, files.isAvailable, let location = run.fileLocation {
            content.contextMenu {
                Button("Open \(location.name)", systemImage: "doc.text.magnifyingglass") { files.open(location) }
            }
        } else {
            content
        }
    }
}
