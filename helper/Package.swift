// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "slapsense",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "SlapsenseCore"),
        .executableTarget(name: "slapsense", dependencies: ["SlapsenseCore"]),
        .testTarget(name: "SlapsenseCoreTests", dependencies: ["SlapsenseCore"]),
    ]
)
