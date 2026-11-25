import AppKit
import HandsCore

/// Child windows (dialogs, alerts, sheets, palettes an app raises) and the verbs that let an agent manage its own workspace
/// (`workspaces`, `arrange`, `move`, `close`). Donovan, 2026-11-10: "make it so spaces can be managed by the agents so they
/// can start windows in a BG if they so choose so the user doesnt have to deal with it". Every rule here is in the core:
/// `ChildWindowRule`, `ChildAttribution`, `WorkspaceVerbs`, `AgentArrange`, `SessionWindows`. Nothing here switches the
/// shown workspace, focuses or raises a window, or quits an app.
extension HandsRouter {
    func childLocked<T>(_ f: () -> T) -> T { childLock.lock(); defer { childLock.unlock() }; return f() }

    // MARK: child windows

    /// One process's child windows, read now (off the main thread), each seen by the attribution book.
    func readChildren(pid: Int32, all: [HandsWindow]) -> ChildWindowsAX.Reading {
        let placed = Set(all.filter { $0.pid == pid }.map(\.id))
        var r = ChildWindowsAX.read(pid: pid, placed: placed)
        let now = Date()
        // Each child's window as first seen: its own, else the app's main window when it is also the focused one and usable.
        let agent = onMain { host.agentWorkspace() }
        let usable = r.children.contains { $0.parent == nil } && r.main != nil && r.main == r.focused
            ? Set(all.filter { $0.pid == pid && decide($0, agent).allowed }.map(\.id)) : []
        let hint = ChildCollect.hint(main: r.main, focused: r.focused, usable: usable)
        var firstParents: [UInt32: UInt32] = [:]
        for c in r.children { if let p = c.parent ?? hint { firstParents[c.id] = p } }
        let known = childLocked { () -> [UInt32: UInt32] in
            attribution.observed(Set(r.children.map(\.id)), pid: pid, at: now, parents: firstParents, complete: r.complete)
            attribution.observedSheets(on: r.sheetsOn, pid: pid, at: now, read: r.sheetsRead)
            return r.children.reduce(into: [:]) { m, c in if let p = attribution.parent(of: c.id, pid: pid) { m[c.id] = p } }
        }
        for i in r.children.indices where r.children[i].parent == nil { r.children[i].parent = known[r.children[i].id] }
        return r
    }

    /// A window the host doesn't place, as the engine and the scope checks see it; nil when no process lists it as a
    /// child window (closed, a menu, or unreadable).
    func childWindow(_ id: UInt32) -> HandsWindow? {
        guard let owner = ChildWindowsAX.owner(id) else { return nil }
        // Rule 3 before any accessibility read: a system prompt's window is named from the window server only, and its
        // decision (`childDecision`) refuses it without reading it.
        if ChildWindowsAX.isSystemPrompt(pid: owner.pid, serverName: owner.name) {
            return HandsWindow(id: id, pid: owner.pid, app: owner.name.isEmpty ? "a system prompt" : owner.name, workspace: nil)
        }
        let all = listWindows().windows
        return readChildren(pid: owner.pid, all: all).children.first { $0.id == id }?.window
    }

    /// The decision for one child window of `pid`, read now.
    func childDecision(_ id: UInt32, pid: Int32, agent: Int?, session: String) -> (facts: ChildWindowFacts, decision: ChildWindowRule.Decision)? {
        let all = listWindows().windows
        let running = NSRunningApplication(processIdentifier: pid)
        let bundle = running?.bundleIdentifier ?? "", process = running?.executableURL?.lastPathComponent ?? ""
        let serverName = ChildWindowsAX.owner(id).map { $0.pid == pid ? $0.name : "" } ?? ""
        // Rule 3 before reading anything of it: a system prompt's window is never read for an agent.
        if ChildWindowsAX.isSystemPrompt(pid: pid, serverName: serverName) {
            let named = ChildWindowRule.isSystemPrompt(bundle: bundle, processName: process) ? process : serverName
            let facts = ChildWindowFacts(id: id, pid: pid, app: running?.localizedName ?? named, bundle: bundle, processName: named)
            return (facts, ChildWindowRule.decide(facts, placed: [], attributed: false, selfPid: getpid()))
        }
        guard let facts = readChildren(pid: pid, all: all).children.first(where: { $0.id == id }) else { return nil }
        return (facts, decideChild(facts, all: all, agent: agent, session: session))
    }

    func decideChild(_ c: ChildWindowFacts, all: [HandsWindow], agent: Int?, session: String) -> ChildWindowRule.Decision {
        decideChildren([c], all: all, agent: agent, session: session)[0].decision
    }

    /// sol-F1: a window that fails inspection now (an outside document, a file panel) authorizes no child of it. Each
    /// process's windows are inspected once for all its children.
    func decideChildren(_ cs: [ChildWindowFacts], all: [HandsWindow], agent: Int?, session: String) -> [(facts: ChildWindowFacts, decision: ChildWindowRule.Decision)] {
        ChildWindowRule.decideEach(cs, placed: { pid in
            ChildWindowRule.inspected(all.filter { $0.pid == pid }.map { (window: $0, scope: decide($0, agent, session: session)) }) { inspectProblem($0) }
        }, decide: { c, placed in
            let attributed = childLocked { attribution.attributed(c.id, pid: c.pid, session: session) }
            return ChildWindowRule.decide(c, placed: placed, attributed: attributed, selfPid: getpid())
        })
    }

    /// `windows`: the child windows of these processes, decided, and which placed windows hold a sheet with no number.
    func children(ofPids pids: Set<Int32>, all: [HandsWindow], agent: Int?, session: String)
        -> (rows: [(facts: ChildWindowFacts, decision: ChildWindowRule.Decision)], sheetsOn: [UInt32: Int]) {
        let list = Array(pids)
        var readings = [ChildWindowsAX.Reading](repeating: .init(children: [], sheetsOn: [:]), count: list.count)
        let lock = NSLock()
        // On the main thread one at a time: each read waits on main (`onMain`), which concurrentPerform would hold.
        if Thread.isMainThread { for i in list.indices { readings[i] = readChildren(pid: list[i], all: all) } } else {
            DispatchQueue.concurrentPerform(iterations: list.count) { i in
                let r = readChildren(pid: list[i], all: all)
                lock.lock(); readings[i] = r; lock.unlock()
            }
        }
        let facts = readings.flatMap(\.children).sorted { $0.id < $1.id }
        return (decideChildren(facts, all: all, agent: agent, session: session), readings.reduce(into: [UInt32: Int]()) { $0.merge($1.sheetsOn) { a, _ in a } })
    }

    /// sol-F1: a placed window of an app split between the agent and Donovan, holding a sheet this session's action didn't
    /// raise (`ChildWindowRule.sheetOnWindowRefusal`). Nothing to read when the app isn't split.
    func sheetProblem(_ w: HandsWindow, agent: Int?, session: String) -> HandsError? {
        // Most windows hold no sheet: then nothing else is read (round 1 first-F2, round 2 first-F2).
        if ChildWindowRule.noSheetToCheck(sheets: BackgroundAX.sheetCount(pid: w.pid, window: w.id)) { return nil }
        let all = listWindows().windows
        // sol-F2: split as the child rule sees it, each window inspected too, so an outside document makes the app split.
        let placed = ChildWindowRule.inspected(all.filter { $0.pid == w.pid }.map { (window: $0, scope: decide($0, agent, session: session)) }) { inspectProblem($0) }
        guard placed.contains(where: { !$0.scope.allowed }) else { return nil }
        let r = readChildren(pid: w.pid, all: all)
        let attributed = childLocked { () -> [Bool] in
            (r.sheetsOn[w.id].map { [attribution.sheetAttributed(on: w.id, sheet: $0, pid: w.pid, session: session)] } ?? [])
                + r.children.filter { $0.parent == w.id && $0.kind == .sheet }.map { attribution.attributed($0.id, pid: w.pid, session: session) }
        }
        return ChildWindowRule.sheetOnWindowRefusal(window: w, sheetsAttributed: attributed, split: true)
    }

    /// Right before an action on `pid`: the child windows it has now, recorded as this session's action, and a watch that
    /// looks again every half second for 10 s so a dialog the action raises is seen within the window.
    func noteAction(session: String, pid: Int32) -> Set<UInt32> {
        let all = listWindows().windows
        let read = ChildWindowsAX.read(pid: pid, placed: Set(all.filter { $0.pid == pid }.map(\.id)))
        let existing = Set(read.children.map(\.id))
        let now = Date()
        // The action is recorded first, so a running watch sees it before deciding to stop; a pid has one watch at most.
        let start = childLocked { () -> Bool in
            attribution.acted(session: session, pid: pid, at: now, existing: existing, sheetsOn: read.sheetsOn)
            return childWatchers.insert(pid).inserted
        }
        if start { watch(pid: pid) }
        return existing
    }

    /// Looks every half second while an action on `pid` is under 10 s old, then slower while one of its children is
    /// someone's, up to `ChildAttribution.watchFor` after the last action (`watchDelay`); a later action extends this watch.
    private func watch(pid: Int32, after delay: TimeInterval = ChildAttribution.watchFast) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            let next = self.childLocked { () -> TimeInterval? in
                if let d = self.attribution.watchDelay(pid: pid, now: Date()) { return d }
                self.childWatchers.remove(pid)
                return nil
            }
            guard let next else { return }
            _ = self.readChildren(pid: pid, all: self.listWindows().windows)
            self.watch(pid: pid, after: next)
        }
    }

    /// After an action: the child windows that appeared since `before`, and the numberless sheets this session's action
    /// raised, looked for up to 200 ms. Nil when none did.
    func openedChildren(pid: Int32, before: Set<UInt32>, session: String) -> JSONValue? {
        let deadline = Date().addingTimeInterval(0.2)
        var first: Set<OpenedPoll.Mark>?
        repeat {
            let server = Set(MenuAX.serverWindows(pid: pid).map { OpenedPoll.Mark(id: $0.id, onScreen: $0.onScreen) })
            defer { if first == nil { first = server } }
            guard OpenedPoll.reads(now: server, first: first) else { Thread.sleep(forTimeInterval: 0.05); continue }
            let all = listWindows().windows
            let r = readChildren(pid: pid, all: all)
            let new = r.children.filter { !before.contains($0.id) }
            let sheets = childLocked { attribution.openedSheets(r.sheetsOn, pid: pid, session: session) }
            if !new.isEmpty || !sheets.isEmpty {
                let agent = onMain { host.agentWorkspace() }
                let usable = decideChildren(new, all: all, agent: agent, session: session).filter(\.decision.allowed).map { ChildWindowList.opened($0.facts) }
                    + sheets.sorted().map(ChildWindowList.openedSheet(on:))
                return usable.isEmpty ? nil : (usable.count == 1 ? usable[0] : .array(usable))
            }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        return nil
    }

    static func busy(_ app: String, verb: String) -> HandsError {
        HandsError(.inUse, "another action on \(app) is still running", suggestion: "Try `\(verb)` again when it has answered.", retry: .safe)
    }

    func close(_ req: HandsRequest) -> HandsEnvelope {
        let session = req.session ?? ""
        switch target(req) {
        case .failure(let e):
            // A panel this session's `menu` raised that the app keeps out of sight: say why it can't close (#309).
            guard e.code == .windowNotFound, let id = req.int("window").flatMap({ UInt32(exactly: $0) }),
                  let h = childLocked({ hiddenPanels[id] }), h.session == session,
                  let p = MenuAX.serverWindows(pid: h.pid).first(where: { $0.id == id }), !p.onScreen else { return .failure(e) }
            return .failure(HiddenPanel.closeRefusal(p, app: h.app))
        case .success(let (w, scope, _)):
            resolvePendingOpens(all: listWindows().windows, agent: onMain { host.agentWorkspace() })
            if let e = childLocked({ WorkspaceVerbs.closeRefusal(window: w, session: session, opened: sessionWindows) }) { return .failure(e) }
            if let e = awaitUse(w, verb: "close", delivery: .posted, wait: req.int("wait"), session: session) { return .failure(e) }
            let before = noteAction(session: session, pid: w.pid)
            if let e = actingCheck(w, verb: "close", delivery: .posted, session: session)() { return .failure(e) }
            let token = AgentActivity.shared.begin(pid: w.pid, window: w.id)
            defer { AgentActivity.shared.end(token) }
            // Read Only, scope and in use, read again in the pass that presses the button.
            let pressed: Bool
            // On the process's queue, so the press never falls inside a background action's transaction on it (sol-F1).
            let busy = HandsError(.inUse, "another action on \(w.app) is still running", suggestion: "Try `close` again when it has answered.", retry: .safe)
            // The main thread never waits (the work needs it to finish): there it refuses at once.
            switch HandsEngine.shared.serialized(pid: w.pid, wait: Thread.isMainThread ? 0 : 10, { [self] cancelled in
                mutateOnMain([w], verb: "close", session: session, perform: { _ in cancelled() ? .failure(busy) : .success(host.close(w.id)) })
            }) ?? .failure(busy) {
            case .failure(let e): return .failure(e)
            case .success(let p): pressed = p
            }
            guard pressed else {
                return .failure(HandsError(.notSupported, "window \(w.id) of \(w.app) has no close button Tychicus can press",
                                           suggestion: "Leave it open; Tychicus never quits an app for an agent.", retry: .never))
            }
            var data: [String: JSONValue] = ["window": .int(Int(w.id)), "app": .string(w.app), "pressed": "close", "target": targetJSON(w, scope)]
            if let opened = openedChildren(pid: w.pid, before: before, session: session) {
                data["opened"] = opened
                data["note"] = "the app asked something before closing: answer the sheet or dialog in opened"
            } else {
                // Read back from the window server until the window is gone, then one fresh scan: one look 0.2 s after the
                // press answered `closed: false` for windows already gone (`CloseReadback`).
                // A closed panel stays in the window server, ordered out: the app showing it no more is the read back.
                let gone = CloseReadback.gone(mainThread: Thread.isMainThread,
                                              listed: { w.workspace == nil ? !ChildWindowsAX.closed(pid: w.pid, id: w.id) : Self.serverLists(w.id) },
                                              inModel: { onMain { host.freshWindows().contains { $0.id == w.id } } })
                data["closed"] = .bool(gone)
                Trace.log("agent close: window \(w.id) of \(w.app) \(gone ? "closed" : "still open after the press")")
                if gone { childLocked { sessionWindows.forget(window: w.id) } }
            }
            return .success(.object(data))
        }
    }
}
