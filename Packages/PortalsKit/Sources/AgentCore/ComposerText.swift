import Foundation

/// What the composer's field did with a key.
public enum ComposerText {
    /// `new` is `old` with one stretch of it (nothing, where the cursor was, or the
    /// selected text) replaced by a single line break: what Return does in a text field.
    /// False for any other change (a letter, a deletion, more than a line break put in).
    public static func isLineBreakTyped(over old: String, giving new: String) -> Bool {
        isTyped("\n", over: old, giving: new)
    }

    /// `new` is `old` with one stretch of it replaced by `character` alone: that key typed
    /// in a text field (a Mac's field puts in a tab for Tab, which the `@` menu takes).
    public static func isTyped(_ character: Character, over old: String, giving new: String) -> Bool {
        let old = Array(old), new = Array(new)
        // What is the same at the start, then at the end of what is left.
        var start = 0
        while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
        var end = 0
        while end < old.count - start, end < new.count - start,
              old[old.count - 1 - end] == new[new.count - 1 - end] { end += 1 }
        return new.count - start - end == 1 && new[start] == character
    }
}
