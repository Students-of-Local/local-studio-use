//! The 17 protocol verbs plus `close`, their schemas for tools/list, and the argument checks that run before anything
//! touches the desktop (docs/hands-protocol.md, "Argument checks").

use crate::envelope::{bad, Code, HResult, HandsError};
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Str,
    Int,
    Bool,
    Strings,
    Objects,
}

pub struct Param {
    pub name: &'static str,
    pub kind: Kind,
    pub help: &'static str,
    pub required: bool,
}

pub struct Tool {
    pub name: &'static str,
    pub summary: &'static str,
    pub params: Vec<Param>,
    pub read_only: bool,
}

const fn p(name: &'static str, kind: Kind, help: &'static str) -> Param {
    Param {
        name,
        kind,
        help,
        required: false,
    }
}
const fn req(name: &'static str, kind: Kind, help: &'static str) -> Param {
    Param {
        name,
        kind,
        help,
        required: true,
    }
}

const REF_HELP: &str =
    "A ref like @s8f3k2p9:e5, or a row number from your latest snapshot, like 5.";
const WAIT_HELP: &str = "Seconds to wait, 0 to 120 (default 10), while the person is using the app; the action goes ahead once the app is free. 0 answers in_use at once.";

/// Verbs a `run_steps` step may name.
pub const STEP_TOOLS: [&str; 10] = [
    "click",
    "type",
    "set_value",
    "press",
    "click_at",
    "drag",
    "scroll",
    "select",
    "toggle",
    "menu",
];
/// Verbs that manage windows. A connector is refused them whether or not they are listed.
pub const MANAGING: [&str; 6] = ["arrange", "move", "close", "switch", "focus", "frame"];

pub fn all() -> Vec<Tool> {
    use Kind::*;
    let mut tools = vec![
        Tool { name: "windows", read_only: true, params: vec![], summary: "List the windows an agent may use now, with their ids: windows of apps an agent opened (open), windows on the agent workspace (Hyprland's special:local-studio-browser), and with Full Access every window. A window of the app the person is using carries in_use: true; reads on it work now, and an action on it waits." },
        Tool { name: "snapshot", read_only: true, summary: "Read one window through accessibility, one row per element: [N] role \"name\" =value (states), indented under its parent. Act on row N with ref \"N\" (this snapshot) or the full ref the header shows. After acting, read again with since: \"latest\" to see only what changed. Example: {\"window\":4211,\"query\":\"Save\"}", params: vec![
            p("app", Str, "App name (as windows lists it). With several of its windows, the newest is read; pass window to choose."),
            p("window", Int, "Window id from windows, open or a previous snapshot."),
            p("query", Str, "Only rows whose role, name or value has this text (any case; several with |), with their parents."),
            p("since", Str, "latest: only rows added (+), changed (~) or removed (-) since your last read of this window."),
            p("max_elements", Int, "At most this many rows (default 400); a last line says how to get the rest."),
            p("format", Str, "rows (default) or json (the tree)."),
            p("interactive", Bool, "Only elements you can act on."),
            p("compact", Bool, "Leave out rows that only name a group (no ref needed to act)."),
            p("depth", Int, "How deep to read (default 30)."),
            p("screenshot", Bool, "Also return a picture of the window (longest side 1280), with how its pixels map to window points."),
            p("zoom", Str, "With screenshot: only this region, x,y,width,height in window points, like \"0,0,400,300\"."),
        ]},
        Tool { name: "find", read_only: true, summary: "Search one window's accessibility tree and return the matching elements with refs. To click an element by its label, skip find: click with window and text does both.", params: vec![
            p("app", Str, "App name."),
            p("window", Int, "Window id."),
            p("role", Str, "Role, like button, textfield or checkbox."),
            p("name", Str, "Part of the accessible name."),
            p("text", Str, "Part of any text the element shows (name or value)."),
            p("value", Str, "Part of its value."),
            p("limit", Int, "At most this many matches (default 20)."),
        ]},
        Tool { name: "get", read_only: true, summary: "Read one property of an element from the live window: value, text, title, role, bounds or states.", params: vec![
            req("ref", Str, REF_HELP),
            p("property", Str, "value (default), text, title, role, bounds or states."),
            p("copy", Bool, "Also hold the text on this session's agent clipboard, for type with paste: true. Never the desktop clipboard."),
        ]},
        Tool { name: "shot", read_only: false, summary: "Capture one window as a PNG, saved in Local Studio's shots folder. Over MCP the picture comes back fitted to 1280 pixels, labeled untrusted, with how its pixels map to window points. Works where the window is on screen (X11, wlroots with grim); GNOME and KDE on Wayland answer not_supported. Example: {\"window\":4211,\"zoom\":\"0,0,400,300\"}", params: vec![
            req("window", Int, "Window id."),
            p("out", Str, "A file name (no folder) for the PNG."),
            p("zoom", Str, "Only this region of the window, x,y,width,height in window points, like \"0,0,400,300\". Crops the MCP image; the saved file stays whole."),
            p("cursor", Bool, "Draw the pointer. Not offered on Linux: the picture is the app itself."),
        ]},
        Tool { name: "click", read_only: false, summary: "Click an element by ref, or by the text it shows in a window, through its accessibility action: no pointer moves and no window is raised. By text it reads the window when it runs and clicks the element whose label is that text (a partial match only when it is the only one); two matches are refused with their refs. Example: {\"ref\":\"12\"} or {\"window\":4211,\"text\":\"Save\"}", params: vec![
            p("ref", Str, "A ref like @s8f3k2p9:e5, or a row number from your latest snapshot. Or pass window and text instead."),
            p("window", Int, "With text: the window id."),
            p("text", Str, "With window: the label of the element to click, as the window shows it."),
            p("role", Str, "With text: only elements of this role, when the text is on more than one."),
            p("button", Str, "left (default). right answers not_supported: Linux gives no background context menu."),
            p("item", Str, "With button right: the context menu item."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "type", read_only: false, summary: "Type text into an element by ref: inserted at its caret through accessibility, never by posting keys. Prints the value it read back. paste: true types what you copied with get. Example: {\"ref\":\"7\",\"text\":\"hello\"}", params: vec![
            req("ref", Str, REF_HELP),
            p("text", Str, "The text."),
            p("paste", Bool, "Type what this session copied (get with copy: true) instead of text."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "set_value", read_only: false, summary: "Replace an element's whole value (a text field, a slider, a spin button). Prints the value it read back.", params: vec![
            req("ref", Str, REF_HELP),
            req("value", Str, "The new value."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "press", read_only: false, summary: "Press keys on an element by ref, without posting input to the desktop: Return and Enter run its activate action, space presses it, ctrl+a selects all its text, BackSpace and Delete edit it, and plain characters are inserted at its caret. Other keys answer not_supported, because Linux gives no way to send them to a window in the background.", params: vec![
            req("ref", Str, REF_HELP),
            req("key", Str, "Key name with optional modifiers, like Return or ctrl+a; several keys separated by spaces (at most 64)."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "click_at", read_only: false, summary: "Click a point in a window, with window-local coordinates: the element under the point does its accessibility action. No pointer moves. A point with no element that can act (a canvas) answers not_supported. Double click: {\"window\":4211,\"x\":120,\"y\":80,\"count\":2}", params: vec![
            req("window", Int, "Window id."),
            req("x", Int, "Points from the window's left edge."),
            req("y", Int, "Points from the window's top edge."),
            p("count", Int, "2 for a double click (the action runs twice), at most 3."),
            p("button", Str, "left (default). right answers not_supported."),
            p("item", Str, "With button right: the context menu item."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "drag", read_only: false, summary: "Drag from one point to another in a window. Answers not_supported on Linux: a drag needs pointer input, which Wayland and X11 give only to the person's own pointer.", params: vec![
            req("window", Int, "Window id."),
            req("x", Int, "Start x."),
            req("y", Int, "Start y."),
            req("x2", Int, "End x."),
            req("y2", Int, "End y."),
            p("steps", Int, "Intermediate moves."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "scroll", read_only: false, summary: "Scroll the view an element is in, by ref, through its scroll bar's value.", params: vec![
            req("ref", Str, REF_HELP),
            req("direction", Str, "up, down, left or right."),
            p("amount", Int, "Notches (default 3)."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "select", read_only: false, summary: "Choose an option in a list, combo box or menu by ref.", params: vec![
            req("ref", Str, REF_HELP),
            req("option", Str, "The text of the option to choose."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "toggle", read_only: false, summary: "Flip a checkbox, switch, toggle button or expander by ref. Prints the state it read back.", params: vec![
            req("ref", Str, REF_HELP),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "menu", read_only: false, summary: "Run a menu-bar command of the window by its titles, through accessibility, without opening the menu on screen. Example: {\"window\":4211,\"path\":\"File > New\"}", params: vec![
            req("window", Int, "Window id."),
            req("path", Str, "Menu titles from the menu bar down, separated by >."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "run_steps", read_only: false, summary: "Several actions in one call, then one read of what changed in the last window. Every step is checked before any runs, and the run stops at the first step that fails, isn't verified or raises a dialog. Steps: click, type, set_value, press, click_at, drag, scroll, select, toggle, menu (at most 32). Example: {\"steps\":[{\"tool\":\"click\",\"args\":{\"ref\":\"5\"}},{\"tool\":\"type\",\"args\":{\"ref\":\"7\",\"text\":\"hi\"}}]}", params: vec![
            req("steps", Objects, "The actions in order, each {tool, args} with the tool's own arguments."),
            p("wait", Int, WAIT_HELP),
        ]},
        Tool { name: "open", read_only: false, summary: "Start an app for agent work, in the background where the window manager allows it (Hyprland: on the hidden agent workspace special:local-studio-browser, no focus change). Answers with the new window's id once the window exists (it waits up to wait seconds, at most 7), and focus: {changed, returned} says whether the window manager focused it and Local Studio gave focus back. Default access opens editors, calculators and viewers, plus apps the person listed in hands.json; apps that hold the person's own data (browsers, mail, chat, files, passwords) answer needs_sandbox.", params: vec![
            req("app", Str, "App: a command name, a desktop file id, or a path the person allowed."),
            p("targets", Strings, "Files in the agent handoff folder (~/.local/share/local-studio-browser/handoff) to open in it."),
            p("new_window", Bool, "true (default): always a fresh process. false: reuse a window this session opened in the app."),
            p("wait", Int, "Seconds to wait for the window (default 7; more than 7 counts as 7)."),
        ]},
        Tool { name: "close", read_only: false, summary: "Close a window this session opened with open, through the window manager. Anything else is refused.", params: vec![
            req("window", Int, "Window id that your open returned."),
        ]},
    ];
    // `wait` is on every acting verb but shot (docs: "an optional argument of every acting verb but shot").
    for t in tools.iter_mut() {
        if !t.read_only
            && t.name != "shot"
            && t.name != "close"
            && !t.params.iter().any(|x| x.name == "wait")
        {
            t.params.push(p("wait", Int, WAIT_HELP));
        }
    }
    tools
}

pub fn schema(t: &Tool) -> Value {
    let mut props = Map::new();
    for x in &t.params {
        let v = match x.kind {
            Kind::Str => json!({"type": "string", "description": x.help}),
            Kind::Int => json!({"type": "integer", "description": x.help}),
            Kind::Bool => json!({"type": "boolean", "description": x.help}),
            Kind::Strings => {
                json!({"type": "array", "items": {"type": "string"}, "description": x.help})
            }
            Kind::Objects => {
                json!({"type": "array", "items": {"type": "object"}, "description": x.help})
            }
        };
        props.insert(x.name.to_string(), v);
    }
    let required: Vec<&str> = t
        .params
        .iter()
        .filter(|x| x.required)
        .map(|x| x.name)
        .collect();
    let mut s = json!({"type": "object", "properties": props, "additionalProperties": false});
    if !required.is_empty() {
        s["required"] = json!(required);
    }
    s
}

pub fn list() -> Value {
    let tools: Vec<Value> = all()
        .iter()
        .map(|t| json!({"name": t.name, "description": t.summary, "inputSchema": schema(t), "annotations": {"readOnlyHint": t.read_only, "openWorldHint": false}}))
        .collect();
    json!({ "tools": tools })
}

pub fn is_acting(name: &str) -> bool {
    all()
        .iter()
        .any(|t| t.name == name && !t.read_only && t.name != "shot")
}

/// `computer_click-at` -> `click_at`.
pub fn normalize(raw: &str) -> String {
    raw.strip_prefix("computer_")
        .unwrap_or(raw)
        .replace('-', "_")
}

/// The arguments with strings normalized, or `bad_arguments`. Runs before anything touches the desktop.
pub fn check(name: &str, input: &Map<String, Value>) -> HResult<Map<String, Value>> {
    let tools = all();
    let Some(t) = tools.iter().find(|t| t.name == name) else {
        return Err(bad(format!("unknown tool {name}")).suggest(format!(
            "usage: tools are {}",
            tools.iter().map(|t| t.name).collect::<Vec<_>>().join(", ")
        )));
    };
    let mut out = Map::new();
    for (k, v) in input {
        let Some(param) = t.params.iter().find(|x| x.name == k) else {
            return Err(bad(format!("unknown argument {k}")).suggest(format!(
                "usage: {} takes {}",
                t.name,
                t.params
                    .iter()
                    .map(|x| x.name)
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        };
        let v = match param.kind {
            Kind::Int => {
                if !(v.is_i64() || v.is_u64()) {
                    return Err(bad(format!("{k} takes a number")));
                }
                v.clone()
            }
            Kind::Bool => {
                if !v.is_boolean() {
                    return Err(bad(format!("{k} takes true or false")));
                }
                v.clone()
            }
            Kind::Str => match v {
                Value::String(_) => v.clone(),
                Value::Number(_) | Value::Bool(_) => Value::String(v.to_string()),
                _ => return Err(bad(format!("{k} takes text"))),
            },
            Kind::Strings => {
                if !v
                    .as_array()
                    .is_some_and(|a| a.iter().all(|x| x.is_string()))
                {
                    return Err(bad(format!("{k} takes a list of strings")));
                }
                v.clone()
            }
            Kind::Objects => {
                if !v
                    .as_array()
                    .is_some_and(|a| a.iter().all(|x| x.is_object()))
                {
                    return Err(bad(format!("{k} takes a list of objects")));
                }
                v.clone()
            }
        };
        out.insert(k.clone(), v);
    }
    for x in &t.params {
        if x.required && !out.contains_key(x.name) {
            return Err(bad(format!("{} is missing", x.name)));
        }
    }
    let has = |k: &str| out.contains_key(k);
    let s = |k: &str| out.get(k).and_then(|v| v.as_str()).map(str::to_string);
    if name == "type" && has("text") == (out.get("paste").and_then(Value::as_bool) == Some(true)) {
        return Err(bad("pass text or paste: true, not both").suggest(
            "usage: {\"ref\":\"7\",\"text\":\"hello\"} or {\"ref\":\"7\",\"paste\":true}",
        ));
    }
    if name == "click" {
        if has("ref") && (has("text") || has("role") || has("window")) {
            return Err(bad("pass ref, or window and text, not both")
                .suggest("usage: {\"ref\":\"12\"} or {\"window\":4211,\"text\":\"Save\"}"));
        }
        if !has("ref") && !(has("text") && has("window")) {
            return Err(bad("ref is missing (or pass window and text)")
                .suggest("usage: {\"ref\":\"12\"} or {\"window\":4211,\"text\":\"Save\"}"));
        }
    }
    if (name == "snapshot" || name == "find") && !has("app") && !has("window") {
        return Err(bad("say which window: app or window")
            .suggest("usage: {\"window\":4211}; windows lists the ids"));
    }
    if name == "snapshot" {
        if let Some(f) = s("format") {
            if f != "rows" && f != "json" {
                return Err(bad(format!("format is rows or json, not {f}")));
            }
        }
        if let Some(v) = s("since") {
            if v != "latest" {
                return Err(bad(format!("since takes \"latest\", not {v}")));
            }
        }
        if let Some(n) = out.get("max_elements").and_then(Value::as_i64) {
            if n < 1 {
                return Err(bad(format!("max_elements is 1 or more, not {n}")));
            }
        }
    }
    if let Some(w) = out.get("wait") {
        let n = w.as_i64().unwrap_or(-1);
        if !(0..=120).contains(&n) {
            return Err(bad(format!("wait is seconds from 0 to 120, not {w}")));
        }
    }
    if let Some(d) = s("direction") {
        if !["up", "down", "left", "right"].contains(&d.as_str()) {
            return Err(bad(format!(
                "direction is up, down, left or right, not {d}"
            )));
        }
    }
    if let Some(b) = s("button") {
        if b != "left" && b != "right" {
            return Err(bad(format!("button is left or right, not {b}")));
        }
    }
    if let Some(pr) = s("property") {
        if !["value", "text", "title", "role", "bounds", "states"].contains(&pr.as_str()) {
            return Err(bad(format!(
                "property is value, text, title, role, bounds or states, not {pr}"
            )));
        }
    }
    if let Some(c) = out.get("count").and_then(Value::as_i64) {
        if !(1..=3).contains(&c) {
            return Err(bad(format!("count is 1 to 3, not {c}")));
        }
    }
    if let Some(o) = s("out") {
        if o.is_empty() || o.contains('/') || o.starts_with('.') {
            return Err(bad(format!("out is a file name with no folder, not {o}")));
        }
    }
    for k in ["zoom"] {
        if let Some(z) = s(k) {
            parse_zoom(&z)?;
        }
    }
    if name == "press" {
        let keys = s("key").unwrap_or_default();
        let n = keys.split_whitespace().count();
        if n == 0 || n > 64 {
            return Err(bad("key names 1 to 64 keys, separated by spaces"));
        }
    }
    if name == "run_steps" {
        let steps = out["steps"].as_array().cloned().unwrap_or_default();
        if steps.is_empty() {
            return Err(bad("steps is missing: pass a list of {tool, args}"));
        }
        if steps.len() > 32 {
            return Err(bad(format!("at most 32 steps, not {}", steps.len())));
        }
        for (i, step) in steps.iter().enumerate() {
            let Some(raw) = step.get("tool").and_then(Value::as_str) else {
                return Err(bad(format!("step {} has no tool", i + 1)));
            };
            let verb = normalize(raw);
            if !STEP_TOOLS.contains(&verb.as_str()) {
                return Err(bad(format!(
                    "step {}: {raw} can't be a step; steps are {}",
                    i + 1,
                    STEP_TOOLS.join(", ")
                )));
            }
            let args = match step.get("args") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(m)) => m.clone(),
                Some(_) => return Err(bad(format!("step {} ({verb}): args is an object", i + 1))),
            };
            if let Err(e) = check(&verb, &args) {
                return Err(bad(format!("step {} ({verb}): {}", i + 1, e.message)));
            }
        }
    }
    Ok(out)
}

/// `x,y,width,height` in window points.
pub fn parse_zoom(z: &str) -> HResult<(i32, i32, i32, i32)> {
    let parts: Vec<i32> = z.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if parts.len() != 4 || parts[2] <= 0 || parts[3] <= 0 || parts[0] < 0 || parts[1] < 0 {
        return Err(bad(format!(
            "zoom is x,y,width,height in window points, like \"0,0,400,300\", not {z}"
        )));
    }
    Ok((parts[0], parts[1], parts[2], parts[3]))
}

/// What an agent gets for `lend` or `return`: the person's verbs, never an agent's.
pub fn asked_for_lend(input: &Map<String, Value>) -> HandsError {
    let app = input
        .get("app")
        .and_then(Value::as_str)
        .unwrap_or("the app");
    HandsError::new(Code::NeedsLend, format!("agents can't lend apps; {app} is not on the agent workspace"))
        .suggest(format!("Ask the person to lend it, or do the work in an app you start with open {{\"app\":\"{app}\"}}."))
}
