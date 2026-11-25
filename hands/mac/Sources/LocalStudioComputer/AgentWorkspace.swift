import Foundation

/// Where agent windows live. A window manager that keeps an agent workspace can list its windows and move one onto it;
/// none is wired in yet, so the windows of processes this helper started count as the agent's, and nothing moves.
protocol AgentWorkspace {
    /// The agent workspace's number and the ids of the windows on it, or nil when there is none to ask.
    func windows() -> (workspace: Int, ids: Set<UInt32>)?
    /// Asks for window `id` to be moved onto the agent workspace; true when it was.
    func move(_ id: UInt32) -> Bool
}

/// No window manager: nothing is listed and nothing moves.
struct NoAgentWorkspace: AgentWorkspace {
    func windows() -> (workspace: Int, ids: Set<UInt32>)? { nil }
    func move(_ id: UInt32) -> Bool { false }
}
