// swift-tools-version:5.9
import PackageDescription

let package = Package(
	name: "local-studio-vm",
	platforms: [.macOS(.v14)],
	targets: [
		.executableTarget(name: "local-studio-vm", path: "Sources/local-studio-vm"),
	]
)
