import AgentCore
import SwiftUI
import UIKit

/// What differs between the iPhone, the iPad and the Mac the app runs on. The screens
/// themselves follow the window's width, not the device (`MainScreen`); this is for the
/// few things that are the device's own.
enum Platform {
    /// On a Mac, as a Mac Catalyst app.
    nonisolated static var isMac: Bool {
        #if targetEnvironment(macCatalyst)
        true
        #else
        false
        #endif
    }

    /// Whether the code the bridge's setup shows can be scanned here. A Mac has no
    /// camera to hold up to it: there the link under the code is opened or pasted.
    static var scansCodes: Bool { !isMac }

    /// "this iPhone", "this iPad" or "this Mac", for copy that names the device in hand.
    static var thisDevice: String {
        if isMac { return "this Mac" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "this iPad" : "this iPhone"
    }

    /// Draws every window of the app light, dark or as the system is (Settings,
    /// Appearance). On the windows themselves, and not with `preferredColorScheme`, whose
    /// nil (the system's) does not take back a light or dark set before it.
    static func apply(_ appearance: AppearanceChoice) {
        let style: UIUserInterfaceStyle = switch appearance {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { window.overrideUserInterfaceStyle = style }
        }
    }

    /// A sheet, or an alert, is up over a window of the app.
    static var isSheetUp: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .contains { $0.rootViewController?.presentedViewController != nil }
    }

    /// `thisDevice` to begin a sentence: "This iPhone".
    static var thisDeviceCapitalized: String {
        "T" + thisDevice.dropFirst()
    }

    /// The device's platform as a net knows it (`NetMember.platform`): `ios`, `ipados` or
    /// `macos`.
    static var netPlatform: String {
        if isMac { return "macos" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
    }

    /// Whether `machine`, the Mac a host says it runs on, is the Mac the app is on: the
    /// same host name and the same user's home folder. Never on an iPhone or iPad.
    static func isThisMac(_ machine: HostMachine) -> Bool {
        #if targetEnvironment(macCatalyst)
        var name = [CChar](repeating: 0, count: 256)
        // In the sandbox the app's home is its container: the user's own is the account's.
        guard gethostname(&name, name.count - 1) == 0, let home = getpwuid(getuid())?.pointee.pw_dir else { return false }
        return String(cString: name) == machine.hostname && String(cString: home) == machine.home
        #else
        false
        #endif
    }

    /// The key a Mac is handling right now is Return or Enter, without Shift, Option,
    /// Control or Command. A Mac's text field takes Return itself, so the composer asks
    /// this to tell Return (send) from Shift-Return, a paste or an undo, which put a line
    /// break in too. It is AppKit's event in hand (`NSApplication.currentEvent`), with the
    /// modifiers that came with the key, not the ones held by the time the field's change
    /// is seen. Should another event be in hand by then that says nothing either way (the
    /// pointer moved), it is whether no modifier is held now. A Catalyst app reaches
    /// AppKit by name; false anywhere else, and if AppKit does not answer.
    static var handlesPlainReturn: Bool {
        handlesPlainKey([36, 76]) // Return, the keypad's Enter.
    }

    /// The key a Mac is handling right now is Tab alone, as `handlesPlainReturn` tells: the
    /// composer's `@` menu picks a row for it, where the field has put in a tab, and not for
    /// a tab pasted or put back by Undo. Only a Tab key in hand says so: with no key event
    /// in hand, no modifier held is not enough.
    static var handlesPlainTab: Bool {
        handlesPlainKey([48], keyEventOnly: true)
    }

    /// `handlesPlainReturn` and `handlesPlainTab`, for keys of these AppKit key codes;
    /// `keyEventOnly`, false without one of them in hand.
    private static func handlesPlainKey(_ codes: Set<UInt16>, keyEventOnly: Bool = false) -> Bool {
        #if targetEnvironment(macCatalyst)
        let app = appKit(NSClassFromString("NSApplication"), "sharedApplication")
        if let event = appKit(app, "currentEvent"), let type = appKit(event, "type") as? UInt {
            switch type {
            case 10, 11: // A key going down or coming up.
                guard let key = appKit(event, "keyCode") as? UInt16,
                      let flags = appKit(event, "modifierFlags") as? UInt else { return false }
                return codes.contains(key) && flags & modifierKeys == 0
            case 1, 2, 3, 4, 25, 26, 12: // A mouse button (a menu's Paste or Undo), a modifier key.
                return false
            default:
                break
            }
        }
        guard !keyEventOnly, let flags = appKit(NSClassFromString("NSEvent"), "modifierFlags") as? UInt else { return false }
        return flags & modifierKeys == 0
        #else
        return false
        #endif
    }

    #if targetEnvironment(macCatalyst)
    /// `NSEvent.ModifierFlags`: shift, control, option, command.
    private static let modifierKeys: UInt = 1 << 17 | 1 << 18 | 1 << 19 | 1 << 20

    /// One of an AppKit object's properties, by name: nil if it has none, where asking
    /// for it anyway would raise an exception.
    private static func appKit(_ object: Any?, _ key: String) -> Any? {
        guard let object else { return nil }
        let target = object as AnyObject
        guard class_respondsToSelector(object_getClass(target), NSSelectorFromString(key)) else { return nil }
        return target.value(forKey: key)
    }
    #endif

    /// Whether the app is the one in use: on a Mac, the active app (another in front makes
    /// it inactive while its window still shows); elsewhere, in the foreground and active.
    static var isAppActive: Bool {
        #if targetEnvironment(macCatalyst)
        let app = appKit(NSClassFromString("NSApplication"), "sharedApplication")
        return appKit(app, "isActive") as? Bool ?? (UIApplication.shared.applicationState == .active)
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }

    /// Posted as the app becomes the one in use (`isAppActive`): on a Mac, as it becomes
    /// the active app, which it can stop being with its window still showing.
    static var appBecameActive: Notification.Name {
        #if targetEnvironment(macCatalyst)
        Notification.Name("NSApplicationDidBecomeActiveNotification")
        #else
        UIApplication.didBecomeActiveNotification
        #endif
    }

    /// Whether a word is being composed in the text field in use (Chinese, Japanese, an
    /// accent being chosen). Keys pressed then are the keyboard's own: its Return ends
    /// the word, and is not the app's to act on.
    static var isComposingText: Bool {
        (UIResponder.inUse as? any UITextInput)?.markedTextRange != nil
    }

    /// Sets up the app's window on a Mac: no title beside the window's buttons and no bar
    /// of the system's (the tabs say what is on screen), and no smaller than a small
    /// iPhone, which is the narrowest the screens are laid out for. The first time, it is
    /// given a size for the sidebar and a full chat column, in the middle of the screen; a
    /// Mac otherwise opens it as large as the screen. After that it keeps the size it was
    /// left at. Nothing on an iPhone or iPad.
    static func prepareWindows() {
        #if targetEnvironment(macCatalyst)
        let isFirstTime = !UserDefaults.standard.bool(forKey: firstWindowKey)
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.titlebar?.titleVisibility = .hidden
            // No bar of the system's: the tabs are drawn up in the window's bar instead
            // (`TabBar`), and the empty bar around them still moves the window.
            scene.titlebar?.toolbar = nil
            scene.sizeRestrictions?.minimumSize = WindowLayout.smallestWindow
            if isFirstTime {
                let screen = scene.screen.bounds.size
                let size = CGSize(width: min(WindowLayout.firstWindow.width, screen.width), height: min(WindowLayout.firstWindow.height, screen.height))
                let frame = CGRect(x: (screen.width - size.width) / 2, y: (screen.height - size.height) / 2, width: size.width, height: size.height)
                scene.requestGeometryUpdate(.Mac(systemFrame: frame))
            }
        }
        UserDefaults.standard.set(true, forKey: firstWindowKey)
        #endif
    }

    /// Set once the Mac's window has been given its first size.
    private static let firstWindowKey = "window.sizedOnce"
}

/// Whether a drag in a Mac window's bar moves the window. Off while the pointer is on one
/// of the tabs there (`TabStrip`), whose drag moves the tab along the row instead; on
/// everywhere else, so the bar around the tabs still moves the window, as it did in the
/// mockup the user tried (2026-10-23). The window is AppKit's, reached by name from
/// Catalyst (`NSWindow.isMovable`). Nothing on an iPhone or iPad.
enum WindowMover {
    static func setMovable(_ movable: Bool) {
        #if targetEnvironment(macCatalyst)
        for window in windows where class_respondsToSelector(object_getClass(window), NSSelectorFromString("setMovable:")) {
            window.setValue(movable, forKey: "movable")
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    /// The app's windows, without its panels (a menu's, a popover's).
    private static var windows: [NSObject] {
        guard let application = NSClassFromString("NSApplication") as? NSObject.Type,
              class_respondsToSelector(object_getClass(application), NSSelectorFromString("sharedApplication")),
              let app = application.value(forKey: "sharedApplication") as? NSObject,
              let windows = app.value(forKey: "windows") as? [NSObject] else { return [] }
        return windows.filter { window in
            let name = NSStringFromClass(type(of: window))
            return name.contains("Window") && !name.contains("Panel")
        }
    }
    #endif
}

/// Whether any of the app's windows can be seen. On a Mac a window stays active, and
/// its animations go on, while other windows cover it whole; AppKit says when that
/// changes (`NSWindow.occlusionState`), which a Catalyst app hears by the
/// notification's name. What only shows (an avatar's life, the wash) stops while no
/// window can be seen. Always seen on an iPhone and iPad, where the scene's phase says
/// as much.
@Observable
final class WindowVisibility {
    static let shared = WindowVisibility()

    /// No window of the app's can be seen: each is covered, on another Space, or hidden.
    private(set) var isHidden = false

    @ObservationIgnored private var observer: (any NSObjectProtocol)?

    private init() {
        isHidden = DebugLaunch.windowsHidden
        #if targetEnvironment(macCatalyst)
        observer = NotificationCenter.default.addObserver(
            forName: Notification.Name("NSWindowDidChangeOcclusionStateNotification"), object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    private func update() {
        let hidden = !Self.anyWindowSeen()
        if hidden != isHidden { isHidden = hidden }
    }

    /// Whether AppKit says any of the app's windows is on screen and not covered. Seen
    /// when AppKit does not answer: nothing is stopped on a guess.
    private static func anyWindowSeen() -> Bool {
        let app = appKit(NSClassFromString("NSApplication"), "sharedApplication")
        guard let windows = appKit(app, "windows") as? [AnyObject] else { return true }
        return windows.contains { window in
            guard appKit(window, "isVisible") as? Bool == true else { return false }
            // NSWindowOcclusionStateVisible
            return (appKit(window, "occlusionState") as? UInt ?? 2) & 2 != 0
        }
    }

    private static func appKit(_ object: Any?, _ key: String) -> Any? {
        guard let object else { return nil }
        let target = object as AnyObject
        guard class_respondsToSelector(object_getClass(target), NSSelectorFromString(key)) else { return nil }
        return target.value(forKey: key)
    }
    #endif
}

private extension UIResponder {
    private static weak var found: UIResponder?

    /// The responder keys go to now, or nil when there is none. An action sent to no one
    /// in particular reaches it first.
    static var inUse: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(noteInUse), to: nil, from: nil, for: nil)
        return found
    }

    @objc private func noteInUse() {
        UIResponder.found = self
    }
}

/// How the window is laid out, from its width alone: an iPad in Split View and a narrow
/// Mac window are laid out as an iPhone is.
nonisolated enum WindowLayout {
    /// From this width on, the sidebar stays beside the chat instead of behind it: where
    /// the chat beside it is still `narrowestChatBeside` wide (700 with the sidebar's 320
    /// of before).
    static let wideWidth: CGFloat = pinnedSidebarWidth + narrowestChatBeside
    /// The least room the chat has beside the pinned sidebar.
    static let narrowestChatBeside: CGFloat = 380
    /// The sidebar's width beside the chat: 360 since 2026-10-20 (320 before), a little
    /// wider so that it is not awkward (2026-10-17): a thread's title shows
    /// about five letters more, and beside it the chat's widest column still fits a
    /// window of 1,300 points (the first one a Mac opens) and a 13-inch Mac's screen. On an
    /// iPad 15% slimmer, 306 (2026-10-23: "can we also make sidebar like 15% slimmer
    /// on ipad build?"). Or what a development launch asks for (`PORTALS_DEBUG_SIDEBAR_WIDTH`).
    static let pinnedSidebarWidth: CGFloat = DebugLaunch.sidebarWidth ?? (Platform.isMac ? 360 : 306)
    /// The most the sidebar over the chat takes of a narrow window, and its widest there.
    static let overlaidSidebarShare: CGFloat = 0.82
    static let overlaidSidebarWidth: CGFloat = 340

    /// The sidebar's width in a window `width` wide: beside the chat on a wide one, over
    /// it on a narrow one.
    static func sidebarWidth(window width: CGFloat) -> CGFloat {
        width >= wideWidth ? pinnedSidebarWidth : min(width * overlaidSidebarShare, overlaidSidebarWidth)
    }
    /// How far the sidebar's background takes to fade out at its far edge beside the
    /// chat, and how far the chat's wash runs on under it there, so that the blue of the
    /// one passes into the other with no edge between them.
    static let sidebarEdgeFade: CGFloat = 64
    /// The widest the chat's column gets: replies, the composer and the cards over it.
    /// On a wider window it sits in the middle. A Mac's is wider, for the room its
    /// screen has (2026-10-15); 5% narrower since 2026-11-01 (the ask).
    static let chatColumnWidth: CGFloat = Platform.isMac ? 836 : 722
    /// The widest a page of a few lines gets (the welcome, connecting).
    static let pageWidth: CGFloat = 480
    /// The smallest a Mac's window gets: about an iPhone's screen.
    static let smallestWindow = CGSize(width: 390, height: 640)
    /// The height of a Mac window's bar as the chat has it: the window's buttons and the
    /// tabs beside them (`TabBar`), and the room under them where the chat starts.
    static let windowBar: CGFloat = 52
    /// A Mac's window the first time it opens: the sidebar and a full chat column.
    static let firstWindow = CGSize(width: 1300, height: 820)
}

extension View {
    /// Keeps the chat's column to its widest (`WindowLayout.chatColumnWidth`), in the
    /// middle of whatever room there is, or as far left of it as the panel open beside it
    /// needs (`chatColumnShift`).
    func chatColumn() -> some View {
        frame(maxWidth: WindowLayout.chatColumnWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
            .movesWithChatColumn()
    }

    /// Moved as the chat's column is, for what stands in the middle of the chat outside it.
    func movesWithChatColumn() -> some View {
        modifier(ChatColumnShift())
    }
}

extension EnvironmentValues {
    /// How far left of the middle the chat's column goes, for the panel open beside it
    /// (`ThreadPanel.columnShift`).
    @Entry var chatColumnShift: CGFloat = 0
}

private struct ChatColumnShift: ViewModifier {
    @Environment(\.chatColumnShift) private var shift

    func body(content: Content) -> some View {
        // Moved, not laid out again: the window's every width as it is resized.
        content.offset(x: -shift)
    }
}
