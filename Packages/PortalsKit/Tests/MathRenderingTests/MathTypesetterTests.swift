import CoreGraphics
import MathRendering
import Testing

@MainActor
@Suite struct MathTypesetterTests {
    @Test func typesetsAFormulaWithItsBaselineInside() throws {
        let formula = try #require(MathTypesetter.typeset("x^2 + y^2 = z^2", size: 17, style: .inline, scale: 2))
        #expect(formula.size.width > 40)
        #expect(formula.size.height > 10)
        #expect(formula.baseline > 0)
        #expect(formula.baseline < formula.size.height / 2)
    }

    @Test func displayStyleIsLargerThanInline() throws {
        let latex = "\\sum_{i=1}^{n} \\frac{1}{i^2}"
        let display = try #require(MathTypesetter.typeset(latex, size: 17, style: .display, scale: 2))
        let inline = try #require(MathTypesetter.typeset(latex, size: 17, style: .inline, scale: 2))
        #expect(display.size.height > inline.size.height)
    }

    @Test func sizeFollowsTheFontSize() throws {
        let small = try #require(MathTypesetter.typeset("a + b", size: 17, style: .inline, scale: 2))
        let large = try #require(MathTypesetter.typeset("a + b", size: 34, style: .inline, scale: 2))
        #expect(large.size.width > small.size.width * 1.8)
    }

    @Test func rulesAreDrawn() throws {
        // A fraction's bar and a root's run across most of the formula, unlike any
        // letter's ink.
        let fraction = try #require(MathTypesetter.typeset(#"\frac{abc}{def}"#, size: 17, style: .display, scale: 2))
        let root = try #require(MathTypesetter.typeset(#"\sqrt{abcdef}"#, size: 17, style: .display, scale: 2))
        let letters = try #require(MathTypesetter.typeset("abcdef", size: 17, style: .display, scale: 2))
        #expect(longestRule(in: fraction) > 0.7)
        #expect(longestRule(in: root) > 0.6)
        #expect(longestRule(in: letters) < 0.3)
    }

    /// The longest run of ink along any one row of the image, as a share of its width.
    private func longestRule(in formula: TypesetFormula) -> Double {
        let image = formula.image
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let longest = pixels.withUnsafeMutableBytes { buffer -> Int in
            guard let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return 0 }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            var longest = 0
            for row in 0..<image.height {
                var run = 0
                for column in 0..<image.width {
                    run = buffer[(row * image.width + column) * 4 + 3] > 128 ? run + 1 : 0
                    longest = max(longest, run)
                }
            }
            return longest
        }
        return Double(longest) / Double(image.width)
    }

    @Test func theImageHasThePixelsOfItsScale() throws {
        let two = try #require(MathTypesetter.typeset("a + b", size: 17, style: .inline, scale: 2))
        let three = try #require(MathTypesetter.typeset("a + b", size: 17, style: .inline, scale: 3))
        #expect(abs(two.size.width - three.size.width) < 1)
        #expect(three.image.width > two.image.width * 14 / 10)
    }

    @Test func whatCannotBeReadIsNil() {
        #expect(MathTypesetter.typeset("\\notacommand{x}", size: 17, style: .inline, scale: 2) == nil)
        #expect(MathTypesetter.typeset("{x", size: 17, style: .display, scale: 2) == nil)
        #expect(MathTypesetter.typeset(String(repeating: "x+", count: 3000) + "x", size: 17, style: .inline, scale: 2) == nil)
    }

    @Test func matchingAnXHeightTypesetsLarger() {
        // The body text's x is about half its size; Latin Modern's is less.
        let size = MathTypesetter.size(matchingXHeight: 17 * 0.52)
        #expect(size > 17)
        #expect(size < 24)
    }

    @Test func charactersItCannotDrawAreNotLeftOut() throws {
        // SwiftMath alone would set "x ≤ 5" as "x5", and Japanese as nothing at all.
        let spelled = try #require(MathTypesetter.typeset("x ≤ 5", size: 17, style: .inline, scale: 2))
        let plain = try #require(MathTypesetter.typeset("x 5", size: 17, style: .inline, scale: 2))
        #expect(spelled.size.width > plain.size.width + 8)
        #expect(MathTypesetter.typeset(#"\text{日本}"#, size: 17, style: .inline, scale: 2) == nil)
        #expect(MathTypesetter.typeset("{}", size: 17, style: .inline, scale: 2) == nil)
    }

    @Test func nothingItIsGivenCrashesIt() {
        // Formulas that crashed SwiftMath 1.7.3, or stopped its debug builds, before they
        // were turned away or put right: these must come back, typeset or not.
        let known = [
            #"\begin{aligned}\text\\\text\mathbb\sqrt'\\\sqrt[\sqrt"#,
            #"\begin{matrix} \color{red}\\ b \\ c \end{matrix}"#,
            #"a + \textcolor{red}{\frac{1}{2}}"#,
            #"x\textcolor{blue}"#,
            #"x = \, -1"#,
            #"\left(\displaystyle -x\right)"#,
            #"a + \, = b"#,
            #"\overline{x}^{\frac{1}{2}}"#,
            #"\overline^\binom&"#,
        ]
        for latex in known {
            _ = MathTypesetter.typeset(latex, size: 17, style: .display, scale: 2)
        }
        // Every beginning and end of some formulas, as a reply cut anywhere would give.
        let formulas = [
            #"\begin{aligned} x &= \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \\ &= \left( \sum_{i=1}^{n} x_i \right)^2 \end{aligned}"#,
            #"\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix} \begin{cases} x & x > 0 \\ -x & \text{otherwise} \end{cases}"#,
            #"\sqrt[3]{\overline{x}} + \hat{\vec{v}} \cdot \mathbb{R}^{n \times m} \color{red}{y} \left\{ a \middle| b \right."#,
        ]
        for formula in formulas {
            for length in 0...formula.count {
                _ = MathTypesetter.typeset(String(formula.prefix(length)), size: 17, style: .display, scale: 2)
                _ = MathTypesetter.typeset(String(formula.suffix(length)), size: 17, style: .inline, scale: 2)
            }
        }
        // And strings of LaTeX's pieces, in an order that is the same each run.
        let pieces = [#"\"#, "{", "}", "^", "_", "&", "x", "1", " ", "[", "]", "(", ")", "|", ".", "'", "-", "+", "=", #"\\"#,
                      #"\cr"#, #"\frac"#, #"\binom"#, #"\sqrt"#, #"\sqrt["#, #"\left"#, #"\right"#, #"\left("#, #"\right)"#,
                      #"\begin{matrix}"#, #"\end{matrix}"#, #"\begin{aligned}"#, #"\end{aligned}"#, #"\begin{cases}"#,
                      #"\end{cases}"#, #"\limits"#, #"\over"#, #"\atop"#, #"\text"#, #"\mathbb"#, #"\hat"#, #"\overline"#,
                      #"\overset"#, #"\color"#, #"\textcolor{blue}"#, #"\colorbox{red}"#, #"\displaystyle"#, #"\,"#, #"\\[2pt]"#,
                      "ℝ", "α", "≤"]
        var seed: UInt64 = 1
        for _ in 0..<5000 {
            var latex = ""
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            for _ in 0..<(Int(seed >> 60) + 1) {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                latex += pieces[Int(seed >> 33) % pieces.count]
            }
            _ = MathTypesetter.typeset(latex, size: 17, style: seed % 2 == 0 ? .display : .inline, scale: 2)
        }
    }

    @Test func aFormulaIsTypesetOnce() throws {
        let first = try #require(MathTypesetter.typeset("e^{i\\pi} + 1 = 0", size: 17, style: .inline, scale: 2))
        let second = try #require(MathTypesetter.typeset("e^{i\\pi} + 1 = 0", size: 17, style: .inline, scale: 2))
        #expect(first.image === second.image)
    }
}
