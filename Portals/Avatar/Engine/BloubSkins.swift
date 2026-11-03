// Ported from bloub (https://github.com/jeremy-prt/bloub), MIT License, Copyright (c) 2026 Jérémy Perret
// Source: src/bot/skins.ts. Full licence text: THIRD_PARTY_NOTICES.md at the repo root.

import Foundation

/// The customiser's body shapes and colours.
///
/// Unlike the animation silhouettes (`profiles`), these are NOT measured off the video:
/// they are built analytically from the original customiser's grid. A chosen shape only
/// replaces the body on `baseBody` states (idle, wink, wide, notify, swirl); everywhere
/// else the silhouette IS the animation.
nonisolated extension Bloub {
    /// bloub's ids, kept in French so they match its catalogue one to one.
    enum ShapeID: String, Sendable, CaseIterable, Codable {
        /// circle (the measured body)
        case cercle
        /// pebble: a circle bent by two low harmonics, irregular but smooth
        case galet
        case squircle
        /// lying capsule: the hull of two discs side by side
        case capsule
        case triangle
        /// hexagon, flat top and bottom
        case hexagone
        /// cloud: a union of bumps, wide at the bottom, two lobes on top
        case nuage
        /// droplet: a big disc at the bottom, a tapered point on top
        case goutte

        var shape: BodyShape { shapeByID[self]! }
    }

    /// A body shape from the catalogue. Equality is by value, which stands in for bloub's
    /// reference identity of the radii array.
    struct BodyShape: Equatable, Sendable {
        var id: ShapeID
        var radii: [Double]
    }

    /// Scales the profile so its largest radius is `max`, so every shape weighs the same.
    private static func normalize(_ radii: [Double], _ max: Double = 1) -> [Double] {
        let peak = radii.max() ?? 0
        if peak <= 0 { return radii }
        let k = max / peak
        return radii.map { $0 * k }
    }

    /// bloub writes these angles `(i / N) * Math.PI * 2`, not `(i / N) * TAU`: the two
    /// can differ in the last bit, so the expression is kept as written.
    private static let skinAngles: [Double] = (0..<profileSamples).map {
        (Double($0) / Double(profileSamples)) * .pi * 2
    }

    private static let pebble = normalize(
        skinAngles.map { a in 1 + 0.075 * cos(2 * a + 0.5) + 0.035 * cos(3 * a + 2.1) },
        1.02
    )

    private static let cloud = normalize(
        unionOfCirclesProfile([
            (x: -0.44, y: 0.2, r: 0.54),
            (x: 0.46, y: 0.2, r: 0.5),
            (x: 0.02, y: 0.3, r: 0.6),
            (x: -0.24, y: -0.3, r: 0.48),
            (x: 0.3, y: -0.24, r: 0.44),
        ]),
        1.02
    )

    private static let droplet = normalize(
        profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), cx: 0, cy: 0),
        1.04
    )

    private static let lyingCapsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), cx: 0, cy: 0)

    static let shapes: [BodyShape] = [
        BodyShape(id: .cercle, radii: Array(repeating: 1, count: profileSamples)),
        BodyShape(id: .galet, radii: pebble),
        // 1.15, not 1.02: a superellipse's largest radius is the diagonal, so normalising
        // on it gives a shape that looks smaller than the circle.
        BodyShape(id: .squircle, radii: normalize(superellipseProfile(4.2), 1.15)),
        BodyShape(id: .capsule, radii: lyingCapsule),
        // -90deg: a vertex at the top of the screen (y points down)
        BodyShape(id: .triangle, radii: regularPolygonProfile(sides: 3, radius: 1.12, rc: 0.34, rotationDeg: -90)),
        // 0deg: vertices left and right, so the top and bottom edges are flat
        BodyShape(id: .hexagone, radii: regularPolygonProfile(sides: 6, radius: 1.04, rc: 0.26, rotationDeg: 0)),
        BodyShape(id: .nuage, radii: cloud),
        BodyShape(id: .goutte, radii: droplet),
    ]

    private static let shapeByID: [ShapeID: BodyShape] = Dictionary(uniqueKeysWithValues: shapes.map { ($0.id, $0) })

    static let defaultShape = ShapeID.cercle

    enum ColorID: String, Sendable, CaseIterable, Codable {
        case encre, creme, brun, rouge, orange, ambre, vert, turquoise, bleu, violet, rose, gris
    }

    /// The original customiser's palette. `encre` is the video's black.
    static let colors: [(id: ColorID, hex: String)] = [
        (.encre, "#0a0a0c"),
        (.brun, "#8b5e3c"),
        (.rouge, "#e8483f"),
        (.orange, "#f08a24"),
        (.ambre, "#f0b429"),
        (.vert, "#3ecf8e"),
        (.turquoise, "#2fbfa0"),
        (.bleu, "#3b93f0"),
        (.violet, "#8b5cf6"),
        (.rose, "#e152b0"),
        (.gris, "#a3a3a3"),
        (.creme, "#f1efe9"),
    ]

    static let defaultColor = ColorID.encre

    /// Mixes two hex colours: the particles' depth haze.
    static func mixHex(_ from: String, _ to: String, _ t: Double) -> String {
        let a = RGB8(hex: from)
        let b = RGB8(hex: to)
        func mix(_ x: Int, _ y: Int) -> Int { Int(jsRound(Double(x) + Double(y - x) * t)) }
        return RGB8(r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b)).hex
    }
}
