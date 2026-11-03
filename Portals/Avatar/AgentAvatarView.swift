import Combine
import SwiftUI

/// An agent's animated avatar: a body with two eyes, in the primary label
/// colour (black in light mode, white in dark). The eyes are holes that show the
/// background.
///
///     AgentAvatarView(mood: .thinking, size: 56)
///     AgentAvatarView(state: .orbit, frozenAt: 1.2, size: 72)   // one exact frame
///
/// `size` is the side of the square the avatar draws in. The frame keeps bloub's margin
/// for the orbit rings, so the body's diameter is about 0.63 times `size`. For Dynamic
/// Type, scale it at the call site: `@ScaledMetric(relativeTo: .title) var size = 56`.
///
/// Decorative by default (hidden from VoiceOver). Pass `accessibilityLabel` when the
/// avatar carries meaning on its own.
///
/// With Reduce Motion on, the avatar holds a still pose per mood and crossfades between
/// moods.
///
/// A coding agent's avatar wears its maker's logo in a badge on its lower-right corner,
/// or shows the logo in its place when its look says so (`AgentAvatarStyle.logo`,
/// `AgentLogoTile`), which holds still whatever the mood.
struct AgentAvatarView: View {
    private enum Content: Equatable {
        case mood(AgentMood)
        case frozen(Bloub.StateID, Double)
    }

    private let content: Content
    private let size: CGFloat
    private let style: AgentAvatarStyle
    private let label: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The live avatar, playing `mood`. Changing `mood` morphs to the new one.
    init(mood: AgentMood, size: CGFloat, style: AgentAvatarStyle = .standard, accessibilityLabel: String? = nil) {
        content = .mood(mood)
        self.size = size
        self.style = style
        label = accessibilityLabel
    }

    /// One fixed frame: `state`, `frozenAt` seconds into it. No animation loop.
    init(state: Bloub.StateID, frozenAt: Double, size: CGFloat, style: AgentAvatarStyle = .standard,
         accessibilityLabel: String? = nil)
    {
        content = .frozen(state, frozenAt)
        self.size = size
        self.style = style
        label = accessibilityLabel
    }

    var body: some View {
        drawing
            .frame(width: size, height: size)
            .modifier(AgentLogoBadgeModifier(logo: style.showsLogo ? nil : style.logo, size: size))
            .modifier(AgentAvatarAccessibility(label: label))
    }

    @ViewBuilder private var drawing: some View {
        if let logo = style.logo, style.showsLogo {
            AgentLogoTile(logo: logo, size: size, cue: logoCue)
        } else {
            avatar
        }
    }

    /// What the logo, shown in place of the avatar, says of the agent: the waiting pose
    /// only. It holds still while the agent works.
    private var logoCue: AgentLogoTile.Cue {
        switch content {
        case .mood(.waiting), .frozen(.notify, _): .waiting
        default: .none
        }
    }

    @ViewBuilder private var avatar: some View {
        switch content {
        case let .frozen(state, t):
            AgentAvatarCanvas(frame: AgentAvatarDirector.frozen(state, at: t, style: style), style: style)
        case let .mood(mood):
            if reduceMotion {
                ZStack {
                    AgentAvatarCanvas(frame: AgentAvatarDirector.still(mood, style: style), style: style)
                        .id(mood)
                        .transition(.opacity)
                }
                .animation(.easeInOut(duration: 0.25), value: mood)
            } else {
                AgentLiveAvatar(mood: mood, style: style)
            }
        }
    }
}

/// The animation loop. The director keeps the engine and the mood schedule; the
/// timeline only asks it for the frame at each date, and when the next one is due: at
/// the full rate while something moves, and at rest, where the avatar holds still
/// between blinks, only for the blinks.
private struct AgentLiveAvatar: View {
    var mood: AgentMood
    var style: AgentAvatarStyle
    @State private var director = AgentAvatarDirector()
    /// Times the time of day was set since this appeared: the timeline starts again from
    /// now, as its dates are in the time of day (the director's times are not).
    @State private var clockChanges = 0
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isOutOfSight) private var isOutOfSight

    /// What starts the timeline again from now, at the full rate: a change of mood or
    /// look is drawn from its very start, not from the next frame at rest.
    private struct Restart: Hashable {
        var mood: AgentMood
        var style: AgentAvatarStyle
        var paused: Bool
        var clockChanges: Int
    }

    var body: some View {
        let paused = Self.isPaused(scenePhase: scenePhase, windowsHidden: WindowVisibility.shared.isHidden, outOfSight: isOutOfSight)
        TimelineView(AgentAvatarSchedule(director: director, mood: mood, style: style, paused: paused)) { _ in
            AgentAvatarCanvas(frame: director.frame(mood: mood, style: style), style: style)
        }
        .id(Restart(mood: mood, style: style, paused: paused, clockChanges: clockChanges))
        // Its clock stands still while it is paused, so it goes on from the pose it had.
        .onChange(of: paused, initial: true) { _, paused in director.setPaused(paused) }
        // Set back, the time of day would hold the timeline's next date far ahead.
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange).receive(on: DispatchQueue.main)) { _ in
            clockChanges += 1
        }
    }

    /// Paused in the background; on an iPhone or iPad also while the app is inactive (the
    /// app switcher, Control Center, a system alert over it, the way back from the
    /// background), which a Mac's window is whenever another app is in front, still in
    /// view; on a Mac while no window can be seen; and where the window is but the avatar is
    /// out of sight (the sidebar behind the chat, the welcome under a sheet).
    static func isPaused(scenePhase: ScenePhase, windowsHidden: Bool, outOfSight: Bool) -> Bool {
        switch scenePhase {
        case .background: return true
        case .inactive where !Platform.isMac: return true
        default: return windowsHidden || outOfSight
        }
    }
}

/// The dates the director asks to be drawn at, one after another (`nextFrame(after:mood:style:)`).
/// It is told the mood and look about to be drawn: the timeline asks for the next date
/// before the frame for this one is drawn, so the director has not started a change yet
/// when it is asked.
private struct AgentAvatarSchedule: TimelineSchedule {
    let director: AgentAvatarDirector
    var mood: AgentMood
    var style: AgentAvatarStyle
    var paused: Bool

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
        var next: Date? = startDate
        return AnyIterator { [director, mood, style, paused] in
            guard let date = next else { return nil }
            next = paused ? nil : director.nextFrame(after: date, mood: mood, style: style)
            return date
        }
    }
}

private struct AgentAvatarAccessibility: ViewModifier {
    var label: String?

    func body(content: Content) -> some View {
        if let label {
            content
                .accessibilityElement()
                .accessibilityLabel(Text(label))
                .accessibilityAddTraits(.isImage)
        } else {
            content.accessibilityHidden(true)
        }
    }
}

#Preview("Moods") {
    VStack(spacing: 24) {
        ForEach(AgentMood.allCases, id: \.self) { mood in
            HStack {
                AgentAvatarView(mood: mood, size: 72)
                Text(mood.rawValue).font(.app.headline)
                Spacer()
            }
        }
    }
    .padding(20)
}
