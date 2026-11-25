import Foundation
import Virtualization

/// machine.json in the guest folder, written by the CLI.
struct Spec: Codable {
	var cpus: Int = 2
	var memoryMiB: UInt64 = 1024
	var width: Int = 1280
	var height: Int = 800
}

struct VMError: Error, CustomStringConvertible {
	let description: String
	init(_ description: String) { self.description = description }
}

/// Replace `dst` with an APFS copy-on-write clone of `src`.
func cloneReplace(_ src: URL, _ dst: URL) throws {
	let tmp = dst.appendingPathExtension("tmp")
	unlink(tmp.path)
	guard clonefile(src.path, tmp.path, 0) == 0 else {
		throw VMError("clonefile \(src.lastPathComponent): \(String(cString: strerror(errno))) (the guest folder must be on APFS)")
	}
	guard rename(tmp.path, dst.path) == 0 else { throw VMError("rename \(tmp.lastPathComponent): \(String(cString: strerror(errno)))") }
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

/// One guest. Every Virtualization call runs on the main queue, which owns the VM.
@MainActor
final class Guest: NSObject, VZVirtualMachineDelegate {
	let dir: URL
	let spec: Spec
	var vm: VZVirtualMachine?
	/// starting, running, stopping, failed
	var state = "starting"
	/// cold, ready (restored from the reset point) or session (restored from `down`)
	var bootKind = ""
	var error: String?
	var notes: [String] = []
	var timings: [String: Double] = [:]
	var saveSupported = false
	let started = now()
	/// Each VM runs on its own clone of efi.vars: a VM that is still stopping keeps its store locked.
	var instance = 0
	var liveEfi: URL?

	nonisolated var disk: URL { dir.appendingPathComponent("disk.raw") }
	nonisolated var readyDisk: URL { dir.appendingPathComponent("ready.raw") }
	nonisolated var readyState: URL { dir.appendingPathComponent("ready.vzvmsave") }
	nonisolated var sessionState: URL { dir.appendingPathComponent("session.vzvmsave") }

	nonisolated init(dir: URL) throws {
		self.dir = dir
		let specFile = dir.appendingPathComponent("machine.json")
		spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: specFile))
		super.init()
		for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix("efi.vars.run") {
			unlink(dir.appendingPathComponent(name).path)
		}
	}

	func file(_ name: String) -> URL { dir.appendingPathComponent(name) }

	/// The configuration is rebuilt for every VM: a disk attachment opens its file when created, and
	/// reset swaps the file underneath.
	func configuration() throws -> VZVirtualMachineConfiguration {
		let config = VZVirtualMachineConfiguration()
		config.cpuCount = spec.cpus
		config.memorySize = spec.memoryMiB * 1024 * 1024

		let platform = VZGenericPlatformConfiguration()
		let idFile = file("machine.id")
		if let data = try? Data(contentsOf: idFile), let id = VZGenericMachineIdentifier(dataRepresentation: data) {
			platform.machineIdentifier = id
		} else {
			try platform.machineIdentifier.dataRepresentation.write(to: idFile)
		}
		config.platform = platform

		let loader = VZEFIBootLoader()
		let vars = file("efi.vars")
		if !exists(vars) { _ = try VZEFIVariableStore(creatingVariableStoreAt: vars, options: []) }
		instance += 1
		let live = file("efi.vars.run\(instance)")
		try cloneReplace(vars, live)
		liveEfi = live
		loader.variableStore = VZEFIVariableStore(url: live)
		config.bootLoader = loader

		let root = try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false, cachingMode: .automatic, synchronizationMode: .fsync)
		var storage: [VZStorageDeviceConfiguration] = [VZVirtioBlockDeviceConfiguration(attachment: root)]
		let seed = file("seed.iso")
		if FileManager.default.fileExists(atPath: seed.path) {
			let attachment = try VZDiskImageStorageDeviceAttachment(url: seed, readOnly: true)
			storage.append(VZVirtioBlockDeviceConfiguration(attachment: attachment))
		}
		config.storageDevices = storage

		let net = VZVirtioNetworkDeviceConfiguration()
		net.attachment = VZNATNetworkDeviceAttachment()
		let macFile = file("mac")
		if let text = try? String(contentsOf: macFile, encoding: .utf8), let mac = VZMACAddress(string: text.trimmingCharacters(in: .whitespacesAndNewlines)) {
			net.macAddress = mac
		} else {
			try net.macAddress.string.write(to: macFile, atomically: true, encoding: .utf8)
		}
		config.networkDevices = [net]

		config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
		config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
		config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
		let gpu = VZVirtioGraphicsDeviceConfiguration()
		gpu.scanouts = [VZVirtioGraphicsScanoutConfiguration(widthInPixels: spec.width, heightInPixels: spec.height)]
		config.graphicsDevices = [gpu]

		let console = VZVirtioConsoleDeviceSerialPortConfiguration()
		console.attachment = try VZFileSerialPortAttachment(url: file("console.log"), append: false)
		config.serialPorts = [console]

		try config.validate()
		return config
	}

	func makeVM() throws -> VZVirtualMachine {
		let config = try configuration()
		do {
			try config.validateSaveRestoreSupport()
			saveSupported = true
		} catch {
			saveSupported = false
			note("saved state is not supported here (\(error.localizedDescription)); reset cold boots instead")
		}
		let machine = VZVirtualMachine(configuration: config)
		machine.delegate = self
		vm = machine
		return machine
	}

	func note(_ text: String) {
		if !notes.contains(text) { notes.append(text) }
		FileHandle.standardError.write("\(text)\n".data(using: .utf8)!)
	}

	func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

	/// `--from-ready`: make disk.raw from the reset point. clonefile never overwrites, so a disk that exists is
	/// refused: only `reset` replaces disk.raw.
	nonisolated func createDiskFromReady() throws {
		guard clonefile(readyDisk.path, disk.path, 0) == 0 else {
			switch errno {
			case EEXIST: throw VMError("disk.raw exists, and --from-ready never overwrites it; reset the guest first")
			case ENOENT: throw VMError("no reset point yet: the guest has not reached ready once")
			default: throw VMError("clonefile ready.raw: \(String(cString: strerror(errno)))")
			}
		}
		// A saved session belongs to the disk that is gone.
		unlink(sessionState.path)
	}

	/// Start the guest from the session `down` saved, else cold boot disk.raw as it stands, however the last run
	/// ended. With fromReady, disk.raw was just made from the reset point, so its saved memory fits.
	func boot(cold: Bool, fromReady: Bool) async {
		do {
			if cold { unlink(sessionState.path) }
			if !cold, exists(sessionState) {
				let machine = try makeVM()
				try await restore(machine, from: sessionState)
				unlink(sessionState.path)
				bootKind = "session"
			} else if fromReady, exists(readyState) {
				let machine = try makeVM()
				try await restore(machine, from: readyState)
				bootKind = "ready"
			} else {
				guard exists(disk) else { throw VMError("no disk.raw in \(dir.path); --from-ready makes one from the reset point") }
				let machine = try makeVM()
				try await machine.start()
				bootKind = "cold"
			}
			timings["startMs"] = now() - started
		} catch {
			fault("could not start the guest: \(error.localizedDescription)")
			return
		}
		let firstReady = !exists(readyDisk)
		Thread.detachNewThread { [self] in
			do {
				try Agent.waitReady(self, timeout: 300)
				if firstReady {
					// The reset point is taken once boot has settled: cloud-init done, systemd idle, disks
					// synced. The pause waits for the last vsock connection to finish closing.
					let settle = "cloud-init status --wait >/dev/null 2>&1; systemctl is-system-running --wait >/dev/null 2>&1; sync; true"
					_ = try Agent.call(self, cmd: settle, timeout: 300)
					usleep(200_000)
				}
			} catch {
				Task { @MainActor in self.fault("the guest never became ready: \(error)") }
				return
			}
			Task { @MainActor in await self.becameReady() }
		}
	}

	func becameReady() async {
		timings["readyMs"] = now() - started
		if !exists(readyDisk) {
			// First ready state on a fresh clone: keep it as the reset point.
			let t0 = now()
			do { try await capture() } catch { note("could not save the reset point: \(error.localizedDescription)") }
			timings["captureMs"] = now() - t0
		}
		state = "running"
	}

	/// Pause, save the machine state, clone the disk as it stands, resume. The paused disk matches the
	/// saved memory, so the pair restores together.
	func capture() async throws {
		guard let machine = vm else { return }
		try await machine.pause()
		var failure: Error?
		do {
			if saveSupported {
				let tmp = dir.appendingPathComponent("ready.vzvmsave.tmp")
				unlink(tmp.path)
				try await machine.saveMachineStateTo(url: tmp)
				try cloneReplace(disk, readyDisk)
				guard rename(tmp.path, readyState.path) == 0 else { throw VMError("rename ready state") }
			} else {
				try cloneReplace(disk, readyDisk)
			}
		} catch {
			failure = error
		}
		try await machine.resume()
		if let failure { throw failure }
	}

	func restore(_ machine: VZVirtualMachine, from url: URL) async throws {
		try await machine.restoreMachineStateFrom(url: url)
		try await machine.resume()
	}

	func fault(_ message: String) {
		error = message
		state = "failed"
		note(message)
		DispatchQueue.main.asyncAfter(deadline: .now() + 3) { exit(1) }
	}

	/// Reset needs a running guest with a reset point: during the first boot, or after a failed capture, it is refused.
	func checkResettable() throws {
		guard state == "running" else { throw VMError("the guest is \(state); reset waits until it is ready") }
		guard exists(readyDisk) else { throw VMError("no reset point yet: the guest has not reached ready once") }
	}

	/// Back to the reset point. With saved state that is a restore; without, a cold boot of the clean disk.
	func reset() async throws -> [String: Any] {
		guard exists(readyDisk) else { throw VMError("no reset point yet: the guest has not reached ready once") }
		let t0 = now()
		state = "resetting"
		// The old guest is frozen, not stopped: stopping takes 0.1 to 2 s, so it stops after the new one
		// runs. It keeps writing to its own disk inode, which the rename below unlinks.
		let old = vm
		let oldEfi = liveEfi
		if let old, old.state == .running { try await old.pause() }
		vm = nil
		defer {
			if let old {
				Task { @MainActor in
					try? await old.stop()
					if let oldEfi { unlink(oldEfi.path) }
				}
			}
		}
		unlink(sessionState.path)
		try cloneReplace(readyDisk, disk)
		let machine = try makeVM()
		timings["resetCloneMs"] = now() - t0
		if saveSupported, exists(readyState) {
			try await restore(machine, from: readyState)
			bootKind = "ready"
		} else {
			note("saved state is unsupported: reset cold boots the clean disk")
			try await machine.start()
			bootKind = "cold"
		}
		timings["resetStartMs"] = now() - t0
		return ["since": t0]
	}

	/// Save the session (or shut down where saving isn't supported) and stop.
	func down() async throws {
		guard let machine = vm else { return }
		state = "stopping"
		// A start, restore or capture under way finishes first: stopped halfway, its session would be lost.
		for _ in 0..<100 where bootKind.isEmpty || ![.running, .stopped, .error].contains(machine.state) {
			try await Task.sleep(nanoseconds: 100_000_000)
		}
		if saveSupported, machine.state == .running {
			try await machine.pause()
			let tmp = dir.appendingPathComponent("session.vzvmsave.tmp")
			unlink(tmp.path)
			try await machine.saveMachineStateTo(url: tmp)
			try await machine.stop()
			guard rename(tmp.path, sessionState.path) == 0 else { throw VMError("rename session state") }
		} else {
			if machine.canRequestStop { try machine.requestStop() }
			for _ in 0..<200 where machine.state != .stopped {
				try await Task.sleep(nanoseconds: 100_000_000)
			}
			if machine.state != .stopped { try await machine.stop() }
		}
		vm = nil
		if let live = liveEfi {
			try cloneReplace(live, file("efi.vars"))
			unlink(live.path)
		}
	}

	func status() -> [String: Any] {
		var out: [String: Any] = [
			"ok": true, "state": state, "boot": bootKind, "saveSupported": saveSupported,
			"pid": Int(getpid()), "timings": timings, "notes": notes,
		]
		if let vm { out["vm"] = ["stopped", "running", "paused", "error", "starting", "pausing", "resuming", "stopping", "saving", "restoring"][min(vm.state.rawValue, 9)] }
		if let error { out["error"] = error }
		return out
	}

	nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
		Task { @MainActor in
			guard self.vm === virtualMachine else { return }
			self.note("the guest powered off")
			exit(0)
		}
	}

	nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
		Task { @MainActor in
			guard self.vm === virtualMachine else { return }
			self.fault("the guest stopped: \(error.localizedDescription)")
		}
	}
}
