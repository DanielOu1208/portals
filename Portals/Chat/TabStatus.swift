import SwiftUI
import UIKit

/// What a tab's thread is doing, drawn round the whole tab as well as by its mark at the
/// leading end (2026-10-26: "smt that takes up the whole tab somehow"; of a test
/// copy with five looks, "comet is way nicer but make it a bit more subtle", and of the
/// comet with the spinner and dots kept, "both is ok"): at work, a faint comet running
/// round the outline; waiting for the user, an orange edge breathing; ended out of sight,
/// a blue edge.
enum TabStatus: Equatable {
    case idle, working, waiting, unseen

    init(_ activity: HostModel.Activity, unseen: Bool) {
        switch activity {
        case .working: self = .working
        case .waiting: self = .waiting
        case .idle: self = unseen ? .unseen : .idle
        }
    }

    /// A debug launch's states for the first tabs, by their key (`PORTALS_DEBUG_TAB_STATES`,
    /// e.g. "working,waiting,unseen"), so that each shows at once.
    static func forced(shortcut: Int?) -> TabStatus? {
        guard let shortcut else { return nil }
        let states = DebugLaunch.tabStates
        guard states.indices.contains(shortcut - 1) else { return nil }
        return switch states[shortcut - 1] {
        case "working": .working
        case "waiting": .waiting
        case "unseen": .unseen
        case "idle": .idle
        default: nil
        }
    }

    /// What the activity mark shows for it (`ActivityMark`).
    var activity: HostModel.Activity {
        switch self {
        case .working: .working
        case .waiting: .waiting
        case .idle, .unseen: .idle
        }
    }
}

/// The status drawn over a tab's capsule, under its title.
struct TabStatusFill: View {
    let status: TabStatus

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch status {
        case .idle:
            EmptyView()
        case .working:
            TabEdge(kind: .comet, color: scheme == .dark ? UIColor.white.withAlphaComponent(0.7) : UIColor.black.withAlphaComponent(0.45))
        case .waiting:
            ZStack {
                Capsule().fill(Color.orange.opacity(scheme == .dark ? 0.12 : 0.08))
                TabEdge(kind: .breathing, color: .systemOrange)
            }
        case .unseen:
            ZStack {
                Capsule().fill(Color.blue.opacity(scheme == .dark ? 0.10 : 0.06))
                Capsule().strokeBorder(Color.blue.opacity(0.85), lineWidth: 1.3)
            }
        }
    }
}

/// A tab's moving edge, moved by Core Animation alone: no frame of it is the app's work
/// (drawn by the app each frame, two comets took a quarter of a core, where the spinners
/// alone took nothing).
private struct TabEdge: UIViewRepresentable {
    let kind: TabEdgeView.Kind
    let color: UIColor

    func makeUIView(context: Context) -> TabEdgeView {
        TabEdgeView(kind: kind)
    }

    func updateUIView(_ view: TabEdgeView, context: Context) {
        view.color = color
    }
}

final class TabEdgeView: UIView {
    enum Kind {
        /// A short arc running round the outline at an even pace, fading out smoothly
        /// behind its head along the outline, with a faint glow at its head (2026-10-26: "why is the trail so unsmooth" of four pieces of falling
        /// brightness): many strokes ending at the head, each a little longer than the one
        /// before, whose brightness adds up to an even fade from the head to the tail.
        case comet
        /// The outline, slowly growing faint and back.
        case breathing
    }

    var color: UIColor = .white {
        didSet { if color != oldValue { applyColor() } }
    }

    private let kind: Kind
    /// The comet's strokes, the shortest first, and its glow's; the outline alone when
    /// it breathes.
    private let trail = CALayer()
    private let halo = CALayer()
    private var trailStrokes: [CAShapeLayer] = []
    private var haloStrokes: [CAShapeLayer] = []
    private var outline: CGPath?
    /// How much of the outline the comet's trail covers, as a share of it.
    private var stroked: CGFloat = 0.2

    /// A comet's time round the outline; a breath's, in and out.
    private static let cometPeriod: CFTimeInterval = 2.8
    private static let breathPeriod: CFTimeInterval = 2.4
    /// How long the trail is: a fifth of the outline, and no longer than this on a wide
    /// tab, whose comet would otherwise trail round its end.
    private static let share: CGFloat = 0.2
    private static let longest: CGFloat = 140
    private static let trailSteps = 32
    private static let haloSteps = 10
    /// How much of the trail the glow covers, and how strong it is at the head.
    private static let haloShare: CGFloat = 0.3
    private static let haloStrength: CGFloat = 0.25

    init(kind: Kind) {
        self.kind = kind
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layer.addSublayer(halo)
        layer.addSublayer(trail)
        switch kind {
        case .comet:
            trailStrokes = Self.strokes(Self.trailSteps, width: 1.1, profile: { 1 - $0 }, exponent: 1.6)
            haloStrokes = Self.strokes(Self.haloSteps, width: 3.5, profile: { Self.haloStrength * (1 - $0) }, exponent: 1.5)
            trailStrokes.forEach(trail.addSublayer)
            haloStrokes.forEach(halo.addSublayer)
        case .breathing:
            let edge = CAShapeLayer()
            edge.fillColor = nil
            edge.lineWidth = 1.4
            trailStrokes = [edge]
            trail.addSublayer(edge)
        }
        applyColor()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// `count` strokes, the shortest first, each as opaque as it takes for them together to
    /// be `profile` of the head's brightness along the trail (0 at the head, 1 at the tail),
    /// eased by `exponent`: at a step k from the head, the strokes from k on cover it, and
    /// 1 − Π(1 − a) over them is the brightness wanted there.
    private static func strokes(_ count: Int, width: CGFloat, profile: (CGFloat) -> CGFloat, exponent: CGFloat) -> [CAShapeLayer] {
        let wanted = (0...count).map { step -> CGFloat in
            step == count ? 0 : pow(max(profile(CGFloat(step) / CGFloat(count)), 0), exponent)
        }
        return (0..<count).map { step in
            let stroke = CAShapeLayer()
            stroke.fillColor = nil
            stroke.lineWidth = width
            stroke.lineCap = .butt
            let alpha = 1 - (1 - wanted[step]) / max(1 - wanted[step + 1], 0.0001)
            stroke.opacity = Float(min(max(alpha, 0), 1))
            return stroke
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0, trail.frame.size != bounds.size else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let inset: CGFloat = kind == .comet ? 0.55 : 0.7
        let rect = bounds.insetBy(dx: inset, dy: inset)
        let outline = UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2).cgPath
        self.outline = outline
        for container in [trail, halo] { container.frame = bounds }
        switch kind {
        case .comet:
            // Round twice: the strokes run on the second round, so the trail behind the
            // head is always on the path.
            let twice = CGMutablePath()
            twice.addPath(outline)
            twice.addPath(outline)
            for stroke in trailStrokes + haloStrokes {
                stroke.frame = bounds
                stroke.path = twice
            }
            let side = min(rect.width, rect.height)
            let perimeter = 2 * (max(rect.width, rect.height) - side) + .pi * side
            stroked = min(Self.share * perimeter, Self.longest) / perimeter
        case .breathing:
            trailStrokes.first?.frame = bounds
            trailStrokes.first?.path = outline
        }
        CATransaction.commit()
        animate()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Taken off with the view: put back as it shows again.
        if window != nil { animate() }
    }

    private func applyColor() {
        var alpha: CGFloat = 1
        color.getRed(nil, green: nil, blue: nil, alpha: &alpha)
        let opaque = color.withAlphaComponent(1).cgColor
        for stroke in trailStrokes + haloStrokes { stroke.strokeColor = opaque }
        // The strokes' own opacities add up within each group, then the group is faded.
        trail.opacity = Float(alpha)
        halo.opacity = Float(alpha)
    }

    /// Starts the edge's motion, in step with the clock: every comet, and one laid out
    /// again, is where any other would be.
    private func animate() {
        guard outline != nil else { return }
        let now = CACurrentMediaTime()
        func looping(_ animation: CAAnimation, period: CFTimeInterval) -> CAAnimation {
            // Smooth at 60 frames a second; the window server need not draw the tabs again
            // at a ProMotion screen's 120 (the comets added 7% of a core to it there).
            animation.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            animation.duration = period
            animation.repeatCount = .infinity
            animation.isRemovedOnCompletion = false
            animation.beginTime = now - now.truncatingRemainder(dividingBy: period)
            return animation
        }
        switch kind {
        case .comet:
            let end = CABasicAnimation(keyPath: "strokeEnd")
            end.fromValue = 0.5
            end.toValue = 1
            func place(_ strokes: [CAShapeLayer], over share: CGFloat) {
                for (step, stroke) in strokes.enumerated() {
                    // On the path round twice, a share of one round is half as much.
                    let length = share * CGFloat(step + 1) / CGFloat(strokes.count) / 2
                    let start = CABasicAnimation(keyPath: "strokeStart")
                    start.fromValue = 0.5 - length
                    start.toValue = 1 - length
                    stroke.add(looping(end, period: Self.cometPeriod), forKey: "end")
                    stroke.add(looping(start, period: Self.cometPeriod), forKey: "start")
                }
            }
            place(trailStrokes, over: stroked)
            place(haloStrokes, over: stroked * Self.haloShare)
        case .breathing:
            let breath = CABasicAnimation(keyPath: "opacity")
            breath.fromValue = 1
            breath.toValue = 0.56
            breath.autoreverses = true
            breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            trail.add(looping(breath, period: Self.breathPeriod / 2), forKey: "breath")
        }
    }
}
