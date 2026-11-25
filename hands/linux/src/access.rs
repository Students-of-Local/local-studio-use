//! What agents may do here: the person's access mode, read from Local Studio's config folder on every call so a narrowing
//! applies at once, and the connector cap over it. Also the folders the helper uses and the record of processes agents
//! started, which is what makes a window an agent's when there is no agent workspace to put it on.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    Default,
    Full,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read_only",
            Mode::Default => "default",
            Mode::Full => "full",
        }
    }
    /// A saved value that isn't one of the modes reads as Default, never as more access.
    pub fn parse(s: Option<&str>) -> Mode {
        match s {
            Some("read_only") => Mode::ReadOnly,
            Some("full") => Mode::Full,
            _ => Mode::Default,
        }
    }
    /// What a caller on another machine gets: never more than Default.
    pub fn for_remote(self) -> Mode {
        if self == Mode::Full {
            Mode::Default
        } else {
            self
        }
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

pub fn home() -> PathBuf {
    env("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// The same folder `configDir()` in cli/src/files.ts picks: the override, else `browser` in Local Studio's data folder.
pub fn config_dir() -> PathBuf {
    if let Some(d) = env("LOCAL_STUDIO_BROWSER_DIR") {
        return PathBuf::from(d);
    }
    env("LOCAL_STUDIO_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local-studio"))
        .join("browser")
}

pub fn data_dir() -> PathBuf {
    env("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("local-studio-browser")
}

pub fn state_dir() -> PathBuf {
    env("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("state"))
        .join("local-studio-browser")
}

pub fn cache_dir() -> PathBuf {
    env("LOCAL_STUDIO_BROWSER_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home().join(".cache"))
                .join("local-studio-browser")
        })
}

pub fn handoff_dir() -> PathBuf {
    data_dir().join("handoff")
}

/// The home folder of apps agents start without Full Access.
pub fn app_home() -> PathBuf {
    data_dir().join("app-home")
}

pub fn shots_dir() -> PathBuf {
    cache_dir().join("shots")
}

/// `hands.json` in the config folder: `{"access": "read_only" | "default" | "full", "apps": ["gedit", "/opt/x/bin/y"]}`.
/// A missing file means Default and no extra apps. A file that is there but can't be read or parsed, or whose
/// `access` isn't a string, means Read Only: the person may have chosen it, and a typo or a save in progress never
/// widens access. `problem` says why, for `windows`.
#[derive(Clone, Debug)]
pub struct Settings {
    pub mode: Mode,
    pub apps: Vec<String>,
    pub problem: Option<String>,
}

pub fn settings() -> Settings {
    parse_settings(fs::read_to_string(config_dir().join("hands.json")))
}

pub fn parse_settings(read: std::io::Result<String>) -> Settings {
    let unusable = |why: String| Settings {
        mode: Mode::ReadOnly,
        apps: vec![],
        problem: Some(format!(
            "hands.json {why}, so agents get Read Only until it is fixed"
        )),
    };
    let text = match read {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Settings {
                mode: Mode::Default,
                apps: vec![],
                problem: None,
            }
        }
        Err(e) => return unusable(format!("can't be read ({e})")),
    };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => return unusable(format!("isn't valid JSON ({e})")),
    };
    let mode = match v.get("access") {
        None => Mode::Default,
        Some(Value::String(s)) => Mode::parse(Some(s)),
        Some(_) => return unusable("has an access that isn't a string".into()),
    };
    let apps = v
        .get("apps")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Settings {
        mode,
        apps,
        problem: None,
    }
}

/// The mode this session works under: the person's, capped at Default for a connector.
pub fn mode(connector: bool) -> Mode {
    let m = settings().mode;
    if connector {
        m.for_remote()
    } else {
        m
    }
}

/// A process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat), so a reused pid isn't taken for
/// the one an agent started.
pub fn start_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 2..];
    after.split_whitespace().nth(19)?.parse().ok()
}

pub fn parent_of(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &stat[stat.rfind(')')? + 2..];
    after.split_whitespace().nth(1)?.parse().ok()
}

/// Processes agents started on this machine, kept in the state folder across helper runs, as `pid start_time` lines, a
/// confined one (src/confine.rs) with `confined` after them. A window belongs to an agent when its process is one of
/// these or a child of one.
pub struct AgentProcesses;

impl AgentProcesses {
    fn path() -> PathBuf {
        state_dir().join("hands-agent-processes")
    }

    pub fn load() -> Vec<AgentProcess> {
        let text = fs::read_to_string(Self::path()).unwrap_or_default();
        parse_processes(&text)
            .into_iter()
            .filter(|p| start_time(p.pid) == Some(p.start))
            .collect()
    }

    pub fn add(pid: u32, confined: bool) {
        let Some(start) = start_time(pid) else { return };
        let mut all = Self::load();
        all.push(AgentProcess {
            pid,
            start,
            confined,
        });
        let _ = fs::create_dir_all(state_dir());
        let text: String = all
            .iter()
            .map(|p| {
                let mark = if p.confined { " confined" } else { "" };
                format!("{} {}{mark}\n", p.pid, p.start)
            })
            .collect();
        let _ = fs::write(Self::path(), text);
    }

    /// The ids of those an agent under `mode` may use: an app started under Full Access can open any file, so a session
    /// with less doesn't get its windows.
    pub fn ids(list: &[AgentProcess], mode: Mode) -> Vec<u32> {
        list.iter()
            .filter(|p| p.confined || mode == Mode::Full)
            .map(|p| p.pid)
            .collect()
    }

    /// Whether `pid` is an agent's process or descends from one.
    pub fn owns(list: &[u32], pid: u32) -> bool {
        let mut p = pid;
        for _ in 0..32 {
            if list.contains(&p) {
                return true;
            }
            match parent_of(p) {
                Some(up) if up > 1 => p = up,
                _ => return false,
            }
        }
        false
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AgentProcess {
    pub pid: u32,
    pub start: u64,
    pub confined: bool,
}

fn parse_processes(text: &str) -> Vec<AgentProcess> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some(AgentProcess {
                pid: it.next()?.parse().ok()?,
                start: it.next()?.parse().ok()?,
                confined: it.next() == Some("confined"),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_access_gets_the_windows_of_an_app_that_is_not_confined() {
        let all = parse_processes("10 5\n11 6 confined\n12 7 other\nx\n");
        assert_eq!(AgentProcesses::ids(&all, Mode::Full), vec![10, 11, 12]);
        assert_eq!(AgentProcesses::ids(&all, Mode::Default), vec![11]);
    }

    fn read(t: &str) -> std::io::Result<String> {
        Ok(t.to_string())
    }

    #[test]
    fn settings_never_widen_on_a_bad_file() {
        assert_eq!(
            parse_settings(read(r#"{"access":"read_only"}"#)).mode,
            Mode::ReadOnly
        );
        assert_eq!(
            parse_settings(read(r#"{"access":"full"}"#)).mode,
            Mode::Full
        );
        assert_eq!(
            parse_settings(read(r#"{"access":"bogus"}"#)).mode,
            Mode::Default
        );
        assert_eq!(parse_settings(read(r#"{}"#)).mode, Mode::Default);
        let typo = parse_settings(read(r#"{"access":"read_only",}"#));
        assert_eq!(typo.mode, Mode::ReadOnly);
        assert!(typo.problem.is_some());
        assert_eq!(parse_settings(read("")).mode, Mode::ReadOnly);
        assert_eq!(parse_settings(read(r#"{"access":1}"#)).mode, Mode::ReadOnly);
        let missing = parse_settings(Err(std::io::Error::from(std::io::ErrorKind::NotFound)));
        assert_eq!(missing.mode, Mode::Default);
        assert!(missing.problem.is_none());
        let denied = parse_settings(Err(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )));
        assert_eq!(denied.mode, Mode::ReadOnly);
    }
}
