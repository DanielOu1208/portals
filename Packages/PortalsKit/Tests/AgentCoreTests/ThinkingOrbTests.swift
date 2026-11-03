import Foundation
import Testing
@testable import AgentCore

struct ThinkingOrbTests {
    @Test func everyStateDrawsInsideItsSquareAtBothSizes() {
        for state in ThinkingOrb.State.allCases {
            for size in ThinkingOrb.Size.allCases {
                let side = Double(size.rawValue)
                for seconds in [0, 0.5, 3.7, 41.2, 600.9] {
                    let frame = ThinkingOrb.frame(state, size: size, at: seconds)
                    #expect(!frame.dots.isEmpty, "\(state) \(size) at \(seconds)")
                    for dot in frame.dots {
                        #expect(dot.x.isFinite && dot.y.isFinite && dot.radius.isFinite)
                        #expect(dot.x > -2 && dot.x < side + 2 && dot.y > -2 && dot.y < side + 2, "\(state) \(size)")
                        // A little over 1 where a strand bulges past the sphere, as in the
                        // original: drawing takes it as 1.
                        #expect(dot.alpha >= 0.02 && dot.alpha <= 1.1)
                    }
                    // Furthest first.
                    #expect(zip(frame.dots, frame.dots.dropFirst()).allSatisfy { $0.z <= $1.z })
                }
            }
        }
    }

    @Test func itMovesAndIsTheSameForTheSameMoment() {
        for state in ThinkingOrb.State.allCases {
            #expect(ThinkingOrb.frame(state, size: .large, at: 2) == ThinkingOrb.frame(state, size: .large, at: 2))
            #expect(ThinkingOrb.frame(state, size: .large, at: 2) != ThinkingOrb.frame(state, size: .large, at: 2.1), "\(state)")
        }
    }

    @Test func aClockReadBeforeItsStartStillDraws() {
        // The timeline's first date can come before the clock's start: the shapes and the
        // solving moves are picked by the time's remainder, which must not be negative.
        #expect(!ThinkingOrb.frame(.shaping, size: .large, at: -0.01).dots.isEmpty)
        #expect(!ThinkingOrb.frame(.solving, size: .small, at: -3).dots.isEmpty)
    }

    @Test func thePresetsAreTheOriginalsTuning() {
        // searching at 64: the globe's 17 × 44 grid thinned by √0.42, its dots 1.15 times larger.
        let globe = ThinkingOrb.Preset.resolved(.searching, .large)
        #expect(globe.mode == .globe && globe.speed == 2.015)
        #expect(globe.options["latRings", default: 0] == 11)
        #expect(globe.options["lonDensity", default: 0] == 29)
        #expect(abs(globe.options["rBase", default: 0] - 0.69) < 1e-9)
        #expect(globe.options["scanMul", default: 0] == 4.08)
        // working at 20: 12 orbits × 0.238 rounds to 3, 40 ghost dots to 10.
        let orbits = ThinkingOrb.Preset.resolved(.working, .small)
        #expect(orbits.options["orbitN", default: 0] == 3)
        #expect(orbits.options["ghostN", default: 0] == 10)
        // breathing has no sphere behind its ring, at either size.
        #expect(ThinkingOrb.Preset.resolved(.breathing, .large).options["ghostN", default: -1] == 0)
        #expect(ThinkingOrb.frame(.breathing, size: .large, at: 1).dots.allSatisfy { $0.alpha >= 0.4 - 1e-9 })
        #expect(ThinkingOrb.frame(.composing, size: .large, at: 1).dots.contains { $0.alpha < 0.4 })
        // shaping is an outline of 24 dots at 64 (34 × 0.702).
        #expect(ThinkingOrb.frame(.shaping, size: .large, at: 1).dots.count == 24)
    }

    @Test func inkIsDarkOnLightAndLightOnDark() {
        #expect(ThinkingOrb.gray(ink: 0.1, dark: false) == 26.0 / 255)
        #expect(ThinkingOrb.gray(ink: 0.1, dark: true) == 230.0 / 255)
        #expect(ThinkingOrb.gray(ink: -1, dark: false) == 0)
        #expect(ThinkingOrb.gray(ink: 2, dark: true) == 0)
    }

    @Test func onlyConnectingDrawsLines() {
        for state in ThinkingOrb.State.allCases {
            let lines = ThinkingOrb.frame(state, size: .large, at: 5).lines
            #expect(lines.isEmpty == (state != .connecting), "\(state)")
        }
    }
}
