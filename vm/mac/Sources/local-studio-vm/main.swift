// local-studio-vm: runs one Linux guest on Virtualization.framework, with no window and no Dock icon.
//
//   local-studio-vm serve <guest-dir> [--cold | --from-ready]
//       start the guest, then answer on <guest-dir>/control.sock: resume the saved session, else cold boot disk.raw.
//       --cold drops the session; --from-ready makes a missing disk.raw from the reset point and starts there.
//   local-studio-vm focus-watch
//       print one line per app activation on the host until stopped
//   local-studio-vm version
//
// The local-studio-browser CLI (cli/src/vm.ts) prepares the guest folder and talks to the control socket.

import AppKit
import Foundation

let version = "0.2.1"

func fail(_ message: String, code: Int32 = 1) -> Never {
	FileHandle.standardError.write("local-studio-vm: \(message)\n".data(using: .utf8)!)
	exit(code)
}

// A client that hangs up before its reply must not kill the helper, and the guest with it.
signal(SIGPIPE, SIG_IGN)

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "serve":
	guard args.count >= 2 else { fail("usage: local-studio-vm serve <guest-dir> [--cold | --from-ready]", code: 2) }
	let dir = URL(fileURLWithPath: args[1], isDirectory: true)
	let cold = args.dropFirst(2).contains("--cold")
	let fromReady = args.dropFirst(2).contains("--from-ready")
	guard !(cold && fromReady) else { fail("--cold and --from-ready exclude each other", code: 2) }
	let guest: Guest
	do {
		guest = try Guest(dir: dir)
		if fromReady { try guest.createDiskFromReady() }
	} catch {
		fail("\(error)")
	}
	let server: ControlServer
	do {
		server = try ControlServer(path: dir.appendingPathComponent("control.sock").path, guest: guest)
	} catch {
		fail("\(error)")
	}
	let signals = server.downOnSignals()
	server.run()
	Task { @MainActor in await guest.boot(cold: cold, fromReady: fromReady) }
	withExtendedLifetime(signals) { dispatchMain() }
case "focus-watch":
	// Counts host focus changes during a bench run. Each activation prints the app's bundle id.
	setvbuf(stdout, nil, _IOLBF, 0)
	let center = NSWorkspace.shared.notificationCenter
	let token = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
		let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
		print("activated \(app?.bundleIdentifier ?? "unknown")")
	}
	signal(SIGTERM, SIG_IGN)
	let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
	term.setEventHandler {
		center.removeObserver(token)
		exit(0)
	}
	term.resume()
	print("watching")
	withExtendedLifetime(term) { RunLoop.main.run() }
case "version", "--version":
	print(version)
default:
	fail("usage: local-studio-vm serve <guest-dir> [--cold | --from-ready] | focus-watch | version", code: 2)
}
