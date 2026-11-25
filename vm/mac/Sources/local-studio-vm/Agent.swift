import CoreGraphics
import Foundation
import ImageIO
import Virtualization

/// The guest agent: a small Python service cloud-init installs, listening on vsock port 1024. One JSON
/// line in ({"cmd", "timeout"}), one JSON line out ({"code", "stdout", "stderr"}). Calls run on the
/// calling thread and never on the main queue, which owns the VM.
enum Agent {
	static let port: UInt32 = 1024

	/// The result of a connect that may arrive after the caller gave up; a late connection is closed.
	final class Pending: @unchecked Sendable {
		private let lock = NSLock()
		private var abandoned = false
		var result: Result<VZVirtioSocketConnection, Error>?

		func settle(_ value: Result<VZVirtioSocketConnection, Error>) -> Bool {
			lock.lock()
			defer { lock.unlock() }
			if abandoned { return false }
			result = value
			return true
		}

		func abandon() -> Result<VZVirtioSocketConnection, Error>? {
			lock.lock()
			defer { lock.unlock() }
			abandoned = true
			return result
		}
	}

	static func connect(_ guest: Guest, timeout: Double) throws -> VZVirtioSocketConnection {
		let done = DispatchSemaphore(value: 0)
		let pending = Pending()
		Task { @MainActor in
			guard let device = guest.vm?.socketDevices.first as? VZVirtioSocketDevice else {
				_ = pending.settle(.failure(VMError("the guest is not running")))
				done.signal()
				return
			}
			device.connect(toPort: port) { result in
				if !pending.settle(result), case let .success(late) = result { late.close() }
				done.signal()
			}
		}
		if done.wait(timeout: .now() + timeout) == .timedOut {
			if case let .success(conn) = pending.abandon() { conn.close() }
			throw VMError("vsock connect timed out")
		}
		return try pending.result!.get()
	}

	static func call(_ guest: Guest, cmd: String, timeout: Double) throws -> [String: Any] {
		let conn = try connect(guest, timeout: min(timeout, 5))
		defer { conn.close() }
		let fd = conn.fileDescriptor
		var tv = timeval(tv_sec: Int(timeout.rounded(.up)) + 2, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
		setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
		var request = try JSONSerialization.data(withJSONObject: ["cmd": cmd, "timeout": timeout])
		request.append(0x0A)
		try writeAll(fd, request)
		let line = try readLine(fd)
		guard let reply = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw VMError("the guest agent sent no object") }
		return reply
	}

	/// Poll the agent until it answers. Only runs while the guest boots.
	static func waitReady(_ guest: Guest, timeout: Double) throws {
		let deadline = Date().addingTimeInterval(timeout)
		var last: Error = VMError("no answer")
		while Date() < deadline {
			do {
				let reply = try call(guest, cmd: "true", timeout: 3)
				if reply["code"] as? Int == 0 { return }
				last = VMError("the agent answered \(reply)")
			} catch {
				last = error
			}
			usleep(50_000)
		}
		throw last
	}

	/// The guest's framebuffer as a PNG. The console framebuffer (fbdev on virtio-gpu) is what the
	/// display shows until a desktop takes the screen over with its own buffers.
	static func shot(_ guest: Guest, to path: String) throws -> [String: Any] {
		let script = """
		f=/sys/class/graphics/fb0
		[ -e /dev/fb0 ] || { echo "the guest shows no display: its kernel has no framebuffer (/dev/fb0), and Debian's cloud kernel leaves out virtio-gpu" >&2; exit 3; }
		set -- $(sed -n '1s/.*:\\([0-9]*\\)x\\([0-9]*\\).*/\\1 \\2/p' $f/modes) $(cat $f/stride) $(cat $f/bits_per_pixel)
		echo "$1 $2 $3 $4"
		head -c $(($2 * $3)) /dev/fb0 | base64 -w0
		"""
		let reply = try call(guest, cmd: script, timeout: 30)
		guard reply["code"] as? Int == 0, let out = reply["stdout"] as? String else {
			throw VMError((reply["stderr"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "shot failed")
		}
		guard let newline = out.firstIndex(of: "\n") else { throw VMError("no framebuffer header") }
		let header = out[..<newline].split(separator: " ").compactMap { Int($0) }
		guard header.count == 4, header[3] == 32, let pixels = Data(base64Encoded: String(out[out.index(after: newline)...])) else {
			throw VMError("unsupported framebuffer: \(out[..<newline])")
		}
		let (width, height, stride) = (header[0], header[1], header[2])
		guard pixels.count >= height * stride, let provider = CGDataProvider(data: pixels as CFData),
			let image = CGImage(
				width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: stride,
				space: CGColorSpace(name: CGColorSpace.sRGB)!,
				bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue),
				provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
		else { throw VMError("could not read the framebuffer as an image") }
		let url = URL(fileURLWithPath: path)
		guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw VMError("cannot write \(path)") }
		CGImageDestinationAddImage(dest, image, nil)
		guard CGImageDestinationFinalize(dest) else { throw VMError("cannot write \(path)") }
		return ["ok": true, "path": path, "width": width, "height": height]
	}

	static func writeAll(_ fd: Int32, _ data: Data) throws {
		try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
			var off = 0
			while off < buf.count {
				let n = write(fd, buf.baseAddress! + off, buf.count - off)
				if n < 0 {
					if errno == EINTR { continue }
					throw VMError("write: \(String(cString: strerror(errno)))")
				}
				off += n
			}
		}
	}

	/// Read up to the first newline; the connection carries one reply.
	static func readLine(_ fd: Int32) throws -> Data {
		var out = Data()
		var chunk = [UInt8](repeating: 0, count: 65536)
		while true {
			let n = read(fd, &chunk, chunk.count)
			if n < 0 {
				if errno == EINTR { continue }
				throw VMError("read: \(String(cString: strerror(errno)))")
			}
			if n == 0 { break }
			if let nl = chunk[0..<n].firstIndex(of: 0x0A) {
				out.append(contentsOf: chunk[0..<nl])
				return out
			}
			out.append(contentsOf: chunk[0..<n])
		}
		if out.isEmpty { throw VMError("the connection closed with no reply") }
		return out
	}
}
