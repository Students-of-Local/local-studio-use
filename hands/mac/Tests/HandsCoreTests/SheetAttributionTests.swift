import XCTest
import HandsCore

/// A sheet with no window number of its own is known by its accessibility element, not by the window it sits on (review of
/// #88, round 2).
final class SheetAttributionTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func book() -> ChildAttribution {
        var a = ChildAttribution()
        a.acted(session: "s1", pid: 7, at: t0, existing: [])
        a.observedSheets(on: [5: 100], pid: 7, at: t0.addingTimeInterval(1))
        return a
    }

    func testASheetASessionRaisedIsThatSessions() {
        let a = book()
        XCTAssertTrue(a.sheetAttributed(on: 5, sheet: 100, pid: 7, session: "s1"))
        XCTAssertFalse(a.sheetAttributed(on: 5, sheet: 100, pid: 7, session: "s2"))
        XCTAssertEqual(a.openedSheets([5: 100], pid: 7, session: "s1"), [5])
    }

    /// Between two looks the sheet closed and another came up: it inherits nothing.
    func testAnotherSheetOnTheSameWindowIsNotInherited() {
        var a = book()
        XCTAssertFalse(a.sheetAttributed(on: 5, sheet: 200, pid: 7, session: "s1"), "before any look has seen it")
        XCTAssertEqual(a.openedSheets([5: 200], pid: 7, session: "s1"), [])
        for at in stride(from: 2.0, through: 12, by: 1) { a.observedSheets(on: [5: 100], pid: 7, at: t0.addingTimeInterval(at)) }
        a.observedSheets(on: [5: 200], pid: 7, at: t0.addingTimeInterval(13))
        XCTAssertFalse(a.sheetAttributed(on: 5, sheet: 200, pid: 7, session: "s1"))
        XCTAssertFalse(a.sheetAttributed(on: 5, sheet: 100, pid: 7, session: "s1"), "the first one is gone")
        // Back within reach of a new action, but there before it.
        a.acted(session: "s1", pid: 7, at: t0.addingTimeInterval(14), existing: [], sheetsOn: [5: 200])
        a.observedSheets(on: [5: 200], pid: 7, at: t0.addingTimeInterval(15))
        XCTAssertFalse(a.sheetAttributed(on: 5, sheet: 200, pid: 7, session: "s1"))
        XCTAssertEqual(a.openedSheets([5: 200], pid: 7, session: "s1"), [])
    }

    /// The action that answers one sheet and raises the next owns the next.
    func testASheetThatTakesThePlaceOfOneThereBeforeTheActionIsTheActions() {
        var a = ChildAttribution()
        a.observedSheets(on: [5: 100], pid: 7, at: t0)
        a.acted(session: "s1", pid: 7, at: t0.addingTimeInterval(1), existing: [], sheetsOn: [5: 100])
        a.observedSheets(on: [5: 200], pid: 7, at: t0.addingTimeInterval(1.5))
        XCTAssertEqual(a.openedSheets([5: 200], pid: 7, session: "s1"), [5])
    }
}
