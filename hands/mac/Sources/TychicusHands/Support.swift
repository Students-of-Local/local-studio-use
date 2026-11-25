import AppKit
import HandsCore

// What the hands code used from the app it came from, cut down to what a stdio helper needs. Each type keeps the
// name the hands code calls, so those files stay close to their history.

/// Where the helper keeps its files: `~/.local/share/tychicus/hands` (TYCHICUS_HANDS_HOME overrides it, for tests).
enum Wire {
    static var supportDir: URL {
        if let home = ProcessInfo.processInfo.environment["TYCHICUS_HANDS_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/tychicus", isDirectory: true)
    }

    /// What `open` answers the router with: the shape an app session's reply has.
    struct Reply {
        var ok: Bool
        var error: String?
        var info: [String: String]?
        init(ok: Bool, error: String? = nil, info: [String: String]? = nil) { self.ok = ok; self.error = error; self.info = info }
    }
}

enum Spaces {
    /// Where moved-in windows are recorded (`HandsMovedIn`).
    static var folder: URL { Wire.supportDir }
}

/// A log on stderr, which the MCP client keeps out of the conversation. Quiet unless TYCHICUS_HANDS_TRACE=1.
enum Trace {
    static let on = ProcessInfo.processInfo.environment["TYCHICUS_HANDS_TRACE"] == "1"
    static func log(_ s: String) {
        guard on else { return }
        FileHandle.standardError.write(Data("tychicus-hands: \(s)\n".utf8))
    }
}

/// Processes this helper started for an agent (`open`). Each is kept with its start time, so a pid macOS reuses for
/// one of the person's apps is never taken for it, and dropped when it quits.
final class AgentOwned {
    static let shared = AgentOwned()
    private let lock = NSLock()
    private var set = AgentOwnedSet()

    init() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.remove(app.processIdentifier)
        }
    }

    /// When the process started, in seconds (the kernel's record for this pid).
    static func startTime(_ pid: Int32) -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let t = info.kp_proc.p_un.__p_starttime
        return Double(t.tv_sec) + Double(t.tv_usec) / 1_000_000
    }

    func add(_ pid: Int32) {
        guard let t = Self.startTime(pid) else { return }
        lock.lock(); set.add(pid, startedAt: t); lock.unlock()
    }
    func remove(_ pid: Int32) { lock.lock(); set.remove(pid); lock.unlock() }
    /// The processes still running that are the ones started for an agent.
    var pids: Set<Int32> {
        lock.lock(); let all = set; lock.unlock()
        return all.pids.filter { all.contains($0, startedAt: Self.startTime($0)) }
    }
}

enum SessionController {
    /// An app by bundle ID, path, or name ("TextEdit", "textedit").
    static func appURL(_ name: String) -> URL? {
        if let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return u }
        if name.hasSuffix(".app"), FileManager.default.fileExists(atPath: name) { return URL(fileURLWithPath: name) }
        let dirs = ["/Applications", NSHomeDirectory() + "/Applications", "/System/Applications", "/System/Applications/Utilities"]
        for d in dirs {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: d) else { continue }
            if let hit = names.first(where: { $0.lowercased() == name.lowercased() + ".app" }) { return URL(fileURLWithPath: d).appendingPathComponent(hit) }
        }
        return nil
    }
}

/// A window manager may bench apps that stop answering Accessibility; this helper asks every time, so there is nothing to clear.
enum Windows {
    static func markResponsive(_ pid: pid_t) {}
}

/// Where an agent's cursor last acted. The helper draws no agent cursor, so no shot carries one.
struct CursorMark: Equatable {
    var point: CGPoint
    var windowFrame: CGRect?
}

enum ShotComposite {
    static func draw(_ c: CursorMark, onto: CGImage, windowFrame: CGRect, scale: CGFloat) -> CGImage? { nil }
}

extension AXUIElement {
    var windowID: UInt32? { BackgroundAX.windowID(of: self) }

    func value<T>(_ attribute: String) -> T? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(self, attribute as CFString, &raw) == .success else { return nil }
        return raw as? T
    }

    func string(_ attribute: String) -> String? { value(attribute) }
    func bool(_ attribute: String) -> Bool { (value(attribute) as NSNumber?)?.boolValue ?? false }
}
