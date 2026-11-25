import AppKit
import Darwin
import HandsCore

/// The Accessibility grant, and the program macOS checks it against. macOS doesn't ask about local-studio-computer itself but
/// about the process responsible for it: the app it runs under (Terminal, an agent's app) or, for a background service,
/// the program launchd started. The person has to allow that one, so the messages name it and say where it lives.
enum AccessibilityGrant {
    /// The program the grant belongs to: an app's name and bundle path, or a plain program's name and path.
    struct Program: Equatable {
        var name: String
        var path: String
        /// A plain program (not an app bundle). Signed ad hoc like local-studio-computer, macOS matches it by its hash, so each
        /// update needs the grant again.
        var plain: Bool
    }

    /// Whether this process may read and act on other apps' windows, asked of macOS on every call, not once at start.
    static var granted: Bool { AXIsProcessTrusted() }

    /// The permission_denied error for a missing grant, or nil when it is there.
    static func problem() -> HandsError? {
        granted ? nil : missing()
    }

    /// The error that says exactly what the person has to allow, and where.
    static func missing() -> HandsError {
        let program = responsibleProgram()
        let who = program.path == ownPath ? "it" : "local-studio-computer"
        let message = "macOS hasn't allowed \(program.name) to use Accessibility, so \(who) can't read or act on windows"
        return HandsError(.permissionDenied, message, suggestion: suggestion(program), retry: .safe)
    }

    /// The steps, for the person, in System Settings' own words.
    static func suggestion(_ program: Program) -> String {
        let open = "Ask the person to open System Settings > Privacy & Security > Accessibility and turn on \(program.name) (\(program.path))."
        let why = program.path == ownPath ? "" : " macOS asks about \(program.name) because local-studio-computer runs under it."
        let add = program.plain
            ? " If it isn't listed, click +, press Cmd-Shift-G, paste that path and click Open." + (program.path == ownPath ? " It is signed ad hoc, so after each update macOS treats it as new: if it is listed and on already, select it, click - and add it again." : "")
            : " If it isn't listed, click + and choose it."
        return open + why + add + " Then try again."
    }

    /// `hands/grants` and `grants --json`, live: every grant the helper looks at, and the ones it can't work without that are
    /// missing (Local Studio's computer_status reads those to say what to do; Screen Recording is only for pictures).
    static func report() -> JSONValue {
        let program = responsibleProgram()
        let accessibility = granted
        let recording = CGPreflightScreenCaptureAccess()
        let error = missing()
        let absent: [JSONValue] = accessibility ? [] : [.object([
            "grant": "accessibility",
            "message": .string(error.message),
            "suggestion": .string(error.suggestion),
            "program": .object(["name": .string(program.name), "path": .string(program.path)]),
        ])]
        return .object(["missing": .array(absent), "grants": .array([
            grant("Accessibility", accessibility, accessibility ? "macOS allows \(program.name) to use Accessibility" : error.message),
            grant("Screen Recording", recording, recording ? "macOS allows \(program.name) to record the screen" : WindowShot.notAllowed(program)),
        ])])
    }

    private static func grant(_ name: String, _ ok: Bool, _ text: String) -> JSONValue {
        .object(["name": .string(name), "ok": .bool(ok), "text": .string(text)])
    }

    // MARK: The responsible process

    private static var ownPath: String { path(of: getpid()) ?? CommandLine.arguments[0] }

    /// The program macOS asks about for this process.
    static func responsibleProgram() -> Program {
        let pid = responsiblePid()
        let exe = path(of: pid) ?? ownPath
        return program(at: exe)
    }

    /// An executable's program: the outermost app bundle it sits in (a helper app inside an app counts as that app),
    /// or the executable itself.
    static func program(at exe: String) -> Program {
        if let range = exe.range(of: ".app/") {
            let bundle = String(exe[..<range.lowerBound]) + ".app"
            var name = FileManager.default.displayName(atPath: bundle)
            if name.hasSuffix(".app") { name.removeLast(4) }
            return Program(name: name, path: bundle, plain: false)
        }
        return Program(name: (exe as NSString).lastPathComponent, path: exe, plain: true)
    }

    private typealias ResponsibleFor = @convention(c) (pid_t) -> pid_t

    /// The responsible process: libsystem's `responsibility_get_pid_responsible_for_pid` where it exists (not public API,
    /// so looked up at run time); otherwise the topmost ancestor below launchd, which is what macOS picks for a process
    /// tree started from an app or a service.
    private static func responsiblePid() -> pid_t {
        let me = getpid()
        if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") {
            let pid = unsafeBitCast(symbol, to: ResponsibleFor.self)(me)
            if pid > 0 { return pid }
        }
        var pid = me
        for _ in 0..<64 {
            let parent = parentPid(of: pid)
            if parent <= 1 { break }
            pid = parent
        }
        return pid
    }

    private static func parentPid(of pid: pid_t) -> pid_t {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? pid_t(info.pbi_ppid) : 0
    }

    private static func path(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
    }
}
