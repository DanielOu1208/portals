import CoreGraphics
import Testing
@testable import Wash

@Suite struct WashLayoutTests {
    /// The Mac's picture keeps at most 1024 pixels on its long side, as its bitmap did.
    @Test func boundsTheLongSide() {
        let size = WashRenderer.pixelSize(of: CGSize(width: 2056, height: 838), scale: 2, longestSide: 1024)
        #expect(size == CGSize(width: 1024, height: 417))
        let tall = WashRenderer.pixelSize(of: CGSize(width: 400, height: 900), scale: 2, longestSide: 1024)
        #expect(tall == CGSize(width: 455, height: 1024))
    }

    /// In a tall window the bound is on the mesh, not on the page below it: the mesh keeps
    /// at least the pixels its bitmap had before (390 × 855 for a calm wash in a window
    /// of 390 × 1900 points, drawn then at a pixel a point), at any energy.
    @Test func keepsTheMeshsPixelsInATallWindow() {
        let share = 0.45 / 0.65
        let layer = CGSize(width: 390, height: 1900 * 0.65)
        let size = WashRenderer.pixelSize(of: layer, scale: 2, longestSide: 1024, meshShare: share)
        for energy in [0.0, 0.5, 1.0] {
            let mesh = (0.45 + 0.2 * energy) / 0.65
            let old = min(1, 1024 / max(390, 1900 * (0.45 + 0.2 * energy)))
            #expect(size.width >= (390 * old).rounded())
            #expect(size.height * mesh >= (1900 * (0.45 + 0.2 * energy) * old).rounded() - 1)
        }
        // The calm mesh's long side is the 1024 pixels.
        #expect(abs(size.height * share - 1024) <= 1)
    }

    /// A small window, and an iPhone or iPad, get every pixel.
    @Test func keepsEveryPixelBelowTheBound() {
        #expect(WashRenderer.pixelSize(of: CGSize(width: 400, height: 260), scale: 2, longestSide: 1024) == CGSize(width: 800, height: 520))
        #expect(WashRenderer.pixelSize(of: CGSize(width: 440, height: 621), scale: 3, longestSide: nil) == CGSize(width: 1320, height: 1863))
    }

    /// The layer keeps the tallest height; the mesh covers the share the energy gives it.
    @Test func meshCoversItsShareOfTheLayer() {
        #expect(WashRenderer.meshHeight(0.65, tallest: 0.65) == 1)
        #expect(abs(WashRenderer.meshHeight(0.45, tallest: 0.65) - 0.6923) < 0.001)
        #expect(WashRenderer.meshHeight(0.8, tallest: 0.65) == 1)
    }
}

@Suite struct WashCapTests {
    /// An iPhone's picture is bounded at 1024 pixels on the layer's long side as well: on
    /// an iPhone 18 Pro Max (a layer of 440 × 621 points at 3×) 726 × 1024 pixels, about
    /// 3 MB a picture, where its full resolution, 1320 × 1863, took about 10 MB.
    @Test func boundsAnIPhonesPicture() {
        let share = WashRenderer.boundShare(onMac: false, calmShare: 0.45 / 0.65)
        let size = WashRenderer.pixelSize(of: CGSize(width: 440, height: 621), scale: 3, longestSide: 1024, meshShare: share)
        #expect(size == CGSize(width: 726, height: 1024))
        #expect(size.width * size.height * 4 < 3.1 * 1024 * 1024)
        // An iPad, wider than tall.
        let pad = WashRenderer.pixelSize(of: CGSize(width: 1376, height: 671), scale: 2, longestSide: 1024, meshShare: share)
        #expect(pad == CGSize(width: 1024, height: 499))
    }

    /// The Mac keeps its bound on the mesh at its smallest.
    @Test func keepsTheMacsBoundOnTheMesh() {
        #expect(WashRenderer.boundShare(onMac: true, calmShare: 0.7) == 0.7)
        #expect(WashRenderer.boundShare(onMac: false, calmShare: 0.7) == 1)
    }
}
