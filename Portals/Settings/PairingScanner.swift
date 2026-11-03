// VisionKit's scanner is not on the Mac: there the link under the code is pasted
// (`HostSettingsSheet`).
#if !targetEnvironment(macCatalyst)
import AgentCore
import AVFoundation
import SwiftUI
import Vision
import VisionKit

/// The camera, looking for the QR code the bridge's setup shows on the Mac, or the one Add
/// a device shows on a device in a net. Where this device cannot scan, or Portals may not
/// use the camera, it says so instead.
///
/// The camera and the reading of its pictures are among the costliest things a phone does:
/// they stop while the app is not active in front, and after two minutes with no code
/// found the camera is let go of, "Scanning paused" with a tap to go on, so a phone put
/// down with the scanner open does not keep it running.
struct PairingScanner: View {
    /// Called once, with the first Portals code seen; the scanner then closes.
    var onFound: (PortalsLink) -> Void

    /// Whether the camera can be used, once that is known.
    private enum Camera {
        case checking, ready, missing, refused
    }

    @State private var camera = Camera.checking
    /// Why the last code seen was not one to add.
    @State private var problem: String?
    @State private var hasFound = false
    /// Two minutes went by with no code found: the camera is let go of until a tap.
    @State private var isIdle = false
    /// Each start of the camera, which starts its two minutes again.
    @State private var session = 0

    /// How long the camera looks for a code before it is let go of.
    static let patience: Duration = .seconds(120)

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Group {
                switch camera {
                case .checking:
                    Color.clear
                case .ready where isIdle:
                    ContentUnavailableView {
                        Label("Scanning paused", systemImage: "camera")
                    } description: {
                        Text("No code was found for a while, so the camera was turned off.")
                    } actions: {
                        Button("Scan again") {
                            isIdle = false
                            session += 1
                        }
                        .buttonStyle(.monochromeProminent)
                        .buttonBorderShape(.capsule)
                        .accessibilityIdentifier("scanner-resume")
                    }
                case .ready:
                    QRCodeScanner(onCode: read, isActive: scenePhase == .active)
                        .ignoresSafeArea()
                        .overlay(alignment: .bottom) { caption }
                        .task(id: session) {
                            guard (try? await Task.sleep(for: Self.patience)) != nil, !hasFound else { return }
                            isIdle = true
                        }
                case .missing:
                    ContentUnavailableView {
                        Label("No camera to scan with", systemImage: "camera")
                    } description: {
                        Text("Type the host's address and sign-in instead. Setup shows them under the code.")
                    }
                case .refused:
                    ContentUnavailableView {
                        Label("Portals can't use the camera", systemImage: "camera")
                    } description: {
                        Text("Allow camera access in Settings to scan the code, or type the host's address instead.")
                    } actions: {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                }
            }
            .navigationTitle("Scan the code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { camera = await Self.checkCamera() }
    }

    /// What to point at, or why the last code will not do.
    private var caption: some View {
        Group {
            if let problem {
                Text(problem)
            } else {
                Text("Point the camera at the code `\(PairingLink.setupCommand)` shows on your Mac or Linux computer, or the one Add a portal shows on one of your portals.")
            }
        }
        .font(.app.subheadline)
        .multilineTextAlignment(.center)
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid * 1.5)
        .glassEffect(.regular, in: .rect(cornerRadius: Theme.grid * 2))
        .padding(.horizontal, Theme.grid * 2)
        .padding(.bottom, Theme.grid * 4)
        .animation(.easeInOut(duration: 0.2), value: problem)
    }

    private func read(_ text: String) {
        guard !hasFound else { return }
        do {
            let pairing = try PortalsLink(parsing: text)
            hasFound = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onFound(pairing)
            dismiss()
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Asks for the camera the first time; after that, says what was decided.
    private static func checkCamera() async -> Camera {
        guard DataScannerViewController.isSupported else { return .missing }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return DataScannerViewController.isAvailable ? .ready : .refused
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: .video) ? .ready : .refused
        default:
            return .refused
        }
    }
}

/// VisionKit's scanner, reading QR codes only, one at a time.
private struct QRCodeScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void
    /// The app is active in front: the scanner reads only then.
    var isActive: Bool

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        if isActive {
            if !scanner.isScanning { try? scanner.startScanning() }
        } else if scanner.isScanning {
            scanner.stopScanning()
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            read(addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            read([item])
        }

        private func read(_ items: [RecognizedItem]) {
            for item in items {
                if case let .barcode(code) = item, let text = code.payloadStringValue {
                    onCode(text)
                    return
                }
            }
        }
    }
}
#endif
