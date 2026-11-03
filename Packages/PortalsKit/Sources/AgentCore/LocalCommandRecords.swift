import Foundation

extension Turn {
    /// Commands belong only to this device. A host can coalesce the text that streamed
    /// on either side, so put its text boundary back before restoring the command.
    mutating func keepCommandAnswers(from original: Turn) {
        for (offset, command) in original.items.enumerated() {
            guard case .command = command.content, !items.contains(where: { $0.id == command.id }) else { continue }
            var start = 0
            var prefix = ""
            for earlier in original.items[..<offset].reversed() {
                if case let .text(text) = earlier.content {
                    prefix = text + prefix
                } else if let index = anchorIndex(for: earlier) {
                    start = index + 1
                    break
                }
            }
            if prefix.isEmpty {
                items.insert(command, at: start)
            } else if let place = textBoundary(after: prefix, startingAt: start) {
                guard case let .text(text) = items[place.item].content else { continue }
                // Not into a visual, a code block or a paragraph the host finished
                // since: after it, as a live answer is placed (`ThreadState.continueBlock`).
                let end = Self.endOfBlock(in: text, from: place.end)
                let head = String(text[..<end])
                let tail = end == place.end ? String(text[end...]) : String(text[end...].drop(while: \.isWhitespace))
                let first = TurnItem(id: items[place.item].id, .text(head))
                var replacement = [first, command]
                if !tail.isEmpty {
                    let nextID = original.items.dropFirst(offset + 1).first.flatMap { next -> UUID? in
                        if case let .text(words) = next.content, words == tail { return next.id }
                        return nil
                    } ?? UUID()
                    replacement.append(TurnItem(id: nextID, .text(tail)))
                }
                items.replaceSubrange(place.item...place.item, with: replacement)
            } else {
                // A canonical repair can rewrite the words. Keep the command before
                // the next surviving piece of work, or at the end if none remains.
                var next: Int?
                for later in original.items.dropFirst(offset + 1) {
                    if let index = anchorIndex(for: later) {
                        next = index
                        break
                    }
                }
                items.insert(command, at: next ?? items.count)
            }
        }
    }

    /// A host that has lost a whole turn still cannot remove its local command boxes.
    var commandRecords: Turn? {
        let commands = items.filter { if case .command = $0.content { true } else { false } }
        guard let first = commands.first else { return nil }
        return Turn(id: first.id, startedAt: startedAt, endedAt: endedAt ?? startedAt,
                    outcome: .completed, items: commands)
    }

    /// Where an answer that came at `end` of `text` goes: `end` when no block is open there
    /// (at the start, after a blank line or a closed fence), else the end of the block open
    /// there, so that the answer neither breaks a visual or code block nor splits a
    /// sentence. A fence open at `end`, or opened by its line, ends with the line that
    /// closes it; a paragraph with its last line, before a blank line or a line that opens a
    /// fence. The text's end when nothing ends it yet. A fence whose opening marks were not
    /// whole before `end` (the text came in pieces: "``" then "`swift", or ":\n" then
    /// "```swift") opened after the answer: it begins below it, at its line's start, which
    /// is before `end` when its first marks came before the answer.
    static func endOfBlock(in text: String, from end: String.Index) -> String.Index {
        var fence: Markdown.Fence?
        var inParagraph = false
        var reached = false
        // The line before ended a block: a blank line, a fence closed, or none at all.
        var afterBlock = true
        var previousEnd = text.startIndex
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let wasOpen = fence != nil
            Markdown.fence(line, &fence)
            let blank = !wasOpen && fence == nil && line.allSatisfy(\.isWhitespace)
            if reached {
                if inParagraph {
                    if blank || (!wasOpen && fence != nil) { return previousEnd }
                } else if fence == nil {
                    return line.endIndex
                }
            } else if line.endIndex >= end {
                // The line `end` is in: a fence open before it, or opened by it, is cut.
                if wasOpen || fence != nil {
                    if fence == nil { return line.endIndex }
                    if !wasOpen {
                        var before: Markdown.Fence?
                        Markdown.fence(text[line.startIndex..<end], &before)
                        // Opened only by what came after `end`. A text that is nothing but
                        // its first marks keeps them, as the fence is no block yet.
                        if before == nil { return line.startIndex > text.startIndex ? line.startIndex : end }
                    }
                } else if blank || (afterBlock && text[line.startIndex..<end].allSatisfy(\.isWhitespace)) {
                    return end
                } else {
                    inParagraph = true
                }
                reached = true
            }
            afterBlock = blank || (wasOpen && fence == nil)
            previousEnd = line.endIndex
        }
        return reached ? text.endIndex : end
    }

    private static func sameAnchor(_ lhs: TurnItem, _ rhs: TurnItem) -> Bool {
        if lhs.id == rhs.id { return true }
        switch (lhs.content, rhs.content) {
        case let (.tool(a), .tool(b)): return a.id == b.id
        case let (.user(a), .user(b)): return a.text == b.text
        case let (.text(a), .text(b)): return a == b
        default: return false
        }
    }

    private func anchorIndex(for item: TurnItem) -> Int? {
        items.firstIndex { $0.id == item.id } ?? items.firstIndex { Self.sameAnchor($0, item) }
    }

    private func textBoundary(after prefix: String, startingAt start: Int) -> (item: Int, end: String.Index)? {
        let expected = Array(prefix.filter { !$0.isWhitespace })
        guard !expected.isEmpty else { return nil }
        var matched = 0
        for index in items.indices.dropFirst(start) {
            switch items[index].content {
            case let .text(text):
                for position in text.indices where !text[position].isWhitespace {
                    guard text[position] == expected[matched] else { return nil }
                    matched += 1
                    if matched == expected.count { return (index, text.index(after: position)) }
                }
            case .command:
                continue
            default:
                return nil
            }
        }
        return nil
    }
}
