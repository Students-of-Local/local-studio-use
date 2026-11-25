// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The hands engine (agent-desktop's C library, built by scripts/build-engine.sh into engine/lib as a static library).
// An absolute path, because the linker's working directory isn't always the package's.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "TychicusHands",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "tychicus-hands", targets: ["TychicusHands"]),
    ],
    targets: [
        // The protocol: tools, arguments, envelopes, policies. Foundation only.
        .target(name: "HandsCore"),
        .testTarget(name: "HandsCoreTests", dependencies: ["HandsCore"]),
        // agent-desktop's C header, for the hands engine.
        .systemLibrary(name: "CAgentDesktop", path: "Sources/CAgentDesktop"),
        // `tychicus-hands mcp [--connector]`: the hands over stdio. The engine is linked in statically
        // (engine/lib/libagent_desktop_ffi.a, by path so a stray dylib there is never picked), so the helper is one
        // file that signs with the hardened runtime ad hoc. The frameworks are the ones rustc lists for the crate
        // (`--print native-static-libs`).
        .executableTarget(
            name: "TychicusHands",
            dependencies: ["HandsCore", "CAgentDesktop"],
            linkerSettings: [
                .unsafeFlags([
                    "\(root)/engine/lib/libagent_desktop_ffi.a",
                    "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CoreFoundation",
                    "-framework", "AppKit", "-framework", "Carbon", "-framework", "ImageIO", "-framework", "QuartzCore",
                    "-lz", "-liconv",
                ]),
            ]),
    ]
)
