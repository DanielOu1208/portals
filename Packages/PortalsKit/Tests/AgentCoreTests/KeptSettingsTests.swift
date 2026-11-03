import Foundation
import Testing
@testable import AgentCore

/// The settings the demo keeps as they were and puts back (`KeptSettings`).
@Suite struct KeptSettingsTests {
    private static let settings: Set<String> = ["notify.needsYou", "appearance.mode", "composer.drafts", "chat.new"]
    private static let mark = "demo.settingsKept"

    private func scratch(keys: Set<String> = settings) -> (defaults: UserDefaults, domain: String, kept: KeptSettings) {
        let domain = "portals-kept-settings-\(UUID().uuidString)"
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(domain).plist")
        return (UserDefaults(suiteName: domain)!, domain, KeptSettings(file: file, keys: keys, mark: Self.mark))
    }

    private func fileExists(_ kept: KeptSettings) -> Bool {
        FileManager.default.fileExists(atPath: kept.file.path)
    }

    @Test func theSettingsChangedAfterKeepingArePutBack() throws {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set(true, forKey: "notify.needsYou")
        defaults.set("system", forKey: "appearance.mode")
        defaults.set(Data([1, 2, 3]), forKey: "composer.drafts")
        #expect(kept.keep(defaults, domain: domain))
        #expect(kept.isKept(in: defaults))

        // In the demo: a choice turned off, the appearance changed, a draft typed, and a
        // setting that had no value given one.
        defaults.set(false, forKey: "notify.needsYou")
        defaults.set("dark", forKey: "appearance.mode")
        defaults.removeObject(forKey: "composer.drafts")
        defaults.set(true, forKey: "chat.new")

        #expect(kept.putBack(into: defaults, domain: domain) == .done)
        #expect(defaults.object(forKey: "notify.needsYou") as? Bool == true)
        #expect(defaults.string(forKey: "appearance.mode") == "system")
        #expect(defaults.data(forKey: "composer.drafts") == Data([1, 2, 3]))
        #expect(defaults.object(forKey: "chat.new") == nil)
        // Once only: the mark and the copy are gone.
        #expect(!kept.isKept(in: defaults))
        #expect(!fileExists(kept))
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
    }

    /// What the app or the system writes by itself meanwhile, on keys not named, is never
    /// put back over, nor removed.
    @Test func keysNotNamedAreNeverTouched() {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set("token-a", forKey: "PortalsLastDeviceToken")
        defaults.set(true, forKey: "notify.needsYou")
        kept.keep(defaults, domain: domain)
        defaults.set("token-b", forKey: "PortalsLastDeviceToken")
        defaults.set("frame", forKey: "NSWindow Frame main")
        defaults.set(false, forKey: "notify.needsYou")
        kept.putBack(into: defaults, domain: domain)
        #expect(defaults.string(forKey: "PortalsLastDeviceToken") == "token-b")
        #expect(defaults.string(forKey: "NSWindow Frame main") == "frame")
        #expect(defaults.object(forKey: "notify.needsYou") as? Bool == true)
    }

    /// Kept by a version naming fewer keys and put back by one naming more (an update
    /// between a demo the app was quit in and the next launch): the keys it did not keep
    /// stay as they are, not taken for keys that had no value.
    @Test func onlyTheKeysKeptArePutBack() {
        let (defaults, domain, older) = scratch(keys: ["notify.needsYou"])
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set("dark", forKey: "appearance.mode")
        older.keep(defaults, domain: domain)
        defaults.set(false, forKey: "notify.needsYou")
        let newer = KeptSettings(file: older.file, keys: Self.settings, mark: Self.mark)
        #expect(newer.putBack(into: defaults, domain: domain) == .done)
        #expect(defaults.object(forKey: "notify.needsYou") == nil)
        #expect(defaults.string(forKey: "appearance.mode") == "dark")
    }

    /// The app ended partway through a put-back, some keys back and some not: the mark is
    /// still there, so the next put-back does it all again, before anything else changes.
    @Test func aPutBackCutShortIsDoneAgainInFull() {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set(true, forKey: "notify.needsYou")
        defaults.set("system", forKey: "appearance.mode")
        kept.keep(defaults, domain: domain)
        defaults.set(false, forKey: "notify.needsYou")
        defaults.set("dark", forKey: "appearance.mode")
        // As far as the first key, then ended.
        defaults.set(true, forKey: "notify.needsYou")
        #expect(kept.isKept(in: defaults))
        #expect(kept.putBack(into: defaults, domain: domain) == .done)
        #expect(defaults.object(forKey: "notify.needsYou") as? Bool == true)
        #expect(defaults.string(forKey: "appearance.mode") == "system")
    }

    /// A copy marked kept that cannot be read just now (protected until the device is first
    /// unlocked) stays, marked, and nothing is put back; read later, it all is.
    @Test func aCopyNotReadableNowIsKeptForLater() throws {
        let (defaults, domain, kept) = scratch()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: kept.file.path)
            defaults.removePersistentDomain(forName: domain)
        }
        defaults.set("system", forKey: "appearance.mode")
        kept.keep(defaults, domain: domain)
        defaults.set("dark", forKey: "appearance.mode")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: kept.file.path)
        #expect(kept.putBack(into: defaults, domain: domain) == .notNow)
        #expect(kept.isKept(in: defaults))
        #expect(fileExists(kept))
        #expect(defaults.string(forKey: "appearance.mode") == "dark")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: kept.file.path)
        #expect(kept.putBack(into: defaults, domain: domain) == .done)
        #expect(defaults.string(forKey: "appearance.mode") == "system")
    }

    /// A copy left behind once its mark went (it could not be removed as the demo ended)
    /// is never put back over what was changed since, and is left as it is; one marked with
    /// another id is not put back either, and goes with the mark.
    @Test func aCopyNotMarkedIsNeverPutBack() throws {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set("system", forKey: "appearance.mode")
        kept.keep(defaults, domain: domain)
        let left = try Data(contentsOf: kept.file)
        defaults.removeObject(forKey: Self.mark)
        defaults.set("dark", forKey: "appearance.mode")
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(defaults.string(forKey: "appearance.mode") == "dark")

        // Marked, but by a later copy than the one in the file.
        kept.keep(defaults, domain: domain)
        try left.write(to: kept.file)
        defaults.set("light", forKey: "appearance.mode")
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(defaults.string(forKey: "appearance.mode") == "light")
        #expect(!kept.isKept(in: defaults))
        #expect(!fileExists(kept))
    }

    /// A copy in another form (a development build's, which kept the whole domain and set no
    /// mark) has no id to match a mark: never put back.
    @Test func aCopyInAnotherFormIsNeverPutBack() throws {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        let flat = try PropertyListSerialization.data(fromPropertyList: ["appearance.mode": "system"], format: .binary, options: 0)
        try flat.write(to: kept.file)
        defaults.set("dark", forKey: "appearance.mode")
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(defaults.string(forKey: "appearance.mode") == "dark")
        // Marked as a copy of this form never was: not put back, and gone with the mark.
        defaults.set("some-id", forKey: Self.mark)
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(defaults.string(forKey: "appearance.mode") == "dark")
        #expect(!fileExists(kept))
        #expect(!kept.isKept(in: defaults))
    }

    /// A copy marked kept that is gone for certain: nothing to put back, and the mark goes.
    /// One whose folder cannot be reached is not taken for gone.
    @Test func aCopyGoneTakesItsMarkWithItButOneOutOfReachDoesNot() throws {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        kept.keep(defaults, domain: domain)
        try FileManager.default.removeItem(at: kept.file)
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(!kept.isKept(in: defaults))

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("kept-\(UUID().uuidString)", isDirectory: true)
        let inFolder = KeptSettings(file: folder.appendingPathComponent("settings.plist"), keys: Self.settings, mark: Self.mark)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
            try? FileManager.default.removeItem(at: folder)
        }
        defaults.set("system", forKey: "appearance.mode")
        #expect(inFolder.keep(defaults, domain: domain))
        defaults.set("dark", forKey: "appearance.mode")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: folder.path)
        #expect(inFolder.putBack(into: defaults, domain: domain) == .notNow)
        #expect(inFolder.isKept(in: defaults))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        #expect(inFolder.putBack(into: defaults, domain: domain) == .done)
        #expect(defaults.string(forKey: "appearance.mode") == "system")
    }

    @Test func nothingKeptPutsNothingBack() {
        let (defaults, domain, kept) = scratch()
        defer { defaults.removePersistentDomain(forName: domain) }
        defaults.set(1, forKey: "notify.needsYou")
        #expect(kept.putBack(into: defaults, domain: domain) == .none)
        #expect(defaults.integer(forKey: "notify.needsYou") == 1)
    }
}
