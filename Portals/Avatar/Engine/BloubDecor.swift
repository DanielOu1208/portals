// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/decor.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

nonisolated extension Bloub {
    // MARK: Colours

    struct RGB8: Equatable, Sendable {
        var r: Int
        var g: Int
        var b: Int

        var hex: String { String(format: "#%02x%02x%02x", r, g, b) }

        init(r: Int, g: Int, b: Int) {
            self.r = r
            self.g = g
            self.b = b
        }

        init(hex: String) {
            let v = Int(hex.dropFirst(), radix: 16) ?? 0
            self.init(r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255)
        }
    }

    /// The rings are not flat colours: the video shows a full hue wheel at constant
    /// lightness, with a gradient along each stroke. Measured: S 45-62 %, L 50-67 %.
    static func wheel(_ hue: Double, s: Double = 0.55, l: Double = 0.62) -> RGB8 {
        let h = ((hue.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
        let c = (1 - abs(2 * l - 1)) * s
        let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = l - c / 2
        let (r, g, b): (Double, Double, Double) =
            h < 60 ? (c, x, 0)
            : h < 120 ? (x, c, 0)
            : h < 180 ? (0, c, x)
            : h < 240 ? (0, x, c)
            : h < 300 ? (x, 0, c)
            : (c, 0, x)
        func byte(_ v: Double) -> Int { Int(jsRound((v + m) * 255)) }
        return RGB8(r: byte(r), g: byte(g), b: byte(b))
    }

    // MARK: Render types

    struct Dot: Equatable, Sendable {
        var x: Double
        var y: Double
        var r: Double
        var opacity: Double
        /// Explicit colour; by default the renderer uses the body's.
        var color: RGB8?
        /// Depth haze: 0 = melted into the background, 1 = full body colour.
        var depth: Double?
        /// Non-circular dot, in ball radii and centred on the origin (the leaning "!"'s
        /// teardrop). When present, `r` is not used for drawing.
        var shape: [Point]?
        /// Rotation applied to `shape`, degrees.
        var rot: Double?
    }

    /// What a state declares. Arc geometry stays in ball radii; the engine, the only
    /// one that knows the output scale, rasterises it.
    struct ArcSpec: Equatable, Sendable {
        var id: String
        var seed: ArcSeed
        var t: Double
        var opacity: Double
    }

    struct ArcGradient: Equatable, Sendable {
        var x1: Double
        var y1: Double
        var x2: Double
        var y2: Double
        var stops: [RGB8]
    }

    struct ArcRender: Equatable, Sendable {
        var id: String
        /// Part in front of the body, as separate polylines.
        var front: [[Point]]
        /// Part behind the body (drawn first, so the silhouette hides it).
        var back: [[Point]]
        var width: Double
        var opacity: Double
        /// Hue gradient along the stroke.
        var gradient: ArcGradient
    }

    // MARK: 3D elliptic arc

    struct ArcSeed: Equatable, Sendable {
        /// Semi-major axis, in ball radii.
        var a: Double
        /// Flattening b/a: measured <= 0.45, the orbit planes are seen edge-on.
        var k: Double
        /// Tilt of the major axis on screen, radians.
        var tilt: Double
        /// Turns per second.
        var speed: Double
        var phase: Double
        /// Fraction of the turn actually drawn.
        var sweep: Double
        var hue: Double
        var hueSpan: Double
        var width: Double
        var cx: Double
        var cy: Double
    }

    /// Projects a tilted 3D circle orthographically. The z component splits the arc in
    /// two: the back half is drawn before the body, which hides it. That depth sort is
    /// what makes the rings read as orbits rather than flat drawing.
    static func arcRender(_ seed: ArcSeed, t: Double, scale: Double, id: String, opacity: Double = 1) -> ArcRender {
        let spin = seed.phase + t * seed.speed * tau
        let cu = cos(seed.tilt)
        let su = sin(seed.tilt)
        let kz = max(0, 1 - seed.k * seed.k).squareRoot()

        let n = 64
        let span = seed.sweep * tau
        var front: [[Point]] = []
        var back: [[Point]] = []
        var prev: Bool?

        for i in 0...n {
            let th = spin + (Double(i) / Double(n)) * span
            let ct = cos(th)
            let st = sin(th)
            // u = (cos tilt, sin tilt, 0) ; v = (-sin tilt * k, cos tilt * k, kz)
            let x = seed.a * (ct * cu + st * -su * seed.k) + seed.cx
            let y = seed.a * (ct * su + st * cu * seed.k) + seed.cy
            let z = seed.a * st * kz

            let behind = z < 0
            let p = Point(x: x * scale, y: y * scale)
            let startsRun = behind != prev
            if behind {
                if startsRun { back.append([p]) } else { back[back.count - 1].append(p) }
            } else {
                if startsRun { front.append([p]) } else { front[front.count - 1].append(p) }
            }
            prev = behind
        }

        let gx = cos(seed.tilt) * seed.a * scale
        let gy = sin(seed.tilt) * seed.a * scale
        return ArcRender(
            id: id,
            front: front,
            back: back,
            width: seed.width * scale,
            opacity: opacity,
            gradient: ArcGradient(
                x1: seed.cx * scale - gx,
                y1: seed.cy * scale - gy,
                x2: seed.cx * scale + gx,
                y2: seed.cy * scale + gy,
                stops: [wheel(seed.hue), wheel(seed.hue + seed.hueSpan * 0.5), wheel(seed.hue + seed.hueSpan)]
            )
        )
    }

    // MARK: Rings

    /// 6 rings, semi-major axis 1.30-1.40 (well outside the ball), flattening <= 0.45,
    /// thickness 0.055, about 3.3 turns a second.
    static let rings: [ArcSeed] = {
        var rng = Rng(seed: 0xa11ce)
        return (0..<6).map { i in
            let i = Double(i)
            // one draw per field, in bloub's field order
            let a = 1.3 + rng.next() * 0.1
            let k = 0.05 + rng.next() * 0.4
            let tilt = (i / 6) * .pi + rng.next() * 0.5
            let speed = 3 + rng.next() * 0.7
            let phase = rng.next() * tau
            let sweep = 0.6 + rng.next() * 0.25
            let hue = (i * 360) / 6 + rng.next() * 30
            let hueSpan = 60 + rng.next() * 60
            let width = 0.05 + rng.next() * 0.012
            return ArcSeed(a: a, k: k, tilt: tilt, speed: speed, phase: phase, sweep: sweep,
                           hue: hue, hueSpan: hueSpan, width: width, cx: 0, cy: 0.1)
        }
    }()

    /// Nested arcs that sweep the triangle just before the orbits. Seen almost edge-on
    /// (hence the hairpin look), rmax 1.37.
    static let swoosh: [ArcSeed] = (0..<4).map { i in
        let i = Double(i)
        return ArcSeed(a: 0.78 + i * 0.2, k: 0.05 + i * 0.02, tilt: -0.62 + i * 0.05, speed: 0.3,
                       phase: 0.06 * i, sweep: 0.4, hue: 95 + i * 62, hueSpan: 100, width: 0.05,
                       cx: 0, cy: -0.12)
    }

    // MARK: Three dots

    /// Measured x: -0.557 / -0.013 / +0.532, y = 0.
    static let dotX: [Double] = [-0.557, -0.013, 0.532]
    static let dotR = 0.165
    static let dotPeak = 1.25

    // MARK: Particles

    private struct Particle: Sendable {
        var birth: Double
        var angle: Double
        var rho: Double
    }

    /// 5 particles, a new one every 0.2 s, each living 0.55 s.
    private static let particleSeeds: [Particle] = {
        var rng = Rng(seed: 0xbeef)
        return (0..<5).map { i in
            let birth = Double(i) * 0.2
            let angle = rng.next() * tau
            let rho = 0.58 + rng.next() * 0.18
            return Particle(birth: birth, angle: angle, rho: rho)
        }
    }()

    /// The particles do not fly straight: they spiral towards the centre (radius x0.75
    /// per frame, angle +100 deg/s) while growing, and pass behind the core.
    static func particles(_ t: Double, scale: Double) -> [Dot] {
        var out: [Dot] = []
        for p in particleSeeds {
            let u = t - p.birth
            if u < 0 || u > 0.62 { continue }
            let rho = p.rho * pow(0.75, u * 10)
            let a = p.angle + (u * 100 * .pi) / 180
            out.append(Dot(
                x: cos(a) * rho * scale,
                y: sin(a) * rho * scale,
                r: (0.04 + 0.028 * clamp(u / 0.55)) * scale,
                opacity: clamp(u / 0.06) * clamp((0.62 - u) / 0.08),
                depth: clamp(1 - rho / 0.8)
            ))
        }
        return out
    }

    // MARK: Comet

    /// Against intuition, the dot does not cross the screen: it stays put and the trail
    /// orbits it. Ellipse a = 0.85, b = 0.15, major axis at +34deg, 4 ribbons, ~210 deg/s.
    static let cometRibbons: [ArcSeed] = {
        var rng = Rng(seed: 0xc0e7)
        return (0..<4).map { i in
            let i = Double(i)
            let d = i - 1.5
            let phase = -i * 0.045 + rng.next() * 0.012
            let hue = i * 85 + rng.next() * 20
            return ArcSeed(
                a: 0.85 * (1 + d * 0.03),
                // same flattening within +-5 %: the ribbons form a tight bundle
                k: (0.15 / 0.85) * (1 + d * 0.16),
                tilt: (34 * .pi) / 180 + d * 0.035,
                speed: 210.0 / 360,
                // measured phase shift: 10 to 20 degrees between ribbons
                phase: phase,
                sweep: 0.34,
                hue: hue,
                hueSpan: 80,
                width: 0.095,
                cx: 0,
                cy: 0
            )
        }
    }()

    /// Radius of the comet's dot, measured at 0.129.
    static let cometDot = 0.129

    // MARK: Notification dot

    /// Blue sampled to the pixel.
    static let notifBlue = RGB8(hex: "#2496e8")
    /// The dot sits exactly on the circumference, at -42deg.
    static let notifAngle = -42.0
    static let notifDistance = 1.003
    /// Resting radius; the pop peaks 14 % above.
    static let notifRadius = 0.15
    static let notifPop = 1.14
    /// The notch is a disc concentric with the dot, cut out of the body, with a constant
    /// margin (0.054 R) that follows the body's scale.
    static let notifMargin = 0.054
}
