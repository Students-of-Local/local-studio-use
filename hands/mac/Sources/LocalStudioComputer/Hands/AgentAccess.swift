import Foundation
import HandsCore

/// The agent access mode, read by the hands on any thread. Local Studio's helper has no Settings window and no consent
/// sheet yet, so nothing here widens access: the saved value (`defaults write local-studio-computer agentAccessMode read_only`)
/// can narrow it to Read Only, and anything else, Full Access included, reads as Default.
final class AgentAccess {
    static let shared = AgentAccess()
    /// Read from the saved value on every call, so Read Only stops a helper that is already running.
    private let saved = SavedAccessMode { UserDefaults.standard.string(forKey: AgentAccessMode.defaultsKey) }

    private init() {
        if current != .standard { Trace.log("agent access at launch: \(current.rawValue) (saved)") }
    }

    var current: AgentAccessMode { saved.current }
}
