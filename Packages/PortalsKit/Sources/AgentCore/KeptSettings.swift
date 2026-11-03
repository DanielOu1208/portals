import Foundation

/// Some of an app's settings (keys of its `UserDefaults` domain) kept in a file as they
/// were, to be put back later: the demo's (`Demo` in the app), so that what a person
/// changes in Settings or types while it is on does not outlast it, also when the app is
/// quit before it ends.
///
/// Only the keys named are kept and put back: the settings a person can change. Every other
/// key is never touched, so nothing the app or the system writes by itself meanwhile (the
/// device's notification address, a window's frame) is put back over. The file says which
/// keys it kept, and only those are put back: a later version naming more keys leaves the
/// others as they are.
///
/// A mark in the settings themselves (`mark`), with the copy's id, says a copy is kept and
/// not wholly put back yet. Only a copy so marked is put back, and the mark goes once all of
/// it is back: a put-back cut short (the app ended partway) is done again in full the next
/// time, before anything else is changed, and a copy left behind after the mark went (one
/// that could not be removed) is never put back over what was changed since. A copy marked
/// that cannot be read just now (protected until the device is first unlocked, say) stays,
/// marked, for a later put-back: `PutBack.notNow`.
public struct KeptSettings: Sendable {
    /// What a put-back came to.
    public enum PutBack: Equatable, Sendable {
        /// The copy marked kept was put back, and forgotten.
        case done
        /// No copy was marked kept, or the one marked was gone or not its own: nothing to
        /// put back, now or later.
        case none
        /// The copy marked kept is there but could not be read just now: it stays, marked,
        /// to be put back later. Nothing was put back.
        case notNow
    }

    /// Where they are kept until they are put back.
    public let file: URL
    /// The keys kept and put back.
    public let keys: Set<String>
    /// The key in the domain that marks a copy kept and not wholly put back, with its id:
    /// never one of `keys`.
    public let mark: String

    public init(file: URL, keys: Set<String>, mark: String) {
        self.file = file
        self.keys = keys.subtracting([mark])
        self.mark = mark
    }

    /// Whether a copy is kept and not wholly put back yet.
    public func isKept(in defaults: UserDefaults) -> Bool {
        defaults.string(forKey: mark) != nil
    }

    /// Keeps the values the keys have in `domain` of `defaults` now (a key with none, as
    /// having none), in a file left out of backups, then marks it kept. False when it could
    /// not be written, and nothing is marked.
    @discardableResult
    public func keep(_ defaults: UserDefaults, domain: String) -> Bool {
        let id = UUID().uuidString
        let now = defaults.persistentDomain(forName: domain) ?? [:]
        let kept: [String: Any] = ["id": id, "keys": keys.sorted(), "values": now.filter { keys.contains($0.key) }]
        guard let data = try? PropertyListSerialization.data(fromPropertyList: kept, format: .binary, options: 0) else { return false }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
        } catch {
            return false
        }
        var written = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? written.setResourceValues(values)
        // Marked once written: ended before this, nothing is kept, and nothing was changed.
        defaults.set(id, forKey: mark)
        return true
    }

    /// Puts the kept keys back in `domain` as they were, when a copy is marked kept: key by
    /// key, and only those that changed, so that what shows one (SwiftUI's `@AppStorage`)
    /// hears of it. A kept key that had no value has none again. Then the mark goes, and the
    /// copy. A copy not marked is left as it is, never put back; one marked with another id,
    /// or not readable as a copy, is not put back, and goes with the mark.
    @discardableResult
    public func putBack(into defaults: UserDefaults, domain: String) -> PutBack {
        // Nothing is removed without a mark: the settings themselves may not be readable yet
        // (before the device is first unlocked), and an unmarked copy is never put back.
        guard let id = defaults.string(forKey: mark) else { return .none }
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // Gone for certain: there is nothing to put back, ever.
            defaults.removeObject(forKey: mark)
            return .none
        } catch {
            // Not readable now (protected, its folder out of reach), which is no proof it
            // is gone: kept, marked, for later.
            return .notNow
        }
        guard let kept = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              kept["id"] as? String == id, let keptKeys = kept["keys"] as? [String], let values = kept["values"] as? [String: Any]
        else {
            forget(in: defaults)
            return .none
        }
        let now = defaults.persistentDomain(forName: domain) ?? [:]
        for key in keptKeys where key != mark {
            switch (values[key], now[key]) {
            case (nil, nil):
                continue
            case (nil, _?):
                defaults.removeObject(forKey: key)
            case let (was?, value):
                if let value, (value as AnyObject).isEqual(was) { continue }
                defaults.set(was, forKey: key)
            }
        }
        // All of it back: until now, ended partway, it is all put back again next time.
        forget(in: defaults)
        return .done
    }

    /// The mark goes, then the copy: should the copy not go, it is never put back unmarked.
    private func forget(in defaults: UserDefaults) {
        defaults.removeObject(forKey: mark)
        try? FileManager.default.removeItem(at: file)
    }
}
