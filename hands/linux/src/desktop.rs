//! Windows and workspaces from the window manager: Hyprland and Sway over their IPC sockets, X11 through EWMH, and on
//! GNOME and KDE under Wayland nothing (they offer no window list to other programs), where AT-SPI's frames stand in.

use serde_json::Value;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The agent workspace on Hyprland: a special workspace, never on screen unless someone toggles it.
pub const HYPR_AGENT: &str = "special:local-studio";
/// On Sway, windows on this workspace count as the agent's (Local Studio moves nothing there itself).
pub const SWAY_AGENT: &str = "local-studio-agent";

#[derive(Clone, Debug)]
pub struct WmWindow {
    pub id: i64,
    pub pid: u32,
    pub title: String,
    pub app: String,
    pub workspace: Option<String>,
    /// On an output and not hidden: what a region capture would see.
    pub visible: bool,
    /// Screen box, in compositor points.
    pub rect: Option<(i32, i32, i32, i32)>,
    pub focused: bool,
    pub dialog: bool,
}

#[derive(Clone, Debug)]
pub enum Backend {
    Hyprland(PathBuf),
    Sway(PathBuf),
    X11(String),
    /// No window manager Local Studio can ask: GNOME or KDE on Wayland, or anything else. The name is XDG_CURRENT_DESKTOP.
    AtspiOnly(String),
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub fn runtime_dir() -> PathBuf {
    env("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })))
}

/// The only entry of `dir` that `pick` accepts, when there is exactly one.
fn only(dir: &Path, pick: impl Fn(&str) -> bool) -> Option<PathBuf> {
    let found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| pick(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    (found.len() == 1).then(|| found[0].clone())
}

impl Backend {
    /// The session's window manager. The environment names it; without it (a connector started with little of the
    /// session's environment) the runtime folder is searched, and only an unambiguous find counts.
    pub fn detect() -> Backend {
        let rt = runtime_dir();
        if let Some(sig) = env("HYPRLAND_INSTANCE_SIGNATURE") {
            let sock = rt.join("hypr").join(sig).join(".socket.sock");
            if sock.exists() {
                return Backend::Hyprland(sock);
            }
        }
        if let Some(s) = env("SWAYSOCK") {
            if Path::new(&s).exists() {
                return Backend::Sway(PathBuf::from(s));
            }
        }
        let wayland = env("WAYLAND_DISPLAY");
        let display = env("DISPLAY");
        if wayland.is_none() && display.is_none() {
            if let Some(dir) = only(&rt.join("hypr"), |_| true) {
                let sock = dir.join(".socket.sock");
                if sock.exists() {
                    return Backend::Hyprland(sock);
                }
            }
            if let Some(sock) = only(&rt, |n| n.starts_with("sway-ipc.") && n.ends_with(".sock")) {
                return Backend::Sway(sock);
            }
        }
        if wayland.is_none() {
            if let Some(d) = display {
                return Backend::X11(d);
            }
        }
        Backend::AtspiOnly(env("XDG_CURRENT_DESKTOP").unwrap_or_else(|| "unknown".into()))
    }

    pub fn name(&self) -> String {
        match self {
            Backend::Hyprland(_) => "hyprland".into(),
            Backend::Sway(_) => "sway".into(),
            Backend::X11(_) => "x11".into(),
            Backend::AtspiOnly(d) => format!("atspi-only ({d})"),
        }
    }

    pub fn has_wm(&self) -> bool {
        !matches!(self, Backend::AtspiOnly(_))
    }

    pub fn windows(&self) -> Result<Vec<WmWindow>, String> {
        match self {
            Backend::Hyprland(s) => hypr_windows(s),
            Backend::Sway(s) => sway_windows(s),
            Backend::X11(d) => x11::windows(d),
            Backend::AtspiOnly(_) => Ok(vec![]),
        }
    }

    /// The agent workspace's number, when the window manager has one now.
    pub fn agent_workspace(&self) -> Option<i64> {
        match self {
            Backend::Hyprland(s) => {
                let v: Value = serde_json::from_str(&hypr(s, "j/workspaces").ok()?).ok()?;
                v.as_array()?
                    .iter()
                    .find(|w| w["name"] == HYPR_AGENT)
                    .and_then(|w| w["id"].as_i64())
            }
            Backend::Sway(s) => {
                let v: Value = serde_json::from_slice(&sway(s, 1, "").ok()?).ok()?;
                v.as_array()?
                    .iter()
                    .find(|w| w["name"] == SWAY_AGENT)
                    .and_then(|w| w["id"].as_i64())
            }
            _ => None,
        }
    }

    pub fn is_agent_workspace(&self, ws: &str) -> bool {
        match self {
            Backend::Hyprland(_) => ws == HYPR_AGENT,
            Backend::Sway(_) => ws == SWAY_AGENT,
            _ => false,
        }
    }

    /// Gives focus back to `id`. True when the window manager took the request.
    pub fn focus(&self, id: i64) -> bool {
        match self {
            Backend::Hyprland(s) => hypr(s, &format!("dispatch focuswindow address:0x{id:x}"))
                .is_ok_and(|r| r.trim() == "ok"),
            Backend::Sway(s) => sway_ok(s, &format!("[con_id={id}] focus")),
            Backend::X11(d) => x11::activate(d, id as u32).is_ok(),
            Backend::AtspiOnly(_) => false,
        }
    }

    pub fn close(&self, id: i64) -> Result<(), String> {
        match self {
            Backend::Hyprland(s) => hypr(s, &format!("dispatch closewindow address:0x{id:x}"))
                .and_then(|r| if r.trim() == "ok" { Ok(()) } else { Err(r) }),
            Backend::Sway(s) => {
                if sway_ok(s, &format!("[con_id={id}] kill")) {
                    Ok(())
                } else {
                    Err("sway refused".into())
                }
            }
            Backend::X11(d) => x11::close(d, id as u32),
            Backend::AtspiOnly(d) => Err(format!(
                "{d} offers no way for another program to close a window"
            )),
        }
    }

    /// A second, direct request after `close` went unanswered. Only X11 has one: there the app takes WM_DELETE_WINDOW
    /// from anyone, while the compositors offer nothing beyond their own close.
    pub fn close_again(&self, id: i64) -> Result<(), String> {
        match self {
            Backend::X11(d) => x11::delete(d, id as u32),
            _ => Err("no second way to close".into()),
        }
    }

    /// Sends every window a client of the security context `instance` maps, now and later (its dialogs too), to the
    /// agent workspace, and keeps sway from focusing them. Called before the app starts. Sway keeps the rules for its
    /// whole session and has no way to drop one, so they name a random id made for this launch (`wl::instance_id`),
    /// never a process id another process could reuse.
    pub fn sway_claim(&self, instance: &str) -> Result<(), String> {
        let Backend::Sway(s) = self else {
            return Err("not sway".into());
        };
        for cmd in sway_claim_rules(instance) {
            if !sway_ok(s, &cmd) {
                return Err(format!("sway refused: {cmd}"));
            }
        }
        Ok(())
    }

    /// Starts `argv` through Hyprland on the hidden agent workspace, without focusing it. Answers the process id.
    pub fn hypr_exec(&self, argv: &[String]) -> Result<u32, String> {
        let Backend::Hyprland(s) = self else {
            return Err("not hyprland".into());
        };
        let pidfile = std::env::temp_dir().join(format!(
            "local-studio-computer-{}-{}.pid",
            std::process::id(),
            now_nanos()
        ));
        let quoted: Vec<String> = argv.iter().map(|a| shell_quote(a)).collect();
        // `exec` keeps the pid Hyprland's rule is bound to all the way to the app.
        let inner = format!(
            "echo $$ > {}; exec {}",
            shell_quote(&pidfile.to_string_lossy()),
            quoted.join(" ")
        );
        let cmd = format!(
            "dispatch exec [workspace {HYPR_AGENT} silent] sh -c {}",
            shell_quote(&inner)
        );
        let r = hypr(s, &cmd)?;
        if r.trim() != "ok" {
            return Err(format!("hyprland refused exec: {r}"));
        }
        for _ in 0..40 {
            if let Some(pid) = std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|t| t.trim().parse().ok())
            {
                let _ = std::fs::remove_file(&pidfile);
                return Ok(pid);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("hyprland started nothing within 2 s".into())
    }
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn hypr(sock: &Path, cmd: &str) -> Result<String, String> {
    let mut s = UnixStream::connect(sock).map_err(|e| format!("hyprland socket: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok();
    s.write_all(cmd.as_bytes()).map_err(|e| e.to_string())?;
    let mut out = String::new();
    s.read_to_string(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Hyprland's clients, as `j/clients` lists them (also what the unit tests feed in).
pub fn parse_hypr_clients(json: &str, active: Option<&str>) -> Vec<WmWindow> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|c| c["mapped"].as_bool() != Some(false))
                .filter_map(|c| {
                    let addr = c["address"].as_str()?;
                    let id = i64::from_str_radix(addr.trim_start_matches("0x"), 16).ok()?;
                    let ws = c["workspace"]["name"].as_str().map(str::to_string);
                    let hidden = c["hidden"].as_bool() == Some(true)
                        || ws.as_deref().is_some_and(|w| w.starts_with("special:"));
                    let at = c["at"].as_array().map(|p| {
                        (
                            p[0].as_i64().unwrap_or(0) as i32,
                            p[1].as_i64().unwrap_or(0) as i32,
                        )
                    });
                    let size = c["size"].as_array().map(|p| {
                        (
                            p[0].as_i64().unwrap_or(0) as i32,
                            p[1].as_i64().unwrap_or(0) as i32,
                        )
                    });
                    Some(WmWindow {
                        id,
                        pid: c["pid"].as_i64().unwrap_or(0).max(0) as u32,
                        title: c["title"].as_str().unwrap_or("").to_string(),
                        app: c["class"]
                            .as_str()
                            .or(c["initialClass"].as_str())
                            .unwrap_or("")
                            .to_string(),
                        workspace: ws,
                        visible: !hidden,
                        rect: at.zip(size).map(|((x, y), (w, h))| (x, y, w, h)),
                        focused: active == Some(addr),
                        dialog: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn hypr_windows(sock: &Path) -> Result<Vec<WmWindow>, String> {
    let clients = hypr(sock, "j/clients")?;
    let active: Value = serde_json::from_str(&hypr(sock, "j/activewindow").unwrap_or_default())
        .unwrap_or(Value::Null);
    // Workspaces shown on a monitor right now, so a window on another one isn't taken for visible.
    let monitors: Value =
        serde_json::from_str(&hypr(sock, "j/monitors").unwrap_or_default()).unwrap_or(Value::Null);
    let shown: Vec<String> = monitors
        .as_array()
        .map(|m| {
            m.iter()
                .flat_map(|x| {
                    [
                        x["activeWorkspace"]["name"].as_str(),
                        x["specialWorkspace"]["name"].as_str(),
                    ]
                })
                .flatten()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut list = parse_hypr_clients(&clients, active["address"].as_str());
    for w in list.iter_mut() {
        w.visible = w.workspace.as_ref().is_some_and(|ws| shown.contains(ws));
    }
    Ok(list)
}

fn sway(sock: &Path, kind: u32, payload: &str) -> Result<Vec<u8>, String> {
    let mut s = UnixStream::connect(sock).map_err(|e| format!("sway socket: {e}"))?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let mut msg = b"i3-ipc".to_vec();
    msg.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    msg.extend_from_slice(&kind.to_ne_bytes());
    msg.extend_from_slice(payload.as_bytes());
    s.write_all(&msg).map_err(|e| e.to_string())?;
    let mut head = [0u8; 14];
    s.read_exact(&mut head).map_err(|e| e.to_string())?;
    let len = u32::from_ne_bytes([head[6], head[7], head[8], head[9]]) as usize;
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(body)
}

/// Sway before 1.10 has no sandbox criteria: there the rules name process `pid`, which `hold` keeps from reuse for
/// as long as Sway (and so the rules) lives.
pub fn sway_claim_pid(sock: &Path, pid: u32) -> Result<(), String> {
    for cmd in [
        format!("for_window [pid={pid}] move container to workspace {SWAY_AGENT}"),
        format!("no_focus [pid={pid}]"),
    ] {
        if !sway_ok(sock, &cmd) {
            return Err(format!("sway refused: {cmd}"));
        }
    }
    Ok(())
}

/// The process behind Sway's IPC socket (the kernel's peer credentials, not anything Sway says), with its start time
/// so a later process given the same pid isn't taken for it.
pub fn sway_process(sock: &Path) -> Option<(u32, u64)> {
    use std::os::fd::AsRawFd;
    let s = UnixStream::connect(sock).ok()?;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if r != 0 || cred.pid <= 0 {
        return None;
    }
    let pid = cred.pid as u32;
    Some((pid, crate::access::start_time(pid)?))
}

/// Sway's (major, minor) version, from GET_VERSION. None when it doesn't answer.
pub fn sway_version(sock: &Path) -> Option<(u64, u64)> {
    let reply = sway(sock, 7, "").ok()?;
    sway_version_of(&serde_json::from_slice(&reply).ok()?)
}

pub fn sway_version_of(v: &Value) -> Option<(u64, u64)> {
    Some((v["major"].as_u64()?, v["minor"].as_u64()?))
}

/// The rules `sway_claim` adds. They match only clients of the one security context, never a process id.
pub fn sway_claim_rules(instance: &str) -> [String; 2] {
    [
        format!("for_window [sandbox_instance_id=\"{instance}\"] move container to workspace {SWAY_AGENT}"),
        format!("no_focus [sandbox_instance_id=\"{instance}\"]"),
    ]
}

fn sway_ok(sock: &Path, cmd: &str) -> bool {
    sway(sock, 0, cmd)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_array().map(|a| a.iter().all(|r| r["success"] == true)))
        .unwrap_or(false)
}

/// Sway's windows from a GET_TREE reply and the visible workspaces' names (also what the unit tests feed in).
pub fn parse_sway_tree(tree: &Value, visible: &[String]) -> Vec<WmWindow> {
    fn walk(n: &Value, ws: Option<&str>, visible: &[String], out: &mut Vec<WmWindow>) {
        let ws = if n["type"] == "workspace" {
            n["name"].as_str()
        } else {
            ws
        };
        let is_view =
            (n["type"] == "con" || n["type"] == "floating_con") && n["pid"].as_i64().is_some();
        if is_view {
            let r = &n["rect"];
            out.push(WmWindow {
                id: n["id"].as_i64().unwrap_or(0),
                pid: n["pid"].as_i64().unwrap_or(0).max(0) as u32,
                title: n["name"].as_str().unwrap_or("").to_string(),
                app: n["app_id"]
                    .as_str()
                    .or(n["window_properties"]["class"].as_str())
                    .unwrap_or("")
                    .to_string(),
                workspace: ws.map(str::to_string),
                visible: ws.is_some_and(|w| visible.iter().any(|v| v == w))
                    && n["visible"].as_bool() != Some(false),
                rect: Some((
                    r["x"].as_i64().unwrap_or(0) as i32,
                    r["y"].as_i64().unwrap_or(0) as i32,
                    r["width"].as_i64().unwrap_or(0) as i32,
                    r["height"].as_i64().unwrap_or(0) as i32,
                )),
                focused: n["focused"] == true,
                dialog: n["type"] == "floating_con"
                    && n["window_properties"]["window_role"] == "dialog",
            });
        }
        for key in ["nodes", "floating_nodes"] {
            if let Some(kids) = n[key].as_array() {
                for k in kids {
                    walk(k, ws, visible, out);
                }
            }
        }
    }
    let mut out = vec![];
    walk(tree, None, visible, &mut out);
    out
}

fn sway_windows(sock: &Path) -> Result<Vec<WmWindow>, String> {
    let tree: Value = serde_json::from_slice(&sway(sock, 4, "")?).map_err(|e| e.to_string())?;
    let wss: Value = serde_json::from_slice(&sway(sock, 1, "")?).map_err(|e| e.to_string())?;
    let visible: Vec<String> = wss
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|w| w["visible"] == true)
                .filter_map(|w| w["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(parse_sway_tree(&tree, &visible))
}

/// X11 through EWMH, with x11rb's pure-Rust connection (no libxcb).
pub mod x11 {
    use super::WmWindow;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{
        AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, ImageFormat, MapState, Window,
        WindowClass,
    };
    use x11rb::rust_connection::RustConnection;

    fn connect(display: &str) -> Result<(RustConnection, Window), String> {
        let (conn, screen) = x11rb::connect(Some(display))
            .map_err(|e| format!("can't open X display {display}: {e}"))?;
        let root = conn.setup().roots[screen].root;
        Ok((conn, root))
    }

    fn atom(conn: &RustConnection, name: &str) -> Result<u32, String> {
        Ok(conn
            .intern_atom(false, name.as_bytes())
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .atom)
    }

    fn prop32(conn: &RustConnection, win: Window, prop: u32, ty: u32) -> Vec<u32> {
        conn.get_property(false, win, prop, ty, 0, 4096)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }

    fn prop_str(conn: &RustConnection, win: Window, prop: u32, ty: u32) -> Option<String> {
        let r = conn
            .get_property(false, win, prop, ty, 0, 4096)
            .ok()?
            .reply()
            .ok()?;
        (!r.value.is_empty()).then(|| String::from_utf8_lossy(&r.value).to_string())
    }

    pub fn windows(display: &str) -> Result<Vec<WmWindow>, String> {
        let (conn, root) = connect(display)?;
        let list_atom = atom(&conn, "_NET_CLIENT_LIST")?;
        let pid_atom = atom(&conn, "_NET_WM_PID")?;
        let name_atom = atom(&conn, "_NET_WM_NAME")?;
        let utf8 = atom(&conn, "UTF8_STRING")?;
        let desk_atom = atom(&conn, "_NET_WM_DESKTOP")?;
        let cur_atom = atom(&conn, "_NET_CURRENT_DESKTOP")?;
        let active_atom = atom(&conn, "_NET_ACTIVE_WINDOW")?;
        let type_atom = atom(&conn, "_NET_WM_WINDOW_TYPE")?;
        let dialog_atom = atom(&conn, "_NET_WM_WINDOW_TYPE_DIALOG")?;
        let ids = prop32(&conn, root, list_atom, AtomEnum::WINDOW.into());
        let current = prop32(&conn, root, cur_atom, AtomEnum::CARDINAL.into())
            .first()
            .copied();
        let active = prop32(&conn, root, active_atom, AtomEnum::WINDOW.into())
            .first()
            .copied();
        let mut out = vec![];
        for id in ids {
            let pid = prop32(&conn, id, pid_atom, AtomEnum::CARDINAL.into())
                .first()
                .copied()
                .unwrap_or(0);
            let title = prop_str(&conn, id, name_atom, utf8)
                .or_else(|| prop_str(&conn, id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
                .unwrap_or_default();
            let class = prop_str(
                &conn,
                id,
                AtomEnum::WM_CLASS.into(),
                AtomEnum::STRING.into(),
            )
            .unwrap_or_default();
            let app = class.split('\0').nth(1).unwrap_or("").to_string();
            let desk = prop32(&conn, id, desk_atom, AtomEnum::CARDINAL.into())
                .first()
                .copied();
            let dialog = prop32(&conn, id, type_atom, AtomEnum::ATOM.into()).contains(&dialog_atom);
            let mapped = conn
                .get_window_attributes(id)
                .ok()
                .and_then(|c| c.reply().ok())
                .is_some_and(|a| a.map_state == MapState::VIEWABLE);
            let rect = conn
                .get_geometry(id)
                .ok()
                .and_then(|c| c.reply().ok())
                .and_then(|g| {
                    let t = conn
                        .translate_coordinates(id, root, 0, 0)
                        .ok()?
                        .reply()
                        .ok()?;
                    Some((
                        t.dst_x as i32,
                        t.dst_y as i32,
                        g.width as i32,
                        g.height as i32,
                    ))
                });
            out.push(WmWindow {
                id: id as i64,
                pid,
                title,
                app,
                workspace: desk.map(|d| {
                    if d == 0xFFFF_FFFF {
                        "all".to_string()
                    } else {
                        d.to_string()
                    }
                }),
                visible: mapped && (desk.is_none() || desk == current || desk == Some(0xFFFF_FFFF)),
                rect,
                focused: active == Some(id),
                dialog,
            });
        }
        Ok(out)
    }

    fn client_message(
        display: &str,
        win: Window,
        kind: &str,
        data: [u32; 5],
    ) -> Result<(), String> {
        let (conn, root) = connect(display)?;
        let ty = atom(&conn, kind)?;
        let ev = ClientMessageEvent::new(32, win, ty, data);
        // Checked, so the request has reached the server (and was accepted) before the connection closes.
        conn.send_event(
            false,
            root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            ev,
        )
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Asks the window manager to activate `win`, as a pager would (source 2).
    pub fn activate(display: &str, win: Window) -> Result<(), String> {
        client_message(display, win, "_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0])
    }

    pub fn close(display: &str, win: Window) -> Result<(), String> {
        client_message(display, win, "_NET_CLOSE_WINDOW", [0, 2, 0, 0, 0])
    }

    /// Asks the app itself to close `win` with the ICCCM WM_DELETE_WINDOW message, the one its window manager sends.
    /// Used when the window manager let a _NET_CLOSE_WINDOW go by. An app that doesn't offer WM_DELETE_WINDOW is left
    /// alone: closing it would mean killing its connection.
    pub fn delete(display: &str, win: Window) -> Result<(), String> {
        let (conn, _) = connect(display)?;
        let protocols = atom(&conn, "WM_PROTOCOLS")?;
        let delete = atom(&conn, "WM_DELETE_WINDOW")?;
        if !prop32(&conn, win, protocols, AtomEnum::ATOM.into()).contains(&delete) {
            return Err("the app doesn't take WM_DELETE_WINDOW".into());
        }
        let ev = ClientMessageEvent::new(32, win, protocols, [delete, 0, 0, 0, 0]);
        conn.send_event(false, win, EventMask::NO_EVENT, ev)
            .map_err(|e| e.to_string())?
            .check()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A mapped window stacked over `win`'s top-level (its window manager frame) that overlaps `win` on screen, named
    /// by its id. X11 pictures a window from the screen, so whatever is over it would show in the picture.
    pub fn covered_by(display: &str, win: Window) -> Result<Option<String>, String> {
        let (conn, root) = connect(display)?;
        let tree = |w: Window| -> Result<(Window, Vec<Window>), String> {
            let t = conn
                .query_tree(w)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            Ok((t.parent, t.children))
        };
        let mut top = win;
        for _ in 0..16 {
            let (parent, _) = tree(top)?;
            if parent == root || parent == 0 {
                break;
            }
            top = parent;
        }
        let rect = |w: Window| -> Option<(i32, i32, i32, i32)> {
            let g = conn.get_geometry(w).ok()?.reply().ok()?;
            let at = conn
                .translate_coordinates(w, root, 0, 0)
                .ok()?
                .reply()
                .ok()?;
            let b = g.border_width as i32;
            Some((
                at.dst_x as i32 - b,
                at.dst_y as i32 - b,
                g.width as i32 + 2 * b,
                g.height as i32 + 2 * b,
            ))
        };
        let mine = rect(win).ok_or("the window has no geometry")?;
        let (_, stack) = tree(root)?;
        let Some(at) = stack.iter().position(|&k| k == top) else {
            return Err("can't find the window in the stacking order".into());
        };
        for &k in &stack[at + 1..] {
            let Some(attrs) = conn
                .get_window_attributes(k)
                .ok()
                .and_then(|c| c.reply().ok())
            else {
                continue;
            };
            if attrs.map_state != MapState::VIEWABLE || attrs.class == WindowClass::INPUT_ONLY {
                continue;
            }
            if let Some(r) = rect(k) {
                let apart = r.0 >= mine.0 + mine.2
                    || mine.0 >= r.0 + r.2
                    || r.1 >= mine.1 + mine.3
                    || mine.1 >= r.1 + r.3;
                if !apart && r.2 > 0 && r.3 > 0 {
                    return Ok(Some(format!("X11 window 0x{k:x}")));
                }
            }
        }
        Ok(None)
    }

    /// The window's pixels as RGBA, when it is mapped and on screen.
    pub fn capture(display: &str, win: Window) -> Result<(u32, u32, Vec<u8>), String> {
        let (conn, _) = connect(display)?;
        let g = conn
            .get_geometry(win)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        // X11 gives pixels only for the part of a window that is on screen, so the picture is clipped to it.
        let at = conn
            .translate_coordinates(win, g.root, 0, 0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let screen = conn
            .get_geometry(g.root)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let (ax, ay) = (at.dst_x as i32, at.dst_y as i32);
        let x0 = (-ax).max(0);
        let y0 = (-ay).max(0);
        let x1 = (g.width as i32).min(screen.width as i32 - ax);
        let y1 = (g.height as i32).min(screen.height as i32 - ay);
        if x1 <= x0 || y1 <= y0 {
            return Err("the window is entirely off screen".into());
        }
        let (w, h) = ((x1 - x0) as u32, (y1 - y0) as u32);
        let img = conn
            .get_image(ImageFormat::Z_PIXMAP, win, x0 as i16, y0 as i16, w as u16, h as u16, !0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| format!("the X server gave no pixels for the window ({e}); it may be unmapped or on another desktop"))?;
        if img.depth != 24 && img.depth != 32 {
            return Err(format!("unsupported window depth {}", img.depth));
        }
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for px in img.data.chunks_exact(4).take((w * h) as usize) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
        Ok((w, h, rgba))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sway_versions_read_from_get_version() {
        let v: Value =
            serde_json::from_str(r#"{"major":1,"minor":9,"patch":0,"human_readable":"1.9"}"#)
                .unwrap();
        assert_eq!(sway_version_of(&v), Some((1, 9)));
        assert!(sway_version_of(&v).is_some_and(|v| v < (1, 10)));
        let v: Value = serde_json::from_str(r#"{"major":1,"minor":12}"#).unwrap();
        assert!(!sway_version_of(&v).is_some_and(|v| v < (1, 10)));
        assert_eq!(
            sway_version_of(&serde_json::json!({"human_readable":"1.9"})),
            None
        );
    }

    #[test]
    fn hyprland_clients_parse_with_the_agent_workspace_hidden() {
        let json = r#"[
          {"address":"0x55d4c0a1b2c0","mapped":true,"hidden":false,"at":[10,20],"size":[800,600],
           "workspace":{"id":1,"name":"1"},"class":"org.gnome.TextEditor","title":"Untitled","pid":4242},
          {"address":"0x55d4c0a1f000","mapped":true,"hidden":false,"at":[0,0],"size":[400,300],
           "workspace":{"id":-98,"name":"special:local-studio"},"class":"gnome-calculator","title":"Calculator","pid":4300},
          {"address":"0x1","mapped":false,"workspace":{"id":1,"name":"1"},"class":"x","title":"y","pid":1}
        ]"#;
        let w = parse_hypr_clients(json, Some("0x55d4c0a1b2c0"));
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].id, 0x55d4c0a1b2c0);
        assert!(w[0].focused && w[0].visible);
        assert_eq!(w[0].rect, Some((10, 20, 800, 600)));
        assert_eq!(w[1].workspace.as_deref(), Some(HYPR_AGENT));
        assert!(
            !w[1].visible,
            "a window on a special workspace isn't taken for visible"
        );
        assert_eq!(w[1].pid, 4300);
    }

    #[test]
    fn sway_tree_parses_views_with_their_workspace() {
        let tree: Value = serde_json::from_str(
            r#"{"type":"root","nodes":[{"type":"output","nodes":[
              {"type":"workspace","name":"1","nodes":[{"type":"con","id":7,"pid":10,"name":"Fixture","app_id":"python3","focused":true,
                 "rect":{"x":0,"y":0,"width":640,"height":480},"nodes":[],"floating_nodes":[]}],"floating_nodes":[]},
              {"type":"workspace","name":"local-studio-agent","nodes":[],"floating_nodes":[{"type":"floating_con","id":9,"pid":11,"name":"Dialog",
                 "window_properties":{"class":"Xapp","window_role":"dialog"},"rect":{"x":5,"y":6,"width":7,"height":8},"nodes":[],"floating_nodes":[]}]}
            ]}]}"#,
        )
        .unwrap();
        let w = parse_sway_tree(&tree, &["1".to_string()]);
        assert_eq!(w.len(), 2);
        assert_eq!(
            (w[0].id, w[0].pid, w[0].focused, w[0].visible),
            (7, 10, true, true)
        );
        assert_eq!(w[1].workspace.as_deref(), Some(SWAY_AGENT));
        assert!(w[1].dialog && !w[1].visible);
        assert_eq!(w[1].app, "Xapp");
    }

    #[test]
    fn shell_quote_survives_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
