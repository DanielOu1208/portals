import Foundation
import SwiftUI
import Testing
@testable import Wash

/// With WASH_MOVIE_OUT set to a folder: six seconds of the drifting wash at 30 frames a
/// second, the same instants drawn by SwiftUI's MeshGradient (`swiftui-NNNN.png`) and by
/// `WashRenderer` (`metal-NNNN.png`), for a side-by-side film (ffmpeg). Off otherwise.
@MainActor
@Suite struct WashMovie {
    @Test func frames() throws {
        guard let path = ProcessInfo.processInfo.environment["WASH_MOVIE_OUT"] else { return }
        let renderer = try #require(WashRenderer.shared)
        let scheme: ColorScheme = ProcessInfo.processInfo.environment["WASH_MOVIE_DARK"] != nil ? .dark : .light
        let out = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let width = 1024, height = 460
        let palette = WashPalette(scheme, tint: .blue)
        let background = WashLookTests.background(scheme)
        let scene = WashScene(palette: palette, background: background, in: WashLookTests.environment(scheme))
        for index in 0..<180 {
            // Working: the wall clock times 2.8, from an arbitrary start; energy 0.5.
            let time = (800_000_000 + Double(index) / 30) * 2.8
            let frame = WashFrame(at: time, palette: palette, presence: 1, energy: 0.5)
            let reference = try #require(WashLookTests.swiftUI(frame, scheme: scheme, width: width, height: height))
            let drawn = try #require(WashLookTests.metal(scene.input(at: time, presence: 1, energy: 0.5),
                                                         width: width, height: height, renderer: renderer, dither: true))
            let name = String(format: "%04d.png", index)
            try WashLookTests.write(reference, width: width, height: height, to: out.appendingPathComponent("swiftui-" + name))
            try WashLookTests.write(drawn, width: width, height: height, to: out.appendingPathComponent("metal-" + name))
        }
    }
}
