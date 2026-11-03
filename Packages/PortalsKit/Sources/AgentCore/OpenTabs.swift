import Foundation

/// The threads open on this device as tabs, in the order their tabs stand, and the one
/// last on screen: every thread opened is a tab until it is closed, a new one once its
/// first message is sent (Synara's way, 2026-10-23. Kept on this device only,
/// and restored with the one on screen after a relaunch. Closing a tab only closes it:
/// its agent goes on with whatever it was doing.
public struct OpenTabs: Codable, Hashable, Sendable {
    /// The tabs, from the first (leading) to the last; each thread once.
    public private(set) var keys: [ThreadKey]
    /// The tab on screen last, put back on screen after a relaunch; nil for none (the
    /// new-thread screen was on screen, or there are no tabs).
    public var lastSelected: ThreadKey?
    /// The tabs opened from the foot of the chat of the thread that started theirs: only
    /// these have the back button to it over their chat, and going back closes them
    /// (2026-10-28: "this button should be only on threads that we clicked in the
    /// footer, and the tab should be closed if we click"). Each is a tab.
    public private(set) var openedFromStarter: Set<ThreadKey>

    public init(keys: [ThreadKey] = [], lastSelected: ThreadKey? = nil, openedFromStarter: Set<ThreadKey> = []) {
        var seen = Set<ThreadKey>()
        self.keys = keys.filter { seen.insert($0).inserted }
        self.lastSelected = lastSelected.flatMap { seen.contains($0) ? $0 : nil }
        self.openedFromStarter = openedFromStarter.intersection(seen)
    }

    /// A list saved by an app with tabs twice in it, or a selection that is no tab, is
    /// read as `init` would make it.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            keys: try container.decodeIfPresent([ThreadKey].self, forKey: .keys) ?? [],
            lastSelected: try container.decodeIfPresent(ThreadKey.self, forKey: .lastSelected),
            openedFromStarter: try container.decodeIfPresent(Set<ThreadKey>.self, forKey: .openedFromStarter) ?? []
        )
    }

    public var isEmpty: Bool { keys.isEmpty }
    public var count: Int { keys.count }

    public func contains(_ key: ThreadKey) -> Bool {
        keys.contains(key)
    }

    /// Opens `key` as a tab, after the others, unless it is one already, where it stays;
    /// with `selecting`, it is the one on screen.
    public mutating func open(_ key: ThreadKey, selecting: Bool = true) {
        if !keys.contains(key) { keys.append(key) }
        if selecting { lastSelected = key }
    }

    /// Marks `key`'s tab as opened from the foot of its starter's chat; nothing for no tab.
    public mutating func markOpenedFromStarter(_ key: ThreadKey) {
        if keys.contains(key) { openedFromStarter.insert(key) }
    }

    /// Whether `key`'s tab was opened from the foot of its starter's chat.
    public func wasOpenedFromStarter(_ key: ThreadKey) -> Bool {
        openedFromStarter.contains(key)
    }

    /// Closes `key`'s tab, and gives the tab to show in its place were it on screen: the
    /// one after it, or else the one before it; nil when it was the last (the new-thread
    /// screen is shown then), or no tab. The one on screen is that one when it was `key`.
    @discardableResult
    public mutating func close(_ key: ThreadKey) -> ThreadKey? {
        guard let index = keys.firstIndex(of: key) else { return nil }
        keys.remove(at: index)
        openedFromStarter.remove(key)
        let neighbour = keys.isEmpty ? nil : keys[min(index, keys.count - 1)]
        if lastSelected == key { lastSelected = neighbour }
        return neighbour
    }

    /// The tabs to show in place of `key`'s once it is closed, the one `close` gives first:
    /// those after it, nearest first, then those before it, nearest first. One that
    /// cannot be shown (its agent gone) gives way to the next. None for no tab.
    public func inPlace(of key: ThreadKey) -> [ThreadKey] {
        guard let index = keys.firstIndex(of: key) else { return [] }
        return Array(keys[(index + 1)...]) + keys[..<index].reversed()
    }

    /// Moves `key`'s tab to `index` among the tabs, counted as they stand after it is
    /// taken out; past the ends, to the end there.
    public mutating func move(_ key: ThreadKey, to index: Int) {
        guard let from = keys.firstIndex(of: key) else { return }
        keys.remove(at: from)
        keys.insert(key, at: min(max(index, 0), keys.count))
    }

    /// Moves `key`'s tab just before `target`'s, or after them all when there is no
    /// `target` (or it is no tab).
    public mutating func move(_ key: ThreadKey, before target: ThreadKey?) {
        guard key != target, let from = keys.firstIndex(of: key) else { return }
        keys.remove(at: from)
        let to = target.flatMap { keys.firstIndex(of: $0) } ?? keys.count
        keys.insert(key, at: to)
    }

    /// The tab ⌘1 to ⌘9 go to, `index` counting from 0: the ninth (8) is the last,
    /// however many there are, as in Safari. nil past the tabs there are.
    public func key(at index: Int) -> ThreadKey? {
        guard !keys.isEmpty, index >= 0 else { return nil }
        if index >= 8 { return keys.last }
        return keys.indices.contains(index) ? keys[index] : nil
    }

    /// The number of the ⌘ key that goes to `key`'s tab (`key(at:)`): 1 to 8 for the first
    /// eight, 9 for the last past them. nil for a tab between those, or no tab.
    public func shortcut(of key: ThreadKey) -> Int? {
        guard let index = keys.firstIndex(of: key) else { return nil }
        if index < 8 { return index + 1 }
        return index == keys.count - 1 ? 9 : nil
    }

    /// The tab `step` tabs on from `key` (back for a negative step), round from one end to
    /// the other, as ⌃Tab and ⌃⇧Tab go: from the first for no `key`, or one that is no tab.
    public func cycled(from key: ThreadKey?, by step: Int) -> ThreadKey? {
        guard !keys.isEmpty else { return nil }
        guard let key, let index = keys.firstIndex(of: key) else { return keys.first }
        let count = keys.count
        return keys[((index + step) % count + count) % count]
    }

    /// Closes the tabs whose thread is gone (removed, its host taken off), with no tab
    /// shown in place of any: the one on screen is none when it was one of them.
    public mutating func remove(where gone: (ThreadKey) -> Bool) {
        keys.removeAll(where: gone)
        openedFromStarter = openedFromStarter.filter { !gone($0) }
        if let lastSelected, !keys.contains(lastSelected) { self.lastSelected = nil }
    }
}
