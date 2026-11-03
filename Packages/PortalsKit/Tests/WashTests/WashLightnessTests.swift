import SwiftUI
import simd
import Testing
@testable import Wash

/// The light wash a bit lighter (2026-10-19): paler, with less colour,
/// whatever its tint, and the dark wash as it was.
@MainActor
@Suite struct WashLightnessTests {
    private static func colours(_ palette: WashPalette, _ scheme: ColorScheme) -> [SIMD3<Float>] {
        let environment = WashLookTests.environment(scheme)
        return [palette.top, palette.fade, palette.vivid, palette.violet].map { Oklab.from($0.resolve(in: environment)) }
    }

    private static func chroma(_ lab: SIMD3<Float>) -> Float { (lab.y * lab.y + lab.z * lab.z).squareRoot() }

    @Test func theLightWashIsPalerByDefault() {
        #expect(WashPalette.Lightness.standard == .lighter)
        for (tint, name) in WashLookTests.tints {
            let before = Self.colours(WashPalette(.light, tint: tint, lightness: .before), .light)
            var previous = before
            for lightness in [WashPalette.Lightness.lighter, .lightest] {
                let now = Self.colours(WashPalette(.light, tint: tint, lightness: lightness), .light)
                for (old, new) in zip(previous, now) {
                    #expect(new.x > old.x, "\(name) \(lightness): lighter")
                    #expect(Self.chroma(new) <= Self.chroma(old) + 1e-4, "\(name) \(lightness): no more colour")
                }
                previous = now
            }
            #expect(Self.colours(WashPalette(.light, tint: tint), .light) == Self.colours(WashPalette(.light, tint: tint, lightness: .lighter), .light))
        }
    }

    @Test func theDarkWashIsAsItWas() {
        for (tint, _) in WashLookTests.tints {
            let before = WashPalette(.dark, tint: tint, lightness: .before)
            for lightness in WashPalette.Lightness.allCases {
                #expect(WashPalette(.dark, tint: tint, lightness: lightness) == before)
            }
        }
    }

    /// Ink's wash stands out from the page at least as far as the blue does, in each mode
    /// (2026-10-22: in dark mode it was "too transparent", in light it did not
    /// show). In dark mode its greys, a little subtler since 2026-10-23 ("very slightly
    /// more transparent") than the day before (the top 0.42 light, the brighter shade 0.6).
    @Test func theInkWashIsAsPlainAsTheBlue() {
        let dark = Self.colours(WashPalette(.dark, tint: nil), .dark)
        let blue = Self.colours(WashPalette(.dark, tint: .blue), .dark)
        for index in [0, 2] {
            #expect(dark[index].x >= blue[index].x, "dark colour \(index)")
        }
        // Dimmer than on 2026-10-23 (top 0.38, brighter shade 0.55), as asked on 2026-10-26.
        #expect(dark[0].x < 0.38)
        #expect(dark[2].x < 0.55 - 0.02)
        // In light mode, whichever treatment: each colour along the top stands out from
        // the page about as far as the blue's top does (by its colour too, not only its
        // lightness), and none is as dark as the greys of 2026-10-22, which did not look
        // good on a light page.
        let environment = WashLookTests.environment(.light)
        let page = Oklab.from(WashLookTests.background(.light).resolve(in: environment))
        func topRow(_ palette: WashPalette) -> [SIMD3<Float>] {
            WashWaves.ends(palette).prefix(4).map { Oklab.from($0.0.resolve(in: environment)) }
        }
        let blueTop = simd_distance(topRow(WashPalette(.light, tint: .blue))[0], page)
        let greys = topRow(WashPalette(.light, tint: nil, inkLight: .greys))
        for treatment in WashPalette.InkLight.allCases where treatment != .greys {
            for colour in topRow(WashPalette(.light, tint: nil, inkLight: treatment)) {
                #expect(simd_distance(colour, page) >= blueTop * 0.6, "\(treatment)")
                #expect(colour.x > greys[0].x + 0.05, "\(treatment): lighter than the greys")
            }
        }
        #expect(WashPalette.InkLight.standard == .rainbow)
    }

    /// The rainbow is Ink's light wash only: a hue for each of its four columns, and none
    /// for any other look or for the dark wash, whose colours are worked out as before.
    @Test func onlyInksLightWashHasASpectrum() {
        #expect(WashPalette(.light, tint: nil, inkLight: .rainbow).spectrum?.count == 4)
        #expect(WashPalette(.dark, tint: nil, inkLight: .rainbow).spectrum == nil)
        for treatment in WashPalette.InkLight.allCases where treatment != .rainbow {
            #expect(WashPalette(.light, tint: nil, inkLight: treatment).spectrum == nil)
        }
        for (tint, name) in WashLookTests.tints where tint != nil {
            for scheme in [ColorScheme.light, .dark] {
                for treatment in WashPalette.InkLight.allCases {
                    #expect(WashPalette(scheme, tint: tint, inkLight: treatment) == WashPalette(scheme, tint: tint), "\(name)")
                }
            }
        }
    }

    @Test func theBlueBeforeIsTheTunedOne() {
        // Kept as it was tuned, to compare with (`PORTALS_DEBUG_WASH_LIGHT=before`).
        let before = WashPalette(.light, tint: .blue, lightness: .before)
        #expect(before.top == Color(washHex: 0xADD2FF))
        #expect(before.fade == Color(washHex: 0xDDECFF))
    }
}
