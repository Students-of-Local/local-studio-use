import AppKit
import HandsCore

/// Records every app the workspace activates, for as long as it lives. An action holds one from planning to the end
/// of its verification: an activation of the target or of any other app in that span is a focus-guard failure, however
/// briefly it lasted and whenever it was noticed.
final class ActivationWatch {
    private let lock = NSLock()
    private var pids: [Int32] = []
    private var token: NSObjectProtocol?

    init() {
        token = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.lock.lock(); self?.pids.append(app.processIdentifier); self?.lock.unlock()
        }
    }

    deinit { stop() }

    func stop() {
        if let t = token { NSWorkspace.shared.notificationCenter.removeObserver(t); token = nil }
    }

    var activated: [Int32] { lock.lock(); defer { lock.unlock() }; return pids }
}

/// A listen-only tap on the session's keyboard, mouse and scroll events for the length of one action: what it sees
/// tells Donovan's hand (source process 0) from anything else, and shows whether one of our own events reached the
/// session. It is made only when Input Monitoring is already granted (`CGPreflightListenEventAccess`, which never asks):
/// creating a tap without it can put the permission prompt on Donovan's screen. Without it `stop()` answers nil and the
/// pointer check falls back to the pointer's own position and the system's idle clock (`IdleWatch`).
final class SessionTap {
    private let lock = NSLock()
    private var seen: [SessionEvent] = []
    private var port: CFMachPort?
    private var loop: CFRunLoop?
    private(set) var available = false
    /// The tap was turned off while it watched.
    private var lost = false

    init() {
        guard CGPreflightListenEventAccess() else { return }
        let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged,
                                    .otherMouseDown, .otherMouseUp, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [self] in
            let info = Unmanaged.passUnretained(self).toOpaque()
            guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
                                              callback: { _, type, event, info in
                                                  if let info { Unmanaged<SessionTap>.fromOpaque(info).takeUnretainedValue().record(type, event) }
                                                  return Unmanaged.passUnretained(event)
                                              }, userInfo: info) else { ready.signal(); return }
            port = tap
            loop = CFRunLoopGetCurrent()
            available = true
            CFRunLoopAddSource(loop, CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        thread.start()
        ready.wait()
    }

    fileprivate func record(_ type: CGEventType, _ event: CGEvent) {
        // macOS turned the tap off: events may be missing, so this action has no tap evidence.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock(); lost = true; lock.unlock()
            return
        }
        let passive: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        let key = type == .keyDown || type == .keyUp
        let activates = key ? event.flags.contains(.maskCommand) : !passive.contains(type)
        lock.lock(); defer { lock.unlock() }
        seen.append(SessionEvent(sourcePid: event.getIntegerValueField(.eventSourceUnixProcessID), canActivate: activates))
    }

    /// What the tap has seen so far (nil without a tap).
    var snapshot: [SessionEvent]? {
        guard available else { return nil }
        lock.lock(); defer { lock.unlock() }
        return lost ? nil : seen
    }

    func stop() -> [SessionEvent]? {
        guard available else { return nil }
        if let loop { CFRunLoopStop(loop) }
        if let port { CFMachPortInvalidate(port) }
        lock.lock(); defer { lock.unlock() }
        return lost ? nil : seen
    }
}

/// The stand-in for the tap when Input Monitoring is not granted: the seconds since the last hardware event, read
/// from the system's own clock before and after. A shorter time afterwards than the time that passed means a hardware
/// event happened in between. (An event posted to a process may also reset the clock; then a pointer move is excused
/// that should not be, which is why the evidence says `pointer_check: idle_fallback`.)
struct IdleWatch {
    private let startedAt = Date()
    private let idleAtStart = IdleWatch.idle()
    static func idle() -> Double { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!) }
    /// Events as the audit wants them: one hardware event if the clock was reset since the start, none otherwise.
    var events: [SessionEvent] {
        let elapsed = Date().timeIntervalSince(startedAt)
        return IdleWatch.idle() < idleAtStart + elapsed - 0.25 ? [SessionEvent(sourcePid: 0, canActivate: false)] : []
    }
    /// Whether a hardware event happened since the start.
    var hardwareSeen: Bool { !events.isEmpty }
}
