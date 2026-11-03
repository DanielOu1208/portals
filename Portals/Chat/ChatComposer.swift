import AgentCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The text field with Send, and the images and files to send with it: picked from the
/// attach button, dragged onto the composer, or pasted (a screenshot, a copied photo or
/// file): ⌘V from iOS 27, or on an iPhone or an iPad the Paste button over the field
/// while a picture is on the clipboard. Always at the bottom of the chat. The
/// field is on top; under it, the attach button and whatever the screen adds beside it
/// (`accessory`: the model chip), then on the right what it has to say (`status`: how
/// full the context is) and Send.
///
/// While the agent works the field stays live: a message sent then steers the run or
/// waits for a turn of its own, as Settings says and the agent can, and Stop sits beside
/// Send. With nothing to send, Stop
/// takes Send's place.
///
/// With a keyboard attached (a Mac, an iPad with one), Return sends and Shift-Return
/// starts a new line. On the screen's own keyboard Return starts a new line, as before.
/// A Mac's field takes Return itself, before `onKeyPress` would see it, and starts a new
/// line: there the line break is taken back out and the message sent, unless Shift,
/// Option, Control or Command came with the key. A line break pasted or put back by Undo
/// stays. While a menu is open over it (`menu`: the slash commands', the `@` menu), Return
/// and Tab pick its row instead, the arrows move through its rows and Escape closes it.
///
/// On an iPhone it is as low as it can be, one line until more is typed: the keyboard
/// leaves the chat little height. It grows to six lines, then scrolls, keeping the line
/// being typed on in view. A Mac's window has the room, so there it starts two lines
/// tall, with more space around the text, and grows further before it scrolls.
struct ChatComposer<Accessory: View, Status: View>: View {
    @Binding var draft: String
    @Binding var attachments: [ImageAttachment]
    @Binding var files: [FileAttachment]
    /// Where the caret is, or what is selected, in the field: the `@` menu reads the word
    /// at the caret, and on an iPhone or an iPad the text is scrolled to show it when it
    /// moves (`ComposerTextScroll`).
    @Binding var caret: TextSelection?
    var isComposing: FocusState<Bool>.Binding
    let placeholder: String
    let isRunning: Bool
    /// The host takes files of any kind; one that does not takes images only.
    var takesFiles = false
    var onSend: () -> Void
    var onStop: () -> Void
    /// Whether the chat is kept built out of sight now (`ChatScreen.isShown`), asked as
    /// what was picked, dropped or pasted is read: what is read for a chat left meanwhile
    /// joins its message without taking the focus from the chat on screen.
    var isOutOfSight: () -> Bool = { false }
    /// The menus over it, the slash commands' and, on a host that searches files, the `@`
    /// menu: told when the text or the caret moves, and given the keys they take while open.
    var menu: ComposerMenuLink?
    /// The files picked from the `@` menu, whose tokens in the text are coloured.
    var mentioned: [String] = []
    /// Both are told the side of the composer's buttons, to line up with them.
    @ViewBuilder var accessory: (_ buttonSize: CGFloat) -> Accessory
    @ViewBuilder var status: (_ buttonSize: CGFloat) -> Status

    @Environment(\.swipeGuard) private var swipeGuard
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = ChatFeature.composerButton
    @ScaledMetric(relativeTo: .body) private var sendSize: CGFloat = ChatFeature.composerSend
    @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = ChatFeature.composerLineHeight
    /// What was just chosen in the photo library, until it is read.
    @State private var picked: [PhotosPickerItem] = []
    /// The photo library and the file picker, opened from the attach menu.
    @State private var showsPhotos = false
    @State private var showsFiles = false
    /// Files are being dragged over the composer.
    @State private var isDropTarget = false
    /// Why something picked or dropped was not attached, for a moment.
    @State private var problem: String?
    /// A picture is on the clipboard: on an iPhone or an iPad, whose field's own Paste
    /// takes text only, a Paste button shows over the field while typing.
    @State private var clipboardHasImage = false
    /// The clipboard's `changeCount` when it was last looked at: what it holds is asked
    /// again only once it has changed, so coming back to the app, or into the composer,
    /// with the same clipboard leaves the paste button as it was (`checkClipboard`).
    @State private var clipboardSeen: Int?
    @State private var intake = AttachmentIntake()

    private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// A message can be words, images, files, or any of them together.
    private var hasMessage: Bool { hasText || !attachments.isEmpty || !files.isEmpty }
    private var canSend: Bool { hasMessage && !intake.isPending }
    private var slotsLeft: Int { max(ChatFeature.imageLimit - attachments.count, 0) }
    private var fileSlotsLeft: Int { max(FileAttachment.perMessage - files.count, 0) }
    /// Touch gets a 44 pt square; the toolbar and its glyph keep their existing size.
    private var attachTarget: CGFloat { Platform.isMac ? buttonSize : max(44, buttonSize) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !attachments.isEmpty || !files.isEmpty {
                AttachmentStrip(attachments: $attachments, files: $files)
                    .transition(.opacity)
            }
            if intake.isPending {
                ProgressView("Preparing attachments…")
                    .font(.app.footnote)
                    .padding(.horizontal, Theme.grid * 1.75)
                    .padding(.top, Theme.grid)
                    .accessibilityIdentifier("attachment-intake")
            }
            if let problem {
                Text(problem)
                    .font(.app.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, Theme.grid * (Platform.isMac ? 1.75 : 1.25))
                    .padding(.top, Theme.grid)
                    .transition(.opacity)
                    .accessibilityIdentifier("attach-problem")
            }
            field
                .padding(.horizontal, Theme.grid * (Platform.isMac ? 1.75 : 1.25))
                .padding(.top, Theme.grid * (Platform.isMac ? 1.5 : 0.75))
                .padding(.bottom, Theme.grid * (Platform.isMac ? 0.75 : 0.25))
                // Only an attached keyboard's keys come this way. Return with a modifier
                // is left to the field, which starts a new line; so is the Return that
                // ends a word being composed (Chinese, Japanese).
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.isDisjoint(with: [.shift, .option, .control, .command]),
                          !Platform.isComposingText else { return .ignored }
                    if let menu, menu.isOpen(), menu.pick(true) { return .handled }
                    submit()
                    return .handled
                }
                // The open menu's keys, the slash commands' or the `@` menu's; the field's own
                // otherwise, and those of a word being composed (Chinese, Japanese), its
                // candidates' arrows too.
                .onKeyPress(keys: [.upArrow, .downArrow, .tab, .escape], phases: [.down, .repeat]) { press in
                    guard let menu, menu.isOpen(), press.modifiers.isDisjoint(with: [.shift, .option, .control, .command]),
                          !Platform.isComposingText else { return .ignored }
                    switch press.key {
                    case .upArrow: menu.move(-1)
                    case .downArrow: menu.move(1)
                    case .tab: return menu.pick(false) ? .handled : .ignored
                    default: menu.close()
                    }
                    return .handled
                }
                .onChange(of: draft) { old, new in
                    // On a Mac, the line break Return just put in (over any selection) is
                    // taken back out, and the message as it was is sent, or the open menu's
                    // row picked.
                    if Platform.isMac, Platform.handlesPlainReturn, !Platform.isComposingText,
                       ComposerText.isLineBreakTyped(over: old, giving: new) {
                        draft = old
                        if let menu, menu.isOpen(), menu.pick(true) { return }
                        submit()
                        return
                    }
                    // So is the tab Tab puts in while a menu is open: its row is picked. A
                    // tab pasted or put back by Undo stays.
                    if Platform.isMac, Platform.handlesPlainTab, !Platform.isComposingText, let menu, menu.isOpen(),
                       ComposerText.isTyped("\t", over: old, giving: new) {
                        draft = old
                        _ = menu.pick(false)
                        return
                    }
                    if draft.count > ChatFeature.messageLimit {
                        draft = String(draft.prefix(ChatFeature.messageLimit))
                    }
                    menu?.follow()
                    if menu != nil { ComposerTokens.colour(draft, picked: mentioned) }
                }
                .onChange(of: caret) { menu?.follow() }
                // Padding beside the text also starts typing, but this focus target
                // never extends underneath the toolbar's chips and attachment button.
                .background {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { swipeGuard { isComposing.wrappedValue = true } }
                }
            HStack(alignment: .center, spacing: 0) {
                attach
                    .zIndex(1)
                if !Platform.isMac, clipboardHasImage, isComposing.wrappedValue, slotsLeft > 0 {
                    pasteImage
                }
                accessory(buttonSize)
                Spacer(minLength: Theme.grid / 2)
                status(buttonSize)
                    .fixedSize()
                    .padding(.trailing, Theme.grid / 2)
                if isRunning, hasMessage {
                    // Stop beside Send, while there is a message to send too.
                    stopButton(isProminent: false)
                        .padding(.trailing, Theme.grid * 0.75)
                }
                if isRunning, !hasMessage {
                    stopButton(isProminent: true)
                } else {
                    send
                }
            }
            // Its touch target reaches into the text field's padding above the row.
            .zIndex(1)
        }
        .padding(Theme.grid * (Platform.isMac ? 0.75 : 0.5))
        .glassEffect(.regular.interactive(), in: shape)
        // Files dragged in from the Finder, the Files app or another window.
        .overlay {
            if isDropTarget {
                shape.strokeBorder(Color.accentColor, lineWidth: 2)
                    .allowsHitTesting(false)
            }
        }
        .dropDestination(for: DroppedFile.self) { dropped, _ in
            intake.run(cleanup: {
                // Also cleaned when navigation cancels the batch before it can start.
                for file in dropped { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
            }) { batch in
                await add(dropped.map(\.url), batch: batch)
            }
            return !dropped.isEmpty
        } isTargeted: { isDropTarget = $0 }
        // Pasted while typing: the field takes text, and what it does not take comes here.
        .pastesAttachments { pasted in
            intake.run { await paste(pasted, batch: $0) }
        }
        // Whether a picture waits on the clipboard; asking that much asks nothing of the user.
        .onAppear {
            checkClipboard()
            ComposerProbe.start()
        }
        .onChange(of: isComposing.wrappedValue) { _, composing in
            checkClipboard()
            // The `@` menu opens as the field is typed in or its caret moves, and closes
            // as it loses the focus (a Mac's field can be typed in while SwiftUI's focus
            // says it is not, its window having stopped and started being the key one).
            if !composing { menu?.leave() }
            if composing, menu != nil { ComposerTokens.colour(draft, picked: mentioned) }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            checkClipboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            checkClipboard()
        }
        .animation(.smooth(duration: 0.2), value: clipboardHasImage && isComposing.wrappedValue)
        .animation(.smooth(duration: 0.2), value: attachments.isEmpty && files.isEmpty)
        .animation(.smooth(duration: 0.2), value: problem)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            intake.run { await add(items, batch: $0) }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $picked, maxSelectionCount: max(slotsLeft, 1), matching: .images)
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            intake.run { await add(urls, batch: $0) }
        }
        .onDisappear { intake.cancelAll() }
        .task(id: problem) {
            // Said for a few seconds, then gone.
            guard problem != nil, (try? await Task.sleep(for: .seconds(6))) != nil else { return }
            problem = nil
        }
        .returnProbe("composer")
    }

    /// The text field. A Mac's grows from two lines to fourteen, then scrolls itself, as
    /// it always has. On an iPhone and an iPad it grows from one line to six, and past
    /// that the scroll view around it scrolls (`ComposerTextScroll`), not the field: the
    /// field's own scrolling slid each new line into view over a few frames, cut
    /// meanwhile (2026-10-22: "the last line isnt show properly and jumps around
    /// a bit sometimes").
    @ViewBuilder private var field: some View {
        if Platform.isMac {
            TextField(placeholder, text: $draft, selection: $caret, axis: .vertical)
                .lineLimit(2...14)
                .focused(isComposing)
                .accessibilityIdentifier("composer-field")
        } else {
            ComposerTextScroll(lineHeight: lineHeight, caret: caret) {
                TextField(placeholder, text: $draft, selection: $caret, axis: .vertical)
                    .lineLimit(1...)
                    .focused(isComposing)
                    .accessibilityIdentifier("composer-field")
            }
        }
    }

    /// Whether a picture waits on the clipboard, asked again only when the clipboard has
    /// changed since it was last asked. Asking that much asks nothing of the user.
    private func checkClipboard() {
        let count = UIPasteboard.general.changeCount
        guard count != clipboardSeen else { return }
        clipboardSeen = count
        let hasImage = UIPasteboard.general.hasImages
        if hasImage != clipboardHasImage { clipboardHasImage = hasImage }
    }

    /// The composer's outline. The corner follows Send, which sits in it.
    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: sendSize / 2 + Theme.grid * (Platform.isMac ? 0.75 : 0.5))
    }

    /// The system's own Paste, beside +: it asks nothing, as the button is the asking. Its
    /// glyph alone in a small light circle, not a labelled capsule over the field (2026-10-25: "we need a smaller paste button this is kinda bad").
    private var pasteImage: some View {
        PasteImageControl { pasted in
            intake.run { await paste(pasted, batch: $0) }
        }
        .frame(width: 34, height: 34)
        .padding(.leading, Theme.grid / 2)
        .transition(.opacity)
        .accessibilityIdentifier("paste-image")
        .returnProbe("paste-button")
    }

    /// What to attach. On a host that takes files, a menu: the photo library, or files of
    /// any kind. On one that takes images only, the photo library's picker itself.
    @ViewBuilder private var attach: some View {
        if takesFiles {
            Menu {
                Button("Photo Library", systemImage: "photo.on.rectangle") { showsPhotos = true }
                    .disabled(slotsLeft == 0)
                Button("Choose Files…", systemImage: "folder") { showsFiles = true }
                    .disabled(fileSlotsLeft == 0)

            } label: {
                Image(systemName: "plus")
                    .font(.app.callout.weight(.medium))
                    .frame(width: attachTarget, height: attachTarget)
                    .contentShape(.rect)
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .padding((buttonSize - attachTarget) / 2)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Add images or files")
            .accessibilityIdentifier("attach")
        } else {
            // The picker draws its label off the main actor: it gets the size, not the view.
            let side = buttonSize
            let target = attachTarget
            PhotosPicker(selection: $picked, maxSelectionCount: max(slotsLeft, 1), matching: .images) {
                Image(systemName: "plus")
                    .font(.app.callout.weight(.medium))
                    .frame(width: target, height: target)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding((side - target) / 2)
            .foregroundStyle(slotsLeft == 0 ? .tertiary : .secondary)
            .disabled(slotsLeft == 0)
            .accessibilityLabel("Add images")
            .accessibilityIdentifier("attach")
        }
    }

    private func add(_ items: [PhotosPickerItem], batch: AttachmentIntake.Token) async {
        for item in items {
            guard intake.accepts(batch) else { return }
            let data = try? await item.loadTransferable(type: Data.self)
            guard intake.accepts(batch) else { return }
            guard let data else { continue }
            let image = await ImageAttachment.prepared(from: data)
            guard intake.accepts(batch) else { return }
            if let image, slotsLeft > 0 { attachments.append(image) }
        }
    }

    /// Pasted into the composer: images join the images, copied files go as files would
    /// when dropped. What does not fit is said.
    private func paste(_ pasted: [PastedItem], batch: AttachmentIntake.Token) async {
        let urls = pasted.compactMap { if case let .file(url) = $0 { url } else { nil } }
        if !urls.isEmpty { await add(urls, batch: batch) }
        await addPictures(pasted.compactMap { if case let .image(data) = $0 { data } else { nil } }, batch: batch)
    }

    private func addPictures(_ pictures: [Data], batch: AttachmentIntake.Token) async {
        guard !pictures.isEmpty, intake.accepts(batch) else { return }
        var left = pictures.count
        for data in pictures where slotsLeft > 0 {
            guard intake.accepts(batch) else { return }
            let image = await ImageAttachment.prepared(from: data, name: "pasted")
            guard intake.accepts(batch) else { return }
            if let image, slotsLeft > 0 {
                attachments.append(image)
                left -= 1
            }
        }
        if left > 0 { problem = slotsLeft == 0 ? "A message takes \(ChatFeature.imageLimit) images at most." : "That image could not be read." }
        if !isOutOfSight() { isComposing.wrappedValue = true }
    }

    /// Files picked or dropped: pictures join the images, the rest go as files.
    private func add(_ urls: [URL], batch: AttachmentIntake.Token) async {
        guard intake.accepts(batch) else { return }
        let taken = await FileIntake.read(urls, imageSlots: slotsLeft, fileSlots: fileSlotsLeft, takesFiles: takesFiles)
        guard intake.accepts(batch) else { return }
        // Another pick or drop that ended first may have taken the room these were read for.
        let images = taken.images.prefix(slotsLeft), added = taken.files.prefix(fileSlotsLeft)
        attachments.append(contentsOf: images)
        files.append(contentsOf: added)
        let left = taken.images.count - images.count + taken.files.count - added.count
        // A pick that went well says nothing over what another one had to say.
        if let said = left > 0 ? (left == 1 ? "One more did not fit in this message." : "\(left) more did not fit in this message.") : taken.problems.first {
            problem = said
        }
        if !taken.images.isEmpty || !taken.files.isEmpty, !isOutOfSight() { isComposing.wrappedValue = true }
    }

    private func submit() {
        guard canSend else { return }
        onSend()
    }

    private var send: some View {
        Button(action: submit) {
            Image(systemName: "arrow.up")
                .font(.app.callout.weight(.bold))
                .frame(width: sendSize, height: sendSize)
        }
        .buttonStyle(ComposerDiscStyle(isProminent: true))
        .padding(.vertical, ChatFeature.composerSendOverlap)
        .disabled(!canSend)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("send")
    }

    private func stopButton(isProminent: Bool) -> some View {
        Button(action: onStop) {
            Image(systemName: "stop.fill")
                .font(.app.footnote.weight(.bold))
                .frame(width: sendSize, height: sendSize)
        }
        .buttonStyle(ComposerDiscStyle(isProminent: isProminent))
        .padding(.vertical, ChatFeature.composerSendOverlap)
        .accessibilityLabel("Stop")
        .accessibilityIdentifier("stop")
    }
}

/// A round composer button, exactly the size of its label: a grey disc with a white
/// glyph for the one thing to do now (Send, or Stop while there is nothing to send),
/// a faint disc for the other. A bordered system button would pad the label and come
/// out much larger than the controls beside it.
private struct ComposerDiscStyle: ButtonStyle {
    let isProminent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let isStrong = isProminent && isEnabled
        configuration.label
            .foregroundStyle(isStrong ? AnyShapeStyle(.white) : AnyShapeStyle(isEnabled ? .secondary : .tertiary))
            .background(
                isStrong ? AnyShapeStyle(Color(uiColor: .systemGray)) : AnyShapeStyle(Color(uiColor: .tertiarySystemFill)),
                in: .circle
            )
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(.circle)
            .animation(.easeOut(duration: 0.15), value: isStrong)
    }
}

/// What is pasted into the composer that its text field does not take: a copied file,
/// or an image (a screenshot, a copied photo). A file comes first: a file copied in the
/// Finder brings its icon as an image too.
private enum PastedItem: Transferable {
    case file(URL)
    case image(Data)

    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation { (url: URL) in
            guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
            return PastedItem.file(url)
        }
        DataRepresentation(importedContentType: .image) { PastedItem.image($0) }
    }
}

/// UIKit's paste control, its glyph alone, in the composer's greys: SwiftUI's
/// `PasteButton` takes a tint alone and draws its glyph white on it, a dark blob over the
/// composer. Like it, it pastes without asking, being the asking.
private struct PasteImageControl: UIViewRepresentable {
    let onPaste: ([PastedItem]) -> Void

    func makeCoordinator() -> Target { Target() }

    func makeUIView(context: Context) -> UIPasteControl {
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .iconOnly
        configuration.cornerStyle = .capsule
        // Opaque, and plain against each other: the system takes no paste from a control
        // it cannot be sure is seen.
        configuration.baseForegroundColor = .label
        configuration.baseBackgroundColor = .systemGray5
        let control = UIPasteControl(configuration: configuration)
        control.target = context.coordinator
        context.coordinator.onPaste = onPaste
        return control
    }

    func updateUIView(_ control: UIPasteControl, context: Context) {
        context.coordinator.onPaste = onPaste
    }

    final class Target: UIResponder {
        var onPaste: ([PastedItem]) -> Void = { _ in }

        override init() {
            super.init()
            pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image.identifier, UTType.fileURL.identifier])
        }

        override func paste(itemProviders: [NSItemProvider]) {
            Task {
                var pasted: [PastedItem] = []
                for provider in itemProviders {
                    if let item = await Self.load(provider) { pasted.append(item) }
                }
                if !pasted.isEmpty { onPaste(pasted) }
            }
        }

        private static func load(_ provider: NSItemProvider) async -> PastedItem? {
            await withCheckedContinuation { done in
                _ = provider.loadTransferable(type: PastedItem.self) { result in
                    done.resume(returning: try? result.get())
                }
            }
        }
    }
}

private extension View {
    /// Images and files pasted into the composer, which its text field does not take
    /// (`pasteDestination`, from iOS 27).
    @ViewBuilder
    func pastesAttachments(_ action: @escaping ([PastedItem]) -> Void) -> some View {
        if #available(iOS 27, *) {
            pasteDestination(for: PastedItem.self, action: action)
        } else {
            self
        }
    }
}
