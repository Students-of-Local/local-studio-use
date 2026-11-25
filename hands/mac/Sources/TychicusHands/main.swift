import AppKit
import HandsCore

// `tychicus-hands mcp [--connector]`: Tychicus's computer-use helper, a stdio MCP server speaking the hands protocol
// (docs/hands-protocol.md in the Tychicus repo). Its tools act on Mac apps in the background through Accessibility.
// `--connector` is for an assistant on another machine: never more than Default access, and no managing verbs.

let usage = "usage: tychicus-hands mcp [--connector]\n"
let version = "0.1.0"

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "--version", "version":
    print("tychicus-hands \(version)")
    exit(0)
case "mcp":
    break
default:
    FileHandle.standardError.write(Data(usage.utf8))
    exit(2)
}
let connector = args.dropFirst().contains("--connector")
if let extra = args.dropFirst().first(where: { $0 != "--connector" }) {
    FileHandle.standardError.write(Data("tychicus-hands: unknown option \(extra)\n\(usage)".utf8))
    exit(2)
}

// No Dock icon, no menu bar, never the active app: a background helper.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

// The engine's state folder, set before any engine queue exists (setenv isn't safe against other threads).
HandsEngine.prepareEnvironment()

let host = TychicusHost(workspace: NoAgentWorkspace())
let router = connector ? HandsRouter(cap: { $0.forRemote }, remote: true) : HandsRouter()
router.host = host.hands
_ = AgentLaunchFocus.shared
_ = AgentOwned.shared

var server = HandsMCP(version: version, session: "\(connector ? "connector" : "mcp"):\(getpid())",
                      perform: { router.handleRequest($0) },
                      readImage: { FileManager.default.contents(atPath: $0) })
server.grants = { AccessibilityGrant.report() }
if connector {
    server.name = HandsCaller.connectorServerName
    server.refuse = { WorkspaceVerbs.connectorRefusal(verb: $0) }
}

// Requests are read and answered one at a time off the main thread; the router hops to the main thread for the host,
// which the run loop below serves (launch callbacks and app notifications arrive there too).
let reader = Thread {
    setvbuf(stdout, nil, _IOLBF, 0)
    while let line = readLine(strippingNewline: true) {
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
        if let reply = server.handle(line) { print(reply); fflush(stdout) }
    }
    exit(0)
}
reader.start()
RunLoop.main.run()
