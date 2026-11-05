import SwiftUI
import UIKit

/// How far an update has got, in the agent's colour: how much is done, where the updater says
/// so (`AgentProgram.Update.fraction`), else a band sliding across, as nothing says how far.
/// Never a guess from the time gone. The band is one Core Animation layer moved by one repeating
/// animation, which the render server plays, as `StatusSheen`'s is: nothing in the app runs per
/// frame. It stands still while no window of the app's can be seen, and when motion is reduced.
struct UpdateBar: View {
    var fraction: Double?
    var tint: Color?
    var height: CGFloat = 6

    @Environment(\.accessibilityReduceMotion) private var reducesMotion
    @Environment(\.scenePhase) private var scenePhase

    private var color: Color { tint ?? .primary }

    var body: some View {
        Capsule()
            .fill(.primary.opacity(0.12))
            .overlay(alignment: .leading) {
                if let fraction {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(color)
                            .frame(width: max(height, proxy.size.width * min(max(fraction, 0), 1)))
                    }
                    .animation(.smooth(duration: 0.4), value: fraction)
                } else if reducesMotion || scenePhase == .background || WindowVisibility.shared.isHidden {
                    Capsule().fill(color.opacity(0.5))
                } else {
                    SlidingBand(color: UIColor(color))
                        .clipShape(.capsule)
                }
            }
            .frame(height: height)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(fraction.map { "Updating, \(Int(($0 * 100).rounded())) percent" } ?? "Updating")
    }
}

/// The band, as a UIKit view, for its layer's animation.
private struct SlidingBand: UIViewRepresentable {
    let color: UIColor

    func makeUIView(context: Context) -> SlidingBandView {
        SlidingBandView()
    }

    func updateUIView(_ view: SlidingBandView, context: Context) {
        view.color = color
    }
}

private final class SlidingBandView: UIView {
    /// One crossing every this many seconds.
    private static let period: CFTimeInterval = 1.4
    private static let key = "slide"

    private let band = CALayer()
    /// The width the slide was laid out for.
    private var slidWidth: CGFloat = -1

    var color: UIColor = .label {
        didSet { paint() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        clipsToBounds = true
        layer.addSublayer(band)
        paint()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.paint() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private func paint() {
        band.backgroundColor = color.resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width != slidWidth || band.bounds.height != bounds.height else { return }
        slidWidth = bounds.width
        restart()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A layer's animations do not outlast its leaving the window.
        if window != nil { restart() }
    }

    private func restart() {
        band.removeAnimation(forKey: Self.key)
        guard bounds.width > 0, window != nil else { return }
        let width = bounds.width * 0.4
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        band.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        band.cornerRadius = bounds.height / 2
        band.position = CGPoint(x: -width / 2, y: bounds.midY)
        CATransaction.commit()
        let slide = CABasicAnimation(keyPath: "position.x")
        slide.fromValue = -width / 2
        slide.toValue = bounds.width + width / 2
        slide.duration = Self.period
        slide.repeatCount = .infinity
        slide.timingFunction = CAMediaTimingFunction(name: .linear)
        slide.isRemovedOnCompletion = false
        band.add(slide, forKey: Self.key)
    }
}
