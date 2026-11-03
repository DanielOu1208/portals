import Foundation
@testable import MathRendering
import SwiftMath
import Testing

@Suite struct SwiftMathDialectTests {
    @Test func environmentsSwiftMathLacksAreRenamed() {
        #expect(SwiftMathDialect.rewritten(#"\begin{align*} a &= b \\ c &= d \end{align*}"#) == #"\begin{aligned} a &= b \\ c &= d \end{aligned}"#)
        // Lines with nothing to align at are gathered: SwiftMath's aligned has two columns.
        #expect(SwiftMathDialect.rewritten(#"\begin{aligned} a = b \\ c = d \end{aligned}"#) == #"\begin{gather} a = b \\ c = d \end{gather}"#)
        #expect(SwiftMathDialect.rewritten(#"\begin{equation} E = mc^2 \end{equation}"#) == " E = mc^2 ")
        #expect(SwiftMathDialect.rewritten(#"\begin{array}{cc} a & b \end{array}"#) == #"\begin{matrix} a & b \end{matrix}"#)
        // SwiftMath has eqnarray, with its three columns.
        #expect(SwiftMathDialect.rewritten(#"\begin{eqnarray*} a &=& b \end{eqnarray*}"#) == #"\begin{eqnarray} a &=& b \end{eqnarray}"#)
        // An environment inside keeps its name, and ends with it.
        #expect(
            SwiftMathDialect.rewritten(#"\begin{align} A &= \begin{pmatrix} 1 & 0 \end{pmatrix} \end{align}"#)
                == #"\begin{aligned} A &= \begin{pmatrix} 1 & 0 \end{pmatrix} \end{aligned}"#
        )
    }

    @Test func commandsSwiftMathLacksAreSaidInOnesItKnows() {
        #expect(SwiftMathDialect.rewritten(#"\dfrac{1}{2}"#) == #"\frac{1}{2}"#)
        #expect(SwiftMathDialect.rewritten(#"\dbinom{n}{k} + \tbinom{n}{k}"#) == #"\binom{n}{k} + \binom{n}{k}"#)
        #expect(SwiftMathDialect.rewritten(#"\operatorname{sgn}(x)"#) == #"\mathrm{sgn}(x)"#)
        #expect(SwiftMathDialect.rewritten(#"a \overset{\text{def}}{=} b"#) == #"a {=}^{\text{def}} b"#)
        #expect(SwiftMathDialect.rewritten(#"\underset{x}{\arg\min}"#) == #"{\arg\min}_{x}"#)
        #expect(SwiftMathDialect.rewritten(#"A \xrightarrow{\dfrac{1}{2}} B"#) == #"A {\longrightarrow}^{\frac{1}{2}} B"#)
        #expect(SwiftMathDialect.rewritten(#"a \equiv b \mod n"#) == #"a \equiv b \;\mathrm{mod}\; n"#)
        #expect(SwiftMathDialect.rewritten(#"a\:b"#) == #"a\>b"#)
        #expect(SwiftMathDialect.rewritten(#"x = 1 \tag{2}"#) == #"x = 1 \qquad (2)"#)
        #expect(SwiftMathDialect.rewritten(#"\underbrace{1 + \cdots + 1}_{n}"#) == #"\underline{1 + \cdots + 1}_{n}"#)
        // What it knows stays as written.
        #expect(SwiftMathDialect.rewritten(#"\frac{a}{b} \\ \{x\}"#) == #"\frac{a}{b} \\ \{x\}"#)
    }

    @Test func roomAfterARowBreakAndColoursAreLeftOut() {
        // Room after a break, but not a row that begins with a bracket.
        #expect(SwiftMathDialect.rewritten(#"a \\[4pt] b \\ [c]"#) == #"a \\ b \\ [c]"#)
        #expect(SwiftMathDialect.rewritten(#"\color{red}{x} + \textcolor{blue}{\frac{1}{2}}"#) == #"{x} + {\frac{1}{2}}"#)
        #expect(SwiftMathDialect.rewritten(#"\colorbox{yellow}{y}"#) == "{y}")
    }

    @Test func symbolsWrittenAsCharactersAreSpelledAsCommands() {
        #expect(SwiftMathDialect.rewritten("x ≤ 5") == #"x {\leq} 5"#)
        #expect(SwiftMathDialect.rewritten("απ") == #"{\alpha}{\pi}"#)
        #expect(SwiftMathDialect.rewritten("x ∈ ℝ") == #"x {\in} {\mathbb{R}}"#)
        #expect(SwiftMathDialect.rewritten("x² − 1") == "x^{2} - 1")
        // Accented letters SwiftMath reads as they are.
        #expect(SwiftMathDialect.rewritten(#"\text{café}"#) == #"\text{café}"#)
    }

    @Test func primesAreRaisedButApostrophesInTextStay() {
        #expect(SwiftMathDialect.rewritten(#"f'(x) + y'' = x_i'"#) == #"f^{\prime}(x) + y^{\prime\prime} = x_i^{\prime}"#)
        #expect(SwiftMathDialect.rewritten("f″(x)") == #"f^{\prime\prime}(x)"#)
        #expect(SwiftMathDialect.rewritten(#"\text{don't} \textit{it's} g'"#) == #"\text{don't} \textit{it's} g^{\prime}"#)
    }

    @Test func aCharacterSwiftMathWouldLeaveOutMakesTheFormulaUnreadable() {
        #expect(SwiftMathDialect.rewritten(#"\text{日本}"#) == nil)
        #expect(SwiftMathDialect.rewritten("x 🙂 y") == nil)
    }

    @Test func whatSwiftMathCannotBeTrustedWithIsTurnedAway() {
        for latex in [
            // A row break as an argument, in braces or in a root's degree, and another
            // after it: SwiftMath reads past its rows.
            #"\begin{aligned} a^\\ b \\ c \end{aligned}"#,
            #"a \\ \frac\\ b \\ c"#,
            #"\begin{matrix} {a \\ b \\ c \\ d} \end{matrix}"#,
            #"\begin{matrix} \sqrt[a \\ b \\ c \end{matrix}"#,
            #"\left( a \\ b \right)"#,
            // A command without its argument.
            #"\overline^2"#,
            #"x^"#,
            #"\frac{1}"#,
            #"\hat{x}_"#,
            #"a^^b"#,
        ] {
            #expect(SwiftMathDialect.rewritten(latex) == nil, "\(latex)")
        }
        // Breaks between cells, wherever the table is.
        for latex in [
            #"a \\ b \\ c"#,
            #"\begin{pmatrix} 1 & 2 \\ 3 & 4 \\ \end{pmatrix}"#,
            #"\left( \begin{matrix} a \\ b \end{matrix} \right)^{\frac{1}{2}}"#,
            #"\frac{\begin{matrix} a \\ b \end{matrix}}{c} \cr d"#,
            #"\sum\limits_{i=1}^{n} \hat x_i \over 2"#,
        ] {
            #expect(SwiftMathDialect.rewritten(latex) == latex, "\(latex)")
        }
    }

    @Test func anOperatorWithNothingToOperateOnIsASign() throws {
        var error: NSError?
        let list = try #require(MTMathListBuilder.build(fromString: #"x = \, -1 + y - \,"#, error: &error))
        SwiftMathDialect.settle(list)
        // The minus after the equals sign and the space, and the one at the end, are signs.
        let operators = list.atoms.filter { ["\u{2212}", "+"].contains($0.nucleus) }
        #expect(operators.map(\.type) == [.unaryOperator, .binaryOperator, .unaryOperator])
    }

    @Test func theScriptsOfAnOverlineAreFinished() throws {
        var error: NSError?
        let list = try #require(MTMathListBuilder.build(fromString: #"\overline{x}^{\frac{1}{2}}"#, error: &error))
        SwiftMathDialect.settle(list)
        let fraction = try #require(list.atoms.first?.superScript?.atoms.first)
        #expect(fraction.indexRange.length == 1)
    }
}
