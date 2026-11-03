import AgentCore
import SwiftUI

extension EnvironmentValues {
    /// Closes a command's answer box in the chat (`CommandAnswerCloser`).
    @Entry var dismissCommandAnswer: CommandAnswerCloser? = nil
}

/// Closes a command's answer box in its thread. One for each thread's whole life
/// (`ThreadController.commandAnswers`), so the chat's rows find the same value in their
/// environment at every streamed word: a closure made in the chat's body was new each
/// time, and every row reading it (a message's bubble, each step of an opened fold, whose
/// Markdown is read again) was drawn again with each piece of a reply.
@MainActor
final class CommandAnswerCloser {
    fileprivate(set) weak var chat: ThreadController?

    func close(_ id: UUID) { chat?.dismissCommand(id) }
}

extension ThreadController {
    /// Ties `answers` to this thread (`commandAnswers`).
    func closesCommandAnswers(with answers: CommandAnswerCloser) { answers.chat = self }
}

/// The slash commands' menu of one chat: what it offers for the text typed, the row a
/// keyboard is on, and whether Escape closed it. Its keys are the `@` menu's
/// (`ComposerMenuLink`): the arrows move through its rows, Return or Tab picks one, Escape
/// closes it (a beta tester, 2026-10-31: "I can't navigate though it using the arrow keys
/// neither use tab/enter to select").
@MainActor
@Observable
final class ComposerCommands {
    /// The row Return or Tab picks, by its name, and the text it was moved to over: the
    /// first row again once the text changes, as the best match is first.
    private var highlightedName: (text: String, name: String)?
    /// Escape closed the menu over this text: it stays closed until the text changes.
    private var dismissed: String?

    /// What the menu offers for `text`: none once Escape has closed it.
    func rows(for text: String, in catalog: CommandCatalog) -> [SlashCommand] {
        text == dismissed ? [] : catalog.suggestions(for: text)
    }

    func highlighted(in rows: [SlashCommand], for text: String) -> Int {
        guard let highlightedName, highlightedName.text == text else { return 0 }
        return rows.firstIndex { $0.name == highlightedName.name } ?? 0
    }

    /// The arrows: the row above or below, no further than the first or the last.
    func move(_ step: Int, in rows: [SlashCommand], for text: String) {
        guard !rows.isEmpty else { return }
        let index = min(max(highlighted(in: rows, for: text) + step, 0), rows.count - 1)
        highlightedName = (text, rows[index].name)
    }

    /// Escape: closed until the text changes.
    func close(over text: String) {
        dismissed = text
    }

    /// The text changed: a menu Escape closed opens again for what is typed next.
    func follow(_ text: String) {
        if let dismissed, dismissed != text { self.dismissed = nil }
    }

    /// What picking `command` writes: its name, then a space, the caret after it, for
    /// whatever follows the command to be typed.
    static func written(_ command: SlashCommand) -> String {
        "/\(command.name) "
    }
}

/// The commands that match what is being typed after a slash, just above the composer,
/// built as the `@` menu is (`MentionMenu`). Choosing one writes its name into the
/// composer, ready for whatever follows it; Send runs it.
struct CommandMenu: View {
    let commands: [SlashCommand]
    /// Which row a keyboard's Return or Tab picks, for `text`: read here, so that an arrow
    /// draws this menu again and not the chat it is over.
    let menu: ComposerCommands
    /// What is typed in the composer.
    let text: String
    var onPick: (SlashCommand) -> Void

    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 52
    /// About four rows, so the chat stays in view above the keyboard.
    private static let visibleRows: CGFloat = 4.4

    /// Where a keyboard's Return picks a row, the row it picks is marked: a Mac, an iPad.
    private var marksHighlighted: Bool {
        Platform.isMac || UIDevice.current.userInterfaceIdiom == .pad
    }

    var body: some View {
        let highlighted = menu.highlighted(in: commands, for: text)
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(commands.enumerated()), id: \.element.id) { index, command in
                        row(command, isHighlighted: marksHighlighted && index == highlighted)
                            .id(command.id)
                    }
                }
                .padding(MentionMenu.inset)
            }
            .scrollIndicators(.hidden)
            .onChange(of: highlighted) { _, index in
                guard commands.indices.contains(index) else { return }
                reader.scrollTo(commands[index].id)
            }
        }
        .frame(height: min(CGFloat(commands.count), Self.visibleRows) * rowHeight + MentionMenu.inset * 2)
        .composerMenuGlass()
        .accessibilityIdentifier("command-menu")
    }

    private func row(_ command: SlashCommand, isHighlighted: Bool) -> some View {
        Button { onPick(command) } label: {
            HStack(spacing: Theme.grid) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 0.75) {
                        Text("/\(command.name)")
                            .font(.app.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .layoutPriority(1)
                        if let usage = command.usage {
                            Text(usage)
                                .font(.app.subheadline)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    Text(command.summary)
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if command.kind == .skill {
                    Text("Skill")
                        .font(.app.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, Theme.grid * 0.75)
                        .padding(.vertical, 2)
                        .background(Color(uiColor: .tertiarySystemFill), in: .capsule)
                }
            }
            .padding(.horizontal, Theme.grid * 2 - MentionMenu.inset)
            .frame(height: rowHeight)
            .background(isHighlighted ? Color(uiColor: .tertiarySystemFill) : .clear)
            .contentShape(.rect)
        }
        .buttonStyle(PressedRowStyle())
        // Its mark, picked by the keyboard or pressed, as round as the menu's corner within it.
        .clipShape(.rect(cornerRadius: ComposerMenuGlass.corner - MentionMenu.inset))
        .accessibilityLabel("/\(command.name), \(command.summary)")
        .accessibilityHint("Writes the command into the message field")
    }
}

/// What the host answered to a slash command: the command on top, marked done, its text
/// below, as the host wrote it. A long answer shows its first lines until asked for the
/// rest.
struct CommandOutputView: View {
    let run: CommandRun
    var onClose: () -> Void

    @RowOpen private var showsAll: Bool
    private static let foldedLines = 14

    /// - Parameter row: where the chat keeps whether all of it shows.
    init(run: CommandRun, row: OpenRows.Row? = nil, onClose: @escaping () -> Void) {
        self.run = run
        self.onClose = onClose
        _showsAll = RowOpen(row, initially: false)
    }

    var body: some View {
        let lines = run.output.split(separator: "\n", omittingEmptySubsequences: false)
        // Folding away a line or two would save nothing.
        let folds = lines.count > Self.foldedLines + 4
        let shown = folds && !showsAll ? lines.prefix(Self.foldedLines).joined(separator: "\n") : run.output
        // Written for a terminal eighty columns wide: smaller than code in a reply, so
        // more of each line shows.
        let font = Font.app.footnote.monospaced()
        VStack(alignment: .leading, spacing: Theme.grid) {
            CopyableBlock(title: run.command, copies: run.output, titleSymbol: CommandDoneLine.symbol, onClose: onClose) {
                if lines.count <= 3 {
                    // A line or two is a sentence, which reads better wrapped.
                    Text(shown)
                        .font(font)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Theme.grid * 1.5)
                } else {
                    // More than that may be laid out in columns, which wrapping would break.
                    SidewaysText(text: shown, font: font)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Answer to \(run.command)")
            if folds {
                Button(showsAll ? "Show less" : "Show all \(lines.count) lines") {
                    showsAll.toggle()
                }
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .padding(.leading, Theme.grid / 2)
            }
        }
        .accessibilityIdentifier("command-output")
    }
}

/// A slash command that did not run, where its answer would have been: the command, and
/// why (the host did not know it, refused it, or could not be asked).
struct CommandFailureRow: View {
    let command: String
    let reason: String
    var onClose: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Image(systemName: "exclamationmark.circle")
                .font(.app.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(command)
                    .font(.app.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(reason)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Theme.grid)
            CommandCloseButton(command: command, action: onClose)
        }
        .copyMenu(reason)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(command) did not run: \(reason)")
        .accessibilityIdentifier("command-failed")
    }
}

struct CommandCloseButton: View {
    let command: String
    var action: () -> Void

    var body: some View {
        Button("Close answer", systemImage: "xmark", action: action)
            .labelStyle(.iconOnly)
            .font(.app.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .contentShape(.rect)
            .padding(.vertical, -6)
            .buttonStyle(.plain)
            .accessibilityLabel("Close answer to \(command)")
            .accessibilityIdentifier("close-command-answer")
    }
}

/// The end of a slash command's turn that showed nothing else (`Turn.isCommandWithoutAnswer`):
/// it ran, where a message would have had an answer.
struct CommandDoneLine: View {
    /// What a command that ran is marked with, here and on an answer's title.
    static let symbol = "checkmark.circle"

    var body: some View {
        CommandResultLine(text: "Done", symbol: Self.symbol)
            .accessibilityLabel("The command ran")
            .accessibilityIdentifier("command-done")
    }
}

/// Where the agent summarised the conversation to free its context: one quiet line,
/// with how full the context was before when the host said. Asked for with `/compact`, it
/// is that command's result, and is marked done.
struct CompactionLine: View {
    let compaction: Compaction

    var body: some View {
        CommandResultLine(text: compaction.summary, symbol: compaction.trigger == .manual ? CommandDoneLine.symbol : "rectangle.compress.vertical")
            .accessibilityIdentifier("compaction")
    }
}

/// One quiet line saying what came of a command, its symbol in the column the status
/// line's spinner had while it ran, so the line reads as that one, finished.
private struct CommandResultLine: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
            Image(systemName: symbol)
                .font(.app.footnote.weight(.medium))
                .frame(width: 20)
            Text(text)
                .font(.app.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}
