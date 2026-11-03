import SwiftUI
import UIKit

/// An agent's rest pose as a still template image, for lists and small labels where a
/// live avatar per row would cost too much.
///
///     Label { Text(agent.displayName) } icon: { AgentAvatarIcon.image(style: look) }
///
/// `.filled` is the avatar itself: the body solid, the eyes cut out. `.outline` strokes the
/// body and fills the eyes, to sit with outline SF Symbols. Both are templates, so they take
/// the foreground style around them.
enum AgentAvatarIcon {
    enum Variant: Sendable {
        case filled
        case outline
    }

    /// A good size beside a line of body text.
    static let defaultPointSize: CGFloat = 25

    static func image(pointSize: CGFloat = defaultPointSize, variant: Variant = .filled, style: AgentAvatarStyle = .standard) -> Image {
        if let ui = uiImage(pointSize: pointSize, variant: variant, style: style) {
            return Image(uiImage: ui).renderingMode(.template)
        }
        return Image(systemName: "bubble.left")
    }

    /// Rendered once per size, variant and style, through `ImageRenderer`.
    static func uiImage(pointSize: CGFloat = defaultPointSize, variant: Variant = .filled, style: AgentAvatarStyle = .standard,
                        scale: CGFloat = 3) -> UIImage?
    {
        let key = CacheKey(pointSize: pointSize, variant: variant, style: style, scale: scale)
        if let hit = cache[key] { return hit }
        let renderer = ImageRenderer(content: AgentAvatarIconGlyph(variant: variant, style: style)
            .frame(width: pointSize, height: pointSize))
        renderer.scale = scale
        renderer.isOpaque = false
        let image = renderer.uiImage?.withRenderingMode(.alwaysTemplate)
        cache[key] = image
        return image
    }

    private struct CacheKey: Hashable {
        var pointSize: CGFloat
        var variant: Variant
        var style: AgentAvatarStyle
        var scale: CGFloat
    }

    private static var cache: [CacheKey: UIImage] = [:]
}

/// The rest pose, framed tight on the body (no room for rings in an icon).
struct AgentAvatarIconGlyph: View {
    var variant: AgentAvatarIcon.Variant
    var style: AgentAvatarStyle

    var body: some View {
        let frame = AgentAvatarDirector.frozen(.idle, at: Bloub.poseTimes[.idle] ?? 1, style: style)
        Canvas { context, size in
            // the body's widest reach, plus a hair for antialiasing
            let reach = frame.body.map { max(abs($0.x), abs($0.y)) }.max() ?? 1
            switch variant {
            case .filled:
                AgentAvatarRenderer.paint(frame, in: context, size: size, extent: reach * 1.02,
                                         ink: .color(.black), ringGap: style.ringGap)
            case .outline:
                let weight = 0.085 // of the icon's side: about SF Symbols' regular stroke at 25 pt
                let extent = reach / (1 - weight)
                var gc = context
                let k = min(size.width, size.height) / (2 * extent)
                gc.translateBy(x: size.width / 2, y: size.height / 2)
                gc.scaleBy(x: k, y: k)
                gc.stroke(AgentAvatarRenderer.bodyPath(frame), with: .color(.black),
                          style: StrokeStyle(lineWidth: weight * 2 * extent, lineJoin: .round))
                var eyes = gc
                eyes.clip(to: AgentAvatarRenderer.bodyPath(frame))
                for eye in frame.eyes {
                    eyes.fill(AgentAvatarRenderer.eyePath(eye), with: .color(.black))
                }
            }
        }
    }
}
