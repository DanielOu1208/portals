import SwiftUI

/// Draws a `Bloub.Frame` (engine scale 1: the resting ball has radius 1) into a
/// `GraphicsContext`. `ink` fills the body, the dots and the notification dot;
/// `ringInk` strokes the rings and ribbons (the primary and secondary label
/// colours, instead of bloub's hue wheel).
///
/// The order is bloub's: the back half of the rings, the particles that pass behind,
/// the body, then the eyes and the notification notch as HOLES (destination-out,
/// clipped to the body, so they show whatever is behind the canvas and clip
/// themselves at the silhouette's edge), then the front dots, the notification dot and
/// the front half of the rings. Without hues, a ring in front of the body would melt
/// into it, so it gets a thin cut around it first.
nonisolated enum AgentAvatarRenderer {
    /// bloub's viewBox: 1.58 ball radii each side of the centre, room for the rings.
    static let viewBoxExtent = Bloub.halfViewBox / Bloub.radius

    static func paint(
        _ frame: Bloub.Frame,
        in context: GraphicsContext,
        size: CGSize,
        extent: Double = viewBoxExtent,
        ink: GraphicsContext.Shading,
        ringInk: GraphicsContext.Shading? = nil,
        ringGap: Double
    ) {
        let ringInk = ringInk ?? ink
        var gc = context
        let k = min(size.width, size.height) / (2 * extent)
        gc.translateBy(x: size.width / 2, y: size.height / 2)
        gc.scaleBy(x: k, y: k)

        let body = bodyPath(frame)

        // back half of the rings, then the particles that pass behind the core
        for arc in frame.arcs {
            stroke(arc.back, in: gc, width: arc.width, opacity: arc.opacity, ink: ringInk)
        }
        if frame.dotsBehind { fillDots(frame.dots, in: gc, ink: ink) }

        // the body, with its holes
        var bodyLayer = gc
        bodyLayer.opacity = frame.bodyAlpha
        bodyLayer.fill(body, with: ink)
        for eye in frame.eyes {
            punch(eyePath(eye), clippedTo: body, in: gc, opacity: eye.alpha)
        }
        if let notch = frame.notch {
            punch(disc(notch), clippedTo: body, in: gc, opacity: 1)
        }

        if !frame.dotsBehind { fillDots(frame.dots, in: gc, ink: ink) }
        if let notif = frame.notif { gc.fill(disc(notif), with: ink) }

        // front half of the rings, each with a cut so it reads over the body
        for arc in frame.arcs {
            if ringGap > 0 {
                var cut = gc
                cut.blendMode = .destinationOut
                stroke(arc.front, in: cut, width: arc.width + 2 * ringGap, opacity: arc.opacity, ink: .color(.black))
            }
            stroke(arc.front, in: gc, width: arc.width, opacity: arc.opacity, ink: ringInk)
        }
    }

    static func bodyPath(_ frame: Bloub.Frame) -> Path {
        var p = Path()
        guard let first = frame.body.first else { return p }
        p.move(to: cg(first))
        for seg in frame.bodyCurve {
            p.addCurve(to: cg(seg.to), control1: cg(seg.control1), control2: cg(seg.control2))
        }
        p.closeSubpath()
        return p
    }

    static func eyePath(_ eye: Bloub.RenderedEye) -> Path {
        let c = eye.capsule
        let t = eye.transform
        let rect = CGRect(x: -c.halfWidth, y: -c.halfHeight, width: c.halfWidth * 2, height: c.halfHeight * 2)
        return Path(roundedRect: rect, cornerRadius: c.cornerRadius, style: .circular)
            .applying(CGAffineTransform(a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty))
    }

    private static func punch(_ path: Path, clippedTo body: Path, in context: GraphicsContext, opacity: Double) {
        var hole = context
        hole.clip(to: body)
        hole.blendMode = .destinationOut
        hole.opacity = opacity
        hole.fill(path, with: .color(.black))
    }

    private static func fillDots(_ dots: [Bloub.Dot], in context: GraphicsContext, ink: GraphicsContext.Shading) {
        for dot in dots {
            var gc = context
            // bloub mixes a dot's colour towards the page by its depth; in one ink that
            // is the same as fading it
            gc.opacity = dot.opacity * (dot.depth ?? 1)
            if let shape = dot.shape {
                var p = Path()
                p.addLines(shape.map(cg))
                p.closeSubpath()
                let place = CGAffineTransform(translationX: dot.x, y: dot.y)
                    .rotated(by: (dot.rot ?? 0) * .pi / 180)
                gc.fill(p.applying(place), with: ink)
            } else {
                gc.fill(disc(Bloub.Disc(x: dot.x, y: dot.y, r: dot.r)), with: ink)
            }
        }
    }

    private static func stroke(_ runs: [[Bloub.Point]], in context: GraphicsContext, width: Double, opacity: Double,
                               ink: GraphicsContext.Shading)
    {
        var p = Path()
        for run in runs where run.count > 1 { p.addLines(run.map(cg)) }
        guard !p.isEmpty else { return }
        var gc = context
        gc.opacity *= opacity
        gc.stroke(p, with: ink, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    private static func disc(_ d: Bloub.Disc) -> Path {
        Path(ellipseIn: CGRect(x: d.x - d.r, y: d.y - d.r, width: d.r * 2, height: d.r * 2))
    }

    private static func cg(_ p: Bloub.Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }
}

/// One frame, drawn in the style's tint, or in the primary label colour (black in light
/// mode, white in dark) when it has none.
struct AgentAvatarCanvas: View {
    var frame: Bloub.Frame
    var style: AgentAvatarStyle
    var extent = AgentAvatarRenderer.viewBoxExtent

    var body: some View {
        Canvas { context, size in
            let ink: GraphicsContext.Shading = style.tint.map { .color($0) } ?? .style(.primary)
            let quietInk: GraphicsContext.Shading = style.tint.map { .color($0.opacity(0.55)) } ?? .style(.secondary)
            AgentAvatarRenderer.paint(frame, in: context, size: size, extent: extent, ink: ink,
                                     ringInk: style.ringTone == .secondary ? quietInk : ink,
                                     ringGap: style.ringGap)
        }
    }
}
