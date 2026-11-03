import QuartzCore
import SwiftUI
import UIKit
import Wash

/// The wash drawn with the GPU (`WashRenderer`) into a layer of its own, from a thread
/// of its own: while it moves, a frame costs the main thread nothing, and the CPU only
/// the mesh's points and colours and a few hundred bytes of commands. SwiftUI gives it
/// the palette, the background and the eased `presence` and `energy`, as it gave the
/// wash drawn before; the window around it is not redrawn for its frames.
///
/// Its picture is at most 1024 pixels on its long side, scaled to the view: on the Mac as
/// the bitmap drawn before it was, on an iPhone and iPad so that its pictures take about
/// 6 MB rather than 20.
struct GPUWash: UIViewRepresentable, Animatable {
    var colorScheme: ColorScheme
    var contrast: ColorSchemeContrast
    var tint: Color?
    var background: Color
    var timeRate: Double
    var presence: Double
    var energy: Double
    /// It drifts or swells (it eases to a stop and holds still otherwise).
    var isMoving: Bool
    /// It can be seen: the app is not in the background and a window of it is not covered.
    /// Nothing is drawn otherwise, still or moving, and the picture is drawn again on return.
    var isSeen: Bool

    /// The share of the screen's height the wash covers: more the more it reacts.
    static func height(energy: Double) -> CGFloat { Theme.gradientHeightFraction + CGFloat(energy) * 0.2 }
    /// The most it covers, at full energy: the height its layer keeps, so that the layer
    /// is not made again as the wash swells; the mesh covers `height(energy:)` of it.
    static let tallest = height(energy: 1)

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(presence, energy) }
        set {
            presence = newValue.first
            energy = newValue.second
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> GPUWashView {
        let view = GPUWashView()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.changedSize = { [weak coordinator = context.coordinator, weak view] in
            guard let view else { return }
            coordinator?.resized(view)
        }
        context.coordinator.drawer = WashDrawer(layer: view.metalLayer)
        context.coordinator.update(self, environment: context.environment)
        return view
    }

    func updateUIView(_ view: GPUWashView, context: Context) {
        context.coordinator.update(self, environment: context.environment)
    }

    static func dismantleUIView(_ view: GPUWashView, coordinator: Coordinator) {
        coordinator.drawer?.stop()
        coordinator.drawer = nil
        view.changedSize = nil
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: GPUWashView, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }

    @MainActor final class Coordinator {
        var drawer: WashDrawer?
        private var scene: (key: SceneKey, scene: WashScene)?
        private var size = CGSize.zero

        /// What the resolved colours depend on.
        private struct SceneKey: Equatable {
            var colorScheme: ColorScheme
            var contrast: ColorSchemeContrast
            var tint: Color?
            var background: Color
        }

        func update(_ input: GPUWash, environment: EnvironmentValues) {
            let key = SceneKey(colorScheme: input.colorScheme, contrast: input.contrast, tint: input.tint, background: input.background)
            if scene?.key != key {
                var environment = environment
                environment.colorScheme = input.colorScheme
                scene = (key, WashScene(palette: WashPalette(input.colorScheme, tint: input.tint, lightness: .shown, inkLight: .shown), background: input.background, in: environment))
            }
            guard let scene else { return }
            drawer?.set(WashDrawer.State(
                scene: scene.scene, timeRate: input.timeRate, presence: input.presence, energy: input.energy,
                meshHeight: WashRenderer.meshHeight(GPUWash.height(energy: input.energy), tallest: GPUWash.tallest),
                size: size, isMoving: input.isMoving, isSeen: input.isSeen))
        }

        func resized(_ view: GPUWashView) {
            size = view.drawableSize()
            drawer?.resize(size)
        }
    }
}

extension GPUWash {
    /// Frames a second while the wash moves.
    nonisolated static var framesPerSecond: Float {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if let fps = DebugLaunch.washFramesPerSecond { return Float(fps) }
        #endif
        return 30
    }

    /// The most pixels the picture has on its long side, on every device (it is scaled to
    /// the view; the wash has no sharp detail); nil for the screen's full resolution.
    static var longestSide: CGFloat? {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if let pixels = DebugLaunch.washPixels { return pixels > 0 ? CGFloat(pixels) : nil }
        #endif
        return 1024
    }
}

final class GPUWashView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
    var changedSize: (() -> Void)?
    private var previousSize = CGSize.zero
    private var previousScale: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        let layer = metalLayer
        layer.device = WashRenderer.shared?.device
        layer.pixelFormat = .bgra8Unorm
        // The values are sRGB, as the bitmap and the SwiftUI mesh before were.
        layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        layer.framebufferOnly = true
        // One on screen and one being drawn are enough at 30 frames a second, and a
        // full-resolution iPhone picture is about 10 MB.
        layer.maximumDrawableCount = 2
        layer.isOpaque = true
        layer.magnificationFilter = .linear
        layer.minificationFilter = .linear
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric)
    }

    /// The picture's size in pixels: the view's at the screen's scale, bounded.
    func drawableSize() -> CGSize {
        WashRenderer.pixelSize(of: bounds.size, scale: traitCollection.displayScale > 0 ? traitCollection.displayScale : 2,
                               longestSide: GPUWash.longestSide,
                               meshShare: WashRenderer.boundShare(onMac: Platform.isMac, calmShare: GPUWash.height(energy: 0) / GPUWash.tallest))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != previousSize || traitCollection.displayScale != previousScale else { return }
        previousSize = bounds.size
        previousScale = traitCollection.displayScale
        changedSize?()
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.displayScale != traitCollection.displayScale { setNeedsLayout() }
    }
}

/// Draws one wash's frames on the wash thread (`WashThread`), by a display link there,
/// from the state the main thread gives it. A still wash draws when its state changes,
/// and not again for the same state.
nonisolated final class WashDrawer: NSObject, @unchecked Sendable {
    struct State: Equatable {
        var scene: WashScene
        var timeRate: Double
        var presence: Double
        var energy: Double
        var meshHeight: Float
        var size: CGSize
        var isMoving: Bool
        var isSeen: Bool

        /// Frames come from the display link.
        var isRunning: Bool { isMoving && isSeen }
    }

    private let layer: CAMetalLayer
    private let lock = NSLock()
    /// Guarded by `lock`: written on the main thread, read on the wash thread.
    private var state: State?
    // The rest only on the wash thread.
    private var link: CADisplayLink?
    private var isStopped = false
    /// Still frames that could not be drawn, tried again a tenth of a second later.
    private var retries = 0
    /// The moment shown: the wash's time at its last frame while it moved.
    private var time: Double?
    private var pacer = WashPacer<State>()

    init(layer: CAMetalLayer) {
        self.layer = layer
    }

    /// A new state from SwiftUI: drawn now if the wash is still, at the next frame if it moves.
    func set(_ new: State) {
        lock.lock()
        var new = new
        if let old = state { new.size = old.size }
        let changed = new != state
        state = new
        lock.unlock()
        if changed { WashThread.shared.perform { self.apply() } }
    }

    /// The view's size in pixels changed.
    func resize(_ size: CGSize) {
        lock.lock()
        let changed = state != nil && state?.size != size
        state?.size = size
        lock.unlock()
        if changed { WashThread.shared.perform { self.apply() } }
    }

    func stop() {
        WashThread.shared.perform {
            self.isStopped = true
            NSObject.cancelPreviousPerformRequests(withTarget: self)
            self.link?.invalidate()
            self.link = nil
        }
    }

    // MARK: On the wash thread

    private func apply() {
        lock.lock()
        let state = state
        lock.unlock()
        guard let state, !isStopped else { return }
        // Nothing is drawn while it cannot be seen (iOS refuses work for the GPU from an
        // app in the background); it is drawn again once it can.
        switch pacer.step(isMoving: state.isMoving, isSeen: state.isSeen) {
        case .pause:
            // The layer keeps its pictures meanwhile: asking it for pictures of a pixel
            // while away let none of them go on the iPhone simulator (docs/perf-app.md),
            // and the one on show must stay for the return.
            link?.isPaused = true
        case .run:
            if link == nil {
                let link = CADisplayLink(target: self, selector: #selector(tick))
                let rate = GPUWash.framesPerSecond
                link.preferredFrameRateRange = CAFrameRateRange(minimum: rate, maximum: rate, preferred: rate)
                link.add(to: .current, forMode: .default)
                self.link = link
            }
            link?.isPaused = false
        case .drawOnce:
            link?.isPaused = true
            draw()
        }
    }

    @objc private func tick() { draw() }

    /// A still frame that could not be drawn, tried again (not after `stop`).
    @objc private func retry() {
        guard !isStopped else { return }
        draw()
    }

    private func draw() {
        lock.lock()
        let state = state
        lock.unlock()
        guard let state, let renderer = WashRenderer.shared, state.size.width >= 1, state.size.height >= 1 else { return }
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        let started = CACurrentMediaTime()
        #endif
        // Gapless: back from a pause (the app away, its windows covered) the wash goes
        // on from where it stopped. A still wash keeps the moment it stopped at.
        let thread = WashThread.shared
        let time = state.isRunning ? thread.clock.reading(at: CACurrentMediaTime()) : self.time ?? thread.clock.time
        self.time = time
        guard pacer.shouldDraw(state, at: time, isSeen: state.isSeen) else { return }
        if layer.drawableSize != state.size {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.drawableSize = state.size
            CATransaction.commit()
        }
        let input = state.scene.input(at: time * state.timeRate, presence: state.presence, energy: state.energy,
                                      meshHeight: state.meshHeight)
        guard let drawable = layer.nextDrawable(), let commands = renderer.queue.makeCommandBuffer() else {
            pacer.forget()
            // A moving wash tries again at its next frame; a still one has none coming.
            if !state.isRunning, retries < 10 {
                retries += 1
                perform(#selector(retry), with: nil, afterDelay: 0.1)
            }
            return
        }
        retries = 0
        renderer.encode(input, into: drawable.texture, on: commands)
        commands.present(drawable)
        commands.commit()
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        WashMeter.shared?.note(CACurrentMediaTime() - started)
        #endif
    }
}

/// The thread every wash draws on, with a run loop for their display links.
nonisolated final class WashThread: Thread, @unchecked Sendable {
    static let shared: WashThread = {
        let thread = WashThread()
        thread.name = "Wash"
        thread.qualityOfService = .userInteractive
        thread.start()
        thread.ready.wait()
        return thread
    }()

    private let ready = DispatchSemaphore(value: 0)
    private var runLoop: CFRunLoop?
    /// The time every wash moves by, read only on this thread.
    var clock = WashClock(time: Date().timeIntervalSinceReferenceDate)

    override func main() {
        runLoop = CFRunLoopGetCurrent()
        // A source, so that the run loop waits rather than returns.
        RunLoop.current.add(NSMachPort(), forMode: .default)
        ready.signal()
        while true {
            autoreleasepool { _ = RunLoop.current.run(mode: .default, before: .distantFuture) }
        }
    }

    /// Runs `block` on the wash thread, soon.
    func perform(_ block: @escaping () -> Void) {
        guard let runLoop else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
        CFRunLoopWakeUp(runLoop)
    }
}
