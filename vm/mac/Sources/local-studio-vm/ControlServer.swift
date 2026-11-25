import Foundation

/// Run `body` on the main actor and wait for it. Called only from server threads.
final class ResultBox<T>: @unchecked Sendable { var result: Result<T, Error>? }

func onMain<T>(_ body: @escaping @MainActor () async throws -> T) throws -> T {
	let box = ResultBox<T>()
	let done = DispatchSemaphore(value: 0)
	Task { @MainActor in
		do { box.result = .success(try await body()) } catch { box.result = .failure(error) }
		done.signal()
	}
	done.wait()
	return try box.result!.get()
}

/// The control socket: one JSON request line per connection, one JSON reply line. Owner-only (0600),
/// in the guest folder. Each connection gets a thread that blocks in read, so an idle helper uses no CPU.
final class ControlServer: @unchecked Sendable {
	let path: String
	let guest: Guest
	let listener: Int32
	/// Reset and down change the VM; one at a time.
	let changing = NSLock()

	init(path: String, guest: Guest) throws {
		self.path = path
		self.guest = guest
		var addr = sockaddr_un()
		addr.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(path.utf8)
		guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw VMError("socket path too long: \(path)") }
		withUnsafeMutableBytes(of: &addr.sun_path) { raw in
			raw.copyBytes(from: bytes)
			raw[bytes.count] = 0
		}
		unlink(path)
		listener = socket(AF_UNIX, SOCK_STREAM, 0)
		guard listener >= 0 else { throw VMError("socket: \(String(cString: strerror(errno)))") }
		let old = umask(0o077)
		defer { umask(old) }
		let bound = withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
		}
		guard bound == 0, listen(listener, 16) == 0 else { throw VMError("bind \(path): \(String(cString: strerror(errno)))") }
	}

	func run() {
		Thread.detachNewThread { [self] in
			while true {
				let client = accept(listener, nil, nil)
				if client < 0 {
					if errno == EINTR { continue }
					return
				}
				Thread.detachNewThread { [self] in serve(client) }
			}
		}
	}

	func serve(_ fd: Int32) {
		defer { close(fd) }
		var exitAfter = false
		let reply: [String: Any]
		do {
			let line = try Agent.readLine(fd)
			guard let request = try JSONSerialization.jsonObject(with: line) as? [String: Any], let op = request["op"] as? String else {
				throw VMError("bad request")
			}
			(reply, exitAfter) = try handle(op, request)
		} catch {
			let current = try? onMain { self.guest.status() }
			reply = ["ok": false, "error": "\(error)", "state": current?["state"] ?? "unknown"]
		}
		var data = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data("{\"ok\":false}".utf8)
		data.append(0x0A)
		try? Agent.writeAll(fd, data)
		if exitAfter {
			unlink(path)
			exit(0)
		}
	}

	func handle(_ op: String, _ request: [String: Any]) throws -> ([String: Any], Bool) {
		switch op {
		case "status":
			return (try onMain { self.guest.status() }, false)
		case "exec":
			guard let cmd = request["cmd"] as? String else { throw VMError("exec needs cmd") }
			try requireRunning()
			var reply = try Agent.call(guest, cmd: cmd, timeout: request["timeout"] as? Double ?? 60)
			reply["ok"] = true
			return (reply, false)
		case "shot":
			guard let out = request["path"] as? String else { throw VMError("shot needs path") }
			try requireRunning()
			return (try Agent.shot(guest, to: out), false)
		case "reset":
			changing.lock()
			defer { changing.unlock() }
			let t0 = now()
			// Refusals come before the guest is touched, so they leave it running.
			try onMain { try self.guest.checkResettable() }
			do {
				_ = try onMain { try await self.guest.reset() }
				try Agent.waitReady(guest, timeout: 300)
			} catch {
				_ = try? onMain { self.guest.fault("reset failed: \(error)") }
				throw error
			}
			let total = now() - t0
			let status = try onMain {
				self.guest.timings["resetMs"] = total
				self.guest.state = "running"
				return self.guest.status()
			}
			return (status, false)
		case "down":
			let t0 = now()
			try down()
			return (["ok": true, "downMs": now() - t0], true)
		default:
			throw VMError("unknown op \(op)")
		}
	}

	/// Save the session and stop the guest. On success the lock stays held: the helper exits next.
	func down() throws {
		changing.lock()
		do {
			try onMain { try await self.guest.down() }
		} catch {
			changing.unlock()
			throw error
		}
	}

	/// SIGTERM and SIGINT (logout, shutdown, kill) do what the down request does, then exit.
	func downOnSignals() -> [DispatchSourceSignal] {
		[SIGTERM, SIGINT].map { sig in
			signal(sig, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
			source.setEventHandler { [self] in
				var code: Int32 = 0
				do {
					try down()
				} catch {
					FileHandle.standardError.write("could not save the session: \(error)\n".data(using: .utf8)!)
					code = 1
				}
				unlink(path)
				exit(code)
			}
			source.resume()
			return source
		}
	}

	func requireRunning() throws {
		let state = try onMain { self.guest.state }
		guard state == "running" else { throw VMError("the guest is \(state)") }
	}
}
