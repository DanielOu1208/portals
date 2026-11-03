import AgentCore
import SwiftUI

/// The thinking orb (`ThinkingOrb`, ported from thinking-orbs by Jakub Antalík, MIT; see
/// THIRD_PARTY_NOTICES.md), drawn natively: where a visual is about to be shown, while the
/// agent plans it and while its drawing has nothing to show yet. Every orb reads one
/// clock, so one that takes another's place goes on in step with it. It stands still in
/// the background, while no window of the app's can be seen, out of the chat's view and
/// when motion is reduced.
struct ThinkingOrbView: View {
    var state: ThinkingOrb.State = .forVisuals
    var size: ThinkingOrb.Size = .large

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reducesMotion
    @State private var isInView = true
    /// Its chat is kept out of sight behind the one on screen.
    @Environment(\.isOutOfSight) private var isOutOfSight

    var body: some View {
        let paused = reducesMotion || !isInView || isOutOfSight || scenePhase == .background || WindowVisibility.shared.isHidden
        // 30 a second, as the wash: the dots move a fraction of a point a frame.
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: paused)) { timeline in
            let frame = reducesMotion
                ? ThinkingOrb.still(state, size: size)
                : ThinkingOrb.frame(state, size: size, at: ThinkingOrbClock.seconds(at: timeline.date))
            Canvas { context, _ in
                Self.draw(frame, in: context, dark: colorScheme == .dark)
            }
        }
        .frame(width: CGFloat(size.rawValue), height: CGFloat(size.rawValue))
        .onScrollVisibilityChange(threshold: 0.01) { isInView = $0 }
        .accessibilityHidden(true)
    }

    private static func draw(_ frame: ThinkingOrb.Frame, in context: GraphicsContext, dark: Bool) {
        for line in frame.lines {
            var path = Path()
            path.move(to: CGPoint(x: line.x1, y: line.y1))
            path.addLine(to: CGPoint(x: line.x2, y: line.y2))
            context.stroke(path, with: .color(Color(white: ThinkingOrb.gray(ink: line.ink, dark: dark), opacity: line.alpha)), lineWidth: line.width)
        }
        for dot in frame.dots {
            let rect = CGRect(x: dot.x - dot.radius, y: dot.y - dot.radius, width: dot.radius * 2, height: dot.radius * 2)
            context.fill(Path(ellipseIn: rect), with: .color(Color(white: ThinkingOrb.gray(ink: dot.ink, dark: dark), opacity: dot.alpha)))
        }
    }
}

/// The one clock all orbs read: seconds since the first orb of this launch.
enum ThinkingOrbClock {
    @MainActor private static let start = Date.now

    @MainActor static func seconds(at date: Date) -> Double {
        // A timeline's first date can be a moment before the clock started.
        max(0, date.timeIntervalSince(start))
    }
}

extension ThinkingOrb.State {
    /// The state a visual's orb is in: `PORTALS_DEBUG_ORB` picks another.
    @MainActor static var forVisuals: ThinkingOrb.State {
        DebugLaunch.orbState ?? .composing
    }
}

#Preview("States") {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))], spacing: 24) {
        ForEach(ThinkingOrb.State.allCases, id: \.self) { state in
            VStack(spacing: 8) {
                ThinkingOrbView(state: state)
                ThinkingOrbView(state: state, size: .small)
                Text(state.rawValue).font(.caption)
            }
        }
    }
    .padding()
}
