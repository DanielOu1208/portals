// A Swift port of the engine of thinking-orbs 0.3.1 (dist/engine.es.js) by Jakub Antalík,
// https://github.com/Jakubantalik/thinking-orbs, made for Portals. The app draws its frames
// (ThinkingOrbView.swift) where a visual is about to be shown. It is under the MIT License:
//
// MIT License
//
// Copyright (c) 2026 Jakub Antalik
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import Foundation

/// A dotted orb that moves while something is being thought out: nine states, each its
/// own animation, at two sizes tuned apart (64 and 20 points). A frame is the dots (and,
/// for `connecting`, the lines) to draw at one moment of a clock, in a square as wide as
/// the size, furthest first. All orbs read the same clock, so two of them are in step.
/// The orb is one ink: light dots on a dark background, dark ones on a light one.
public enum ThinkingOrb {
    public enum State: String, CaseIterable, Sendable {
        /// Particles on tilted orbits.
        case working
        /// A scan meridian sweeps a dotted globe.
        case searching
        /// Bands scramble in quarter turns, then click back.
        case solving
        /// A waveform rolls through latitude rings.
        case listening
        /// A constellation wires itself, packets running the edges.
        case connecting
        /// Three strands plait around the sphere.
        case weaving
        /// An undulating multi-band sash.
        case composing
        /// A face-on ring slowly morphing.
        case breathing
        /// A dotted outline morphs circle, triangle, square.
        case shaping
    }

    /// The two sizes it is made for, in points: not one design scaled.
    public enum Size: Int, CaseIterable, Sendable {
        case large = 64
        case small = 20
    }

    public struct Dot: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public var z: Double
        public var radius: Double
        /// How far from the ink towards the background, 0 to 1 (`white` in the original).
        public var ink: Double
        public var alpha: Double
    }

    public struct Line: Equatable, Sendable {
        public var x1: Double
        public var y1: Double
        public var x2: Double
        public var y2: Double
        public var ink: Double
        public var alpha: Double
        public var width: Double
    }

    public struct Frame: Equatable, Sendable {
        /// Furthest first, none fainter than can be seen.
        public var dots: [Dot]
        public var lines: [Line]
    }

    /// The grey a dot or line is drawn in, 0 to 1: dark ink on a light background, light
    /// on a dark one.
    public static func gray(ink: Double, dark: Bool) -> Double {
        let ink = min(1, max(0, ink))
        return jsRound((dark ? 1 - ink : ink) * 255) / 255
    }

    /// What the frame of `state` at `size` is at `seconds` of the shared clock.
    public static func frame(_ state: State, size: Size, at seconds: Double) -> Frame {
        let preset = Preset.resolved(state, size)
        let time = seconds * preset.speed
        let side = Double(size.rawValue)
        let options = preset.options
        switch preset.mode {
        case .orbits: return orbits(side, time, options)
        case .globe: return globe(side, time, options)
        case .rubik: return rubik(side, time, options)
        case .wave: return wave(side, time, options)
        case .web: return web(side, time, options)
        case .braid: return braid(side, time, options)
        case .ribbon, .ring: return ribbon(side, time, options)
        case .morph: return morph(side, time, options)
        }
    }

    /// The frame shown when motion is reduced: one that stands for the state.
    public static func still(_ state: State, size: Size) -> Frame {
        let preset = Preset.resolved(state, size)
        let side = Double(size.rawValue)
        let options = preset.options
        let time = 0.6
        switch preset.mode {
        case .orbits: return orbits(side, time, options)
        case .globe: return globe(side, time, options)
        case .rubik: return rubik(side, time, options)
        case .wave: return wave(side, time, options)
        case .web: return web(side, time, options)
        case .braid: return braid(side, time, options)
        case .ribbon, .ring: return ribbon(side, time, options)
        case .morph: return morph(side, time, options)
        }
    }

    // MARK: Presets

    enum Mode: String, Sendable {
        case orbits, globe, rubik, wave, web, braid, ribbon, ring, morph
    }

    /// A state at a size: how it is drawn, how fast its clock runs and its tuning.
    struct Preset: Sendable {
        let mode: Mode
        let speed: Double
        let options: Options

        static func resolved(_ state: State, _ size: Size) -> Preset {
            let mode = mode(of: state)
            let tuning = tunings[mode]![size]!
            var options = Options(base[mode]!)
            if tuning.count != 1 { options = options.counted(tuning.count) }
            if tuning.size != 1 { options = options.sized(tuning.size) }
            for (key, value) in tuning.extra { options.values[key] = value }
            return Preset(mode: mode, speed: tuning.speed, options: options)
        }

        static func mode(of state: State) -> Mode {
            switch state {
            case .working: .orbits
            case .searching: .globe
            case .solving: .rubik
            case .listening: .wave
            case .connecting: .web
            case .weaving: .braid
            case .composing: .ribbon
            case .breathing: .ring
            case .shaping: .morph
            }
        }

        struct Tuning {
            var speed: Double
            var count: Double
            var size: Double
            var extra: [String: Double] = [:]
        }

        static let base: [Mode: [String: Double]] = [
            .globe: ["latRings": 17, "lonDensity": 44, "rBase": 0.6, "rDepth": 1.7, "rBoost": 1, "inkFar": 0.62, "inkSpan": 0.54, "rsPow": 0.6, "rMin": 0.3],
            .orbits: ["orbitN": 12, "ghostN": 40, "ghostR": 0.9, "ghostA": 0.5, "particles": 3, "partR": 1.2, "partRDepth": 1.6, "rsPow": 0.6, "rMin": 0.3],
            .rubik: ["latRings": 15, "lonDensity": 40, "moveCount": 14, "rBase": 0.6, "rDepth": 1.7, "rActive": 0.3, "inkFar": 0.62, "inkSpan": 0.54, "rsPow": 0.6, "rMin": 0.3],
            .wave: ["rings": 15, "lonDensity": 40, "rBase": 0.6, "rDepth": 1.7, "rsPow": 0.6, "rMin": 0.3],
            .web: ["nodeN": 30, "thr": 0.72, "signals": 5, "nodeR": 1.4, "nodeRDepth": 1.8, "lineW": 0.8, "rsPow": 0.6, "rMin": 0.3],
            .braid: ["strandN": 52, "turns": 3, "ghostN": 150, "rBase": 1.2, "rDepth": 1.8, "rsPow": 0.6, "rMin": 0.3],
            .ribbon: ["lanes": 5, "segs": 88, "ghostN": 150, "rBase": 1.1, "rDepth": 1.7, "rsPow": 0.6, "rMin": 0.3],
            // The ribbon's geometry seen face on, the undulation moved onto the radius,
            // with no sphere of faint dots behind it.
            .ring: ["lanes": 5, "segs": 88, "ghostN": 0, "faceOn": 1, "rBase": 1.1, "rDepth": 1.7, "rsPow": 0.6, "rMin": 0.3],
            .morph: ["rDot": 0.021, "iconD": 1, "rMin": 0.25],
        ]

        static let tunings: [Mode: [Size: Tuning]] = [
            .orbits: [.large: Tuning(speed: 1.885, count: 1, size: 1), .small: Tuning(speed: 3.9, count: 0.238, size: 2.4)],
            .globe: [
                .large: Tuning(speed: 2.015, count: 0.42, size: 1.15, extra: ["scanMul": 4.08, "dimBase": 0.45]),
                .small: Tuning(speed: 2.665, count: 0.105, size: 1.75, extra: ["scanMul": 4.335, "dimBase": 0.45]),
            ],
            .rubik: [.large: Tuning(speed: 1.82, count: 0.35, size: 1.05), .small: Tuning(speed: 1.95, count: 0.088, size: 1.9)],
            .wave: [.large: Tuning(speed: 4.388, count: 0.341, size: 1), .small: Tuning(speed: 3.998, count: 0.105, size: 1.6)],
            .web: [.large: Tuning(speed: 3.315, count: 1.35, size: 0.95), .small: Tuning(speed: 6.63, count: 0.25, size: 1.52)],
            .braid: [.large: Tuning(speed: 1.625, count: 0.5, size: 1), .small: Tuning(speed: 2.75, count: 0.1125, size: 1.36)],
            .ribbon: [
                .large: Tuning(speed: 2.34, count: 0.25, size: 0.85, extra: ["spin": 0, "bandMul": 3.9, "wobMul": 1]),
                .small: Tuning(speed: 3.12, count: 0.051, size: 1.073, extra: ["spin": 0, "bandMul": 4.94, "wobMul": 1]),
            ],
            .ring: [
                .large: Tuning(speed: 3.24, count: 0.25, size: 0.956, extra: ["spin": 0, "bandMul": 3.627, "wobMul": 0.368]),
                .small: Tuning(speed: 3.78, count: 0.028, size: 1.622, extra: ["spin": 0, "bandMul": 3.968, "wobMul": 0.565]),
            ],
            .morph: [
                .large: Tuning(speed: 2.405, count: 0.702, size: 0.395, extra: ["spread": 1.45]),
                .small: Tuning(speed: 2.08, count: 0.53, size: 1.011, extra: ["spread": 1.45]),
            ],
        ]
    }

    /// A preset's numbers by name, as the original keeps them; a name not set is the
    /// draw's own default.
    struct Options: Sendable {
        var values: [String: Double]

        init(_ values: [String: Double]) {
            self.values = values
        }

        subscript(_ key: String, default fallback: Double) -> Double {
            values[key] ?? fallback
        }

        func has(_ key: String) -> Bool { values[key] != nil }

        /// Fewer or more dots (`St`): grids by the square root on both of their axes,
        /// counts in proportion, the morph's dots in proportion.
        func counted(_ count: Double) -> Options {
            var values = values
            var scaled = Set<String>()
            let root = count.squareRoot()
            for (first, second) in [("latRings", "lonDensity"), ("rings", "lonDensity"), ("lanes", "segs")] {
                guard let a = values[first], let b = values[second], !scaled.contains(first), !scaled.contains(second) else { continue }
                values[first] = max(2, jsRound(a * root))
                values[second] = max(2, jsRound(b * root))
                scaled.insert(first)
                scaled.insert(second)
            }
            for key in ["orbitN", "ghostN", "nodeN", "strandN", "signals"] {
                guard let value = values[key], value != 0, !scaled.contains(key) else { continue }
                values[key] = max(1, jsRound(value * count))
            }
            if let value = values["iconD"] { values["iconD"] = max(0.02, value * count) }
            return Options(values)
        }

        /// Larger or smaller dots (`Bt`).
        func sized(_ size: Double) -> Options {
            var values = values
            for key in ["rBase", "rDepth", "rActive", "rDot", "ghostR", "partR", "partRDepth", "nodeR", "nodeRDepth"] {
                if let value = values[key] { values[key] = value * size }
            }
            values["rSizeMul"] = (values["rSizeMul"] ?? 1) * size
            return Options(values)
        }
    }

    // MARK: Helpers

    /// `Math.round`: halves up.
    static func jsRound(_ value: Double) -> Double {
        (value + 0.5).rounded(.down)
    }

    static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

    /// `value` modulo `divisor`, from 0 up to it, for a clock read before its start too.
    static func positiveRemainder(_ value: Double, _ divisor: Double) -> Double {
        let remainder = value.truncatingRemainder(dividingBy: divisor)
        return remainder < 0 ? remainder + divisor : remainder
    }

    static func fract(_ value: Double) -> Double { value - value.rounded(.down) }

    /// A number from 0 to 1 that looks random, the same for the same two.
    static func hash(_ a: Double, _ b: Double) -> Double {
        let value = sin(a * 12.9898 + b * 78.233) * 43758.5453
        return value - value.rounded(.down)
    }

    /// Smooth noise over the plane.
    static func noise(_ x: Double, _ y: Double) -> Double {
        let ix = x.rounded(.down), iy = y.rounded(.down)
        var fx = x - ix, fy = y - iy
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        let a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1)
        return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
    }

    /// Point `index` of `count` spread evenly over the unit sphere.
    static func fibonacci(_ index: Int, _ count: Int) -> (Double, Double, Double) {
        let golden = Double.pi * (3 - 5.0.squareRoot())
        let y = 1 - 2 * (Double(index) + 0.5) / Double(count)
        let radius = (1 - y * y).squareRoot()
        let angle = Double(index) * golden
        return (radius * cos(angle), y, radius * sin(angle))
    }

    /// The angle from `b` to `a`, from -π to π.
    static func angleBetween(_ a: Double, _ b: Double) -> Double {
        atan2(sin(a - b), cos(a - b))
    }

    /// A camera turned by `yaw` and tilted by `pitch`, centred at (`cx`, `cy`), scaled by `scale`.
    struct Projection {
        let sinPitch: Double, cosPitch: Double, sinYaw: Double, cosYaw: Double
        let cx: Double, cy: Double, scale: Double

        init(yaw: Double, pitch: Double, cx: Double, cy: Double, scale: Double) {
            sinPitch = sin(pitch)
            cosPitch = cos(pitch)
            sinYaw = sin(yaw)
            cosYaw = cos(yaw)
            self.cx = cx
            self.cy = cy
            self.scale = scale
        }

        func callAsFunction(_ x: Double, _ y: Double, _ z: Double) -> (Double, Double, Double) {
            let e = x * cosYaw + z * sinYaw
            let l = -x * sinYaw + z * cosYaw
            let r = y * cosPitch - l * sinPitch
            let w = y * sinPitch + l * cosPitch
            return (cx + e * scale, cy - r * scale, w)
        }
    }

    static func radiusScale(_ side: Double, _ power: Double) -> Double {
        pow(side / 300, power)
    }

    /// Drops what cannot be seen, keeps every dot at least `smallest`, furthest first.
    static func finished(_ dots: [Dot], _ lines: [Line] = [], smallest: Double) -> Frame {
        var kept: [Dot] = []
        kept.reserveCapacity(dots.count)
        for var dot in dots where dot.alpha >= 0.02 {
            dot.radius = max(smallest, dot.radius)
            kept.append(dot)
        }
        // A stable sort, as JavaScript's.
        let sorted = kept.enumerated().sorted { $0.element.z < $1.element.z || ($0.element.z == $1.element.z && $0.offset < $1.offset) }.map(\.element)
        return Frame(dots: sorted, lines: lines.filter { $0.alpha >= 0.02 })
    }

    // MARK: The draws

    /// `weaving`: three strands plait around a faint sphere.
    static func braid(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.76
        let project = Projection(yaw: s * 0.4, pitch: 0.3, cx: r, cy: a, scale: 1)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        var dots: [Dot] = []
        let ghosts = Int(t["ghostN", default: 150])
        for e in 0..<ghosts {
            let l = fibonacci(e, ghosts)
            let (x, y, z) = project(l.0 * o, l.1 * o, l.2 * o)
            let u = (z / o + 1) / 2
            dots.append(Dot(x: x, y: y, z: z, radius: 0.8 * m, ink: 0.78, alpha: 0.1 + 0.22 * u))
        }
        let strand = Int(t["strandN", default: 52])
        let turns = t["turns", default: 3]
        for e in 0..<3 {
            let l = Double(e) / 3 * 2 * .pi
            for index in 0..<strand {
                let w = (fract(Double(index) / Double(strand) + s * 0.045) * 2 - 1) * 0.96
                let i = max(0, 1 - w * w).squareRoot()
                let u = min(1, (1 - abs(w)) / 0.1)
                let y = w * .pi * turns + l
                let b = 1 + 0.075 * sin(w * .pi * turns * 2 + l * 2 + s * 0.8)
                let f = i * o * b
                let (px, py, pz) = project(cos(y) * f, w * o * b, sin(y) * f)
                let d = (pz / o + 1) / 2
                dots.append(Dot(x: px, y: py, z: pz, radius: (t["rBase", default: 1.2] + t["rDepth", default: 1.8] * d) * m, ink: 0.55 - 0.45 * d, alpha: u * (0.45 + 0.55 * d)))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// The rubik's schedule (`lt`): how far each of `count` quarter turns has gone at
    /// `time`, turning them one after another, back the other way, then a rest.
    static func moves(_ time: Double, _ count: Int, _ step: Double, _ rest: Double) -> (amount: [Double], active: Int) {
        let cycle = 2 * Double(count) * step + rest
        let o = positiveRemainder(time, cycle)
        var amount = [Double](repeating: 0, count: count)
        var active = -1
        if o < 2 * Double(count) * step {
            let h = Int((o / step).rounded(.down))
            let m = (o - Double(h) * step) / step
            let p = 1 - pow(1 - min(1, m / 0.7), 3)
            if h < count {
                for e in 0..<h { amount[e] = 1 }
                amount[h] = p
                active = h
            } else {
                let e = 2 * count - 1 - h
                for l in 0..<e { amount[l] = 1 }
                amount[e] = 1 - p
                active = e
            }
        }
        return (amount, active)
    }

    struct Move {
        let axis: Int
        let lo: Double
        let hi: Double
        let angle: Double
    }

    static func scramble(_ count: Int) -> [Move] {
        (0..<count).map { index in
            let t = Double(index)
            let axis = min(2, Int((hash(t, 2.3) * 3).rounded(.down)))
            let lo = -1 + 0.5 * min(3, (hash(t, 5.9) * 4).rounded(.down))
            let sign: Double = hash(t, 7.7) < 0.5 ? 1 : -1
            return Move(axis: axis, lo: lo, hi: lo + 0.5, angle: sign * .pi / 2)
        }
    }

    static func turned(_ point: (Double, Double, Double), _ moves: [Move], _ schedule: (amount: [Double], active: Int)) -> (Double, Double, Double, Bool) {
        var (r, a, o) = point
        var isActive = false
        for index in moves.indices {
            guard schedule.amount[index] > 0 else { continue }
            let move = moves[index]
            let m = move.axis == 0 ? r : move.axis == 1 ? a : o
            if m < move.lo || m >= move.hi { continue }
            if index == schedule.active { isActive = true }
            let angle = move.angle * schedule.amount[index]
            let p = cos(angle), e = sin(angle)
            switch move.axis {
            case 0:
                let l = a * p - o * e
                o = a * e + o * p
                a = l
            case 1:
                let l = r * p + o * e
                o = -r * e + o * p
                r = l
            default:
                let l = r * p - a * e
                a = r * e + a * p
                r = l
            }
        }
        return (r, a, o, isActive)
    }

    /// `searching`: a scan meridian sweeps a dotted globe.
    static func globe(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let a = n / 2, o = n / 2, c = n / 2 * 0.82
        let pitch = 0.4 + 0.06 * sin(s * 0.35)
        let project = Projection(yaw: s * 0.5, pitch: pitch, cx: a, cy: o, scale: c)
        let scan = s * (0.5 + (1.7 - 0.5) * t["scanMul", default: 1])
        let d = radiusScale(n, t["rsPow", default: 0.6])
        let dim = t["dimBase", default: 1]
        let rings = Int(t["latRings", default: 17])
        let density = t["lonDensity", default: 44]
        var dots: [Dot] = []
        for w in 0...rings {
            let i = -Double.pi / 2 + Double(w) / Double(rings) * .pi
            let u = cos(i), y = sin(i)
            let b = max(1, Int(jsRound(abs(u) * density)))
            for f in 0..<b {
                let p = Double(f) / Double(b) * 2 * .pi
                let (x, g, z) = project(u * cos(p), y, u * sin(p))
                let v = (z + 1) / 2
                let k = angleBetween(p + s * 0.5, scan)
                let lit = exp(-(k * k) / 0.18) * max(0, z)
                dots.append(Dot(
                    x: x, y: g, z: z,
                    radius: (t["rBase", default: 0.6] + t["rDepth", default: 1.7] * v + t["rBoost", default: 1] * lit) * d,
                    ink: t["inkFar", default: 0.62] - t["inkSpan", default: 0.54] * v,
                    // Under 1, the dots the scan is not on fade, so the meridian reads.
                    alpha: dim + (1 - dim) * min(1, lit)
                ))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// `solving`: bands of a dotted globe turn a quarter, one after another, and back.
    static func rubik(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.82
        let project = Projection(yaw: s * 0.55, pitch: 0.35 + 0.1 * sin(s * 0.9), cx: r, cy: a, scale: o)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        let count = Int(t["moveCount", default: 14])
        let scrambled = scramble(count)
        let schedule = moves(s, count, 0.42, 1.2)
        let rings = Int(t["latRings", default: 15])
        let density = t["lonDensity", default: 40]
        var dots: [Dot] = []
        for ring in 0...rings {
            let w = -Double.pi / 2 + Double(ring) / Double(rings) * .pi
            let i = cos(w), u = sin(w)
            let y = max(1, Int(jsRound(abs(i) * density)))
            for b in 0..<y {
                let f = Double(b) / Double(y) * 2 * .pi
                let (px, py, pz, isActive) = turned((i * cos(f), u, i * sin(f)), scrambled, schedule)
                let (x, k, z) = project(px, py, pz)
                let depth = (z + 1) / 2
                dots.append(Dot(
                    x: x, y: k, z: z,
                    radius: (t["rBase", default: 0.6] + t["rDepth", default: 1.7] * depth + (isActive ? t["rActive", default: 0.3] : 0)) * m,
                    ink: t["inkFar", default: 0.62] - t["inkSpan", default: 0.54] * depth - (isActive ? 0.14 : 0),
                    alpha: 1
                ))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// `listening`: a waveform rolls through the rings of a dotted globe.
    static func wave(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.874
        let project = Projection(yaw: s * 0.18, pitch: 0.38, cx: r, cy: a, scale: 1)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        let rings = Int(t["rings", default: 15])
        let density = t["lonDensity", default: 40]
        var dots: [Dot] = []
        for p in 0...rings {
            let e = -Double.pi / 2 + Double(p) / Double(rings) * .pi
            let l = cos(e), ringY = sin(e)
            let w = 0.62 * sin(s * 2.1 - Double(p) * 0.52) + 0.38 * sin(s * 1.27 + Double(p) * 0.83)
            let i = o * (0.88 + 0.105 * w)
            let u = max(1, Int(jsRound(abs(l) * density)))
            for y in 0..<u {
                let b = Double(y) / Double(u) * 2 * .pi
                let (fx, fy, fz) = project(l * cos(b) * i, ringY * i, l * sin(b) * i)
                let g = (fz / o + 1) / 2
                let d = max(0, w)
                dots.append(Dot(
                    x: fx, y: fy, z: fz,
                    radius: (t["rBase", default: 0.6] + t["rDepth", default: 1.7] * g) * (1 + 0.4 * d) * m,
                    ink: 0.66 - 0.56 * g - 0.1 * d,
                    alpha: 1
                ))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// A closed outline through `points`, walked at an even pace from 0 to 1.
    static func outline(_ points: [(Double, Double)]) -> @Sendable (Double) -> (Double, Double) {
        let count = points.count
        var lengths: [Double] = []
        var total = 0.0
        for index in 0..<count {
            let a = points[index], b = points[(index + 1) % count]
            let length = hypot(b.0 - a.0, b.1 - a.1)
            lengths.append(length)
            total += length
        }
        return { [lengths, total] fraction in
            var o = fraction * total
            var c = 0
            while o > lengths[c], c < count - 1 {
                o -= lengths[c]
                c += 1
            }
            let a = points[c], b = points[(c + 1) % count]
            let m = lengths[c] != 0 ? min(1, o / lengths[c]) : 0
            return (a.0 + (b.0 - a.0) * m, a.1 + (b.1 - a.1) * m)
        }
    }

    static let shapes: [@Sendable (Double) -> (Double, Double)] = [
        { fraction in
            let angle = -Double.pi / 2 + fraction * 2 * .pi
            return (cos(angle) * 0.24, sin(angle) * 0.24)
        },
        outline([(0, -0.26), (0.24, 0.16), (-0.24, 0.16)]),
        outline([(0, -0.2), (0.2, -0.2), (0.2, 0.2), (-0.2, 0.2), (-0.2, -0.2)]),
    ]

    /// `shaping`: a dotted outline that holds as a circle, a triangle and a square in
    /// turn, and morphs from one to the next.
    static func morph(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let hold = 1.4, change = 0.9, each = hold + change
        let count = shapes.count
        let a = positiveRemainder(s, each * Double(count))
        let o = min(count - 1, Int((a / each).rounded(.down)))
        let c = a - Double(o) * each
        var mix = 0.0
        if c > hold {
            let x = (c - hold) / change
            mix = x * x * (3 - 2 * x)
        }
        let spread = t["spread", default: 1]
        let from = shapes[o], to = shapes[(o + 1) % count]
        let samples = 160
        var path: [(Double, Double)] = []
        path.reserveCapacity(samples)
        for x in 0..<samples {
            let g = Double(x) / Double(samples)
            let d = from(g), v = to(g)
            path.append(((d.0 + (v.0 - d.0) * mix) * spread, (d.1 + (v.1 - d.1) * mix) * spread))
        }
        var lengths: [Double] = []
        var total = 0.0
        for x in 0..<samples {
            let g = path[x], d = path[(x + 1) % samples]
            let length = hypot(d.0 - g.0, d.1 - g.1)
            lengths.append(length)
            total += length
        }
        let dotsCount = max(6, Int(jsRound(34 * t["iconD", default: 1])))
        let radius = t["rDot", default: 0.021] * 1.35 * spread
        let pulse = 1 + 0.02 * sin(c * 3.1)
        let centre = n / 2
        var dots: [Dot] = []
        var f = 0
        var walked = 0.0
        for x in 0..<dotsCount {
            let g = Double(x) / Double(dotsCount) * total
            while walked + lengths[f] < g, f < samples - 1 {
                walked += lengths[f]
                f += 1
            }
            let d = path[f], v = path[(f + 1) % samples]
            let k = lengths[f] != 0 ? min(1, (g - walked) / lengths[f]) : 0
            let px = (d.0 + (v.0 - d.0) * k) * pulse
            let py = (d.1 + (v.1 - d.1) * k) * pulse
            dots.append(Dot(x: centre + px * n, y: centre + py * n, z: 0, radius: max(0.35, radius * n), ink: 0.1, alpha: 1))
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// `working`: particles on tilted orbits, each orbit a faint ring of dots.
    static func orbits(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.82
        let project = Projection(yaw: s * 0.12, pitch: 0.3, cx: r, cy: a, scale: 1)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        let orbitCount = Int(t["orbitN", default: 12])
        let ghosts = Int(t["ghostN", default: 40])
        let particles = Int(t["particles", default: 3])
        var dots: [Dot] = []
        for e in 0..<orbitCount {
            let index = Double(e)
            let l = hash(index, 1.7), rr = hash(index, 5.2), w = hash(index, 8.9)
            let i = o * (0.45 + 0.52 * l)
            let u = l * 2 * .pi
            let y = acos(2 * rr - 1)
            let b = sin(y) * cos(u), f = cos(y), p = sin(y) * sin(u)
            var x = -f, g = b
            let d = 0.0
            let v = max(1e-6, (x * x + g * g).squareRoot())
            x /= v
            g /= v
            let k = f * d - p * g, nn = p * x - b * d, z = b * g - f * x
            let speed = (0.25 + 0.55 * w) * (w > 0.5 ? 1 : -1)
            func point(_ angle: Double) -> (Double, Double, Double) {
                project(
                    (x * cos(angle) + k * sin(angle)) * i,
                    (g * cos(angle) + nn * sin(angle)) * i,
                    (d * cos(angle) + z * sin(angle)) * i
                )
            }
            for ghost in 0..<ghosts {
                let (sx, sy, sz) = point(Double(ghost) / Double(ghosts) * 2 * .pi)
                let depth = (sz / i + 1) / 2
                dots.append(Dot(x: sx, y: sy, z: sz, radius: t["ghostR", default: 0.9] * m, ink: 0.72, alpha: t["ghostA", default: 0.5] * (0.4 + 0.6 * depth)))
            }
            for particle in 0..<particles {
                let (sx, sy, sz) = point(s * speed + Double(particle) / Double(particles) * 2 * .pi + rr * 6)
                let depth = (sz / i + 1) / 2
                dots.append(Dot(x: sx, y: sy, z: sz, radius: (t["partR", default: 1.2] + t["partRDepth", default: 1.6] * depth) * m, ink: 0.3 - 0.22 * depth, alpha: 1))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// `composing` (an undulating sash of bands around a faint sphere) and, seen face on
    /// with no sphere, `breathing` (a ring slowly morphing).
    static func ribbon(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.78
        let spin = t["spin", default: 1]
        let tilt = 0.3
        let project = Projection(yaw: s * 0.1 * spin, pitch: tilt, cx: r, cy: a, scale: 1)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        var dots: [Dot] = []
        let ghosts = Int(t["ghostN", default: 150])
        for index in 0..<ghosts {
            let point = fibonacci(index, ghosts)
            let (x, y, z) = project(point.0 * o, point.1 * o, point.2 * o)
            let depth = (z / o + 1) / 2
            dots.append(Dot(x: x, y: y, z: z, radius: 0.8 * m, ink: 0.78, alpha: 0.1 + 0.22 * depth))
        }
        let faceOn = t.has("faceOn") && t["faceOn", default: 0] != 0
        let e = s * 0.24 * spin
        let l = faceOn ? -tilt : 0.55 + 0.3 * sin(s * 0.18) * spin
        let rx = cos(e), w = 0.0, i = sin(e)
        let u = -i * sin(l), y = cos(l), b = rx * sin(l)
        let f = w * b - i * y, p = i * u - rx * b, x = rx * y - w * u
        let wobble = t["wobMul", default: 1]
        let g = 0.23 * wobble
        let d = faceOn ? o / (1 + 0.85 * g) : o
        let lanes = t["lanes", default: 5]
        let segments = Int(t["segs", default: 88])
        let bands = max(1, Int(jsRound(lanes * t["bandMul", default: 1])))
        let middle = Double(bands - 1) / 2
        for z in 0..<bands {
            let band = Double(z)
            let offset = (band - middle) * 0.075
            let edge = abs(band - middle) / max(1, middle)
            for index in 0..<segments {
                let angle = Double(index) / Double(segments) * 2 * .pi
                let wave = (0.16 * sin(angle * 3 - s * 1.7 + band * 0.22) + 0.07 * sin(angle * 5 + s * 1.1)) * wobble
                let stretch = faceOn ? 1 + wave : 1
                let across = faceOn ? offset : offset + wave
                let q = rx * cos(angle) + u * sin(angle) + f * across
                let ff = w * cos(angle) + y * sin(angle) + p * across
                let j = i * cos(angle) + b * sin(angle) + x * across
                let length = (q * q + ff * ff + j * j).squareRoot()
                let radius = d * stretch
                let (px, py, pz) = project(q / length * radius, ff / length * radius, j / length * radius)
                let depth = (pz / o + 1) / 2
                dots.append(Dot(
                    x: px, y: py, z: pz,
                    radius: (t["rBase", default: 1.1] + t["rDepth", default: 1.7] * depth) * (1 - 0.25 * edge) * m,
                    ink: 0.52 - 0.44 * depth + 0.18 * edge,
                    alpha: 0.4 + 0.6 * depth
                ))
            }
        }
        return finished(dots, smallest: t["rMin", default: 0.3])
    }

    /// `connecting`: nodes drifting on a sphere, wired to their neighbours, with signals
    /// running between them.
    static func web(_ n: Double, _ s: Double, _ t: Options) -> Frame {
        let r = n / 2, a = n / 2, o = n / 2 * 0.8 * t["spread", default: 1]
        let project = Projection(yaw: s * 0.12, pitch: 0.32, cx: r, cy: a, scale: o)
        let m = radiusScale(n, t["rsPow", default: 0.6])
        let count = Int(t["nodeN", default: 30])
        let threshold = t["thr", default: 0.72]
        let nodeRadius = t["nodeR", default: 1.4]
        let nodeDepth = t["nodeRDepth", default: 1.8]
        var nodes: [(Double, Double, Double)] = []
        for index in 0..<count {
            let i = Double(index)
            let u = fibonacci(index, count)
            let y = u.0 + 0.3 * (noise(i * 0.31 + 9, s * 0.24) - 0.5) * 2
            let b = u.1 + 0.3 * (noise(i * 0.53 + 27, s * 0.21) - 0.5) * 2
            let f = u.2 + 0.3 * (noise(i * 0.77 + 55, s * 0.27) - 0.5) * 2
            let length = (y * y + b * b + f * f).squareRoot()
            nodes.append((y / length, b / length, f / length))
        }
        var lines: [Line] = []
        for i in 0..<count {
            for u in (i + 1)..<max(i + 1, count) {
                let dx = nodes[i].0 - nodes[u].0, dy = nodes[i].1 - nodes[u].1, dz = nodes[i].2 - nodes[u].2
                let distance = (dx * dx + dy * dy + dz * dz).squareRoot()
                if distance >= threshold { continue }
                let (x1, y1, z1) = project(nodes[i].0, nodes[i].1, nodes[i].2)
                let (x2, y2, z2) = project(nodes[u].0, nodes[u].1, nodes[u].2)
                let depth = ((z1 + z2) / 2 + 1) / 2
                lines.append(Line(x1: x1, y1: y1, x2: x2, y2: y2, ink: 0.42, alpha: (1 - distance / threshold) * (0.3 + 0.55 * depth), width: max(0.6, t["lineW", default: 0.8] * m)))
            }
        }
        var dots: [Dot] = []
        for index in 0..<count {
            let (x, y, z) = project(nodes[index].0, nodes[index].1, nodes[index].2)
            let depth = (z + 1) / 2
            let pulse = 1 + 0.25 * sin(s * 1.4 + Double(index) * 2.7)
            dots.append(Dot(x: x, y: y, z: z, radius: (nodeRadius + nodeDepth * depth) * pulse * m, ink: 0.55 - 0.45 * depth, alpha: 1))
        }
        let signals = Int(t["signals", default: 5])
        for index in 0..<signals {
            let i = Double(index)
            let u = (s * 0.55 + i * 7.31).rounded(.down)
            let from = Int((hash(u, i * 3.1 + 1.7) * Double(count)).rounded(.down))
            let to = Int((hash(u, i * 5.7 + 4.2) * Double(count)).rounded(.down))
            if from == to { continue }
            let f = fract(s * 0.55 + i * 7.31)
            let px = lerp(nodes[from].0, nodes[to].0, f)
            let py = lerp(nodes[from].1, nodes[to].1, f)
            let pz = lerp(nodes[from].2, nodes[to].2, f)
            let length = max(1e-6, (px * px + py * py + pz * pz).squareRoot())
            let (x, y, z) = project(px / length, py / length, pz / length)
            let depth = (z + 1) / 2
            dots.append(Dot(x: x, y: y, z: z, radius: (nodeRadius * 1.5 + nodeDepth * depth) * m, ink: 0.05, alpha: 0.5 + 0.5 * depth))
        }
        return finished(dots, lines, smallest: t["rMin", default: 0.3])
    }
}
