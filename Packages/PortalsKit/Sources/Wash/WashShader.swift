/// The Metal source of `WashRenderer`, compiled when the renderer is made (once per
/// launch; the system keeps compiled shaders between launches).
///
/// The mesh is drawn as SwiftUI draws a `MeshGradient` made from points alone with
/// `smoothsColors` (found by drawing probes with SwiftUI and fitting them):
/// - Each point has Bézier handles along its row and its column: a third of the way to
///   each neighbour, along the bisector of the two directions to them (to the one
///   neighbour at the mesh's edges). A patch's edges are the Béziers through them, and
///   its inside the Coons patch of its four edges.
/// - The colours run along each row and column as cubic Hermite curves in the patch's
///   parameter, in the gamma-encoded sRGB values, with tangents that keep them from
///   overshooting (0 at the mesh's edges and where a channel turns, otherwise the
///   average of the two differences bounded by three times either), and over the inside
///   as the Coons patch of the four edges' curves.
/// The vertex stage places a grid of quads over each patch; the fragment stage works out
/// the colour of each pixel from its patch coordinates. `WashRenderer` works out the
/// handles and tangents.
enum WashShader {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct Uniforms {
        float2 points[16];
        // Each point's handles toward its neighbour before and after it in its row, and
        // above and below it in its column.
        float2 before[16];
        float2 after[16];
        float2 above[16];
        float2 below[16];
        float4 colors[16];
        // Each colour's tangent along its row and along its column.
        float4 alongRow[16];
        float4 alongColumn[16];
        float meshHeight;
        uint subdivisions;
        float dither;
    };

    struct Fragment {
        float4 position [[position]];
        float2 uv;
        uint patch [[flat]];
    };

    static float2 bezier(float2 p0, float2 p1, float2 p2, float2 p3, float t) {
        float s = 1.0 - t;
        return p0 * (s * s * s) + p1 * (3.0 * s * s * t) + p2 * (3.0 * s * t * t) + p3 * (t * t * t);
    }

    static float4 hermite(float4 p0, float4 m0, float4 p1, float4 m1, float t) {
        float t2 = t * t, t3 = t2 * t;
        return p0 * (2.0 * t3 - 3.0 * t2 + 1.0) + m0 * (t3 - 2.0 * t2 + t) + p1 * (3.0 * t2 - 2.0 * t3) + m1 * (t3 - t2);
    }

    template <typename T>
    static T bilinear(T p00, T p10, T p01, T p11, float u, float v) {
        return p00 * ((1.0 - u) * (1.0 - v)) + p10 * (u * (1.0 - v)) + p01 * ((1.0 - u) * v) + p11 * (u * v);
    }

    // Where (u, v) of the patch at (column c, row r) is, in the unit square.
    static float2 position(constant Uniforms &m, int c, int r, float u, float v) {
        int i00 = r * 4 + c, i10 = i00 + 1, i01 = i00 + 4, i11 = i00 + 5;
        float2 top = bezier(m.points[i00], m.after[i00], m.before[i10], m.points[i10], u);
        float2 bottom = bezier(m.points[i01], m.after[i01], m.before[i11], m.points[i11], u);
        float2 left = bezier(m.points[i00], m.below[i00], m.above[i01], m.points[i01], v);
        float2 right = bezier(m.points[i10], m.below[i10], m.above[i11], m.points[i11], v);
        return top * (1.0 - v) + bottom * v + left * (1.0 - u) + right * u
            - bilinear(m.points[i00], m.points[i10], m.points[i01], m.points[i11], u, v);
    }

    // The colour at (u, v) of the patch at (column c, row r).
    static float4 color(constant Uniforms &m, int c, int r, float u, float v) {
        int i00 = r * 4 + c, i10 = i00 + 1, i01 = i00 + 4, i11 = i00 + 5;
        float4 top = hermite(m.colors[i00], m.alongRow[i00], m.colors[i10], m.alongRow[i10], u);
        float4 bottom = hermite(m.colors[i01], m.alongRow[i01], m.colors[i11], m.alongRow[i11], u);
        float4 left = hermite(m.colors[i00], m.alongColumn[i00], m.colors[i01], m.alongColumn[i01], v);
        float4 right = hermite(m.colors[i10], m.alongColumn[i10], m.colors[i11], m.alongColumn[i11], v);
        return top * (1.0 - v) + bottom * v + left * (1.0 - u) + right * u
            - bilinear(m.colors[i00], m.colors[i10], m.colors[i01], m.colors[i11], u, v);
    }

    vertex Fragment washVertex(uint id [[vertex_id]], constant Uniforms &uniforms [[buffer(0)]]) {
        // Two triangles a cell, split along its (0, 0)–(1, 1) diagonal, as SwiftUI splits them.
        const uint2 corner[6] = { uint2(0, 0), uint2(1, 0), uint2(1, 1), uint2(0, 0), uint2(1, 1), uint2(0, 1) };
        uint n = uniforms.subdivisions;
        uint quad = id / 6;
        uint patch = quad / (n * n);
        uint cell = quad % (n * n);
        float2 uv = float2(cell % n + corner[id % 6].x, cell / n + corner[id % 6].y) / float(n);
        float2 point = position(uniforms, int(patch % 3), int(patch / 3), uv.x, uv.y);
        Fragment out;
        out.position = float4(point.x * 2.0 - 1.0, 1.0 - 2.0 * point.y * uniforms.meshHeight, 0.0, 1.0);
        out.uv = uv;
        out.patch = patch;
        return out;
    }

    // Interleaved gradient noise (Jimenez 2014): even, cheap, without a texture.
    static float noise(float2 pixel) {
        return fract(52.9829189 * fract(dot(pixel, float2(0.06711056, 0.00583715))));
    }

    fragment float4 washFragment(Fragment in [[stage_in]], constant Uniforms &uniforms [[buffer(0)]]) {
        float4 c = color(uniforms, int(in.patch % 3), int(in.patch / 3), in.uv.x, in.uv.y);
        c.rgb += (noise(in.position.xy) - 0.5) * (uniforms.dither / 255.0);
        return float4(saturate(c.rgb), 1.0);
    }
    """
}
