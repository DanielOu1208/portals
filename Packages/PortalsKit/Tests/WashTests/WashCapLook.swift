import Foundation
import SwiftUI
import Testing
@testable import Wash

/// With WASH_CAP_OUT set to a folder: the wash as SwiftUI drew it on an iPhone and iPad
/// before (its MeshGradient at the screen's full resolution) against the GPU wash with its
/// picture bounded at 1024 pixels and scaled up to the screen as the layer is (linear
/// filtering), still and drifting, light and dark, two tints; `report.tsv` and the
/// pictures of each case (`…-before.png`, `…-capped.png`). Off otherwise (it draws
/// pictures of several million pixels).
@MainActor
@Suite struct WashCapLook {
    struct Screen { var name: String; var points: CGSize; var scale: CGFloat }

    @Test func cappedAgainstFullResolution() throws {
        guard let path = ProcessInfo.processInfo.environment["WASH_CAP_OUT"] else { return }
        let renderer = try #require(WashRenderer.shared)
        let out = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let screens = [Screen(name: "iphone", points: CGSize(width: 440, height: 956), scale: 3),
                       Screen(name: "ipad", points: CGSize(width: 1032, height: 1376), scale: 2)]
        var report = "case\tcapped\tfull\tmean_abs\tmax_abs\tmean_dE\tp99_dE\tmax_dE\tblock8\n"
        for screen in screens {
            for (tint, tintName) in [(Color.blue, "blue"), (Color.orange, "orange")] {
                for scheme in [ColorScheme.light, .dark] {
                    for (presence, energy, time) in [(0.0, 0.0, 0.0), (1.0, 0.5, 7.3), (1.0, 0.5, 123.4), (1.0, 1.0, 4567.8)] {
                        let name = "\(screen.name)-\(tintName)-\(scheme == .dark ? "dark" : "light")-p\(presence)-e\(energy)-t\(time)"
                        // The mesh's part of the screen at full resolution, as SwiftUI drew it.
                        let share = 0.45 + 0.2 * energy
                        let width = Int(screen.points.width * screen.scale)
                        let height = Int((screen.points.height * share * screen.scale).rounded())
                        let frame = WashFrame(at: time, palette: WashPalette(scheme, tint: tint), presence: presence, energy: energy)
                        let before = try #require(WashLookTests.swiftUI(frame, scheme: scheme, width: width, height: height))
                        // The layer's picture, bounded as the app bounds it, then the mesh's part
                        // of it scaled up to the screen.
                        let layer = CGSize(width: screen.points.width, height: screen.points.height * 0.65)
                        let picture = WashRenderer.pixelSize(of: layer, scale: screen.scale, longestSide: 1024,
                                                             meshShare: WashRenderer.boundShare(onMac: false, calmShare: 0.45 / 0.65))
                        let pw = Int(picture.width), ph = Int(picture.height)
                        let meshHeight = Float(share / 0.65)
                        let scene = WashScene(palette: WashPalette(scheme, tint: tint), background: WashLookTests.background(scheme),
                                              in: WashLookTests.environment(scheme))
                        let small = try #require(WashLookTests.metal(scene.input(at: time, presence: presence, energy: energy, meshHeight: meshHeight),
                                                                     width: pw, height: ph, renderer: renderer, dither: true))
                        let full = Self.scaled(small, width: pw, height: ph, to: width, layerHeight: Int((layer.height * screen.scale).rounded()), rows: height)
                        let difference = Difference(before, full, width: width)
                        report += "\(name)\t\(pw)x\(ph)\t\(width)x\(height)\t\(difference.line)\n"
                        if presence == 0 || time == 123.4 {
                            try WashLookTests.write(before, width: width, height: height, to: out.appendingPathComponent("\(name)-before.png"))
                            try WashLookTests.write(full, width: width, height: height, to: out.appendingPathComponent("\(name)-capped.png"))
                        }
                    }
                }
            }
        }
        try report.write(to: out.appendingPathComponent("report.tsv"), atomically: true, encoding: .utf8)
    }

    /// The top `rows` rows of the picture scaled to `width` × `layerHeight` with linear
    /// filtering, pixel centres to pixel centres, edges clamped: what the layer shows.
    static func scaled(_ rgba: [UInt8], width: Int, height: Int, to outWidth: Int, layerHeight: Int, rows: Int) -> [UInt8] {
        var out = [UInt8](repeating: 255, count: outWidth * rows * 4)
        let sx = Double(width) / Double(outWidth), sy = Double(height) / Double(layerHeight)
        for y in 0..<rows {
            let fy = min(max((Double(y) + 0.5) * sy - 0.5, 0), Double(height - 1))
            let y0 = Int(fy), y1 = min(y0 + 1, height - 1), ty = fy - Double(y0)
            for x in 0..<outWidth {
                let fx = min(max((Double(x) + 0.5) * sx - 0.5, 0), Double(width - 1))
                let x0 = Int(fx), x1 = min(x0 + 1, width - 1), tx = fx - Double(x0)
                for k in 0..<3 {
                    let a = Double(rgba[(y0 * width + x0) * 4 + k]), b = Double(rgba[(y0 * width + x1) * 4 + k])
                    let c = Double(rgba[(y1 * width + x0) * 4 + k]), d = Double(rgba[(y1 * width + x1) * 4 + k])
                    let v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
                    out[(y * outWidth + x) * 4 + k] = UInt8(max(0, min(255, v.rounded())))
                }
            }
        }
        return out
    }
}
