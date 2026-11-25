import XCTest
import HandsCore

/// An element whose children may fail to read, as an app that stopped answering Accessibility gives them.
private final class Element {
    let attributes: [String: String]
    let children: [Element]
    let readable: Bool

    init(_ role: String, _ more: [String: String] = [:], children: [Element] = [], readable: Bool = true) {
        attributes = more.merging(["AXRole": role]) { $1 }
        self.children = children
        self.readable = readable
    }
}

/// `PanelDetector.inspect` is what lets a placed window through the Open and Save panel check, so a window it could not
/// read is refused (review of #88, sol-F1).
final class PanelInspectTests: XCTestCase {
    private func inspect(_ root: Element, bundle: String = "com.example.app") -> Bool {
        PanelDetector.inspect(root, bundle: bundle, string: { $0.attributes[$1] }, children: { ($0.children, $0.readable) })
    }

    private let window = ["AXSubrole": "AXStandardWindow", "AXTitle": "Untitled"]

    func testWindowWhoseChildrenCouldNotBeReadIsRefused() {
        XCTAssertTrue(inspect(Element("AXWindow", window, readable: false)))
    }

    /// System Settings' window is judged as a window though it answers AXDialog; a failed read refuses it too.
    func testSystemSettingsWhoseChildrenCouldNotBeReadIsRefused() {
        let root = Element("AXWindow", ["AXSubrole": "AXDialog", "AXIdentifier": "Main"], readable: false)
        XCTAssertTrue(inspect(root, bundle: "com.apple.systempreferences"))
    }

    func testReadableWindowWithNoPanelIsAllowed() {
        XCTAssertFalse(inspect(Element("AXWindow", window, children: [Element("AXGroup"), Element("AXButton")])))
        XCTAssertFalse(inspect(Element("AXWindow", window)), "a window that answers with no children was read")
        XCTAssertFalse(inspect(Element("AXWindow", ["AXSubrole": "AXDialog", "AXIdentifier": "Main"], children: [Element("AXSplitGroup")]),
                               bundle: "com.apple.systempreferences"))
    }

    func testReadableWindowWithASaveSheetIsRefused() {
        let sheet = Element("AXSheet", children: [Element("AXTextField"), Element("AXPopUpButton")])
        XCTAssertTrue(inspect(Element("AXWindow", window, children: [Element("AXGroup"), sheet])))
    }

    func testASheetThatCouldNotBeReadIsRefusedAndAReadAlertIsNot() {
        XCTAssertTrue(inspect(Element("AXWindow", window, children: [Element("AXSheet", readable: false)])))
        let alert = Element("AXSheet", children: [Element("AXStaticText"), Element("AXButton")])
        XCTAssertFalse(inspect(Element("AXWindow", window, children: [alert])))
    }

    /// A window with a long flat list of controls still shows the sheet at its end (review of #88, round 2).
    func testASaveSheetPastTheFirstFortyChildrenIsRefused() {
        let buttons = (0..<44).map { _ in Element("AXButton") }
        let sheet = Element("AXSheet", children: [Element("AXTextField"), Element("AXPopUpButton")])
        XCTAssertTrue(inspect(Element("AXWindow", window, children: buttons + [sheet])))
        XCTAssertTrue(inspect(Element("AXWindow", window, children: buttons + [Element("AXSheet", readable: false)])))
        let alert = Element("AXSheet", children: [Element("AXStaticText"), Element("AXButton")])
        XCTAssertFalse(inspect(Element("AXWindow", window, children: buttons + [alert])), "an alert there leaves the window usable")
        XCTAssertFalse(inspect(Element("AXWindow", window, children: buttons)))
        let many = (0...AXTreeRead.windowScan).map { _ in Element("AXButton") }
        XCTAssertTrue(inspect(Element("AXWindow", window, children: many)), "too many to look at each for a sheet")
    }

    /// The menu watch reads five levels with a reader that calls an element without children unreadable. It presses Cancel
    /// on what this check calls a panel, so a part it could not read must not make a window one.
    func testAnUnreadPartOfAWindowIsNotAPanelForTheMenuWatch() {
        let root = Element("AXWindow", window, children: [Element("AXGroup", children: [Element("AXButton", readable: false)])])
        let node = AXTreeRead.node(root, depth: 5, string: { $0.attributes[$1] }, children: { ($0.children, $0.readable) })
        XCTAssertFalse(PanelDetector.windowIsOffLimits(node))
    }
}
