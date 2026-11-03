import CoreGraphics
import Foundation
import ImageIO
import Metal
import SwiftUI
import Testing
import UniformTypeIdentifiers
@testable import Wash

/// The wash drawn by `WashRenderer` against the same mesh drawn by SwiftUI's
/// `MeshGradient` (what the wash was before, the Mac's through `ImageRenderer`), frame
/// by frame: the colour of every pixel within a difference too small to see.
///
/// Normally 512 × 230; WASH_LOOK_FULL=1 compares the same cases at 1024 × 460.
/// With WASH_LOOK_OUT set to a folder, the larger set of cases is drawn at full
/// resolution, each case's two pictures and a line of numbers (`report.tsv`) written there.
@MainActor
@Suite struct WashLookTests {
    struct Case: CustomStringConvertible {
        var time: Double
        var scheme: ColorScheme
        var tint: Color?
        var tintName: String
        var presence: Double
        var energy: Double

        var description: String {
            "t\(time)-\(scheme == .dark ? "dark" : "light")-\(tintName)-p\(presence)-e\(energy)"
        }
    }

    static let tints: [(Color?, String)] = [(.blue, "blue"), (.orange, "orange"), (.green, "green"), (nil, "ink")]

    /// Every tint, both schemes, still and moving at four moments with WASH_LOOK_OUT set
    /// (168 cases, a few minutes); otherwise a third of the tints and one moment.
    static var cases: [Case] {
        let full = ProcessInfo.processInfo.environment["WASH_LOOK_OUT"] != nil
        var all: [Case] = []
        for (tint, name) in full ? tints : [tints[0], tints[1], tints[3]] {
            for scheme in [ColorScheme.light, .dark] {
                for (presence, energy) in [(0.0, 0.0), (0.5, 0.0), (0.5, 1.0), (1.0, 0.0), (1.0, 0.5), (1.0, 1.0)] {
                    for time in full ? [0.0, 7.3, 123.4, 4567.8] : [123.4] where presence > 0 || time == (full ? 0 : 123.4) {
                        all.append(Case(time: time, scheme: scheme, tint: tint, tintName: name, presence: presence, energy: energy))
                    }
                }
            }
        }
        return all
    }

    static func background(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(washHex: 0x000000) : Color(washHex: 0xF2F2F7)
    }

    @Test func drawsTheMeshAsSwiftUIDoes() throws {
        let renderer = try #require(WashRenderer.shared)
        let out = ProcessInfo.processInfo.environment["WASH_LOOK_OUT"].map { URL(fileURLWithPath: $0) }
        let fullResolution = out != nil || ProcessInfo.processInfo.environment["WASH_LOOK_FULL"] == "1"
        let (width, height) = fullResolution ? (1024, 460) : (512, 230)
        if let out { try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true) }
        var report = "case\tmean_abs\tmax_abs\tmean_dE\tp99_dE\tmax_dE\tblock8\n"
        var worst = Difference.zero
        var worstCase = ""
        for item in Self.cases {
            let frame = WashFrame(at: item.time, palette: WashPalette(item.scheme, tint: item.tint),
                                  presence: item.presence, energy: item.energy)
            let reference = try #require(Self.swiftUI(frame, scheme: item.scheme, width: width, height: height))
            let drawn = try #require(Self.metal(item, width: width, height: height, renderer: renderer, dither: false))
            let difference = Difference(reference, drawn, width: width)
            report += "\(item)\t\(difference.line)\n"
            if difference.block8 > worst.block8 { worstCase = item.description }
            worst = worst.worst(with: difference)
            if let out {
                try Self.write(reference, width: width, height: height, to: out.appendingPathComponent("\(item)-swiftui.png"))
                try Self.write(drawn, width: width, height: height, to: out.appendingPathComponent("\(item)-metal.png"))
            }
        }
        if let out { try report.write(to: out.appendingPathComponent("report.tsv"), atomically: true, encoding: .utf8) }
        // SwiftUI dithers its 8 bits (its own noise is about ±2 steps at most, 0.42 on
        // average against an exact drawing), so single pixels differ by that much; the
        // mean over any 8 × 8 block averages the noise out and shows what is not noise.
        // ΔE 1 is about the smallest difference a trained eye sees side by side.
        #expect(worst.meanAbs < 0.6, "\(worst.line)")
        #expect(worst.maxAbs <= 3, "\(worst.line)")
        #expect(worst.meanDeltaE < 0.6, "\(worst.line)")
        #expect(worst.block8 < 1.0, "\(worst.line) in \(worstCase)")
    }

    @Test func ditherStaysWithinHalfAStep() throws {
        let renderer = try #require(WashRenderer.shared)
        let item = Case(time: 7.3, scheme: .light, tint: .blue, tintName: "blue", presence: 1, energy: 0.5)
        let exact = try #require(Self.metal(item, width: 256, height: 128, renderer: renderer, dither: false))
        let dithered = try #require(Self.metal(item, width: 256, height: 128, renderer: renderer, dither: true))
        let difference = Difference(exact, dithered, width: 256)
        #expect(difference.maxAbs <= 1)
        #expect(difference.meanAbs > 0.05, "no noise was added")
    }

    @Test func fillsBelowTheMeshWithTheBackground() throws {
        let renderer = try #require(WashRenderer.shared)
        let scene = WashScene(palette: WashPalette(.light), background: Self.background(.light), in: Self.environment(.light))
        let input = scene.input(at: 0, presence: 1, energy: 0.5, meshHeight: 0.5)
        let pixels = try #require(Self.metal(input, width: 64, height: 64, renderer: renderer, dither: false))
        // The bottom row is the page: 0xF2F2F7.
        let last = (63 * 64 + 10) * 4
        #expect(Array(pixels[last..<last + 3]) == [0xF2, 0xF2, 0xF7])
        // The top is the wash.
        #expect(Array(pixels[40..<43]) != [0xF2, 0xF2, 0xF7])
    }

    /// The scene's colours, worked out without SwiftUI, are SwiftUI's own mixes.
    @Test func sceneMixesAsSwiftUIDoes() {
        var worst: Float = 0
        for item in Self.cases {
            let env = Self.environment(item.scheme)
            let palette = WashPalette(item.scheme, tint: item.tint)
            let frame = WashFrame(at: item.time, palette: palette, presence: item.presence, energy: item.energy)
            let input = WashScene(palette: palette, background: Self.background(item.scheme), in: env)
                .input(at: item.time, presence: item.presence, energy: item.energy)
            #expect(input.points == frame.points)
            for (color, mine) in zip(frame.colors + Array(repeating: Self.background(item.scheme), count: 4), input.colors) {
                let theirs = color.resolve(in: env)
                let difference = SIMD3<Float>(theirs.red, theirs.green, theirs.blue) - SIMD3<Float>(mine.x, mine.y, mine.z)
                worst = max(worst, abs(difference.x), abs(difference.y), abs(difference.z))
            }
        }
        // A twentieth of a step of 8 bits.
        #expect(worst < 0.05 / 255, "worst \(worst)")
    }

    // MARK: Drawing

    static func environment(_ scheme: ColorScheme) -> EnvironmentValues {
        var env = EnvironmentValues()
        env.colorScheme = scheme
        return env
    }

    /// RGBA, 8 bits, sRGB, rows from the top.
    static func swiftUI(_ frame: WashFrame, scheme: ColorScheme, width: Int, height: Int) -> [UInt8]? {
        let renderer = ImageRenderer(content: frame.meshGradient(background: background(scheme))
            .frame(width: CGFloat(width), height: CGFloat(height))
            .environment(\.colorScheme, scheme))
        renderer.scale = 1
        renderer.colorMode = .nonLinear
        renderer.proposedSize = ProposedViewSize(width: CGFloat(width), height: CGFloat(height))
        guard let image = renderer.cgImage else { return nil }
        return pixels(of: image, width: width, height: height)
    }

    static func metal(_ item: Case, width: Int, height: Int, renderer: WashRenderer, dither: Bool) -> [UInt8]? {
        let scene = WashScene(palette: WashPalette(item.scheme, tint: item.tint), background: background(item.scheme), in: environment(item.scheme))
        return metal(scene.input(at: item.time, presence: item.presence, energy: item.energy),
                     width: width, height: height, renderer: renderer, dither: dither)
    }

    static func metal(_ input: WashRenderer.Input, width: Int, height: Int, renderer: WashRenderer, dither: Bool) -> [UInt8]? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        descriptor.storageMode = .shared
        guard let texture = renderer.device.makeTexture(descriptor: descriptor),
              let buffer = renderer.queue.makeCommandBuffer() else { return nil }
        renderer.encode(input, into: texture, on: buffer, dither: dither)
        buffer.commit()
        buffer.waitUntilCompleted()
        var bgra = [UInt8](repeating: 0, count: width * height * 4)
        texture.getBytes(&bgra, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        var rgba = bgra
        for i in stride(from: 0, to: rgba.count, by: 4) {
            rgba[i] = bgra[i + 2]
            rgba[i + 2] = bgra[i]
        }
        return rgba
    }

    static func pixels(of image: CGImage, width: Int, height: Int) -> [UInt8]? {
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = data.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? data : nil
    }

    static func write(_ rgba: [UInt8], width: Int, height: Int, to url: URL) throws {
        var data = rgba
        let image = data.withUnsafeMutableBytes { bytes -> CGImage? in
            CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
        }
        guard let image, let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
    }
}

/// How far apart two RGBA pictures are: per channel (0–255) and in CIE76 ΔE.
struct Difference {
    var meanAbs = 0.0
    var maxAbs = 0
    var meanDeltaE = 0.0
    var p99DeltaE = 0.0
    var maxDeltaE = 0.0
    /// The largest mean signed difference of a channel over an 8 × 8 block, in steps of 8
    /// bits: what is left once noise is averaged out.
    var block8 = 0.0

    static let zero = Difference()

    private init() {}

    func worst(with other: Difference) -> Difference {
        var worst = self
        worst.meanAbs = max(meanAbs, other.meanAbs)
        worst.maxAbs = max(maxAbs, other.maxAbs)
        worst.meanDeltaE = max(meanDeltaE, other.meanDeltaE)
        worst.p99DeltaE = max(p99DeltaE, other.p99DeltaE)
        worst.maxDeltaE = max(maxDeltaE, other.maxDeltaE)
        worst.block8 = max(block8, other.block8)
        return worst
    }

    init(_ a: [UInt8], _ b: [UInt8], width: Int) {
        precondition(a.count == b.count)
        let height = a.count / 4 / width
        for by in stride(from: 0, to: height - 7, by: 8) {
            for bx in stride(from: 0, to: width - 7, by: 8) {
                for k in 0..<3 {
                    var sum = 0
                    for y in by..<by + 8 {
                        for x in bx..<bx + 8 {
                            let i = (y * width + x) * 4 + k
                            sum += Int(a[i]) - Int(b[i])
                        }
                    }
                    block8 = max(block8, abs(Double(sum) / 64))
                }
            }
        }
        var total = 0, totalE = 0.0
        var deltas: [Double] = []
        deltas.reserveCapacity(a.count / 4)
        for i in stride(from: 0, to: a.count, by: 4) {
            for k in 0..<3 {
                let d = abs(Int(a[i + k]) - Int(b[i + k]))
                total += d
                maxAbs = max(maxAbs, d)
            }
            let e = Self.lab(a[i], a[i + 1], a[i + 2]) - Self.lab(b[i], b[i + 1], b[i + 2])
            let deltaE = (e * e).sum().squareRoot()
            totalE += deltaE
            deltas.append(deltaE)
        }
        let n = Double(a.count / 4)
        meanAbs = Double(total) / (n * 3)
        meanDeltaE = totalE / n
        deltas.sort()
        p99DeltaE = deltas[min(deltas.count - 1, Int(Double(deltas.count) * 0.99))]
        maxDeltaE = deltas.last ?? 0
    }

    var line: String {
        String(format: "%.3f\t%d\t%.3f\t%.3f\t%.3f\t%.3f", meanAbs, maxAbs, meanDeltaE, p99DeltaE, maxDeltaE, block8)
    }

    static func lab(_ r: UInt8, _ g: UInt8, _ b: UInt8) -> SIMD3<Double> {
        func linear(_ v: UInt8) -> Double {
            let c = Double(v) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        let (lr, lg, lb) = (linear(r), linear(g), linear(b))
        let x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047
        let y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
        let z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883
        func f(_ t: Double) -> Double { t > 0.008856 ? cbrt(t) : 7.787 * t + 16.0 / 116 }
        return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
    }
}
