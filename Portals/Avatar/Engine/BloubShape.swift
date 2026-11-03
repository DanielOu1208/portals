// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/shape.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

nonisolated extension Bloub {
    struct Point: Equatable, Sendable {
        var x: Double
        var y: Double
    }

    /// A silhouette is a radial profile r(theta) plus a pose.
    ///
    /// Every profile is sampled at the SAME angles, so any two shapes have points that
    /// correspond one to one and a morph is a linear interpolation of radii. That is
    /// why there is no path-morphing library.
    struct Silhouette: Equatable, Sendable {
        var radii: [Double]
        /// Rotation of the profile, radians.
        var rot = 0.0
        /// Centre offset, in ball radii.
        var cx = 0.0
        var cy = 0.0
        /// Squash and stretch, applied in screen space (after rotation).
        var sx = 1.0
        var sy = 1.0
    }

    /// One cubic segment of a closed Catmull-Rom outline.
    struct CubicSegment: Equatable, Sendable {
        var control1: Point
        var control2: Point
        var to: Point
    }

    /// The stadium an eye is drawn as, centred on the origin, before its transform.
    struct Capsule: Equatable, Sendable {
        var halfWidth: Double
        var halfHeight: Double
        var cornerRadius: Double

        /// bloub's `capsulePath(w, h)`.
        init(width w: Double, height h: Double) {
            halfWidth = max(w, 0.01) / 2
            halfHeight = max(h, 0.01) / 2
            cornerRadius = min(halfWidth, halfHeight)
        }
    }

    static let profileAngles: [Double] = (0..<profileSamples).map {
        (Double($0) / Double(profileSamples)) * tau
    }
    private static let profileCos = profileAngles.map { cos($0) }
    private static let profileSin = profileAngles.map { sin($0) }

    static func silhouette(_ name: ProfileName, rot: Double = 0, cx: Double = 0, cy: Double = 0) -> Silhouette {
        Silhouette(radii: profile(name), rot: rot, cx: cx, cy: cy)
    }

    /// A perfect circle: the neutral base (dot, bubble, fade target).
    static func circle(_ radius: Double, rot: Double = 0, cx: Double = 0, cy: Double = 0) -> Silhouette {
        Silhouette(radii: Array(repeating: radius, count: profileSamples), rot: rot, cx: cx, cy: cy)
    }

    static func blend(_ a: Silhouette, _ b: Silhouette, _ t: Double) -> Silhouette {
        var radii = [Double](repeating: 0, count: profileSamples)
        for i in 0..<profileSamples {
            radii[i] = lerp(a.radii.bloubElement(at: i) ?? 1, b.radii.bloubElement(at: i) ?? 1, t)
        }
        // Shortest way round: never a full turn from +170deg to -170deg.
        var dRot = b.rot - a.rot
        while dRot > .pi { dRot -= tau }
        while dRot < -.pi { dRot += tau }
        return Silhouette(
            radii: radii,
            rot: a.rot + dRot * t,
            cx: lerp(a.cx, b.cx, t),
            cy: lerp(a.cy, b.cy, t),
            sx: lerp(a.sx, b.sx, t),
            sy: lerp(a.sy, b.sy, t)
        )
    }

    /// Projects the silhouette to screen points. `scale` is the ball radius in output units.
    static func toPoints(_ s: Silhouette, scale: Double) -> [Point] {
        let cr = cos(s.rot)
        let sr = sin(s.rot)
        var out: [Point] = []
        out.reserveCapacity(profileSamples)
        for i in 0..<profileSamples {
            let r = s.radii.bloubElement(at: i) ?? 1
            let x = r * profileCos[i]
            let y = r * profileSin[i]
            // rotation, then squash in screen space, then translation
            let rx = x * cr - y * sr
            let ry = x * sr + y * cr
            out.append(Point(x: (rx * s.sx + s.cx) * scale, y: (ry * s.sy + s.cy) * scale))
        }
        return out
    }

    /// Closed polyline to Catmull-Rom cubics (bloub's `closedPath`, without the string).
    /// With 64 points, centred tangents are smooth to the pixel even at 600 px.
    static func closedCurve(_ pts: [Point], tension: Double = 1.0 / 6) -> [CubicSegment] {
        let n = pts.count
        guard n >= 3 else { return [] }
        var out: [CubicSegment] = []
        out.reserveCapacity(n)
        for i in 0..<n {
            let p0 = pts[(i - 1 + n) % n]
            let p1 = pts[i]
            let p2 = pts[(i + 1) % n]
            let p3 = pts[(i + 2) % n]
            out.append(CubicSegment(
                control1: Point(x: p1.x + (p2.x - p0.x) * tension, y: p1.y + (p2.y - p0.y) * tension),
                control2: Point(x: p2.x - (p3.x - p1.x) * tension, y: p2.y - (p3.y - p1.y) * tension),
                to: p2
            ))
        }
        return out
    }

    /// Any polygon to a radial profile, by ray casting from (cx, cy). Built once, never
    /// in the render loop.
    static func profileFromPolygon(_ poly: [Point], cx: Double, cy: Double) -> [Double] {
        var radii = [Double](repeating: 0, count: profileSamples)
        let n = poly.count
        for k in 0..<profileSamples {
            let dx = profileCos[k]
            let dy = profileSin[k]
            var best = 0.0
            for i in 0..<n {
                let a = poly[i]
                let b = poly[(i + 1) % n]
                let ex = b.x - a.x
                let ey = b.y - a.y
                let den = dx * ey - dy * ex
                if abs(den) < 1e-9 { continue }
                let px = a.x - cx
                let py = a.y - cy
                let t = (px * ey - py * ex) / den // distance along the ray
                let u = (px * dy - py * dx) / den // position on the segment
                if t > best && u >= 0 && u <= 1 { best = t }
            }
            radii[k] = best
        }
        return radii
    }

    /// Convex hull of two circles: the tapered bar of the upright "!".
    static func hullOfCircles(
        _ x1: Double, _ y1: Double, _ r1: Double,
        _ x2: Double, _ y2: Double, _ r2v: Double,
        steps: Int = 96
    ) -> [Point] {
        let dx = x2 - x1
        let dy = y2 - y1
        let h = hypot(dx, dy)
        let dist = h == 0 ? 1e-6 : h
        // angle of the common external tangents
        let base = atan2(dy, dx)
        let spread = acos(max(-1, min(1, (r1 - r2v) / dist)))
        let half = Double(steps / 2)
        var pts: [Point] = []
        // arc of the big circle
        for i in 0...(steps / 2) {
            let a = base + spread + ((tau - 2 * spread) * Double(i)) / half
            pts.append(Point(x: x1 + cos(a) * r1, y: y1 + sin(a) * r1))
        }
        // arc of the small circle
        for i in 0...(steps / 2) {
            let a = base - spread + ((2 * spread) * Double(i)) / half
            pts.append(Point(x: x2 + cos(a) * r2v, y: y2 + sin(a) * r2v))
        }
        return pts
    }

    /// The profile's radius in any direction, interpolated between the two neighbouring
    /// samples. Re-anchors whatever sits "on" the body (eyes, notification dot) when the
    /// silhouette is not a circle.
    static func radiusAtAngle(_ radii: [Double], _ angle: Double) -> Double {
        let n = radii.count
        let t = ((((angle / tau).truncatingRemainder(dividingBy: 1)) + 1).truncatingRemainder(dividingBy: 1)) * Double(n)
        let i = Int(t.rounded(.down))
        return lerp(radii[i % n], radii[(i + 1) % n], t - Double(i))
    }

    /// Superellipse |x/sx|^n + |y/sy|^n = 1. n = 2 is an ellipse, n ~ 4 the squircle.
    static func superellipseProfile(_ n: Double, sx: Double = 1, sy: Double = 1) -> [Double] {
        (0..<profileSamples).map { i in
            let c = pow(abs(profileCos[i] / sx), n)
            let s = pow(abs(profileSin[i] / sy), n)
            return pow(c + s, -1 / n)
        }
    }

    /// Radial profile of a UNION of discs: the farthest ray/circle intersection. Exact
    /// while the origin is inside the union (the cloud's bumps, with no path boolean).
    static func unionOfCirclesProfile(_ circles: [(x: Double, y: Double, r: Double)]) -> [Double] {
        var out = [Double](repeating: 0, count: profileSamples)
        for i in 0..<profileSamples {
            let dx = profileCos[i]
            let dy = profileSin[i]
            var best = 0.0
            for c in circles {
                let b = dx * c.x + dy * c.y
                let disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r)
                if disc < 0 { continue }
                let t = b + disc.squareRoot()
                if t > best { best = t }
            }
            out[i] = best
        }
        return out
    }

    /// Rounded polygon, as a Minkowski sum with a disc: each edge pushed out by `rc`,
    /// each vertex turned into an arc of radius `rc`. Expects a clockwise polygon in
    /// screen space (y down).
    private static func roundedPolygon(_ verts: [Point], rc: Double, arcSteps: Int = 10) -> [Point] {
        let n = verts.count
        var out: [Point] = []
        func normal(_ a: Point, _ b: Point) -> Double {
            let dx = b.x - a.x
            let dy = b.y - a.y
            let h = hypot(dx, dy)
            let len = h == 0 ? 1 : h
            // clockwise + y down: the outward normal is (dy, -dx)
            return atan2(-dx / len, dy / len)
        }
        for i in 0..<n {
            let prev = verts[(i - 1 + n) % n]
            let cur = verts[i]
            let next = verts[(i + 1) % n]
            let a0 = normal(prev, cur)
            let a1 = normal(cur, next)
            var d = a1 - a0
            while d > .pi { d -= tau }
            while d < -.pi { d += tau }
            for k in 0...arcSteps {
                let a = a0 + (d * Double(k)) / Double(arcSteps)
                out.append(Point(x: cur.x + cos(a) * rc, y: cur.y + sin(a) * rc))
            }
        }
        return out
    }

    /// Regular polygon with rounded corners, inscribed in `radius`.
    static func regularPolygonProfile(sides: Int, radius: Double, rc: Double, rotationDeg: Double = 0) -> [Double] {
        let rot = (rotationDeg * .pi) / 180
        let verts = (0..<sides).map { i in
            // clockwise on screen: theta grows with y down
            let a = rot + (Double(i) / Double(sides)) * tau
            return Point(x: cos(a) * (radius - rc), y: sin(a) * (radius - rc))
        }
        return profileFromPolygon(roundedPolygon(verts, rc: rc), cx: 0, cy: 0)
    }
}

nonisolated extension Array {
    /// Optional subscript, for the `radii[i] ?? 1` reads ported from TypeScript.
    func bloubElement(at i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
