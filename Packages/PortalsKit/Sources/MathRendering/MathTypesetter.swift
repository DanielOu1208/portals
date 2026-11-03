import CoreGraphics
import CoreText
import Foundation
import SwiftMath

#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// A formula typeset by SwiftMath into an image: black on clear, so that it can be
/// drawn in whatever colour the text around it has.
public struct TypesetFormula {
    public let image: CGImage
    /// Pixels per point.
    public let scale: CGFloat
    /// How far the baseline is above the image's bottom edge, in points: how far to
    /// lower the image for it to sit on the line of text it is in.
    public let baseline: CGFloat

    /// The image's size in points.
    public var size: CGSize {
        CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
    }
}

/// Typesets LaTeX formulas, in Latin Modern Math (TeX's own look), and keeps what it
/// typeset: a streaming reply is laid out again on every piece of text that arrives,
/// and its formulas should not be typeset again each time.
@MainActor
public enum MathTypesetter {
    public enum Style: Sendable {
        /// A formula on its own line: large operators, limits above and below.
        case display
        /// A formula in a line of text, kept to the line's height where it can be.
        case inline
    }

    /// Formulas longer than this are not typeset: they would make an image too large to
    /// be worth drawing, and are more likely something that only looks like math.
    public static let maximumLength = 4000

    /// The size to typeset at for a formula's letters to be as tall as those of text
    /// whose lower-case x is `xHeight` high, as MathJax matches them. Latin Modern's x is
    /// small for its size, so at the text's own size a formula would look a size smaller.
    public static func size(matchingXHeight xHeight: CGFloat) -> CGFloat {
        (xHeight / latinModernXHeight).rounded()
    }

    /// The height of Latin Modern's x at a size of one point.
    private static let latinModernXHeight: CGFloat = CTFontGetXHeight(MathFont.latinModernFont.ctFont(withSize: 100)) / 100

    /// nil when SwiftMath cannot read the formula (a command it does not know, a brace
    /// left open, a character it has no glyph for), so the caller can show its source
    /// instead. `scale` is the screen's pixels per point.
    public static func typeset(_ latex: String, size: CGFloat, style: Style, scale: CGFloat) -> TypesetFormula? {
        let key = "\(style)|\(size)|\(scale)|\(latex)" as NSString
        if let cached = cache.object(forKey: key) { return cached.formula }
        let formula = latex.count <= maximumLength ? render(latex, size: size, style: style, scale: scale) : nil
        cache.setObject(Entry(formula), forKey: key)
        return formula
    }

    private final class Entry {
        let formula: TypesetFormula?
        init(_ formula: TypesetFormula?) { self.formula = formula }
    }

    /// Failures are kept too, so a formula that cannot be read is not tried again on
    /// every update.
    private static let cache: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.countLimit = 500
        return cache
    }()

    private static func render(_ latex: String, size: CGFloat, style: Style, scale: CGFloat) -> TypesetFormula? {
        guard let readable = SwiftMathDialect.rewritten(latex) else { return nil }

        // SwiftMath typesets only through its label, which is never shown: it lays the
        // formula out, and the formula is drawn here.
        let label = MTMathUILabel(frame: .zero)
        label.displayErrorInline = false
        label.font = MathFont.latinModernFont.mtfont(size: size)
        label.fontSize = size
        label.labelMode = style == .display ? .display : .text
        // The label reads the LaTeX itself, and what it read is put right where it is.
        // Given a list instead, it writes it out as LaTeX first, which takes the room
        // before an aligned `=` and the text style of a matrix's cells out of the list.
        label.latex = readable
        guard label.error == nil, let list = label.mathList else { return nil }
        SwiftMathDialect.settle(list)
        #if canImport(UIKit)
        label.layoutIfNeeded()
        #else
        label.layoutSubtreeIfNeeded()
        #endif
        // A formula of no width (`{}` alone) would be a gap where its source should be.
        guard let display = label.displayList, display.width > 0 else { return nil }

        // Room at the sides for a glyph reaching past its box (the tail of an italic f),
        // and a point above and below for the edges' smoothing: no more, as it would
        // space out the lines of text a formula is in.
        let side = (size * 0.06).rounded(.up)
        let baseline = display.descent + 1
        let pixels = CGSize(
            width: ((display.width + 2 * side) * scale).rounded(.up),
            height: ((display.ascent + display.descent + 2) * scale).rounded(.up)
        )
        guard let context = CGContext(
            data: nil, width: Int(pixels.width), height: Int(pixels.height), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.scaleBy(x: scale, y: scale)
        // The label, having no size, put the baseline where it would centre the formula
        // in no height (and no less than half the font size tall); it moves to `baseline`.
        let laidOut = display.descent - max(display.ascent + display.descent, size / 2) / 2
        context.translateBy(x: side, y: baseline - laidOut)
        // SwiftMath draws its rules (a fraction's bar, a root's) with Bézier paths, which
        // draw in the current UIKit or AppKit context, not the one it is given.
        #if canImport(UIKit)
        UIGraphicsPushContext(context)
        display.draw(context)
        UIGraphicsPopContext()
        #else
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        display.draw(context)
        NSGraphicsContext.restoreGraphicsState()
        #endif
        guard let image = context.makeImage() else { return nil }
        return TypesetFormula(image: image, scale: scale, baseline: baseline)
    }
}
