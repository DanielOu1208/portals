import SwiftMath

/// LaTeX that models write often and SwiftMath 1.7.3 does not know, said in terms it
/// does. Each rewrite keeps what the formula says, if not always its exact look (a
/// `\boxed` formula loses its box, `\big` delimiters their size, `\underbrace` its brace
/// for a line, `\overset` puts its mark beside rather than above); without them the
/// formula could not be typeset at all and would show as its source.
///
/// Also what keeps SwiftMath from crashing: formulas it cannot be trusted with are
/// turned away, and what it gets wrong in those it reads is put right.
enum SwiftMathDialect {
    /// `latex` in terms SwiftMath reads; nil when it holds a character SwiftMath has no
    /// way to draw, or is not well formed enough for SwiftMath to be trusted with it.
    /// SwiftMath leaves such a character out without saying so, and the formula would
    /// then say something else ("x ≤ 5" set as "x5").
    static func rewritten(_ latex: String) -> String? {
        guard let spelled = spellingOutCharacters(rewritingCommands(latex)).map(raisingPrimes), isWellFormed(spelled) else { return nil }
        return spelled
    }

    // MARK: Commands

    private static func rewritingCommands(_ latex: String) -> String {
        guard latex.contains("\\") else { return latex }
        var output = ""
        var rest = Substring(latex)
        /// The environments begun under another name and not yet ended, innermost last.
        var renamedEnvironments: [(name: Substring, renamed: String?)] = []
        while let slash = rest.firstIndex(of: "\\") {
            output += rest[..<slash]
            rest = rest[slash...]
            let name = rest.dropFirst().prefix { $0.isASCII && $0.isLetter }
            guard !name.isEmpty else {
                // A control symbol (`\\`, `\{`, `\,`): kept with what it escapes, but for
                // the medium space, which SwiftMath spells `\>`, and the room a row break
                // can ask for (`\\[4pt]`), which SwiftMath would set as text.
                let symbol = rest.prefix(2)
                output += symbol == #"\:"# ? #"\>"# : symbol
                rest = rest.dropFirst(2)
                if symbol == #"\\"#, let room = rest.prefixMatch(of: #/\[\s*-?[0-9.]+\s*[a-z]{2}\s*\]/#) {
                    rest = rest[room.range.upperBound...]
                }
                continue
            }
            let after = rest.dropFirst(1 + name.count)
            if name == "begin" || name == "end", let (environment, remainder) = braced(after) {
                if name == "begin", let renamed = renamed(environment, before: remainder) {
                    renamedEnvironments.append((environment, renamed.name))
                    output += renamed.name.map { "\\begin{\($0)}" } ?? ""
                    rest = renamed.dropsColumns ? (braced(remainder)?.1 ?? remainder) : remainder
                    continue
                }
                if name == "end", renamedEnvironments.last?.name == environment {
                    output += renamedEnvironments.removeLast().renamed.map { "\\end{\($0)}" } ?? ""
                    rest = remainder
                    continue
                }
            }
            if let (replacement, remainder) = rewrite(String(name), followedBy: after) {
                output += replacement
                rest = remainder
            } else {
                output += rest.prefix(1 + name.count)
                rest = after
            }
        }
        return output + rest
    }

    /// Commands replaced where they stand; what follows them stays.
    private static let renamed: [String: String] = {
        var renamed = [
            "dfrac": #"\frac"#,
            "tfrac": #"\frac"#,
            "cfrac": #"\frac"#,
            "dbinom": #"\binom"#,
            "tbinom": #"\binom"#,
            "mbox": #"\text"#,
            "emph": #"\textit"#,
            "boldsymbol": #"\mathbf"#,
            "bm": #"\mathbf"#,
            "mathscr": #"\mathcal"#,
            "overrightarrow": #"\vec"#,
            "underbrace": #"\underline"#,
            "overbrace": #"\overline"#,
            "implies": #"\Longrightarrow"#,
            "impliedby": #"\Longleftarrow"#,
            "dots": #"\ldots"#,
            "dotsc": #"\ldots"#,
            "dotsb": #"\cdots"#,
            "varnothing": #"\emptyset"#,
            "lVert": #"\|"#,
            "rVert": #"\|"#,
            "lvert": "|",
            "rvert": "|",
            "leqslant": #"\leq"#,
            "geqslant": #"\geq"#,
            "coloneqq": ":=",
            "bmod": #"\;\mathrm{mod}\;"#,
            "mod": #"\;\mathrm{mod}\;"#,
            "iint": #"\int\!\!\int"#,
            "iiint": #"\int\!\!\int\!\!\int"#,
            // Kept to their argument, as a group.
            "boxed": "",
            "nonumber": "",
            "notag": "",
        ]
        // Delimiter sizes: the delimiter stays, at its natural size.
        for size in ["big", "Big", "bigg", "Bigg"] {
            for suffix in ["", "l", "r", "m"] {
                renamed[size + suffix] = ""
            }
        }
        return renamed
    }()

    /// What an environment SwiftMath does not know by its name becomes: another
    /// environment, or none (its content stands alone). `dropsColumns`: the column
    /// specification after `\begin{array}`, which a matrix does not take, goes too.
    private static func renamed(_ environment: Substring, before body: Substring) -> (name: String?, dropsColumns: Bool)? {
        switch environment {
        case "align", "align*", "aligned", "flalign", "flalign*", "split":
            // SwiftMath's `aligned` has exactly two columns; lines with no `&` to align
            // them at are a `gather`.
            let content = body.range(of: "\\end{\(environment)}").map { body[..<$0.lowerBound] } ?? body
            return (hasAlignmentPoint(content) ? "aligned" : "gather", false)
        case "eqnarray*":
            return ("eqnarray", false)
        case "gather*", "multline", "multline*":
            return ("gather", false)
        case "equation", "equation*", "displaymath":
            return (nil, false)
        case "array":
            return ("matrix", true)
        case "smallmatrix":
            return ("matrix", false)
        default:
            return nil
        }
    }

    /// Whether `content` has an `&` that is not escaped.
    private static func hasAlignmentPoint(_ content: Substring) -> Bool {
        var isEscaped = false
        for character in content {
            if isEscaped {
                isEscaped = false
            } else if character == "\\" {
                isEscaped = true
            } else if character == "&" {
                return true
            }
        }
        return false
    }

    private static func rewrite(_ name: String, followedBy after: Substring) -> (String, Substring)? {
        if let replacement = renamed[name] {
            return (replacement, after)
        }
        // The rest take a braced argument, some after a star.
        let starred = after.first == "*"
        guard let (argument, remainder) = braced(starred ? after.dropFirst() : after) else { return nil }
        switch name {
        case "operatorname":
            return (#"\mathrm{"# + argument + "}", remainder)
        case "overset", "stackrel", "underset":
            // The mark goes beside what it marks, as a script.
            guard let (base, end) = braced(remainder) else { return nil }
            let script = name == "underset" ? "_" : "^"
            return ("{" + rewritingCommands(String(base)) + "}" + script + "{" + rewritingCommands(String(argument)) + "}", end)
        case "xrightarrow", "xleftarrow":
            let arrow = name == "xrightarrow" ? #"\longrightarrow"# : #"\longleftarrow"#
            return ("{" + arrow + "}^{" + rewritingCommands(String(argument)) + "}", remainder)
        case "tag":
            return (#"\qquad "# + (starred ? argument : "(" + argument + ")"), remainder)
        case "pmod":
            return (#"\quad(\mathrm{mod}\ "# + argument + ")", remainder)
        case "hspace":
            return (#"\quad "#, remainder)
        case "label", "phantom", "hphantom", "vphantom":
            return ("", remainder)
        case "color", "textcolor", "colorbox":
            // A formula is drawn in the colour of the text around it, so a colour of its
            // own goes, and what it coloured stays. SwiftMath 1.7.3 also crashes on a
            // `\textcolor` after anything but a letter, and a box would be drawn solid.
            return ("", remainder)
        default:
            return nil
        }
    }

    /// The argument in braces at the start of `text`, after any spaces, and what follows
    /// it; nil when there is none or its braces do not close.
    private static func braced(_ text: Substring) -> (Substring, Substring)? {
        let start = text.drop { $0 == " " }
        guard start.first == "{" else { return nil }
        var depth = 0
        var index = start.startIndex
        while index < start.endIndex {
            switch start[index] {
            case "\\":
                // An escaped brace does not count.
                index = start.index(after: index)
                if index == start.endIndex { return nil }
            case "{":
                depth += 1
            case "}":
                depth -= 1
                if depth == 0 {
                    return (start[start.index(after: start.startIndex)..<index], start[start.index(after: index)...])
                }
            default:
                break
            }
            index = start.index(after: index)
        }
        return nil
    }

    // MARK: Characters

    /// Characters beyond ASCII, as SwiftMath can read them. It reads accented Latin and
    /// Cyrillic letters as they are, and knows many symbols by their command (α as
    /// `\alpha`); a few more are spelled here.
    private static func spellingOutCharacters(_ latex: String) -> String? {
        guard !latex.allSatisfy(\.isASCII) else { return latex }
        var output = ""
        for character in latex {
            if character.isASCII {
                output.append(character)
            } else if character.isWhitespace {
                output.append(" ")
            } else if let spelled = spelled[character] {
                output += spelled
            } else if let command = MTMathAtomFactory.textToLatexSymbolName[String(character)] {
                // In braces, so that a letter after it does not run into its name.
                output += "{\\" + command + "}"
            } else if MTMathAtomFactory.atom(forCharacter: character) != nil {
                output.append(character)
            } else {
                return nil
            }
        }
        return output
    }

    /// Symbols SwiftMath has no command of the same character for, or a better one.
    private static let spelled: [Character: String] = {
        var spelled: [Character: String] = [
            "−": "-",
            "–": "-",
            "·": #"{\cdot}"#,
            "∂": #"{\partial}"#,
            "′": "'",
            "″": "''",
            "‴": "'''",
            "ℕ": #"{\mathbb{N}}"#,
            "ℤ": #"{\mathbb{Z}}"#,
            "ℚ": #"{\mathbb{Q}}"#,
            "ℝ": #"{\mathbb{R}}"#,
            "ℂ": #"{\mathbb{C}}"#,
        ]
        for (digit, superscript) in zip("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹") {
            spelled[superscript] = "^{\(digit)}"
        }
        for (digit, `subscript`) in zip("0123456789", "₀₁₂₃₄₅₆₇₈₉") {
            spelled[`subscript`] = "_{\(digit)}"
        }
        return spelled
    }()

    /// Primes raised as TeX raises them (`f'` as `f^{\prime}`): SwiftMath sets `'` as an
    /// upright quote on the line. In text (`\text{don't}`) it stays an apostrophe.
    private static func raisingPrimes(_ latex: String) -> String {
        guard latex.contains("'") else { return latex }
        var output = ""
        var rest = Substring(latex)
        while let character = rest.popFirst() {
            switch character {
            case "\\":
                let name = rest.prefix { $0.isASCII && $0.isLetter }
                // A control symbol (`\'`) is kept with what it escapes.
                output += "\\" + (name.isEmpty ? rest.prefix(1) : name)
                rest = rest.dropFirst(max(name.count, 1))
                if textCommands.contains(String(name)), let (_, remainder) = braced(rest) {
                    output += rest[..<remainder.startIndex]
                    rest = remainder
                }
            case "'":
                let primes = 1 + rest.prefix { $0 == "'" }.count
                rest = rest.dropFirst(primes - 1)
                output += "^{" + String(repeating: #"\prime"#, count: primes) + "}"
            default:
                output.append(character)
            }
        }
        return output
    }

    /// The commands whose argument SwiftMath sets as text.
    private static let textCommands: Set<String> = ["text", "textrm", "textbf", "textit", "textsf", "texttt"]

    // MARK: Soundness

    /// Whether SwiftMath 1.7.3 can be trusted with `latex`: each command has its
    /// arguments, and each row break (`\\` or `\cr`) stands between the cells of a
    /// table, in an environment or outside one where SwiftMath makes a table of its own,
    /// not in braces, a root's degree, a `\left`…`\right` pair or a command's argument.
    /// SwiftMath takes a missing argument for an empty one, which stops its debug builds
    /// at an assertion (`\overline^2`). It counts a row for a break wherever it is but
    /// starts one only for a break between cells, so a second break after one in the
    /// wrong place reads past its rows and crashes the app (`MTMathListBuilder.buildTable`,
    /// from `\begin{aligned} a^\\ b \\ c \end{aligned}`). LaTeX like that is broken
    /// anyway, so it shows as its source.
    ///
    /// The formula is read as SwiftMath reads it, as far as arguments and breaks go.
    static func isWellFormed(_ latex: String) -> Bool {
        enum Kind {
            /// The top, or an environment: where a row break belongs.
            case cells
            case braces
            /// `\sqrt[…]`, up to the `]`.
            case degree
            /// `\left` up to its `\right`.
            case delimited
        }
        /// `arguments`: how many of the atoms to come are arguments of a command before
        /// them, which SwiftMath reads one atom at a time, a row break included.
        var levels: [(kind: Kind, arguments: Int)] = [(.cells, 0)]
        /// An atom has been read, perhaps as an argument.
        func read() {
            levels[levels.count - 1].arguments = max(levels[levels.count - 1].arguments - 1, 0)
        }
        func awaitArguments(_ count: Int) {
            levels[levels.count - 1].arguments += count
        }
        var awaitsArgument: Bool { levels[levels.count - 1].arguments > 0 }
        var kind: Kind { levels[levels.count - 1].kind }

        var rest = Substring(latex)
        while let character = rest.popFirst() {
            switch character {
            case "{":
                read()
                levels.append((.braces, 0))
            case "}":
                guard kind == .braces, !awaitsArgument else { return false }
                levels.removeLast()
            case "]" where kind == .degree && !awaitsArgument:
                levels.removeLast()
                // The radicand.
                awaitArguments(1)
            case "^", "_":
                guard !awaitsArgument else { return false }
                awaitArguments(1)
            case "&":
                guard !awaitsArgument else { return false }
            case "\\":
                let command = commandName(&rest)
                switch command {
                case #"\"#, "cr":
                    guard kind == .cells, !awaitsArgument else { return false }
                case "begin":
                    read()
                    skipBraced(&rest)
                    levels.append((.cells, 0))
                case "end":
                    guard kind == .cells, levels.count > 1, !awaitsArgument else { return false }
                    skipBraced(&rest)
                    levels.removeLast()
                case "left":
                    read()
                    skipDelimiter(&rest)
                    levels.append((.delimited, 0))
                case "right":
                    guard kind == .delimited, !awaitsArgument else { return false }
                    skipDelimiter(&rest)
                    levels.removeLast()
                case "sqrt":
                    read()
                    if rest.first == "[" {
                        rest.removeFirst()
                        levels.append((.degree, 0))
                    } else {
                        awaitArguments(1)
                    }
                case "frac", "binom":
                    read()
                    awaitArguments(2)
                case "over", "atop", "choose", "brack", "brace":
                    // What follows is the denominator, read on the same level.
                    guard !awaitsArgument else { return false }
                case "limits", "nolimits":
                    break
                default:
                    read()
                    if MTMathAtomFactory.accents[command] != nil || MTMathAtomFactory.fontStyleWithName(command) != nil
                        || command == "overline" || command == "underline" {
                        awaitArguments(1)
                    }
                }
            default:
                // SwiftMath passes over what it has no atom for, spaces among them.
                if MTMathAtomFactory.atom(forCharacter: character) != nil { read() }
            }
        }
        return levels.count == 1 && !awaitsArgument
    }

    // MARK: The formula read

    /// Puts right two things SwiftMath 1.7.3 gets wrong in a formula it has read, each of
    /// which stops its debug builds at an assertion as it is typeset.
    ///
    /// Which of the `+`, `−` and others like them are operators between two operands is
    /// settled as TeX does: not one after nothing, another operator, a relation, an
    /// opening or punctuation, nor one before a relation, a closing, punctuation or
    /// nothing. SwiftMath decides from the atom just before it, a space (`\,`) or a change
    /// of style included, and then spaces it from the atom before those; the two can
    /// disagree (`x = \, -1`). Here spaces and changes of style are passed over both times.
    ///
    /// And the scripts of an `\overline` are finished as SwiftMath finishes every other
    /// atom's, which it leaves out (`\overline{x}^{\frac{1}{2}}`).
    static func settle(_ list: MTMathList?) {
        guard let list else { return }
        let atoms = list.atoms.filter { $0.type != .space && $0.type != .style }
        for (index, atom) in atoms.enumerated() {
            innerLists(of: atom).forEach(settle)
            if atom is MTOverLine {
                atom.superScript = atom.superScript?.finalized
                atom.subScript = atom.subScript?.finalized
            }
            guard atom.type == .binaryOperator else { continue }
            let before = index > 0 ? atoms[index - 1].type : nil
            let after = index + 1 < atoms.count ? atoms[index + 1].type : nil
            if before.map({ [.binaryOperator, .largeOperator, .relation, .open, .punctuation].contains($0) }) ?? true
                || after.map({ [.relation, .close, .punctuation].contains($0) }) ?? true {
                atom.type = .unaryOperator
            }
        }
    }

    /// The lists inside an atom: its scripts, and what it holds. Colours have none, as
    /// they are taken out before.
    private static func innerLists(of atom: MTMathAtom) -> [MTMathList?] {
        var lists = [atom.superScript, atom.subScript]
        switch atom {
        case let fraction as MTFraction:
            lists += [fraction.numerator, fraction.denominator]
        case let radical as MTRadical:
            lists += [radical.radicand, radical.degree]
        case let inner as MTInner:
            lists.append(inner.innerList)
        case let accent as MTAccent:
            lists.append(accent.innerList)
        case let line as MTOverLine:
            lists.append(line.innerList)
        case let line as MTUnderLine:
            lists.append(line.innerList)
        case let table as MTMathTable:
            lists += table.cells.joined().map(Optional.some)
        default:
            break
        }
        return lists
    }

    // MARK: Reading

    /// Takes the name of the command whose backslash was just read off `rest`, as
    /// SwiftMath reads it: one of a few symbols, or letters.
    private static func commandName(_ rest: inout Substring) -> String {
        if let first = rest.first, #"{}$#%_| ,>;!\"#.contains(first) {
            rest.removeFirst()
            return String(first)
        }
        let name = rest.prefix { $0.isLowercase || $0.isUppercase }
        rest.removeFirst(name.count)
        return String(name)
    }

    /// Takes the delimiter after `\left` or `\right` off `rest`.
    private static func skipDelimiter(_ rest: inout Substring) {
        rest = rest.drop(while: isSkippedSpace)
        guard let delimiter = rest.popFirst() else { return }
        if delimiter == "\\" { _ = commandName(&rest) }
    }

    /// Takes the name of an environment, in braces, off `rest`.
    private static func skipBraced(_ rest: inout Substring) {
        let start = rest.drop(while: isSkippedSpace)
        guard start.first == "{", let close = start.firstIndex(of: "}") else { return }
        rest = start[start.index(after: close)...]
    }

    /// What SwiftMath passes over before a delimiter or a name: spaces, and anything
    /// beyond ASCII.
    private static func isSkippedSpace(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { $0.value < 0x21 || $0.value > 0x7E }
    }
}
