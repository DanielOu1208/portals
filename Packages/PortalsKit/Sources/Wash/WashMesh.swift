import SwiftUI

/// The wash's colours. Tune on device here and in design §9.3 together.
public struct WashPalette: Equatable, Sendable {
    public private(set) var top: Color
    public private(set) var fade: Color
    /// A brighter shade the top leans toward when the wash reacts.
    public private(set) var vivid: Color
    /// A shifted accent the top leans toward when the wash reacts.
    public private(set) var violet: Color
    /// A hue for each of the mesh's four columns, left to right, in place of `top`,
    /// `vivid` and `violet`: the waves lean each toward the next. Only Ink's light
    /// `rainbow`; nil for every other wash.
    public private(set) var spectrum: [Color]?

    /// How pale the wash is in light mode: its colours mixed toward white by `paling`,
    /// with the same motion. Dark mode is the same whichever.
    public enum Lightness: String, CaseIterable, Sendable {
        /// As it was until 2026-10-20.
        case before
        /// A bit lighter (2026-10-19): what the app shows.
        case lighter
        /// Lighter still, to compare with.
        case lightest

        /// The share of white each light colour is mixed with.
        public var paling: Double {
            switch self {
            case .before: 0
            case .lighter: 0.3
            case .lightest: 0.5
            }
        }

        /// What the app shows.
        public static let standard = Lightness.lighter
    }

    /// Ink's wash in light mode (Ink is the label colour, black there). Its greys did not
    /// look good on a light page (2026-10-22: "find a better treatment", and an
    /// idea, not a decision: "maybe just a subtle rainbow spectrum idk"). Three to choose
    /// from with `PORTALS_DEBUG_INK_LIGHT=<name>`, and the greys of 2026-10-22.
    public enum InkLight: String, CaseIterable, Sendable {
        /// Mid greys toward black, as of 2026-10-22.
        case greys
        /// A subtle pastel spectrum across the top, rose to sky, its hues drifting into
        /// each other as the waves pass.
        case rainbow
        /// Pearl: silvery, with a faint lilac and aqua sheen in the waves.
        case pearl
        /// A faint cool slate, a grey with a little blue in it.
        case mist

        /// What the app shows.
        public static let standard = InkLight.rainbow
    }

    /// The classic blue keeps its tuned colours; another tint is mixed toward white
    /// (light) or black (dark) in the same proportions, and ink (nil) is greys toward the
    /// label colour. In light mode, all of them are then made as pale as `lightness` says.
    public init(_ colorScheme: ColorScheme, tint: Color? = .blue, lightness: Lightness = .standard, inkLight: InkLight = .standard) {
        self.init(unpaled: colorScheme, tint: tint, inkLight: inkLight)
        guard colorScheme != .dark, lightness.paling > 0 else { return }
        let paling = lightness.paling
        top = top.mix(with: .white, by: paling)
        fade = fade.mix(with: .white, by: paling)
        vivid = vivid.mix(with: .white, by: paling)
        violet = violet.mix(with: .white, by: paling)
        spectrum = spectrum?.map { $0.mix(with: .white, by: paling) }
    }

    private init(unpaled colorScheme: ColorScheme, tint: Color?, inkLight: InkLight) {
        spectrum = nil
        guard let base = tint else {
            // Ink, the label colour (white in dark mode, black in light): greys toward it,
            // as plain to see as a colour's. It was a mid grey mixed toward the page, all
            // but black in dark mode and all but white in light (2026-10-22: "too
            // transparent and not visible enough on dark mode", and in light mode "it
            // doesnt show, so ... the wave should be black/gray").
            // In dark mode a little subtler since 2026-10-23 ("very slightly more
            // transparent"): the top 0.58 to 0.62 of the way to black, the brighter shade
            // 0.4 to 0.45, still as far from the page as the blue's. And dimmer again since
            // 2026-10-26 ("a little too bright for the white colorway ... slightly,
            // slightly more dim"): the brighter shade, which stood well above the blue's,
            // 0.45 to 0.49, the violet 0.56 to 0.585, the top 0.62 to 0.625, the top only a
            // hair as it was already about the blue's.
            if colorScheme == .dark {
                top = Color.white.mix(with: .black, by: 0.625)
                fade = .black
                vivid = Color.white.mix(with: .black, by: 0.49)
                violet = Color.white.mix(with: .indigo, by: 0.28).mix(with: .black, by: 0.585)
                return
            }
            switch inkLight {
            case .greys:
                top = Color.black.mix(with: .white, by: 0.6)
                fade = Color.black.mix(with: .white, by: 0.94)
                vivid = Color.black.mix(with: .white, by: 0.46)
                violet = Color.black.mix(with: .indigo, by: 0.22).mix(with: .white, by: 0.54)
            case .rainbow:
                // Rose, apricot, mint and sky, a tenth of the way to white (then paled
                // as every light wash is): slightly darker and richer since 2026-10-27.
                let hexes: [UInt32] = [0xF7A8C4, 0xF9C99A, 0xA8E3C4, 0xA9C6F5]
                let hues = hexes.map { Color(washHex: $0).mix(with: .white, by: 0.1) }
                spectrum = hues
                top = hues[3]
                vivid = hues[0]
                violet = hues[2]
                fade = Color(washHex: 0xF3F1FA)
            case .pearl:
                top = Color(washHex: 0xC9CED9)
                fade = Color(washHex: 0xF1F2F6)
                vivid = Color(washHex: 0xD8C9E0)
                violet = Color(washHex: 0xC6DBDD)
            case .mist:
                top = Color(washHex: 0xC9D3DF)
                fade = Color(washHex: 0xEEF1F5)
                vivid = Color(washHex: 0xB7C4D4)
                violet = Color(washHex: 0xC8CCE0)
            }
            return
        }
        if tint == .blue, colorScheme == .dark {
            top = Color(washHex: 0x1E416A)
            fade = .black
            vivid = Color(washHex: 0x2A5F9E)
            violet = Color(washHex: 0x2E3A86)
        } else if tint == .blue {
            top = Color(washHex: 0xADD2FF)
            fade = Color(washHex: 0xDDECFF)
            vivid = Color(washHex: 0x86BAFF)
            violet = Color(washHex: 0xB6C0FF)
        } else if colorScheme == .dark {
            top = base.mix(with: .black, by: 0.62)
            fade = .black
            vivid = base.mix(with: .black, by: 0.38)
            violet = base.mix(with: .indigo, by: 0.28).mix(with: .black, by: 0.52)
        } else {
            top = base.mix(with: .white, by: 0.66)
            fade = base.mix(with: .white, by: 0.88)
            vivid = base.mix(with: .white, by: 0.46)
            violet = base.mix(with: .indigo, by: 0.22).mix(with: .white, by: 0.62)
        }
    }
}

/// A 4 × 4 mesh: the blue along the top, a band between blue and the fade, the fade,
/// and the page background along the bottom. In motion, waves run across the two
/// middle rows and their colours lean toward the brighter blue and the periwinkle in
/// turn. With `presence` 0 it's a plain top-down wash.
///
/// Each of the first three rows' colours is a mix of two of the palette's colours, by a
/// share that moves with time: `WashFrame` mixes them as SwiftUI colours, `WashScene`
/// the same mixes, resolved, without SwiftUI.
enum WashWaves {
    /// The 16 points at `time`, row by row from the top, in the unit square (y down).
    static func points(at time: Double, presence: Double, energy: Double) -> [SIMD2<Float>] {
        // Kept small enough that the two middle rows never cross.
        let sway = presence * (0.09 + 0.09 * energy)
        var points: [SIMD2<Float>] = []
        points.reserveCapacity(16)
        for (row, base) in [0.0, 0.26, 0.6, 1.0].enumerated() {
            let amplitude = row == 1 ? sway * 0.8 : row == 2 ? sway : 0
            for (column, x) in columns.enumerated() {
                let isEdge = column == 0 || column == columns.count - 1
                let dx = isEdge || amplitude == 0 ? 0 : sway * 0.6 * wave(time, column, 0.7, Double(row) * 2.3)
                let dy = amplitude * wave(time, column, 1.0, Double(row) * 1.7)
                points.append([Float(x + dx), Float(base + dy)])
            }
        }
        return points
    }

    /// The share of the second colour in each of the first three rows' 12 mixes.
    static func shares(at time: Double, presence: Double, energy: Double) -> [Double] {
        let tint = presence * (0.45 + 0.55 * energy)
        var shares: [Double] = []
        shares.reserveCapacity(12)
        for column in columns.indices { shares.append(tint * pulse(time, column, 0.8, 0)) }
        for column in columns.indices { shares.append(tint * pulse(time, column, 0.9, 2.0)) }
        for column in columns.indices { shares.append(tint * 0.45 * pulse(time, column, 0.6, 4.0)) }
        return shares
    }

    /// The two colours each of the 12 mixes goes between.
    static func ends(_ palette: WashPalette) -> [(Color, Color)] {
        if let spectrum = palette.spectrum, spectrum.count == columns.count {
            // Each column's hue along the top, leaning toward the next one's; the band
            // under it its hue toward the fade, leaning toward the one before's.
            let count = spectrum.count
            var ends: [(Color, Color)] = []
            for column in columns.indices {
                ends.append((spectrum[column], spectrum[(column + 1) % count]))
            }
            for column in columns.indices {
                ends.append((spectrum[column].mix(with: palette.fade, by: 0.45), spectrum[(column + count - 1) % count].mix(with: palette.fade, by: 0.45)))
            }
            for column in columns.indices {
                ends.append((palette.fade, spectrum[column]))
            }
            return ends
        }
        let band = palette.top.mix(with: palette.fade, by: 0.45)
        var ends: [(Color, Color)] = []
        for column in columns.indices {
            ends.append((palette.top, column.isMultiple(of: 2) ? palette.vivid : palette.violet))
        }
        for column in columns.indices {
            ends.append((band, column.isMultiple(of: 2) ? palette.violet : palette.vivid))
        }
        for _ in columns.indices {
            ends.append((palette.fade, palette.top))
        }
        return ends
    }

    private static let columns: [Double] = [0, 1.0 / 3, 2.0 / 3, 1]

    /// A wave travelling across the columns.
    private static func wave(_ time: Double, _ column: Int, _ rate: Double, _ phase: Double) -> Double {
        sin(time * rate + Double(column) * 1.4 + phase)
    }

    /// 0…1, for colour mixing.
    private static func pulse(_ time: Double, _ column: Int, _ rate: Double, _ phase: Double) -> Double {
        (wave(time, column, rate, phase) + 1) / 2
    }
}

/// The wash at one moment as SwiftUI colours: what `MeshGradient` is given.
public struct WashFrame: Sendable {
    /// 16 points, row by row from the top, in the unit square (y down).
    public var points: [SIMD2<Float>]
    /// The first three rows; the page background fills the fourth.
    public var colors: [Color]

    /// The wash at `time` (seconds, already scaled by the mood's rate), with `presence`
    /// (0 still … 1 moving) and `energy` (0 … 1, how strongly it reacts).
    public init(at time: Double, palette: WashPalette, presence: Double, energy: Double) {
        points = WashWaves.points(at: time, presence: presence, energy: energy)
        colors = zip(WashWaves.ends(palette), WashWaves.shares(at: time, presence: presence, energy: energy)).map { ends, share in
            ends.0.mix(with: ends.1, by: share)
        }
    }

    /// The SwiftUI mesh of this frame over `background`.
    public func meshGradient(background: Color) -> MeshGradient {
        MeshGradient(width: 4, height: 4, points: points,
                     colors: colors + Array(repeating: background, count: 4), smoothsColors: true)
    }
}

/// A palette and a background resolved once (for a colour scheme and contrast), from
/// which the wash at any moment is worked out without SwiftUI, on any thread: the same
/// mixes as `WashFrame`'s (SwiftUI's `Color.mix` is a straight line in Oklab between
/// the two colours, here too).
public struct WashScene: Equatable, Sendable {
    /// The two ends of each of the 12 mixes, in Oklab.
    private var ends: [SIMD3<Float>]
    /// The page background, gamma-encoded sRGB.
    private var background: SIMD4<Float>

    public init(palette: WashPalette, background: Color, in environment: EnvironmentValues) {
        var ends: [SIMD3<Float>] = []
        for (from, to) in WashWaves.ends(palette) {
            ends.append(Oklab.from(from.resolve(in: environment)))
            ends.append(Oklab.from(to.resolve(in: environment)))
        }
        self.ends = ends
        let back = background.resolve(in: environment)
        self.background = [back.red, back.green, back.blue, 1]
    }

    /// What the GPU is given for the wash at `time` (scaled by the mood's rate).
    public func input(at time: Double, presence: Double, energy: Double, meshHeight: Float = 1) -> WashRenderer.Input {
        let shares = WashWaves.shares(at: time, presence: presence, energy: energy)
        var colors: [SIMD4<Float>] = []
        colors.reserveCapacity(16)
        for (index, share) in shares.enumerated() {
            let from = ends[index * 2], to = ends[index * 2 + 1]
            colors.append(Oklab.gammaSRGB(from + (to - from) * Float(share)))
        }
        colors += Array(repeating: background, count: 4)
        return WashRenderer.Input(points: WashWaves.points(at: time, presence: presence, energy: energy),
                                  colors: colors, meshHeight: meshHeight)
    }
}

/// Björn Ottosson's Oklab, from and to linear sRGB.
enum Oklab {
    static func from(_ color: Color.Resolved) -> SIMD3<Float> {
        let r = color.linearRed, g = color.linearGreen, b = color.linearBlue
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
    }

    /// Back to sRGB, gamma-encoded (extended past 0…1 as SwiftUI's resolved colours are).
    static func gammaSRGB(_ lab: SIMD3<Float>) -> SIMD4<Float> {
        let l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z
        let m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z
        let s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z
        let (l3, m3, s3) = (l * l * l, m * m * m, s * s * s)
        let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let b = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
        return [encode(r), encode(g), encode(b), 1]
    }

    private static func encode(_ linear: Float) -> Float {
        let magnitude = abs(linear)
        let encoded = magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * pow(magnitude, 1 / 2.4) - 0.055
        return linear < 0 ? -encoded : encoded
    }
}

extension Color {
    /// An sRGB colour from a 24-bit hex literal.
    init(washHex hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
