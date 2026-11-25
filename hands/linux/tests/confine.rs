//! `confine` as `open` runs it: what the app's environment holds, and that nothing it writes runs.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const NAMED: &[&str] = &[
    "SWAYSOCK",
    "I3SOCK",
    "HYPRLAND_INSTANCE_SIGNATURE",
    "NIRI_SOCKET",
    "SSH_AUTH_SOCK",
    "KITTY_LISTEN_ON",
    "SECRET_TOKEN",
    "XDG_CONFIG_HOME",
];

fn confine(root: &Path, argv: &[&str]) -> Output {
    let (home, handoff) = (root.join("home"), root.join("handoff"));
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_local-studio-computer"));
    cmd.arg("confine").arg(home).arg(handoff).args(argv);
    for k in NAMED {
        cmd.env(k, "/run/user/1000/one");
    }
    cmd.env("WAYLAND_DISPLAY", "wayland-9").env("LC_ALL", "C.UTF-8");
    cmd.output().unwrap()
}

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("ls-confine-{name}-{}", std::process::id()));
    std::fs::create_dir_all(root.join("home")).unwrap();
    root
}

/// False on a kernel without Landlock, where `confine` starts nothing.
fn started(out: &Output) -> bool {
    !String::from_utf8_lossy(&out.stderr).contains("no Landlock")
}

#[test]
fn a_confined_app_gets_no_variable_that_names_the_session() {
    let root = scratch("env");
    let out = confine(&root, &["/usr/bin/env"]);
    if started(&out) {
        let text = String::from_utf8_lossy(&out.stdout);
        let has = |name: &str| text.lines().any(|l| l.split('=').next() == Some(name));
        for name in NAMED {
            assert!(!has(name), "{name} in {text}");
        }
        for name in ["HOME", "PATH", "TMPDIR", "WAYLAND_DISPLAY", "LC_ALL"] {
            assert!(has(name), "no {name} in {text}");
        }
        assert!(text.contains(&format!("HOME={}", root.join("home").display())));
    }
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn nothing_a_confined_app_writes_runs_as_a_program() {
    let root = scratch("run");
    let line = "cp /bin/true \"$HOME/copy\" && chmod 755 \"$HOME/copy\" && /bin/true && echo made && \"$HOME/copy\" && echo ran";
    let out = confine(&root, &["/bin/sh", "-c", line]);
    if started(&out) {
        assert_eq!(String::from_utf8_lossy(&out.stdout), "made\n");
    }
    std::fs::remove_dir_all(&root).unwrap();
}
