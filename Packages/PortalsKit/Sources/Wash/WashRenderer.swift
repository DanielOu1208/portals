import Metal
import SwiftUI
import simd

/// Draws the wash's mesh with the GPU, as SwiftUI's `MeshGradient` draws it
/// (`WashFrame.meshGradient`), into any 8-bit BGRA texture: a `CAMetalLayer`'s drawable
/// in the app, an offscreen texture in the tests. A frame costs the CPU the frame's
/// colours and a few hundred bytes of commands; the GPU fills the pixels.
public final class WashRenderer: @unchecked Sendable {
    /// One for the whole app: the device, its queue and the compiled pipeline. Nil where
    /// there is no Metal device.
    public static let shared: WashRenderer? = WashRenderer()

    public let device: MTLDevice
    public let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState

    /// SwiftUI cuts every patch of a mesh into the same n × n grid of cells, n the
    /// smallest power of two for which the most any edge of any patch bends, in pixels,
    /// over n² is at most this (fitted between 4.39 and 4.75). The colour is worked out
    /// for every pixel; the grid shapes the curved edges and where the colours fall
    /// inside the cells, so the same grid gives the same picture.
    static let bendPerCell = 4.5

    public init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        guard let device, let queue = device.makeCommandQueue() else { return nil }
        do {
            let library = try device.makeLibrary(source: WashShader.source, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.label = "Wash"
            descriptor.vertexFunction = library.makeFunction(name: "washVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "washFragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            return nil
        }
        self.device = device
        self.queue = queue
    }

    /// What the GPU is given for a frame: the mesh's points and its colours, resolved.
    public struct Input: Equatable, Sendable {
        /// 16 points, row by row, in the unit square (y down).
        public var points: [SIMD2<Float>]
        /// 16 colours, gamma-encoded sRGB, premultiplied by nothing (all opaque).
        public var colors: [SIMD4<Float>]
        /// The share of the target's height the mesh covers, from the top; the background
        /// (the colour of the mesh's last row) fills the rest.
        public var meshHeight: Float

        public init(points: [SIMD2<Float>], colors: [SIMD4<Float>], meshHeight: Float = 1) {
            self.points = points
            self.colors = colors
            self.meshHeight = meshHeight
        }
    }

    /// `Uniforms` in the shader, laid out by hand: 5 × 16 `float2`, 3 × 16 `float4`, then
    /// the height, the subdivisions and the dither; and the subdivisions, for drawing a
    /// mesh into `pixels`.
    static func uniforms(_ input: Input, pixels: SIMD2<Float>, dither: Bool) -> (bytes: [UInt8], subdivisions: UInt32) {
        let points = input.points.map { SIMD2<Float>($0.x, $0.y) }
        var before = points, after = points, above = points, below = points
        var alongRow = [SIMD4<Float>](repeating: .zero, count: 16), alongColumn = alongRow
        for line in 0..<4 {
            let row = (0..<4).map { line * 4 + $0 }, column = (0..<4).map { $0 * 4 + line }
            for (index, vertex) in row.enumerated() {
                (before[vertex], after[vertex]) = handles(row.map { points[$0] }, index)
                alongRow[vertex] = tangent(row.map { input.colors[$0] }, index)
            }
            for (index, vertex) in column.enumerated() {
                (above[vertex], below[vertex]) = handles(column.map { points[$0] }, index)
                alongColumn[vertex] = tangent(column.map { input.colors[$0] }, index)
            }
        }
        let subdivisions = subdivisions(points: points, before: before, after: after, above: above, below: below,
                                        pixels: pixels * SIMD2(1, input.meshHeight))
        var bytes: [UInt8] = []
        bytes.reserveCapacity(uniformsSize)
        for array in [points, before, after, above, below] { array.withUnsafeBytes { bytes += $0 } }
        for array in [input.colors, alongRow, alongColumn] { array.withUnsafeBytes { bytes += $0 } }
        withUnsafeBytes(of: input.meshHeight) { bytes += $0 }
        withUnsafeBytes(of: subdivisions) { bytes += $0 }
        withUnsafeBytes(of: Float(dither ? 1 : 0)) { bytes += $0 }
        bytes += [UInt8](repeating: 0, count: uniformsSize - bytes.count)
        return (bytes, subdivisions)
    }

    /// The n of SwiftUI's n × n cells per patch for this mesh drawn over `pixels`.
    static func subdivisions(points: [SIMD2<Float>], before: [SIMD2<Float>], after: [SIMD2<Float>],
                             above: [SIMD2<Float>], below: [SIMD2<Float>], pixels: SIMD2<Float>) -> UInt32 {
        var bend: Float = 0
        func edge(_ p0: SIMD2<Float>, _ p1: SIMD2<Float>, _ p2: SIMD2<Float>, _ p3: SIMD2<Float>) {
            bend = max(bend, simd_length((p0 - 2 * p1 + p2) * pixels), simd_length((p1 - 2 * p2 + p3) * pixels))
        }
        for row in 0..<4 {
            for column in 0..<3 {
                let i = row * 4 + column
                edge(points[i], after[i], before[i + 1], points[i + 1])
            }
        }
        for row in 0..<3 {
            for column in 0..<4 {
                let i = row * 4 + column
                edge(points[i], below[i], above[i + 4], points[i + 4])
            }
        }
        var n: UInt32 = 1
        while Double(bend) / Double(n * n) > bendPerCell, n < 256 { n *= 2 }
        return n
    }

    /// 5 × 16 × 8 + 3 × 16 × 16 + 3 × 4, rounded up to 16.
    static let uniformsSize = 1424

    /// A point's handles toward its neighbours before and after it on a line of the mesh.
    static func handles(_ line: [SIMD2<Float>], _ index: Int) -> (SIMD2<Float>, SIMD2<Float>) {
        let point = line[index]
        if index == 0 { return (point, point + (line[1] - point) / 3) }
        if index == line.count - 1 { return (point + (line[index - 1] - point) / 3, point) }
        let a = point - line[index - 1], b = line[index + 1] - point
        let la = simd_length(a), lb = simd_length(b)
        guard la > 0, lb > 0 else { return (point - a / 3, point + b / 3) }
        let direction = simd_normalize(a / la + b / lb)
        return (point - direction * la / 3, point + direction * lb / 3)
    }

    /// A colour's tangent along a line of the mesh, per channel: 0 at the ends and
    /// where the channel turns, else the mean of the two differences, at most three
    /// times either.
    static func tangent(_ line: [SIMD4<Float>], _ index: Int) -> SIMD4<Float> {
        guard index > 0, index < line.count - 1 else { return .zero }
        let a = line[index] - line[index - 1], b = line[index + 1] - line[index]
        var tangent = SIMD4<Float>.zero
        for k in 0..<4 where a[k] * b[k] > 0 {
            let bound = min(abs(a[k] + b[k]) / 2, 3 * abs(a[k]), 3 * abs(b[k]))
            tangent[k] = a[k] > 0 ? bound : -bound
        }
        return tangent
    }

    /// Encodes the frame into `texture`, cleared first to the background.
    /// `dither` adds up to ± half a step of 8-bit noise, so that the soft gradient does
    /// not band; 0 draws the exact values (for comparing).
    public func encode(_ input: Input, into texture: MTLTexture, on commandBuffer: MTLCommandBuffer, dither: Bool = true) {
        precondition(input.points.count == 16 && input.colors.count == 16)
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        let back = input.colors[12]
        pass.colorAttachments[0].clearColor = MTLClearColor(red: Double(back.x), green: Double(back.y), blue: Double(back.z), alpha: 1)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "Wash"
        let (uniforms, subdivisions) = Self.uniforms(input, pixels: SIMD2(Float(texture.width), Float(texture.height)), dither: dither)
        encoder.setRenderPipelineState(pipeline)
        uniforms.withUnsafeBytes { bytes in
            encoder.setVertexBytes(bytes.baseAddress!, length: bytes.count, index: 0)
            encoder.setFragmentBytes(bytes.baseAddress!, length: bytes.count, index: 0)
        }
        let n = Int(subdivisions)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 9 * n * n * 6)
        encoder.endEncoding()
    }
}

extension WashRenderer {
    /// The size in pixels of the picture for a view of `size` points on a screen of
    /// `scale`: the view's pixels, or fewer when `longestSide` bounds the mesh (the
    /// picture is then scaled up to the view; the wash has no sharp detail). The bound is
    /// on the mesh at its smallest, `meshShare` of the view's height (the rest is the
    /// page): the mesh keeps at least `longestSide` pixels on its long side at any
    /// energy, as the bitmap it had before did, also in a tall window.
    public static func pixelSize(of size: CGSize, scale: CGFloat, longestSide: CGFloat?, meshShare: CGFloat = 1) -> CGSize {
        var width = size.width * scale, height = size.height * scale
        if let longestSide, longestSide > 0 {
            let factor = min(1, longestSide / max(width, height * min(1, max(0, meshShare)), 1))
            width *= factor
            height *= factor
        }
        return CGSize(width: width.rounded(), height: height.rounded())
    }

    /// The share of the layer's height the mesh covers, when the layer is laid out at
    /// `tallest` of the screen and the wash covers `height` of it.
    public static func meshHeight(_ height: CGFloat, tallest: CGFloat) -> Float {
        Float(min(1, max(0, height / tallest)))
    }
}

extension WashRenderer {
    /// The share of the layer's height the 1024-pixel bound is taken on. On the Mac, the
    /// mesh at its smallest (`calmShare`), so that a tall window keeps the pixels the
    /// bitmap it had before gave it; on an iPhone and iPad the whole layer, so that each
    /// of its two pictures stays near 3 MB (about 726 × 1024 pixels on an iPhone, where the
    /// screen's full resolution took about 10 MB).
    public static func boundShare(onMac: Bool, calmShare: CGFloat) -> CGFloat {
        onMac ? calmShare : 1
    }
}
