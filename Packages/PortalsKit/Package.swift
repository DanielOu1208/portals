// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "PortalsKit",
    platforms: [
        .iOS(.v26),
        .macOS(.v15),
    ],
    products: [
        .library(name: "AgentCore", targets: ["AgentCore"]),
        .library(name: "HermesBackend", targets: ["HermesBackend"]),
        .library(name: "MathRendering", targets: ["MathRendering"]),
        .library(name: "Wash", targets: ["Wash"]),
        .library(name: "Watchdog", targets: ["Watchdog"]),
        .executable(name: "portals-probe", targets: ["portals-probe"]),
    ],
    dependencies: [
        // Typesets LaTeX natively. Pinned exactly: how formulas look comes from it.
        .package(url: "https://github.com/mgriebling/SwiftMath.git", exact: "1.7.3"),
    ],
    targets: [
        // Backend-neutral model: agents, threads, transcripts, and the events that build them.
        .target(name: "AgentCore"),
        // The Hermes implementation of AgentCore's backend interface.
        .target(
            name: "HermesBackend",
            dependencies: ["AgentCore"]
        ),
        // Formulas typeset into images with SwiftMath, for the app to draw. Kept out of
        // AgentCore, which finds the formulas in a reply but draws nothing.
        .target(
            name: "MathRendering",
            dependencies: [.product(name: "SwiftMath", package: "SwiftMath")]
        ),
        // The wash behind the chat: its mesh, and drawing it with the GPU.
        .target(name: "Wash"),
        // Notices the main thread staying busy, or stuck, and writes it down.
        .target(name: "Watchdog"),
        .executableTarget(
            name: "portals-probe",
            dependencies: ["AgentCore", "HermesBackend"]
        ),
        .testTarget(
            name: "AgentCoreTests",
            dependencies: ["AgentCore"]
        ),
        .testTarget(
            name: "HermesBackendTests",
            dependencies: ["HermesBackend", "AgentCore"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "WashTests",
            dependencies: ["Wash"]
        ),
        .testTarget(
            name: "WatchdogTests",
            dependencies: ["Watchdog"]
        ),
        .testTarget(
            name: "MathRenderingTests",
            dependencies: ["MathRendering", .product(name: "SwiftMath", package: "SwiftMath")]
        ),
    ]
)
