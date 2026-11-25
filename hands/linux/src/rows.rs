//! A window's tree as rows for a model to read: `[5] button "Save" (disabled)`, indented under its parent. Elements with
//! no name, value or action (wrapper panels) print nothing, and their children move up a level.

use crate::atspi::{state, Info, Obj, Tree, EDITABLE, SELECTION, TEXT, VALUE};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const VALUE_LIMIT: usize = 120;
pub const DEFAULT_MAX: usize = 400;

#[derive(Clone, Debug)]
pub struct Row {
    pub depth: usize,
    pub number: usize,
    pub role: String,
    pub raw_role: String,
    pub name: String,
    pub value: String,
    pub states: Vec<String>,
    pub key: String,
    pub parent: Option<usize>,
    pub interactive: bool,
    pub obj: Obj,
}

impl Row {
    pub fn line(&self) -> String {
        let mut s = "  ".repeat(self.depth);
        s += &format!("[{}] {}", self.number, self.role);
        if !self.name.is_empty() {
            s += &format!(" {}", quoted(&self.name));
        }
        if !self.value.is_empty() && self.value != self.name {
            s += &format!(" ={}", shown_value(&self.value));
        }
        if !self.states.is_empty() {
            s += &format!(" ({})", self.states.join(","));
        }
        s
    }
    pub fn flat(&self) -> String {
        self.line().trim_start().to_string()
    }
}

/// AT-SPI's role names, shortened to what an agent types: `push button` is `button`, an editable `text` is `textfield`.
pub fn short_role(raw: &str, info: Option<&Info>) -> String {
    let editable = info.is_some_and(|i| i.iface(EDITABLE) || i.has(state::EDITABLE));
    match raw {
        "push button" => "button".into(),
        "toggle button" => "togglebutton".into(),
        "check box" => "checkbox".into(),
        "radio button" => "radiobutton".into(),
        "text" | "entry" => {
            if editable {
                "textfield".into()
            } else {
                "text".into()
            }
        }
        "password text" => "securetextfield".into(),
        "spin button" => "spinbutton".into(),
        "combo box" => "combobox".into(),
        "menu item" => "menuitem".into(),
        "check menu item" => "checkmenuitem".into(),
        "radio menu item" => "radiomenuitem".into(),
        "tearoff menu item" => "menuitem".into(),
        "menu bar" => "menubar".into(),
        "page tab" => "tab".into(),
        "page tab list" => "tablist".into(),
        "list item" => "listitem".into(),
        "table cell" => "cell".into(),
        "scroll bar" => "scrollbar".into(),
        "scroll pane" => "scrollarea".into(),
        "label" | "static" => "statictext".into(),
        other => other.replace(' ', ""),
    }
}

/// Whether `asked` (as an agent types it) names a row's role.
pub fn role_matches(asked: &str, row: &Row) -> bool {
    let a = asked.to_lowercase().replace([' ', '_', '-'], "");
    a == row.role || a == row.raw_role.replace(' ', "") || (a == "textfield" && row.role == "text")
}

pub fn interactive(info: &Info) -> bool {
    info.iface(crate::atspi::ACTION)
        || info.iface(EDITABLE)
        || (info.iface(VALUE) && !info.iface(TEXT))
        || info.iface(SELECTION)
}

fn states_of(info: &Info, interactive: bool) -> Vec<String> {
    let mut s = vec![];
    if interactive && !(info.has(state::ENABLED) || info.has(state::SENSITIVE)) {
        s.push("disabled".into());
    }
    if info.has(state::FOCUSED) {
        s.push("focused".into());
    }
    if info.has(state::INDETERMINATE) {
        s.push("mixed".into());
    } else if info.has(state::CHECKED) {
        s.push("checked".into());
    } else if matches!(
        info.role.as_str(),
        "check box" | "toggle button" | "radio button" | "check menu item" | "radio menu item"
    ) {
        s.push("unchecked".into());
    }
    if info.has(state::SELECTED) {
        s.push("selected".into());
    }
    if info.has(state::EXPANDABLE) {
        s.push(if info.has(state::EXPANDED) {
            "expanded".into()
        } else {
            "collapsed".into()
        });
    }
    if info.has(state::READ_ONLY) && info.iface(TEXT) {
        s.push("readonly".into());
    }
    s
}

pub fn state_names(info: &Info) -> Vec<String> {
    let mut s = states_of(info, true);
    if info.has(state::EDITABLE) {
        s.push("editable".into());
    }
    if info.has(state::SHOWING) {
        s.push("showing".into());
    }
    s
}

/// The rows of `tree` (its root is the window, which the header names instead). `title` is the window's.
pub fn rows(tree: &Tree, title: &str) -> Vec<Row> {
    let mut out: Vec<Row> = vec![];
    let mut siblings: HashMap<String, usize> = HashMap::new();
    fn walk(
        tree: &Tree,
        i: usize,
        depth: usize,
        parent: Option<usize>,
        path: &str,
        title: &str,
        out: &mut Vec<Row>,
        siblings: &mut HashMap<String, usize>,
    ) {
        let n = &tree.nodes[i];
        let info = &n.info;
        let act = interactive(info);
        let value = info.value.clone().unwrap_or_default();
        let mut name = info.name.trim().to_string();
        if name.is_empty() && !act {
            name = info.description.trim().to_string();
        }
        // The title bar's label repeats the window title, which the header already prints.
        let echo = !act && value.is_empty() && name == title && !title.is_empty();
        let shown = i != 0 && (act || !name.is_empty() || !value.is_empty()) && !echo;
        let (mut cdepth, mut cparent, mut cpath) = (depth, parent, path.to_string());
        if shown {
            let role = short_role(&info.role, Some(info));
            let slot = format!(
                "{path}/{role}:{}",
                if name == value { "" } else { name.as_str() }
            );
            let ord = siblings.entry(slot.clone()).or_insert(0);
            let key = format!("{slot}#{ord}");
            *ord += 1;
            out.push(Row {
                depth,
                number: out.len() + 1,
                role,
                raw_role: info.role.clone(),
                name,
                value,
                states: states_of(info, act),
                key: key.clone(),
                parent,
                interactive: act,
                obj: n.obj.clone(),
            });
            cdepth = depth + 1;
            cparent = Some(out.len() - 1);
            cpath = key;
        }
        for &k in &n.kids {
            walk(tree, k, cdepth, cparent, &cpath, title, out, siblings);
        }
    }
    if !tree.nodes.is_empty() {
        walk(tree, 0, 0, None, "", title, &mut out, &mut siblings);
    }
    out
}

pub fn quoted(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o += "\\\"",
            '\\' => o += "\\\\",
            '\n' => o += "\\n",
            '\t' => o += "\\t",
            '\r' => o += "\\r",
            c => o.push(c),
        }
    }
    o + "\""
}

pub fn shown_value(v: &str) -> String {
    if v.parse::<f64>().is_ok() && v.len() <= 24 {
        return v.to_string();
    }
    let n = v.chars().count();
    if n <= VALUE_LIMIT {
        return quoted(v);
    }
    let cut: String = v.chars().take(VALUE_LIMIT).collect();
    format!(
        "{}…(+{} chars; get value for all)",
        quoted(&cut),
        n - VALUE_LIMIT
    )
}

pub fn header(snapshot: &str, window: i64, title: &str, app: &str, refs: usize) -> String {
    format!("snapshot {snapshot} · window {window} {} ({app}) · {refs} refs\nact by row number {{\"ref\":\"5\"}} or full ref @{snapshot}:e5", quoted(title))
}

/// Indices of rows to print for `query` (any of `|`-separated terms, any case, in role, name or value), with their parents.
pub fn query_filter(rows: &[Row], query: &str) -> Vec<usize> {
    let terms: Vec<String> = query
        .split('|')
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let mut keep = vec![false; rows.len()];
    for (i, r) in rows.iter().enumerate() {
        let hay = format!("{} {} {} {}", r.role, r.raw_role, r.name, r.value).to_lowercase();
        if terms.iter().any(|t| hay.contains(t)) {
            let mut up = Some(i);
            while let Some(j) = up {
                keep[j] = true;
                up = rows[j].parent;
            }
        }
    }
    (0..rows.len()).filter(|&i| keep[i]).collect()
}

/// What changed between two reads of a window, as `+`, `~` and `-` lines; also the row numbers printed.
pub fn diff(old: &[Row], new: &[Row]) -> (Vec<String>, Vec<usize>) {
    let before: HashMap<&str, &Row> = old.iter().map(|r| (r.key.as_str(), r)).collect();
    let after: HashMap<&str, &Row> = new.iter().map(|r| (r.key.as_str(), r)).collect();
    let mut lines = vec![];
    let mut printed = vec![];
    for r in new {
        match before.get(r.key.as_str()) {
            None => {
                lines.push(format!("+ {}", r.flat()));
                printed.push(r.number);
            }
            Some(o)
                if o.flat().split_once(' ').map(|x| x.1)
                    != r.flat().split_once(' ').map(|x| x.1) =>
            {
                lines.push(format!("~ {}", r.flat()));
                printed.push(r.number);
            }
            _ => {}
        }
    }
    for r in old {
        if !after.contains_key(r.key.as_str()) {
            let mut gone = r.role.clone();
            if !r.name.is_empty() {
                gone += &format!(" {}", quoted(&r.name));
            }
            lines.push(format!("- {gone}"));
        }
    }
    (lines, printed)
}

/// The rows as a nested tree, for `format: "json"`.
pub fn json_tree(rows: &[Row], snapshot: &str) -> Value {
    fn node(
        rows: &[Row],
        i: usize,
        snapshot: &str,
        kids: &HashMap<Option<usize>, Vec<usize>>,
    ) -> Value {
        let r = &rows[i];
        let mut v =
            json!({"ref": format!("@{snapshot}:e{}", r.number), "role": r.role, "name": r.name});
        if !r.value.is_empty() {
            v["value"] = json!(r.value);
        }
        if !r.states.is_empty() {
            v["states"] = json!(r.states);
        }
        if let Some(ks) = kids.get(&Some(i)) {
            v["children"] =
                Value::Array(ks.iter().map(|&k| node(rows, k, snapshot, kids)).collect());
        }
        v
    }
    let mut kids: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        kids.entry(r.parent).or_default().push(i);
    }
    Value::Array(
        kids.get(&None)
            .map(|top| {
                top.iter()
                    .map(|&i| node(rows, i, snapshot, &kids))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atspi::{Info, Node, Obj, Tree, ACTION};

    fn n(
        role: &str,
        name: &str,
        ifaces: &[&str],
        value: Option<&str>,
        _parent: Option<usize>,
    ) -> Node {
        Node {
            obj: Obj {
                bus: ":1.1".into(),
                path: format!("/{role}/{name}"),
            },
            info: Info {
                role: role.into(),
                name: name.into(),
                ifaces: ifaces.iter().map(|s| s.to_string()).collect(),
                value: value.map(str::to_string),
                states: (1 << state::ENABLED) | (1 << state::SHOWING),
                ..Default::default()
            },
            kids: vec![],
        }
    }

    fn fixture() -> Tree {
        let mut t = Tree {
            nodes: vec![
                n("frame", "Fixture", &[], None, None),
                n("filler", "", &[], None, Some(0)),
                n("push button", "Save", &[ACTION], None, Some(1)),
                n("text", "", &[TEXT, EDITABLE], Some("hello"), Some(1)),
                n("label", "Fixture", &[], None, Some(1)),
            ],
        };
        t.nodes[0].kids = vec![1];
        t.nodes[1].kids = vec![2, 3, 4];
        t
    }

    #[test]
    fn wrappers_and_title_echoes_print_nothing() {
        let r = rows(&fixture(), "Fixture");
        let lines: Vec<String> = r.iter().map(Row::line).collect();
        assert_eq!(
            lines,
            vec!["[1] button \"Save\"", "[2] textfield =\"hello\""]
        );
    }

    #[test]
    fn diff_names_changed_and_removed_rows() {
        let old = rows(&fixture(), "Fixture");
        let mut t = fixture();
        t.nodes[3].info.value = Some("hello world".into());
        t.nodes[1].kids = vec![3];
        let new = rows(&t, "Fixture");
        let (lines, printed) = diff(&old, &new);
        assert_eq!(
            lines,
            vec!["~ [1] textfield =\"hello world\"", "- button \"Save\""]
        );
        assert_eq!(printed, vec![1]);
    }

    #[test]
    fn query_keeps_parents_and_roles_match_as_typed() {
        let r = rows(&fixture(), "Fixture");
        assert_eq!(query_filter(&r, "SAVE|nothing"), vec![0]);
        assert!(role_matches("textfield", &r[1]));
        assert!(role_matches("push button", &r[0]));
    }

    #[test]
    fn long_values_are_cut() {
        let v = "x".repeat(130);
        assert!(shown_value(&v).ends_with("…(+10 chars; get value for all)"));
        assert_eq!(shown_value("3.5"), "3.5");
    }
}
