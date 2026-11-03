import SwiftUI
import UIKit

extension View {
    /// Hold to copy: a menu with Copy, which takes `text` whole, and Select Text, which
    /// opens it where any part of it can be selected. SwiftUI's own text selection gave
    /// nothing to copy in the chat (seen on iOS 26 and 27), so whatever can be copied
    /// offers it this way.
    ///
    /// - Parameter selecting: called when Select Text opens, when that text differs
    ///   from what Copy takes. Replies are copied as written and selected as they read.
    func copyMenu(_ text: String, selecting: (() -> String)? = nil) -> some View {
        modifier(CopyMenu(text: text, selecting: selecting ?? { text }))
    }
}

extension View {
    /// Opens Select Text from here for the copy menus inside, instead of from each menu's
    /// own view. A chat's transcript lets go of the turns far from the screen, and a
    /// sheet opened from one would close with it, as a reply streaming in below moves
    /// it away.
    func selectsTextHere() -> some View {
        modifier(SelectsTextHere())
    }
}

extension EnvironmentValues {
    /// Opens Select Text with the text given (`selectsTextHere`); nil where each copy
    /// menu opens its own.
    @Entry var selectsText: ((String) -> Void)? = nil
}

private struct SelectsTextHere: ViewModifier {
    @State private var selected: SelectedText?

    func body(content: Content) -> some View {
        content
            .environment(\.selectsText) { text in selected = SelectedText(text: text) }
            // A panel in the window on a Mac, where a sheet took no click outside it.
            .sheetOrPanel($selected, width: 620) { selected, close in
                SelectTextSheet(text: selected.text, onDone: close)
            }
    }

    private struct SelectedText: Hashable {
        let id = UUID()
        let text: String
    }
}

private struct CopyMenu: ViewModifier {
    let text: String
    let selecting: () -> String

    @State private var isSelecting = false
    @Environment(\.selectsText) private var selectsText

    func body(content: Content) -> some View {
        content
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = text
                }
                Button("Select Text", systemImage: "selection.pin.in.out") {
                    if let selectsText {
                        selectsText(selecting())
                    } else {
                        isSelecting = true
                    }
                }
            }
            .sheet(isPresented: $isSelecting) {
                SelectTextSheet(text: selecting()) { isSelecting = false }
                    .sheetOnMac(width: 620)
            }
    }
}

/// Text to select part of, in a sheet.
private struct SelectTextSheet: View {
    let text: String
    let onDone: () -> Void

    var body: some View {
        PanelChrome(title: "Select Text", doneIdentifier: "select-text-done", onDone: onDone) {
            SelectableText(text: text)
        }
        .presentationDetents([.medium, .large])
    }
}

/// A text view that can be selected in but not edited: SwiftUI's `Text` selects only
/// whole, and a disabled `TextEditor` not at all.
private struct SelectableText: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.font = AppTextStyles.fixedSize(of: .body).map { .systemFont(ofSize: $0) } ?? .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: Theme.grid * 2, left: Theme.grid * 1.5, bottom: Theme.grid * 2, right: Theme.grid * 1.5)
        view.accessibilityIdentifier = "select-text"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}
