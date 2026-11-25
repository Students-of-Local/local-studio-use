import XCTest
import HandsCore

/// A built-in app opens only as macOS's own copy: a bundle id says nothing by itself (review of #88, round 2).
final class BuiltInAppTests: XCTestCase {
    private let calculator = "com.apple.calculator"
    private func gate(_ url: URL?, _ bundle: String = "com.apple.calculator") -> Result<[String], HandsError> {
        AgentOpenGate.check(app: "Calculator", bundle: bundle, targets: [], handoff: FileManager.default.temporaryDirectory, appURL: url)
    }
    private func refused(_ r: Result<[String], HandsError>) -> String? {
        if case .failure(let e) = r { return e.message }
        return nil
    }

    func testTheSystemsOwnCalculatorOpens() {
        XCTAssertNil(refused(gate(URL(fileURLWithPath: "/System/Applications/Calculator.app"))))
    }

    func testAnAppThatClaimsCalculatorsIdIsRefused() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let app = dir.appendingPathComponent("Calculator.app")
        let contents = app.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": calculator], format: .xml, options: 0)
        try info.write(to: contents.appendingPathComponent("Info.plist"))
        XCTAssertEqual(refused(gate(app)), "Calculator: it is not the copy that came with macOS (\(AgentAppCopy.path(app)))")
        // A link in the system folder's name, or no bundle at all, is refused the same way.
        XCTAssertNotNil(refused(gate(URL(fileURLWithPath: "/System/Applications/../../private/tmp/Calculator.app"))))
        XCTAssertNotNil(refused(gate(nil)))
    }

    func testAnotherAppOfTheSystemsIsNotCalculator() {
        XCTAssertEqual(refused(gate(URL(fileURLWithPath: "/System/Applications/TextEdit.app"))), "Calculator: its code is not signed by Apple as this app")
    }
}
