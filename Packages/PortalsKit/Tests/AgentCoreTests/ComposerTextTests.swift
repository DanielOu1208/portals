import AgentCore
import Testing

/// A Mac's field takes Return itself and starts a new line; the composer puts the text
/// back as it was to send instead.
struct ComposerTextTests {
    @Test func aLineBreakTypedAnywhereIsFound() {
        #expect(ComposerText.isLineBreakTyped(over: "hello", giving: "hello\n"))
        #expect(ComposerText.isLineBreakTyped(over: "hello", giving: "he\nllo"))
        #expect(ComposerText.isLineBreakTyped(over: "", giving: "\n"))
        // After a line break already there (one made with Shift-Return).
        #expect(ComposerText.isLineBreakTyped(over: "a\nb", giving: "a\n\nb"))
        #expect(ComposerText.isLineBreakTyped(over: "a\n", giving: "a\n\n"))
    }

    @Test func aLineBreakTypedOverASelectionIsFound() {
        #expect(ComposerText.isLineBreakTyped(over: "hello world", giving: "hello \n"))
        #expect(ComposerText.isLineBreakTyped(over: "abc", giving: "a\n"))
        #expect(ComposerText.isLineBreakTyped(over: "hello", giving: "\n"))
        #expect(ComposerText.isLineBreakTyped(over: "one two three", giving: "one \n three"))
    }

    @Test func aTabTypedIsFoundAsWell() {
        // A Mac's field puts in a tab for Tab, which the `@` menu takes to pick a row.
        #expect(ComposerText.isTyped("\t", over: "@ma", giving: "@ma\t"))
        #expect(ComposerText.isTyped("\t", over: "see @ma now", giving: "see @ma\t now"))
        #expect(!ComposerText.isTyped("\t", over: "@ma", giving: "@ma\n"))
        #expect(!ComposerText.isTyped("\t", over: "@ma", giving: "@ma\t\t"))
    }

    @Test func anyOtherChangeIsNot() {
        // A letter, a space, a deletion, no change, a paste ending in a line break.
        #expect(!ComposerText.isLineBreakTyped(over: "hell", giving: "hello"))
        #expect(!ComposerText.isLineBreakTyped(over: "hello", giving: "hello "))
        #expect(!ComposerText.isLineBreakTyped(over: "hello\n", giving: "hello"))
        #expect(!ComposerText.isLineBreakTyped(over: "hello", giving: "hello"))
        #expect(!ComposerText.isLineBreakTyped(over: "hi", giving: "hi there\n"))
        #expect(!ComposerText.isLineBreakTyped(over: "hi", giving: "hi\n\n"))
        // A word autocorrected as the line break went in: more than the break changed.
        #expect(!ComposerText.isLineBreakTyped(over: "teh", giving: "the\n"))
        // Two characters for the selection, one of them the break.
        #expect(!ComposerText.isLineBreakTyped(over: "abc", giving: "ax\n"))
    }
}
