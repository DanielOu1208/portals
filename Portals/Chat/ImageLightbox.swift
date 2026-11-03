import SwiftUI
import UIKit

// An image a reply shows, opened on its own: the picture alone, fitted and in the middle,
// over a dark backdrop that covers the whole window (the sidebar too), the same in light
// and dark, with no title, file name, path, button or menu (2026-10-20:
// "It should just show up as a pop-up of the image, like nothing else"). It fades and
// grows in, and out. A tap on the picture or around it closes it, as does a swipe down
// (the picture follows the finger and the backdrop fades, as in Photos), Esc on a
// keyboard, and VoiceOver's escape or its Close action. Pinched or double-tapped it zooms
// in (`ZoomView`); zoomed in, a drag moves about the picture rather than swiping it away,
// and a tap zooms back out rather than closing. Held, it offers
// what the reply's image does (`ReplyImageMenu`, but for Open): Copy, Save to Photos,
// Share. It opens at once with the picture the reply shows, and puts the file decoded
// whole in its place, at the same size, when that comes (`ReplyImages.whole`).

/// The picture open over the window. One a window (`showsPicturesHere`), given to what
/// is in it in the environment.
@MainActor @Observable
final class ImageLightbox {
    /// What is open, or nil.
    private(set) var shown: Shown?
    /// Asked to close: the picture fades away, and is let go of once it has (`closed`).
    private(set) var isClosing = false

    var isOpen: Bool { shown != nil }

    struct Shown: Identifiable {
        let id = UUID()
        /// The reply's, shown at once.
        let picture: UIImage
        /// The file's size in pixels, which the picture is fitted by.
        let pixelSize: CGSize
        /// What VoiceOver says of it: "Image: <caption>", as in the reply.
        let label: String
        /// The file decoded whole, sharper than the reply's; nil where the reply's is all
        /// of it already, or where it cannot be had (the reply's stays, and nothing is said).
        let whole: (@MainActor () async -> UIImage?)?
    }

    func show(_ shown: Shown) {
        guard self.shown == nil else { return }
        isClosing = false
        self.shown = shown
    }

    func close() {
        guard shown != nil else { return }
        isClosing = true
    }

    /// It has faded away.
    func closed() {
        shown = nil
        isClosing = false
    }
}

extension EnvironmentValues {
    /// The window's `ImageLightbox`; nil outside one (a preview), where a reply's image
    /// opens in the file viewer instead.
    @Entry var imageLightbox: ImageLightbox? = nil
}

extension View {
    /// Opens a reply's image on its own over all of this: the window's root.
    func showsPicturesHere() -> some View {
        modifier(ShowsPicturesHere())
    }
}

private struct ShowsPicturesHere: ViewModifier {
    @State private var lightbox = ImageLightbox()

    func body(content: Content) -> some View {
        let isOpen = lightbox.isOpen
        content
            .environment(\.imageLightbox, lightbox)
            // Nothing under it is read out while it is open.
            .accessibilityHidden(isOpen)
            .overlay { LightboxLayer(lightbox: lightbox) }
            // Black from edge to edge: the time and the home bar are not drawn over it.
            .statusBarHidden(isOpen)
            .persistentSystemOverlays(isOpen ? .hidden : .automatic)
    }
}

/// The picture and its backdrop while one is open; nothing otherwise. Its own view, so
/// that only it follows the picture.
private struct LightboxLayer: View {
    let lightbox: ImageLightbox

    var body: some View {
        if let shown = lightbox.shown {
            LightboxContent(shown: shown, lightbox: lightbox)
                .id(shown.id)
        }
    }
}

/// One picture open: made with it and let go of with it, the file decoded whole too.
private struct LightboxContent: View {
    let shown: ImageLightbox.Shown
    let lightbox: ImageLightbox

    /// The file decoded whole, once it is.
    @State private var whole: UIImage?

    var body: some View {
        ZStack {
            LightboxCanvas(
                shown: shown,
                whole: whole,
                isClosing: lightbox.isClosing,
                onClose: lightbox.close,
                onClosed: lightbox.closed
            )
            .ignoresSafeArea()
            .accessibilityElement()
            .accessibilityLabel(shown.label)
            .accessibilityAddTraits([.isImage, .isModal])
            // Pressed, it closes, as a tap on it does.
            .accessibilityHint("Closes it")
            .accessibilityAction { lightbox.close() }
            .accessibilityAction(.escape) { lightbox.close() }
            .accessibilityAction(named: "Close") { lightbox.close() }
            .accessibilityIdentifier("image-lightbox")
            // Esc closes it, on a Mac's keyboard or an iPad's: a button that is not drawn.
            Button("Close", action: lightbox.close)
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .task {
            guard let load = shown.whole, let picture = await load(), !Task.isCancelled else { return }
            whole = picture
        }
    }
}

private struct LightboxCanvas: UIViewRepresentable {
    let shown: ImageLightbox.Shown
    let whole: UIImage?
    let isClosing: Bool
    let onClose: () -> Void
    let onClosed: () -> Void

    func makeUIView(context: Context) -> LightboxCanvasView {
        LightboxCanvasView(picture: shown.picture, pixelSize: shown.pixelSize)
    }

    func updateUIView(_ view: LightboxCanvasView, context: Context) {
        view.onClose = onClose
        view.onClosed = onClosed
        if let whole { view.show(whole) }
        if isClosing { view.fadeAway() }
    }
}

/// The backdrop and the picture (`ZoomView`), and what moves them: in UIKit, so that a
/// swipe moves the picture and fades the backdrop with no SwiftUI update at each step.
final class LightboxCanvasView: UIView, UIGestureRecognizerDelegate, UIContextMenuInteractionDelegate {
    private let backdrop = UIView()
    private let zoomView: ZoomView
    private let swipe = UIPanGestureRecognizer()
    /// Where a swipe has moved the picture, and how much it has shrunk it.
    private var moved: CGPoint = .zero
    private var shrunk: CGFloat = 1
    private var hasAppeared = false
    /// On its way out: nothing more is taken in.
    private var isLeaving = false

    var onClose: () -> Void = {}
    var onClosed: () -> Void = {}

    /// How far down a swipe has to take it, or how fast, for it to close when let go.
    private static let swipeDistance: CGFloat = 90
    private static let swipeSpeed: CGFloat = 800

    init(picture: UIImage, pixelSize: CGSize) {
        zoomView = ZoomView(picture: picture, pixelSize: pixelSize)
        super.init(frame: .zero)
        backgroundColor = .clear
        backdrop.backgroundColor = .black
        addSubview(backdrop)
        addSubview(zoomView)
        // Nothing drawn at its edges: a Mac darkened the picture under its window's bar.
        for edge in [zoomView.topEdgeEffect, zoomView.bottomEdgeEffect, zoomView.leftEdgeEffect, zoomView.rightEdgeEffect] {
            edge.isHidden = true
        }
        zoomView.onTap = { [weak self] in self?.onClose() }
        swipe.addTarget(self, action: #selector(swiped(_:)))
        swipe.maximumNumberOfTouches = 1
        // Asked whether it may begin (`gestureRecognizerShouldBegin`) as its delegate: a
        // view is asked that only of the touches on it, and a touch on the picture is the
        // picture's, so that the swipe took every drag, zoomed in or not.
        swipe.delegate = self
        addGestureRecognizer(swipe)
        // A drag down on the picture fitted is the swipe's. Zoomed in, or sideways, the
        // swipe does not begin and the drag moves about the picture.
        zoomView.panGestureRecognizer.require(toFail: swipe)
        zoomView.imageView.isUserInteractionEnabled = true
        zoomView.imageView.addInteraction(UIContextMenuInteraction(delegate: self))
        // Out of sight until it is in the window (`didMoveToWindow`).
        backdrop.alpha = 0
        zoomView.alpha = 0
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        backdrop.frame = bounds
        // On a Mac the picture keeps below the window's bar, where its buttons are; the
        // backdrop alone goes under it. On an iPhone or iPad it has the whole screen.
        let top = Platform.isMac ? safeAreaInsets.top : 0
        let area = CGRect(x: 0, y: top, width: bounds.width, height: max(bounds.height - top, 0))
        // By its size and centre: its transform is not the identity while it is swiped.
        if zoomView.bounds.size != area.size { zoomView.bounds.size = area.size }
        zoomView.center = CGPoint(x: area.midX, y: area.midY)
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    /// Fades and grows in: once, as it is first in the window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, !hasAppeared else { return }
        hasAppeared = true
        zoomView.transform = UIAccessibility.isReduceMotionEnabled ? .identity : CGAffineTransform(scaleX: 0.94, y: 0.94)
        UIView.animate(springDuration: 0.3, bounce: 0, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction]) {
            self.backdrop.alpha = 1
            self.zoomView.alpha = 1
            self.zoomView.transform = .identity
        }
    }

    /// The same picture decoded sharper, in place of the one shown.
    func show(_ picture: UIImage) {
        guard zoomView.imageView.image !== picture else { return }
        zoomView.show(picture)
    }

    /// Fades and shrinks away, then says it has (`onClosed`).
    func fadeAway() {
        guard !isLeaving else { return }
        isLeaving = true
        let scale = UIAccessibility.isReduceMotionEnabled ? shrunk : shrunk * 0.94
        UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
            self.backdrop.alpha = 0
            self.zoomView.alpha = 0
            self.zoomView.transform = Self.transform(moved: self.moved, scale: scale)
        } completion: { _ in
            self.onClosed()
        }
    }

    override func accessibilityPerformEscape() -> Bool {
        onClose()
        return true
    }

    // MARK: Swiping it away

    /// The swipe begins only down or up, with the picture fitted. Asked as the swipe's
    /// delegate (the same method as a view's, which stays as it is for the others).
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === swipe else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        let velocity = swipe.velocity(in: self)
        return !isLeaving && zoomView.isFitted && abs(velocity.y) > abs(velocity.x)
    }

    @objc private func swiped(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: self)
        let progress = min(abs(translation.y) / max(bounds.height * 0.45, 1), 1)
        switch pan.state {
        case .changed:
            moved = translation
            shrunk = 1 - 0.25 * progress
            zoomView.transform = Self.transform(moved: moved, scale: shrunk)
            backdrop.alpha = 1 - progress
        case .ended, .cancelled, .failed:
            let velocity = pan.velocity(in: self)
            let isDown = translation.y > Self.swipeDistance && velocity.y > -100 || velocity.y > Self.swipeSpeed
            if pan.state == .ended, isDown {
                swipeAway(velocity: velocity)
            } else {
                moved = .zero
                shrunk = 1
                UIView.animate(springDuration: 0.35, bounce: 0.1, initialSpringVelocity: 0, delay: 0, options: [.allowUserInteraction]) {
                    self.zoomView.transform = .identity
                    self.backdrop.alpha = 1
                }
            }
        default:
            break
        }
    }

    /// Let go of while going down: it goes on the way it went, and fades.
    private func swipeAway(velocity: CGPoint) {
        isLeaving = true
        let onward = CGPoint(x: moved.x + velocity.x * 0.08, y: moved.y + max(velocity.y * 0.12, bounds.height * 0.12))
        UIView.animate(withDuration: 0.24, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.backdrop.alpha = 0
            self.zoomView.alpha = 0
            self.zoomView.transform = Self.transform(moved: onward, scale: self.shrunk * 0.9)
        } completion: { _ in
            self.onClosed()
        }
    }

    private static func transform(moved: CGPoint, scale: CGFloat) -> CGAffineTransform {
        CGAffineTransform(translationX: moved.x, y: moved.y).scaledBy(x: scale, y: scale)
    }

    // MARK: Its menu

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard !isLeaving, let picture = zoomView.imageView.image else { return nil }
        return UIContextMenuConfiguration(identifier: "picture" as NSString, previewProvider: nil) { [weak self] _ in
            var actions: [UIMenuElement] = [
                UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in
                    UIPasteboard.general.image = picture
                },
            ]
            #if !targetEnvironment(macCatalyst)
            actions.append(UIAction(title: "Save to Photos", image: UIImage(systemName: "square.and.arrow.down")) { _ in
                UIImageWriteToSavedPhotosAlbum(picture, nil, nil, nil)
            })
            #endif
            actions.append(UIAction(title: "Share…", image: UIImage(systemName: "square.and.arrow.up")) { _ in
                self?.share(picture)
            })
            return UIMenu(children: actions)
        }
    }

    /// The part of the picture in view, lifted as the menu opens: all of it when fitted.
    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, highlightPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        preview()
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configuration: UIContextMenuConfiguration, dismissalPreviewForItemWithIdentifier identifier: any NSCopying) -> UITargetedPreview? {
        preview()
    }

    private func preview() -> UITargetedPreview? {
        let imageView = zoomView.imageView
        guard imageView.window != nil else { return nil }
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        let inView = zoomView.convert(zoomView.bounds, to: imageView).intersection(imageView.bounds)
        if !inView.isNull { parameters.visiblePath = UIBezierPath(rect: inView) }
        return UITargetedPreview(view: imageView, parameters: parameters)
    }

    private func share(_ picture: UIImage) {
        var presenter = window?.rootViewController
        while let next = presenter?.presentedViewController { presenter = next }
        guard let presenter else { return }
        let sheet = UIActivityViewController(activityItems: [picture], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = self
        sheet.popoverPresentationController?.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 1, height: 1)
        presenter.present(sheet, animated: true)
    }
}
