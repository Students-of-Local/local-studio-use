import AppKit
import HandsCore

/// The `HandsHost` a stdio helper can give: windows from Accessibility and the window server, the agent workspace from
/// `AgentWorkspace` (none yet), and `open` as a separate copy started in the background. Main thread only,
/// like every `HandsHost` closure.
final class TychicusHost {
    /// The number the agent workspace has when no window manager keeps one: what `windows` reports as agent_workspace.
    static let ownWorkspace = 9
    /// The number every other window gets: somewhere that isn't the agent workspace.
    static let elsewhere = 1

    private let workspace: AgentWorkspace
    /// Windows this helper already asked the agent workspace to move, so each is asked once.
    private var askedToMove = Set<UInt32>()
    private var bundles: [Int32: (startedAt: Double?, bundle: String)] = [:]
    private var last: [HandsWindow] = []
    private var known = KnownWindows()
    private let launcher: AgentAppLauncher = SystemAppLauncher()

    init(workspace: AgentWorkspace) { self.workspace = workspace }

    var hands: HandsHost {
        var h = HandsHost()
        h.agentWorkspace = { [self] in workspace.windows()?.workspace ?? Self.ownWorkspace }
        h.windows = { [self] in scan() }
        h.freshWindows = { [self] in scan() }
        h.live = { [self] id in scan().first { $0.id == id } }
        h.titles = { [self] ids in titles(ids) }
        h.inspect = { [self] id in inspect(id) }
        h.agentOwned = { AgentOwned.shared.pids }
        h.open = { [self] args in open(args) }
        h.agentShown = { false }
        h.close = { [self] id in pressClose(id) }
        return h
    }

    // MARK: windows

    /// Every top-level window: those of processes this helper started, and those the agent workspace lists, on the
    /// agent workspace; the rest elsewhere. A window of ours it hasn't placed yet is asked over once.
    private func scan() -> [HandsWindow] {
        let managed = workspace.windows()
        let agent = managed?.workspace ?? Self.ownWorkspace
        let owned = AgentOwned.shared.pids
        var ours = Set<UInt32>()
        for pid in owned { ours.formUnion(standardWindows(of: pid)) }
        if let managed {
            for id in ours.subtracting(managed.ids) where !askedToMove.contains(id) {
                askedToMove.insert(id)
                let moved = workspace.move(id)
                Trace.log("asked the agent workspace to move window \(id) to the agent workspace: \(moved ? "moved" : "refused")")
            }
        }
        let onAgent = ours.union(managed?.ids ?? [])
        let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        var out: [HandsWindow] = []
        var seen = Set<UInt32>()
        for w in info {
            guard let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0, pid != getpid(), !seen.contains(id) else { continue }
            // Another process's window that isn't on the agent workspace is listed only so scope can refuse it by name.
            // Of our own processes, only their standard windows are placed: a sheet, dialog or panel is a child window
            // (workspace nil), which the router decides on itself.
            if owned.contains(pid), !ours.contains(id) { continue }
            seen.insert(id)
            let app = w[kCGWindowOwnerName as String] as? String ?? ""
            out.append(HandsWindow(id: id, pid: pid, app: app, bundle: bundle(pid), title: "", workspace: onAgent.contains(id) ? agent : Self.elsewhere))
        }
        // An agent window the window server lists under no layer-0 entry yet (still starting): placed all the same.
        for id in onAgent where !seen.contains(id) {
            guard let owner = ChildWindowsAX.owner(id) else { continue }
            out.append(HandsWindow(id: id, pid: owner.pid, app: owner.name, bundle: bundle(owner.pid), title: "", workspace: agent))
        }
        last = out
        return out
    }

    private func bundle(_ pid: Int32) -> String {
        let started = AgentOwned.startTime(pid)
        if let b = bundles[pid], b.startedAt == started { return b.bundle }
        let b = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        // Not known yet (still starting) isn't kept, and one kept is for this process, not a later one with its pid.
        if !b.isEmpty { bundles[pid] = (started, b) }
        return b
    }

    /// The standard windows a process lists in Accessibility, by window id.
    private func standardWindows(of pid: Int32) -> Set<UInt32> {
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.25)
        var raw: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &raw)
        var standard: Set<UInt32>? = code == .success || code == .noValue ? [] : nil
        var unread = Set<UInt32>()
        for el in raw as? [AXUIElement] ?? [] {
            AXUIElementSetMessagingTimeout(el, 0.25)
            guard let id = el.windowID else { continue }
            guard let subrole = el.string(kAXSubroleAttribute) else { unread.insert(id); continue }
            if subrole == kAXStandardWindowSubrole as String { standard?.insert(id) }
        }
        return known.windows(pid: pid, startedAt: AgentOwned.startTime(pid), read: standard, unread: unread) { HandsRouter.listedWindows(of: pid) }
    }

    private func element(_ id: UInt32) -> (element: AXUIElement, pid: Int32)? {
        let pid = last.first { $0.id == id }?.pid ?? ChildWindowsAX.owner(id)?.pid
        guard let pid, let e = ChildWindowsAX.element(pid: pid, id: id) else { return nil }
        AXUIElementSetMessagingTimeout(e, 0.25)
        return (e, pid)
    }

    private func titles(_ ids: [UInt32]) -> [UInt32: String] {
        var out: [UInt32: String] = [:]
        for id in ids { if let e = element(id), let t = e.element.string(kAXTitleAttribute) { out[id] = t } }
        return out
    }

    /// What a window shows (AXDocument), whether it is an Open or Save panel, and whether its app answered both. One its app
    /// doesn't show to Accessibility now (a hung app) isn't readable; it is read again on the next use.
    private func inspect(_ id: UInt32) -> (document: String?, panel: Bool, readable: Bool) {
        guard let (e, pid) = element(id) else { return (nil, false, false) }
        let document = HandsAXTree.document(e)
        guard document.readable, HandsAXTree.children(e).readable else { return (nil, false, false) }
        return (document.path, HandsAXTree.offLimits(e, bundle: bundle(pid)), true)
    }

    /// `close`: presses the window's close button from behind (no raise, no activation). False when it has none. An app that
    /// asks something in a dialog before it answers was pressed: `close` reads back what came of it.
    private func pressClose(_ id: UInt32) -> Bool {
        guard let (e, _) = element(id), let button: AXUIElement = e.value(kAXCloseButtonAttribute) else { return false }
        AXUIElementSetMessagingTimeout(button, 1)
        let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
        return result == .success || result == .cannotComplete
    }

    // MARK: open

    /// `open <app> [files…]`: a separate copy of an app on the list, started without activating, nothing restored. The
    /// router has checked the app and the files; they are checked here again, as an app session would for every caller.
    private func open(_ args: [String]) -> Wire.Reply {
        let mode = AgentAccess.shared.current
        let n = workspace.windows()?.workspace ?? Self.ownWorkspace
        guard let name = args.first, let url = SessionController.appURL(name) else { return .init(ok: false, error: "no app called \(args.first ?? "")") }
        let appName = url.deletingPathExtension().lastPathComponent
        let bundle = Bundle(url: url)?.bundleIdentifier ?? ""
        let launch: AgentLaunchRequest
        switch AgentOpenGate.check(app: appName, bundle: bundle, targets: Array(args.dropFirst()), handoff: HandsRouter.handoffFolder, appURL: url,
                                   mode: mode) {
        case .failure(let e): return .init(ok: false, error: e.message, info: ["code": e.code.rawValue, "suggestion": e.suggestion])
        case .success(let paths): launch = AgentLaunchRequest(app: url, paths: paths)
        }
        guard AgentAppPolicy.needsSeparateInstance(bundle: bundle) else {
            return .init(ok: false, error: "\(appName) isn't an app an agent starts", info: ["code": "needs_sandbox"])
        }
        let before = Set(NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }.map(\.processIdentifier))
        AgentActivity.shared.markLaunch(bundle: bundle, excluding: before, for: 10)
        AgentLaunchFocus.shared.watch(bundle: bundle, excluding: before, for: 10)
        let token = AgentLaunches.shared.current
        launcher.launch(launch) { app in
            DispatchQueue.main.async {
                AgentActivity.shared.clearLaunch(bundle: bundle)
                guard let app, !before.contains(app.processIdentifier) else { return }
                let pid = app.processIdentifier
                AgentOwned.shared.add(pid)
                AgentLaunches.shared.launched(token, pid: pid)
                AgentActivity.shared.markLaunch(pid: pid, for: 8)
                AgentLaunchFocus.shared.watch(pid: pid, for: 8)
                Trace.log("open: \(appName) started as pid \(pid)")
            }
        }
        return .init(ok: true, info: ["workspace": "\(n)", "app": appName, "note": "starting a separate copy; its window opens there in a moment"])
    }
}
