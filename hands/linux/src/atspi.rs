//! AT-SPI over D-Bus: the accessibility tree of every toolkit that speaks it (GTK, Qt, Electron with accessibility on,
//! LibreOffice, Firefox). Reads and actions are D-Bus calls into the app's own process, so nothing here moves the
//! pointer, posts a key or raises a window.
//!
//! Calls go out concurrently on one connection: a tree read costs a few round trips per level, not per element.

use futures_util::future::join_all;
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

pub const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
pub const ACTION: &str = "org.a11y.atspi.Action";
pub const COMPONENT: &str = "org.a11y.atspi.Component";
pub const TEXT: &str = "org.a11y.atspi.Text";
pub const EDITABLE: &str = "org.a11y.atspi.EditableText";
pub const VALUE: &str = "org.a11y.atspi.Value";
pub const SELECTION: &str = "org.a11y.atspi.Selection";
const NULL_PATH: &str = "/org/a11y/atspi/null";

/// AtspiStateType bits.
pub mod state {
    pub const ACTIVE: u32 = 1;
    pub const CHECKED: u32 = 4;
    pub const EDITABLE: u32 = 7;
    pub const ENABLED: u32 = 8;
    pub const EXPANDABLE: u32 = 9;
    pub const EXPANDED: u32 = 10;
    pub const FOCUSED: u32 = 12;
    pub const SELECTED: u32 = 23;
    pub const SENSITIVE: u32 = 24;
    pub const SHOWING: u32 = 25;
    pub const VISIBLE: u32 = 30;
    pub const INDETERMINATE: u32 = 32;
    pub const READ_ONLY: u32 = 43;
}

/// AtspiCoordType.
pub const COORD_WINDOW: u32 = 1;

/// One accessible object: the app's bus name and the object's path.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Obj {
    pub bus: String,
    pub path: String,
}

#[derive(Clone, Debug, Default)]
pub struct Info {
    pub role: String,
    pub name: String,
    pub description: String,
    pub states: u64,
    pub ifaces: Vec<String>,
    pub children: Vec<Obj>,
    /// Text of an editable or text element, or a Value's number.
    pub value: Option<String>,
}

impl Info {
    pub fn has(&self, s: u32) -> bool {
        self.states & (1u64 << s) != 0
    }
    pub fn iface(&self, i: &str) -> bool {
        self.ifaces.iter().any(|x| x == i)
    }
}

pub struct Atspi {
    conn: Connection,
    /// The accessibility bus's address, handed to apps an agent starts on a bus of their own.
    pub address: String,
}

fn runtime_dir() -> String {
    std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("/run/user/{}", unsafe { libc::getuid() }))
}

/// The session bus: $DBUS_SESSION_BUS_ADDRESS, else the user's bus socket in the runtime folder.
pub fn session_address() -> String {
    std::env::var("DBUS_SESSION_BUS_ADDRESS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("unix:path={}/bus", runtime_dir()))
}

impl Atspi {
    /// Connects to the accessibility bus that the session bus's org.a11y.Bus names.
    pub async fn connect() -> Result<Atspi, String> {
        let session = zbus::connection::Builder::address(session_address().as_str())
            .map_err(|e| format!("session bus address: {e}"))?
            .method_timeout(Duration::from_secs(3))
            .build()
            .await
            .map_err(|e| format!("no session bus ({e})"))?;
        let reply = session
            .call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.a11y.Bus"),
                "GetAddress",
                &(),
            )
            .await
            .map_err(|e| format!("no accessibility bus: org.a11y.Bus didn't answer ({e})"))?;
        let address: String = reply.body().deserialize().map_err(|e| e.to_string())?;
        let conn = zbus::connection::Builder::address(address.as_str())
            .map_err(|e| format!("accessibility bus address: {e}"))?
            .method_timeout(Duration::from_secs(4))
            .build()
            .await
            .map_err(|e| format!("can't reach the accessibility bus ({e})"))?;
        Ok(Atspi { conn, address })
    }

    async fn call<B, R>(&self, o: &Obj, iface: &str, method: &str, body: &B) -> Result<R, String>
    where
        B: serde::ser::Serialize + zbus::zvariant::DynamicType,
        R: for<'d> serde::de::Deserialize<'d> + zbus::zvariant::Type,
    {
        let reply = self
            .conn
            .call_method(
                Some(o.bus.as_str()),
                o.path.as_str(),
                Some(iface),
                method,
                body,
            )
            .await
            .map_err(|e| e.to_string())?;
        reply.body().deserialize::<R>().map_err(|e| e.to_string())
    }

    async fn prop(&self, o: &Obj, iface: &str, name: &str) -> Result<OwnedValue, String> {
        self.call(o, "org.freedesktop.DBus.Properties", "Get", &(iface, name))
            .await
    }

    pub async fn set_prop(
        &self,
        o: &Obj,
        iface: &str,
        name: &str,
        v: Value<'_>,
    ) -> Result<(), String> {
        let reply = self
            .conn
            .call_method(
                Some(o.bus.as_str()),
                o.path.as_str(),
                Some("org.freedesktop.DBus.Properties"),
                "Set",
                &(iface, name, v),
            )
            .await
            .map_err(|e| e.to_string())?;
        let _ = reply;
        Ok(())
    }

    fn objs(list: Vec<(String, OwnedObjectPath)>) -> Vec<Obj> {
        list.into_iter()
            .filter(|(_, p)| p.as_str() != NULL_PATH)
            .map(|(bus, path)| Obj {
                bus,
                path: path.as_str().to_string(),
            })
            .collect()
    }

    /// The apps registered on the bus.
    pub async fn apps(&self) -> Vec<Obj> {
        let root = Obj {
            bus: "org.a11y.atspi.Registry".into(),
            path: "/org/a11y/atspi/accessible/root".into(),
        };
        self.children(&root).await
    }

    pub async fn children(&self, o: &Obj) -> Vec<Obj> {
        self.call::<_, Vec<(String, OwnedObjectPath)>>(o, ACCESSIBLE, "GetChildren", &())
            .await
            .map(Self::objs)
            .unwrap_or_default()
    }

    pub async fn pid(&self, bus: &str) -> Option<u32> {
        let reply = self
            .conn
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetConnectionUnixProcessID",
                &(bus,),
            )
            .await
            .ok()?;
        reply.body().deserialize::<u32>().ok()
    }

    pub async fn role(&self, o: &Obj) -> Result<String, String> {
        self.call::<_, String>(o, ACCESSIBLE, "GetRoleName", &())
            .await
    }

    pub async fn name(&self, o: &Obj) -> String {
        self.prop(o, ACCESSIBLE, "Name")
            .await
            .ok()
            .and_then(|v| String::try_from(v).ok())
            .unwrap_or_default()
    }

    pub async fn states(&self, o: &Obj) -> u64 {
        match self
            .call::<_, Vec<u32>>(o, ACCESSIBLE, "GetState", &())
            .await
        {
            Ok(v) => {
                v.first().copied().unwrap_or(0) as u64
                    | ((v.get(1).copied().unwrap_or(0) as u64) << 32)
            }
            Err(_) => 0,
        }
    }

    pub async fn ifaces(&self, o: &Obj) -> Vec<String> {
        self.call::<_, Vec<String>>(o, ACCESSIBLE, "GetInterfaces", &())
            .await
            .unwrap_or_default()
    }

    pub async fn parent(&self, o: &Obj) -> Option<Obj> {
        let v = self.prop(o, ACCESSIBLE, "Parent").await.ok()?;
        let (bus, path): (String, OwnedObjectPath) = v.try_into().ok()?;
        (path.as_str() != NULL_PATH && !path.as_str().ends_with("/root")).then(|| Obj {
            bus,
            path: path.as_str().to_string(),
        })
    }

    /// Everything a row needs, in one concurrent round.
    pub async fn info(&self, o: &Obj, children: bool) -> Result<Info, String> {
        let role = self.role(o);
        let name = self.name(o);
        let desc = async {
            self.prop(o, ACCESSIBLE, "Description")
                .await
                .ok()
                .and_then(|v| String::try_from(v).ok())
                .unwrap_or_default()
        };
        let states = self.states(o);
        let ifaces = self.ifaces(o);
        let kids = async {
            if children {
                self.children(o).await
            } else {
                vec![]
            }
        };
        let (role, name, description, states, ifaces, kids) =
            futures_util::join!(role, name, desc, states, ifaces, kids);
        let role = role?;
        let mut info = Info {
            role,
            name,
            description,
            states,
            ifaces,
            children: kids,
            value: None,
        };
        info.value = self.value_of(o, &info).await;
        Ok(info)
    }

    /// The text an editable or text element holds, or a Value's number; None for anything else.
    pub async fn value_of(&self, o: &Obj, info: &Info) -> Option<String> {
        if info.role == "combo box" && !info.iface(EDITABLE) && info.iface(SELECTION) {
            let item = self.selected_child(o).await?;
            return Some(self.name(&item).await);
        }
        if info.iface(VALUE) && !info.iface(TEXT) {
            let v = self.current_value(o).await?;
            return Some(format_number(v));
        }
        let texty = info.iface(EDITABLE)
            || matches!(
                info.role.as_str(),
                "text" | "entry" | "password text" | "spin button" | "paragraph" | "terminal"
            );
        if info.iface(TEXT) && texty {
            if info.role == "password text" {
                return Some(String::new());
            }
            return self.text(o).await.ok();
        }
        None
    }

    pub async fn text(&self, o: &Obj) -> Result<String, String> {
        self.call::<_, String>(o, TEXT, "GetText", &(0i32, -1i32))
            .await
    }

    pub async fn caret(&self, o: &Obj) -> i32 {
        self.prop(o, TEXT, "CaretOffset")
            .await
            .ok()
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or(-1)
    }

    pub async fn char_count(&self, o: &Obj) -> i32 {
        self.prop(o, TEXT, "CharacterCount")
            .await
            .ok()
            .and_then(|v| i32::try_from(v).ok())
            .unwrap_or(0)
    }

    pub async fn insert_text(&self, o: &Obj, at: i32, text: &str) -> Result<bool, String> {
        self.call::<_, bool>(
            o,
            EDITABLE,
            "InsertText",
            &(at, text, text.chars().count() as i32),
        )
        .await
    }

    pub async fn set_text(&self, o: &Obj, text: &str) -> Result<bool, String> {
        self.call::<_, bool>(o, EDITABLE, "SetTextContents", &(text,))
            .await
    }

    pub async fn delete_text(&self, o: &Obj, start: i32, end: i32) -> Result<bool, String> {
        self.call::<_, bool>(o, EDITABLE, "DeleteText", &(start, end))
            .await
    }

    pub async fn set_caret(&self, o: &Obj, at: i32) -> Result<bool, String> {
        self.call::<_, bool>(o, TEXT, "SetCaretOffset", &(at,))
            .await
    }

    pub async fn select_text(&self, o: &Obj, start: i32, end: i32) -> Result<bool, String> {
        let n: i32 = self
            .call::<_, i32>(o, TEXT, "GetNSelections", &())
            .await
            .unwrap_or(0);
        if n > 0 {
            self.call::<_, bool>(o, TEXT, "SetSelection", &(0i32, start, end))
                .await
        } else {
            self.call::<_, bool>(o, TEXT, "AddSelection", &(start, end))
                .await
        }
    }

    /// The selection's (start, end), if any.
    pub async fn text_selection(&self, o: &Obj) -> Option<(i32, i32)> {
        let n: i32 = self
            .call::<_, i32>(o, TEXT, "GetNSelections", &())
            .await
            .unwrap_or(0);
        if n == 0 {
            return None;
        }
        self.call::<_, (i32, i32)>(o, TEXT, "GetSelection", &(0i32,))
            .await
            .ok()
    }

    pub async fn actions(&self, o: &Obj) -> Vec<String> {
        match self
            .call::<_, Vec<(String, String, String)>>(o, ACTION, "GetActions", &())
            .await
        {
            Ok(v) => v.into_iter().map(|(n, _, _)| n).collect(),
            Err(_) => {
                let n: i32 = self
                    .prop(o, ACTION, "NActions")
                    .await
                    .ok()
                    .and_then(|v| i32::try_from(v).ok())
                    .unwrap_or(0);
                let mut out = vec![];
                for i in 0..n {
                    out.push(
                        self.call::<_, String>(o, ACTION, "GetName", &(i,))
                            .await
                            .unwrap_or_default(),
                    );
                }
                out
            }
        }
    }

    pub async fn do_action(&self, o: &Obj, i: i32) -> Result<bool, String> {
        self.call::<_, bool>(o, ACTION, "DoAction", &(i,)).await
    }

    pub async fn extents(&self, o: &Obj, coord: u32) -> Option<(i32, i32, i32, i32)> {
        self.call::<_, (i32, i32, i32, i32)>(o, COMPONENT, "GetExtents", &(coord,))
            .await
            .ok()
    }

    pub async fn at_point(&self, o: &Obj, x: i32, y: i32, coord: u32) -> Option<Obj> {
        let (bus, path) = self
            .call::<_, (String, OwnedObjectPath)>(
                o,
                COMPONENT,
                "GetAccessibleAtPoint",
                &(x, y, coord),
            )
            .await
            .ok()?;
        (path.as_str() != NULL_PATH).then(|| Obj {
            bus,
            path: path.as_str().to_string(),
        })
    }

    pub async fn current_value(&self, o: &Obj) -> Option<f64> {
        self.prop(o, VALUE, "CurrentValue")
            .await
            .ok()
            .and_then(|v| f64::try_from(v).ok())
    }

    pub async fn value_range(&self, o: &Obj) -> (f64, f64, f64) {
        let min = self
            .prop(o, VALUE, "MinimumValue")
            .await
            .ok()
            .and_then(|v| f64::try_from(v).ok())
            .unwrap_or(0.0);
        let max = self
            .prop(o, VALUE, "MaximumValue")
            .await
            .ok()
            .and_then(|v| f64::try_from(v).ok())
            .unwrap_or(0.0);
        let inc = self
            .prop(o, VALUE, "MinimumIncrement")
            .await
            .ok()
            .and_then(|v| f64::try_from(v).ok())
            .unwrap_or(0.0);
        (min, max, inc)
    }

    pub async fn set_current_value(&self, o: &Obj, v: f64) -> Result<(), String> {
        self.set_prop(o, VALUE, "CurrentValue", Value::from(v))
            .await
    }

    pub async fn select_child(&self, o: &Obj, i: i32) -> Result<bool, String> {
        self.call::<_, bool>(o, SELECTION, "SelectChild", &(i,))
            .await
    }

    /// The first selected child (for a combo box, its chosen item).
    pub async fn selected_child(&self, o: &Obj) -> Option<Obj> {
        let (bus, path) = self
            .call::<_, (String, OwnedObjectPath)>(o, SELECTION, "GetSelectedChild", &(0i32,))
            .await
            .ok()?;
        (path.as_str() != NULL_PATH).then(|| Obj {
            bus,
            path: path.as_str().to_string(),
        })
    }

    pub async fn index_in_parent(&self, o: &Obj) -> i32 {
        self.call::<_, i32>(o, ACCESSIBLE, "GetIndexInParent", &())
            .await
            .unwrap_or(-1)
    }

    /// Every app with its pid and its top-level windows (frames, dialogs, alerts), in one concurrent pass.
    pub async fn toplevels(&self) -> Vec<TopLevel> {
        let apps = self.apps().await;
        let per_app = join_all(apps.iter().map(|app| async move {
            let (pid, app_name, kids) =
                futures_util::join!(self.pid(&app.bus), self.name(app), self.children(app));
            let infos = join_all(kids.iter().map(|k| async move {
                let (role, name, states) =
                    futures_util::join!(self.role(k), self.name(k), self.states(k));
                (k.clone(), role.unwrap_or_default(), name, states)
            }))
            .await;
            infos
                .into_iter()
                .filter(|(_, role, _, _)| {
                    matches!(
                        role.as_str(),
                        "frame"
                            | "window"
                            | "dialog"
                            | "alert"
                            | "file chooser"
                            | "color chooser"
                            | "font chooser"
                    )
                })
                .map(|(obj, role, title, states)| TopLevel {
                    obj,
                    role,
                    title,
                    states,
                    pid: pid.unwrap_or(0),
                    app: app_name.clone(),
                })
                .collect::<Vec<_>>()
        }))
        .await;
        per_app.into_iter().flatten().collect()
    }

    /// The tree under `root`, read level by level with every call of a level in flight at once.
    pub async fn walk(&self, root: &Obj, max_depth: usize, cap: usize) -> Tree {
        let mut tree = Tree { nodes: vec![] };
        let Ok(info) = self.info(root, true).await else {
            return tree;
        };
        tree.nodes.push(Node {
            obj: root.clone(),
            info,
            kids: vec![],
        });
        let mut level = vec![0usize];
        let mut depth = 0;
        while !level.is_empty() && depth < max_depth && tree.nodes.len() < cap {
            let mut next: Vec<(usize, Obj)> = vec![];
            for &i in &level {
                // A subtree the app isn't showing (a closed menu, a hidden page) is left out.
                let showing = i == 0
                    || tree.nodes[i].info.has(state::SHOWING)
                    || tree.nodes[i].info.role == "menu bar";
                if !showing {
                    continue;
                }
                for c in tree.nodes[i].info.children.clone() {
                    next.push((i, c));
                }
            }
            next.truncate(cap.saturating_sub(tree.nodes.len()));
            let infos = join_all(next.iter().map(|(_, o)| self.info(o, true))).await;
            let mut new_level = vec![];
            for ((parent, obj), info) in next.into_iter().zip(infos) {
                let Ok(info) = info else { continue };
                let idx = tree.nodes.len();
                tree.nodes.push(Node {
                    obj,
                    info,
                    kids: vec![],
                });
                tree.nodes[parent].kids.push(idx);
                new_level.push(idx);
            }
            level = new_level;
            depth += 1;
        }
        tree
    }

    /// Every descendant of `root` (including hidden ones, such as a closed menu's items) whose name is `name`, any case,
    /// up to `max_depth` levels down.
    pub async fn find_named(&self, root: &Obj, name: &str, max_depth: usize) -> Vec<(Obj, Info)> {
        let mut out = vec![];
        let mut level = vec![root.clone()];
        for _ in 0..max_depth {
            let kids: Vec<Obj> = join_all(level.iter().map(|o| self.children(o)))
                .await
                .into_iter()
                .flatten()
                .collect();
            if kids.is_empty() {
                break;
            }
            let infos = join_all(kids.iter().map(|k| self.info(k, false))).await;
            for (k, i) in kids.iter().zip(infos) {
                if let Ok(i) = i {
                    if i.name.trim().eq_ignore_ascii_case(name.trim()) {
                        out.push((k.clone(), i));
                    }
                }
            }
            if !out.is_empty() {
                break;
            }
            level = kids;
        }
        out
    }
}

pub struct TopLevel {
    pub obj: Obj,
    pub role: String,
    pub title: String,
    pub states: u64,
    pub pid: u32,
    pub app: String,
}

pub struct Node {
    pub obj: Obj,
    pub info: Info,
    pub kids: Vec<usize>,
}

pub struct Tree {
    pub nodes: Vec<Node>,
}

/// 0.18518517911434174 prints as 0.19; whole numbers print without a point.
pub fn format_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    let mut t = format!("{v:.2}");
    while t.ends_with('0') {
        t.pop();
    }
    if t.ends_with('.') {
        t.pop();
    }
    t
}
