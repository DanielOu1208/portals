import SwiftUI
import UIKit
import Wash

extension EnvironmentValues {
    /// How far the wash runs on past its view's leading edge: under the far edge of a
    /// sidebar beside it, which fades out over it there. 0 everywhere else.
    @Entry var washBleed: CGFloat = 0
}

/// What the screen behind the wash is doing.
nonisolated enum AmbientMood: Hashable, Sendable {
    /// Nothing going on, or nothing until you answer the agent: the wash holds still.
    case calm
    /// The agent is working on a reply: the wash drifts.
    case working
    /// The app is listening to a voice: the wash swells with it.
    case listening
}

/// The blue wash behind the chat: a soft gradient over the top ~45% of the
/// screen, fading into the page background.
///
/// It holds still while nothing is going on. While the agent works it drifts
/// slowly, and while listening it swells and brightens with the microphone
/// level. Under Reduce Motion it never moves.
///
///     ScrollView { … }
///         .background { AmbientGradient(mood: .working) }
struct AmbientGradient: View {
    /// What the wash fades into, and what fills the rest of the screen.
    var background: Color = Theme.pageBackground
    /// The avatar's colour; nil is ink (monochrome), and the default is the classic blue.
    var tint: Color? = .blue
    var mood: AmbientMood = .calm
    /// The microphone level, 0…1, read while listening. Read here rather than
    /// passed in, so a level change redraws only the wash, not the screen.
    var level: (() -> Float)?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.washBleed) private var bleed
    @Environment(\.colorSchemeContrast) private var contrast
    /// The chat it is under is kept out of sight behind the one on screen: it holds still.
    @Environment(\.isOutOfSight) private var isOutOfSight

    var body: some View {
        let mood = shownMood
        let energy = reduceMotion ? 0 : energy(in: mood)
        let presence: Double = mood == .calm || reduceMotion ? 0 : 1
        let timeRate = mood == .listening ? 2.0 : 2.8
        GeometryReader { proxy in
            if WashRenderer.shared != nil {
                // Laid out at the tallest the wash reaches, so that its layer keeps its
                // size; the mesh covers the share `energy` gives it, the page the rest.
                GPUWash(colorScheme: colorScheme, contrast: contrast, tint: tint, background: background,
                        timeRate: timeRate, presence: presence, energy: energy,
                        isMoving: presence != 0, isSeen: scenePhase != .background && !WindowVisibility.shared.isHidden && !isOutOfSight)
                    .frame(width: proxy.size.width, height: proxy.size.height * GPUWash.tallest)
                    .frame(maxHeight: .infinity, alignment: .top)
            } else {
                // Paused in the background and while no window can be seen, not while only
                // inactive: on the Mac a window is inactive whenever another app is in
                // front, and it is still in view.
                TimelineView(.animation(minimumInterval: 1.0 / 30,
                                        paused: presence == 0 || scenePhase == .background || WindowVisibility.shared.isHidden
                                            || isOutOfSight)) { context in
                    #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
                    let _ = WashMeter.shared?.note()
                    #endif
                    MeshWash(
                        colorScheme: colorScheme,
                        tint: tint,
                        background: background,
                        time: context.date.timeIntervalSinceReferenceDate * timeRate,
                        presence: presence,
                        energy: energy
                    )
                }
                .frame(width: proxy.size.width, height: proxy.size.height * GPUWash.height(energy: energy))
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        // The level arrives about eight times a second: ease between readings.
        .animation(.smooth(duration: 0.35), value: energy)
        .animation(.smooth(duration: 0.5), value: presence)
        .animation(.smooth(duration: 0.4), value: tint)
        .background(background)
        // On under the sidebar's edge, beside it (`MainScreen`).
        .padding(.leading, -bleed)
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    /// The mood shown: the one given, or the one a development launch asks for.
    private var shownMood: AmbientMood {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        DebugLaunch.washMood ?? mood
        #else
        mood
        #endif
    }

    /// 0 at rest, up to 1: how strongly the wash reacts right now.
    private func energy(in mood: AmbientMood) -> Double {
        switch mood {
        case .calm: return 0
        case .working: return 0.5
        case .listening:
            // Room noise sits around 0.2 on the mic's scale; speech around 0.4–0.75.
            var raw = Double(level?() ?? 0)
            #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
            if level == nil, DebugLaunch.washMood == .listening { raw = Double(DebugVoice.shared.level) }
            #endif
            return 0.15 + 0.85 * min(max((raw - 0.25) / 0.5, 0), 1)
        }
    }
}

/// The wash drawn by SwiftUI, where there is no Metal: `WashFrame`'s mesh as a
/// `MeshGradient`. `presence` and `energy` animate (the timeline only moves `time`), so
/// the wash eases in and out of motion and between level readings.
private struct MeshWash: View, Animatable {
    let colorScheme: ColorScheme
    let tint: Color?
    let background: Color
    let time: Double
    var presence: Double
    var energy: Double

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(presence, energy) }
        set {
            presence = newValue.first
            energy = newValue.second
        }
    }

    var body: some View {
        WashFrame(at: time, palette: WashPalette(colorScheme, tint: tint, lightness: WashPalette.Lightness.shown, inkLight: WashPalette.InkLight.shown), presence: presence, energy: energy)
            .meshGradient(background: background)
            // MeshWash already eases presence and energy. Timeline frames themselves
            // must replace the mesh, rather than start another implicit interpolation.
            .transaction { $0.animation = nil }
    }
}

extension WashPalette.Lightness {
    /// How pale the light wash is: as chosen, or as a development launch asks.
    nonisolated static let shown: Self = DebugLaunch.washLightness ?? .standard
}

extension WashPalette.InkLight {
    /// Ink's light wash: as chosen, or as a development launch asks.
    nonisolated static let shown: Self = DebugLaunch.inkLight ?? .standard
}

#if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
/// A made-up voice for `PORTALS_DEBUG_WASH=listening`: a level that rises and falls
/// as speech does, arriving eight times a second as the microphone's does.
@Observable @MainActor
final class DebugVoice {
    static let shared = DebugVoice()
    private(set) var level: Float = 0.2
    @ObservationIgnored private var timer: Timer?

    private init() {
        let started = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 8, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                let t = Date().timeIntervalSince(started)
                // Syllables over words over pauses: 0.2 (the room) to about 0.75.
                let words = max(0, sin(t * 1.3))
                self?.level = Float(0.2 + 0.55 * words * (0.6 + 0.4 * abs(sin(t * 7.1))))
            }
        }
    }
}
#endif

#Preview("Moods") {
    TabView {
        ForEach([AmbientMood.calm, .working, .listening], id: \.self) { mood in
            AmbientGradient(mood: mood, level: { 0.6 })
                .overlay { Text(String(describing: mood)).font(.app.largeTitle.bold()) }
        }
    }
    .tabViewStyle(.page)
}
