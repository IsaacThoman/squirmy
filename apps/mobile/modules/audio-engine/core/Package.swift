// swift-tools-version:5.9
// The audio engine's core, with no Expo dependency: the app's pod compiles these sources
// into the module, and `swift test` runs them on macOS, where the same AVFoundation and
// AudioToolbox APIs exist.
import PackageDescription

let package = Package(
  name: "SquirmyAudioCore",
  platforms: [.macOS(.v14), .iOS("16.4"), .tvOS(.v17)],
  products: [
    .library(name: "SquirmyAudioCore", targets: ["SquirmyAudioCore"]),
  ],
  targets: [
    .target(name: "SquirmyAudioCore"),
    .testTarget(
      name: "SquirmyAudioCoreTests",
      dependencies: ["SquirmyAudioCore"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
