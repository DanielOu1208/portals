import SwiftUI
import UIKit

/// The status line's words while the agent works, with a brighter band sweeping over them
/// from left to right, again and again, in place of the spinner the line had (2026-10-23: "a like pulsing animation where a brighter sheen will go left to right on
/// the text"). The band, the label's colour, is drawn only where the words are, and the
/// words under it are a little dimmed while it sweeps, so it reads over every part of them,
/// a tool's name in the label's colour too (2026-10-23, having seen the first one:
/// "the bright spots on the pulsing animation should be a bit more obvious"; it went over
/// the words as they were, at 85%, and could not show on what was already that colour). It is one Core Animation layer moved
/// by one repeating animation, which the render server plays: nothing in the app runs
/// per frame, and the line is never laid out again for it. It stands still while no
/// window of the app's can be seen, in the background, out of the chat's view, and when
/// motion is reduced (the words alone then).
struct StatusSheen<Content: View>: View {
    /// Whether the band sweeps: while the agent works, not while it waits for the user.
    var sweeps: Bool
    @ViewBuilder var content: Content

    @Environment(\.accessibilityReduceMotion) private var reducesMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var isInView = true
    /// Its chat is kept out of sight behind the one on screen.
    @Environment(\.isOutOfSight) private var isOutOfSight

    /// How strongly the words show under the band while it sweeps.
    static var restOpacity: Double { 0.6 }

    var body: some View {
        let runs = sweeps && !reducesMotion && isInView && scenePhase != .background && !WindowVisibility.shared.isHidden
        content
            .opacity(runs ? Self.restOpacity : 1)
            .animation(.easeInOut(duration: 0.2), value: runs)
            .overlay {
                // Not out of sight, and back at once as it comes back, with nothing faded.
                if runs, !isOutOfSight {
                    SheenBand()
                        .mask { content }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .onScrollVisibilityChange(threshold: 0.01) { isInView = $0 }
    }
}

/// The band, as a UIKit view, for its layer's animation.
private struct SheenBand: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme

    func makeUIView(context: Context) -> SheenBandView {
        SheenBandView()
    }

    func updateUIView(_ view: SheenBandView, context: Context) {
        view.isDark = colorScheme == .dark
    }
}

final class SheenBandView: UIView {
    /// One clock for every line's band: the line of the next thing done sweeps in step
    /// with the one it takes the place of, rather than starting over.
    @MainActor private static let epoch = CACurrentMediaTime()
    /// One sweep every this many seconds: across the words, then a rest.
    static let period: CFTimeInterval = 1.8
    /// How long the band takes across the words.
    static let sweep: CFTimeInterval = 1.2
    /// The band's brightest: the label's colour, whole, over a stretch of its middle.
    static let peak: CGFloat = 1

    private let band = CAGradientLayer()
    /// The width the sweep was laid out for.
    private var sweptWidth: CGFloat = -1

    var isDark = false {
        didSet { if isDark != oldValue { paint() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.locations = [0, 0.3, 0.7, 1]
        layer.addSublayer(band)
        paint()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func paint() {
        let color = UIColor(white: isDark ? 1 : 0, alpha: 1)
        band.colors = [color.withAlphaComponent(0), color.withAlphaComponent(Self.peak), color.withAlphaComponent(Self.peak), color.withAlphaComponent(0)].map(\.cgColor)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width != sweptWidth || band.bounds.height != bounds.height else { return }
        sweptWidth = bounds.width
        let width = min(max(bounds.width * 0.45, 56), 160)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        // At rest, between sweeps, the band waits left of the words.
        band.position = CGPoint(x: -width / 2, y: bounds.midY)
        CATransaction.commit()
        restart()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        restart()
    }

    private func restart() {
        band.removeAnimation(forKey: "sheen")
        guard window != nil, bounds.width > 0 else { return }
        let width = band.bounds.width
        let move = CABasicAnimation(keyPath: "position.x")
        move.fromValue = -width / 2
        move.toValue = bounds.width + width / 2
        move.duration = Self.sweep
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        let cycle = CAAnimationGroup()
        cycle.animations = [move]
        cycle.duration = Self.period
        cycle.repeatCount = .infinity
        cycle.beginTime = band.convertTime(Self.epoch, from: nil)
        band.add(cycle, forKey: "sheen")
    }
}
