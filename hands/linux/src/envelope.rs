//! The envelope every tools/call answers with (docs/hands-protocol.md, "The envelope"). Keys come out sorted because
//! serde_json's map is a BTreeMap.

use serde_json::{json, Value};

/// The protocol's whole list of codes. A few belong to other platforms' helpers (a Mac's agent workspace switched off,
/// an app name that matches two apps), so this one never builds them.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    OutsideAgentWorkspace,
    AgentWorkspaceOff,
    AppNotFound,
    WindowNotFound,
    AmbiguousWindow,
    Ambiguous,
    NeedsLend,
    NeedsSandbox,
    InUse,
    UnknownRef,
    StaleRef,
    AmbiguousTarget,
    StaleBareRow,
    NotSupported,
    ActionFailed,
    Unverified,
    Timeout,
    PermissionDenied,
    BadArguments,
    NotRunning,
    EngineError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    Safe,
    AfterSnapshot,
    Never,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::OutsideAgentWorkspace => "outside_agent_workspace",
            Code::AgentWorkspaceOff => "agent_workspace_off",
            Code::AppNotFound => "app_not_found",
            Code::WindowNotFound => "window_not_found",
            Code::AmbiguousWindow => "ambiguous_window",
            Code::Ambiguous => "ambiguous",
            Code::NeedsLend => "needs_lend",
            Code::NeedsSandbox => "needs_sandbox",
            Code::InUse => "in_use",
            Code::UnknownRef => "unknown_ref",
            Code::StaleRef => "stale_ref",
            Code::AmbiguousTarget => "ambiguous_target",
            Code::StaleBareRow => "stale_bare_row",
            Code::NotSupported => "not_supported",
            Code::ActionFailed => "action_failed",
            Code::Unverified => "unverified",
            Code::Timeout => "timeout",
            Code::PermissionDenied => "permission_denied",
            Code::BadArguments => "bad_arguments",
            Code::NotRunning => "not_running",
            Code::EngineError => "engine_error",
        }
    }

    /// The protocol's default retry for the code.
    pub fn default_retry(self) -> Retry {
        match self {
            Code::StaleRef
            | Code::UnknownRef
            | Code::AmbiguousTarget
            | Code::AmbiguousWindow
            | Code::StaleBareRow => Retry::AfterSnapshot,
            Code::Timeout
            | Code::NotRunning
            | Code::AppNotFound
            | Code::WindowNotFound
            | Code::BadArguments
            | Code::PermissionDenied
            | Code::Ambiguous
            | Code::InUse => Retry::Safe,
            _ => Retry::Never,
        }
    }
}

impl Retry {
    pub fn as_str(self) -> &'static str {
        match self {
            Retry::Safe => "safe",
            Retry::AfterSnapshot => "after_snapshot",
            Retry::Never => "never",
        }
    }
}

#[derive(Clone, Debug)]
pub struct HandsError {
    pub code: Code,
    pub message: String,
    pub retry: Retry,
    pub suggestion: String,
    pub next_call: Option<Value>,
}

impl HandsError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        HandsError {
            code,
            message: message.into(),
            retry: code.default_retry(),
            suggestion: String::new(),
            next_call: None,
        }
    }
    pub fn suggest(mut self, s: impl Into<String>) -> Self {
        self.suggestion = s.into();
        self
    }
    pub fn retry(mut self, r: Retry) -> Self {
        self.retry = r;
        self
    }
    pub fn next(mut self, tool: &str, arguments: Value) -> Self {
        self.next_call = Some(json!({ "tool": tool, "arguments": arguments }));
        self
    }

    pub fn to_value(&self) -> Value {
        let suggestion = if self.suggestion.is_empty() {
            default_suggestion(self.code)
        } else {
            self.suggestion.clone()
        };
        json!({
            "ok": false,
            "error": {
                "code": self.code.as_str(),
                "message": self.message,
                "retry": self.retry.as_str(),
                "suggestion": suggestion,
                "next_call": self.next_call.clone().unwrap_or(Value::Null),
            }
        })
    }
}

fn default_suggestion(code: Code) -> String {
    match code {
        Code::BadArguments => "usage: see this tool's inputSchema in tools/list.",
        Code::WindowNotFound => "List the windows you may use with windows.",
        Code::OutsideAgentWorkspace => "Work in a window an agent opened (open), or ask the person to lend the app.",
        Code::NotSupported => "Use a ref from a fresh snapshot and a verb the element offers (click, type, set_value, toggle, select).",
        Code::PermissionDenied => "The person sets agent access in Local Studio's config (hands.json, access).",
        Code::NotRunning => "Start the desktop session and its accessibility bus (at-spi), then try again.",
        Code::InUse => "Wait until the person leaves the app, or pass a longer wait.",
        _ => "See docs/hands-protocol.md.",
    }
    .to_string()
}

pub type HResult<T> = Result<T, HandsError>;

pub fn ok(data: Value) -> Value {
    json!({ "ok": true, "data": data })
}

pub fn bad(message: impl Into<String>) -> HandsError {
    HandsError::new(Code::BadArguments, message)
        .suggest("usage: see this tool's inputSchema in tools/list.")
}
