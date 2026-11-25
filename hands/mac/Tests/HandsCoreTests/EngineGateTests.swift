import XCTest
import HandsCore

/// Review of #90: what must hold right before anything is sent to an app.
final class EngineGateTests: XCTestCase {
    private func error(_ code: HandsErrorCode, retry: HandsRetry = .safe) -> HandsError { HandsError(code, "x", suggestion: "", retry: retry) }

    func testARefusingScopeMeansNoAttempt() {
        var attempts = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .success(1) }, stop: { self.error(.inUse) },
                                                         cancelled: { false }, giveUp: Date(), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(attempts, 0)
    }

    func testACallerThatLeftMeansNoAttempt() {
        var attempts = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .success(1) }, stop: { nil },
                                                         cancelled: { true }, giveUp: Date(), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .timeout)
        XCTAssertEqual(attempts, 0)
    }

    func testTheScopeIsReadAgainBeforeARetry() {
        var attempts = 0, checks = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .failure(self.error(.timeout)) },
                                                         stop: { checks += 1; return checks > 1 ? self.error(.inUse) : nil },
                                                         cancelled: { false }, giveUp: Date().addingTimeInterval(60), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(attempts, 1)
    }

    func testTheSavedAccessModeIsReadOnEveryCall() {
        var saved: String?
        let mode = SavedAccessMode { saved }
        XCTAssertEqual(mode.current, .standard)
        saved = "read_only"
        XCTAssertEqual(mode.current, .readOnly)
        saved = "full"
        XCTAssertEqual(mode.current, .standard)
    }

    func testAWindowItsAppDidNotAnswerForIsRefusedForThisUseOnly() {
        let seen = WindowInspection.decide(full: true, agentOwned: true, panel: false, readable: false, document: nil, handoff: URL(fileURLWithPath: "/tmp"))
        XCTAssertEqual(seen, .unreadable)
        XCTAssertFalse(seen.remembered)
    }

    func testAMenuWatchWhoseLastLookCouldNotReadTheAppIsUnknown() {
        let watch = MenuWatch<Int>(every: 0.01, watch: 0.05)
        watch.start { _ in watch.looked(read: false); return nil }
        XCTAssertEqual(watch.finish(), .unknown)
        let read = MenuWatch<Int>(every: 0.01, watch: 0.05)
        read.start { settled in read.looked(read: settled); return nil }
        XCTAssertEqual(read.finish(), .quiet)
    }

    func testEveryStepOfAPressIsCheckedRightBeforeItIsPosted() {
        var checks = 0, posted: [Int] = []
        let e = KeySteps.run(["a", "b", "c"], check: { checks += 1; return checks > 1 ? Result<Int, HandsError>.failure(self.error(.needsSandbox)) : .success(checks) },
                             post: { i, _, _ in posted.append(i); return nil })
        XCTAssertEqual(posted, [0])
        XCTAssertEqual(e?.retry, .never)
        XCTAssertTrue(e?.message.contains("1 of 3 steps landed") ?? false)
    }

    func testAnAppThatDoesNotAnswerKeepsTheWindowsItShowed() {
        var known = KnownWindows()
        func read(_ ids: Set<UInt32>?, unread: Set<UInt32> = [], startedAt: Double = 1, listed: Set<UInt32> = [1, 2, 3]) -> Set<UInt32> {
            known.windows(pid: 7, startedAt: startedAt, read: ids, unread: unread) { listed }
        }
        XCTAssertEqual(read(nil), [])
        XCTAssertEqual(read([1, 2]), [1, 2])
        XCTAssertEqual(read(nil), [1, 2])
        XCTAssertEqual(read(nil, listed: [2, 3]), [2])
        XCTAssertEqual(read([], unread: [2, 3]), [2])
        XCTAssertEqual(read(nil, startedAt: 2), [])
    }

    func testACopyThatMayHaveAWindowIsNotQuit() {
        func decide(shown: Set<UInt32>?, listed: Set<UInt32>, dialog: Bool = false) -> OpenMiss {
            OpenMiss.decide(launched: 7, agentStarted: [7], startedAt: 10, requestStart: 9, held: 0,
                            unread: OpenMiss.unread(shown: shown, listed: listed, dialog: dialog))
        }
        XCTAssertEqual(decide(shown: nil, listed: []), .leave)
        XCTAssertEqual(decide(shown: [], listed: [4]), .leave)
        XCTAssertEqual(decide(shown: [4], listed: [4]), .quit(pid: 7))
        XCTAssertEqual(decide(shown: [4], listed: [4, 5], dialog: true), .quit(pid: 7))
    }

    func testAHelpersWindowIsNeverClosed() {
        func window(_ id: UInt32, pid: Int32, bundle: String? = nil, parent: Int32? = nil) -> MenuPath.Listed {
            MenuPath.Listed(id: id, pid: pid, owner: "x", visible: true, workspace: 1, bundle: bundle, parent: parent)
        }
        let now = [window(1, pid: 7), window(2, pid: 8, parent: 7), window(3, pid: 9, bundle: "com.apple.print.PrinterProxy")]
        let found = MenuPath.escaped(before: [], now: now, pid: 7, agentWorkspace: 9, settled: true, parent: nil)
        XCTAssertEqual(found.map(\.tied), [true, true, false])
        XCTAssertEqual(found.map { MenuPath.mayClose($0, now: now, pid: 7) }, [true, true, false])
        // Its number is another process's now.
        XCTAssertFalse(MenuPath.mayClose(found[0], now: [window(1, pid: 9)], pid: 7))
    }
}
