import AgentCore
import MathRendering
import SwiftUI
import UIKit

/// Text with its inline formulas typeset into the lines: as tall as the letters around
/// them, on their baseline and in their colour. A formula that cannot be typeset shows
/// its source in monospaced type.
struct MathText: View {
    let text: AttributedString
    /// The style the text is set in, which the formulas are sized to.
    var style: Font.TextStyle = .body
    /// How long a line of the text can be, when that is known. A formula is one piece
    /// that cannot wrap, and one longer than the line would run past its end and be cut
    /// off there, so it is drawn smaller to fit.
    var lineWidth: CGFloat?

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

    var body: Text {
        guard text.runs.contains(where: { $0.mathFormula != nil }) else { return Text(text) }
        let size = MathSize.inline(for: style, at: dynamicTypeSize)
        var pieces: [Text] = []
        var words = AttributedString()
        for run in text.runs {
            guard let formula = run.mathFormula else {
                words.append(text[run.range])
                continue
            }
            if !words.characters.isEmpty {
                pieces.append(Text(words))
                words = AttributedString()
            }
            pieces.append(Self.formula(formula, size: size, scale: displayScale, lineWidth: lineWidth))
        }
        if !words.characters.isEmpty { pieces.append(Text(words)) }
        return pieces.dropFirst().reduce(pieces[0]) { Text("\($0)\($1)") }
    }

    /// A display formula left in a line (in a table cell) is set inline too: a cell has
    /// no line of its own to give it.
    private static func formula(_ formula: MathFormula, size: CGFloat, scale: CGFloat, lineWidth: CGFloat?) -> Text {
        guard let typeset = MathTypesetter.typeset(formula.latex, size: size, style: .inline, scale: scale) else {
            return Text(formula.source).monospaced()
        }
        // Fitted with room left for a stop or a comma after it, which would otherwise
        // begin the next line.
        let room = lineWidth.map { $0 - size / 2 } ?? .infinity
        let shrink = room > 0 ? max(typeset.size.width / room, 1) : 1
        // A template, so the text's colour fills it.
        let image = Image(typeset.image, scale: typeset.scale * shrink, label: Text(formula.latex)).renderingMode(.template)
        return Text(image).baselineOffset(-typeset.baseline / shrink)
    }
}

/// A display formula on a line of its own: centred, and scrolling sideways when it is
/// wider than the column rather than running past it.
struct DisplayMathView: View {
    let formula: MathFormula

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let size = MathSize.inline(for: .body, at: dynamicTypeSize)
        if let typeset = MathTypesetter.typeset(formula.latex, size: size, style: .display, scale: displayScale) {
            let image = Image(typeset.image, scale: typeset.scale, label: Text(formula.latex))
                .renderingMode(.template)
            ViewThatFits(in: .horizontal) {
                image.frame(maxWidth: .infinity)
                ScrollView(.horizontal) { image }
                    .scrollIndicators(.hidden)
            }
        } else {
            ScrollView(.horizontal) {
                Text(formula.source)
                    .font(.app.callout.monospaced())
                    .fixedSize(horizontal: true, vertical: true)
            }
            .scrollIndicators(.hidden)
        }
    }
}

/// The size formulas are typeset at.
enum MathSize {
    /// For a formula among text in `style` at the reader's text size: Latin Modern at the
    /// size whose letters are as tall as the text's.
    static func inline(for style: Font.TextStyle, at dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        if let size = AppTextStyles.fixedSize(of: style) {
            return MathTypesetter.size(matchingXHeight: UIFont.systemFont(ofSize: size).xHeight)
        }
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
        let font = UIFont.preferredFont(forTextStyle: textStyle(style), compatibleWith: traits)
        return MathTypesetter.size(matchingXHeight: font.xHeight)
    }

    private static func textStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}
