// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/math.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

/// Swift port of bloub's avatar engine (`src/bot/`): one filled shape that morphs
/// between 14 states, plus two eyes that morph on their own.
///
/// Everything in this namespace is a pure, `nonisolated`, `Sendable` value. Nothing
/// reads a clock: `Bloub.Engine.sample(_:)` is a function of time only, so pausing,
/// replaying and freezing a frame all give the same image.
///
/// The numbers are measurements taken off a reference video, not design choices.
/// Rounding them breaks the resemblance, so they are kept digit for digit;
/// Ryoko's `Avatar/Tools/AvatarEngineCheck.swift` (not copied here) checks the port against the
/// TypeScript original.
nonisolated enum Bloub {}

nonisolated extension Bloub {
    static let tau = Double.pi * 2

    static func clamp(_ v: Double, _ lo: Double = 0, _ hi: Double = 1) -> Double {
        v < lo ? lo : v > hi ? hi : v
    }

    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
        a + (b - a) * t
    }

    /// Measured on the video: transitions are exponential ease-outs and the body never
    /// overshoots. The only springs are local and written into the state that needs them.
    enum Easing {
        static func easeOutCubic(_ t: Double) -> Double { 1 - pow(1 - t, 3) }

        static func easeInOutCubic(_ t: Double) -> Double {
            t < 0.5 ? 4 * pow(t, 3) : 1 - pow(-2 * t + 2, 3) / 2
        }

        static func easeOutQuint(_ t: Double) -> Double { 1 - pow(1 - t, 5) }
    }

    /// Periodic 1D noise that loops seamlessly over `period` (the gaze drift).
    static func loopNoise(_ t: Double, period: Double, seed: Double = 0) -> Double {
        let p = (t / period) * tau
        return 0.55 * sin(p + seed)
            + 0.3 * sin(2 * p + seed * 1.7 + 1.1)
            + 0.15 * sin(3 * p + seed * 2.3 + 2.4)
    }

    /// Deterministic PRNG (mulberry32): the same sequence on every run. The 32-bit
    /// wrapping arithmetic reproduces JavaScript's `Math.imul` and `>>>` bit for bit.
    struct Rng: Sendable {
        private var a: UInt32

        init(seed: UInt32) { a = seed }

        mutating func next() -> Double {
            a = a &+ 0x6d2b_79f5
            var t = (a ^ (a >> 15)) &* (1 | a)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    /// JavaScript's `Math.round`: halves round towards +infinity (`-2.5` gives `-2`).
    static func jsRound(_ v: Double) -> Double {
        let f = v.rounded(.down)
        return v - f >= 0.5 ? f + 1 : f
    }

    /// bloub's `r2`: two decimals. Only used where bloub bakes the rounding into
    /// geometry (the teardrop of the leaning "!"), never on rendered output.
    static func r2(_ v: Double) -> Double { jsRound(v * 100) / 100 }
}
