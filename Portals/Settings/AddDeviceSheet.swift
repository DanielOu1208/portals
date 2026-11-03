import AgentCore
import CoreImage.CIFilterBuiltins
import SwiftUI

/// Add a portal: a join code from a host of the net, as a QR code to scan on the other
/// device and as its link to copy there, with how long it still works. One use, for ten
/// minutes (`net.invite`); a new one once it has run out.
struct AddDeviceSheet: View {
    let net: Net

    /// Where the code is.
    private enum Code {
        case making
        case made(NetInvite, qr: UIImage?)
        case failed(String)
    }

    @State private var code = Code.making
    @State private var copied = false
    /// A code asked for again (Try again, Make a new code), held by the sheet: cancelled
    /// when it closes, as the first one is with its `.task`.
    @State private var making: Task<Void, Never>?
    /// The time, a second at a time, for how long the code still works.
    @State private var now = Date.now

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                switch code {
                case .making:
                    Section {
                        HStack(spacing: Theme.grid) {
                            ProgressView()
                            Text("Making a code…")
                                .foregroundStyle(.secondary)
                        }
                    }
                case let .made(invite, qr):
                    made(invite, qr: qr)
                case let .failed(reason):
                    Section {
                        Label(reason, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Button("Try again", action: makeAgain)
                    }
                }
            }
            .navigationTitle("Add a portal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await make() }
            .task {
                while !Task.isCancelled {
                    now = .now
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
        .onDisappear { making?.cancel() }
        .sheetOnMac(height: 680)
    }

    /// The code, its link with Copy, and how long it still works.
    @ViewBuilder
    private func made(_ invite: NetInvite, qr: UIImage?) -> some View {
        let left = invite.expiresAt.timeIntervalSince(now)
        Section {
            if let qr {
                Image(uiImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 240)
                    .padding(Theme.grid * 1.5)
                    .background(.white, in: .rect(cornerRadius: Theme.grid * 1.5))
                    .opacity(left > 0 ? 1 : 0.25)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("The join code")
                    .accessibilityIdentifier("join-qr")
            }
        } footer: {
            Text("On the other iPhone, iPad or Mac, open Portals and scan this with Add a host, or with the Camera. It reaches every host in your net from then on.")
                .formFooter()
                .frame(maxWidth: .infinity)
        }

        Section {
            Text(invite.link)
                .font(.app.footnote.monospaced())
                .textSelection(.enabled)
                .accessibilityIdentifier("join-link")
            Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = invite.link
                withAnimation { copied = true }
            }
            .disabled(left <= 0)
            .accessibilityIdentifier("copy-join-link")
        } header: {
            Text("Link")
                .formHeader()
        } footer: {
            Text(Self.timeLeft(left))
                .formFooter()
                .accessibilityIdentifier("join-time-left")
        }

        if left <= 0 {
            Section {
                Button("Make a new code", systemImage: "arrow.clockwise", action: makeAgain)
            }
        }
    }

    /// How long the code still works, in whole minutes rounded up.
    private static func timeLeft(_ seconds: TimeInterval) -> String {
        guard seconds > 0 else { return "This code has run out. Make a new one." }
        let minutes = Int((seconds / 60).rounded(.up))
        return minutes == 1 ? "Works once, for 1 more minute." : "Works once, for \(minutes) more minutes."
    }

    /// Asks a Mac of the net for a code. Nothing once the sheet closed meanwhile.
    private func make() async {
        code = .making
        copied = false
        do {
            let invite = try await net.invite()
            code = .made(invite, qr: Self.qrCode(invite.link))
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            code = .failed(error.localizedDescription)
        }
    }

    /// Asks for a code again, in place of any being asked for.
    private func makeAgain() {
        making?.cancel()
        making = Task { await make() }
    }

    /// `text` as a QR code, each of its modules ten pixels wide.
    private static func qrCode(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}
