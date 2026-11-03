import SwiftUI

/// The app's search field: a magnifying glass, the field, and once something is typed a
/// button that clears it, on a faint capsule. The sidebar searches its threads in it and
/// the folder sheet its host's folders. What the field takes (`submitLabel`, `onSubmit`,
/// `autocorrectionDisabled`, …) is set where it is used.
struct SearchField: View {
    /// A Mac's controls are a little smaller.
    static let height: CGFloat = Platform.isMac ? 36 : 40

    let prompt: String
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    /// Something is being looked for: a spinner before the clear button.
    var isBusy = false
    /// The field's, for tests.
    var identifier = ""

    var body: some View {
        HStack(spacing: Theme.grid) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .focused(isFocused)
                .accessibilityIdentifier(identifier)
            if isBusy {
                ProgressView()
                    .controlSize(.small)
            }
            if !text.isEmpty {
                Button("Clear", systemImage: "xmark.circle.fill") { text = "" }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, Theme.grid * 1.5)
        .frame(minHeight: Self.height)
        .background(Color(uiColor: .tertiarySystemFill), in: .capsule)
    }
}
