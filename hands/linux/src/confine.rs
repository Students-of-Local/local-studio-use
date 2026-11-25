//! `local-studio-computer confine <home> <handoff> <program> [args...]`: how `open` starts an app for an agent that has less
//! than Full Access. An editor's own file dialog opens and saves any file its process may touch, so the process is kept
//! to what an agent may have: the system's programs and settings to read, a home folder of the agents' own, and the
//! handoff folder. Landlock holds it there (and everything it starts), and the program replaces this process, so the
//! process id the window rules name stays the app's.
//!
//! Sockets are not files to Landlock: the display, the app's own bus and the accessibility bus stay in reach, and so does
//! any other whose path is known. So the app gets none of the session's variables that name one (`kept`), and what Default
//! starts is an app that runs no code of the user's (`DEFAULT_APPS`).

use crate::access;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

const CREATE_RULESET: libc::c_long = 444;
const ADD_RULE: libc::c_long = 445;
const RESTRICT_SELF: libc::c_long = 446;
const RULE_PATH_BENEATH: libc::c_int = 1;

const EXECUTE: u64 = 1;
const WRITE_FILE: u64 = 1 << 1;
const READ_FILE: u64 = 1 << 2;
const READ_DIR: u64 = 1 << 3;
const TRUNCATE: u64 = 1 << 14;
const READ: u64 = EXECUTE | READ_FILE | READ_DIR;
/// What a rule on a plain file may hold.
const ON_FILE: u64 = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE;

/// What the system keeps for every program: code, settings, fonts, devices drawing needs. Nothing under a home folder,
/// /tmp, /run/user, /mnt or /media.
const SYSTEM: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/opt",
    "/etc",
    "/nix/store",
    "/gnu/store",
    "/run/current-system",
    "/run/opengl-driver",
    "/var/cache/fontconfig",
    "/var/lib/dbus",
    "/sys",
    "/proc/self",
    "/proc/cpuinfo",
    "/proc/meminfo",
    "/proc/filesystems",
    "/proc/sys/kernel",
];
const DEVICES: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/dri",
];

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

/// The kernel's Landlock version, 0 when it has none (too old, or turned off at boot).
pub fn version() -> i64 {
    let v = unsafe {
        libc::syscall(
            CREATE_RULESET,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            1u32,
        )
    };
    v.max(0) as i64
}

/// Every file right this kernel can hold back.
fn handled(version: i64) -> u64 {
    let mut all = (1u64 << 13) - 1;
    if version >= 2 {
        all |= 1 << 13;
    }
    if version >= 3 {
        all |= TRUNCATE;
    }
    all
}

fn failed(what: &str) -> String {
    format!("{what}: {}", std::io::Error::last_os_error())
}

/// Keeps this process, and what it starts, to the system's files to read and `write` to change, plus `program` itself.
pub fn restrict(program: &Path, write: &[&Path]) -> Result<(), String> {
    let version = version();
    if version == 0 {
        return Err("this kernel has no Landlock".into());
    }
    let all = handled(version);
    let attr = RulesetAttr {
        handled_access_fs: all,
    };
    let ruleset = unsafe {
        libc::syscall(
            CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        )
    } as i32;
    if ruleset < 0 {
        return Err(failed("landlock_create_ruleset"));
    }
    let add = |path: &Path, rights: u64, needed: bool| -> Result<(), String> {
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else {
            return Err(format!("{} isn't a path", path.display()));
        };
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            return if needed {
                Err(failed(&path.display().to_string()))
            } else {
                Ok(())
            };
        }
        let rights = if path.is_dir() {
            rights
        } else {
            rights & ON_FILE
        };
        let rule = PathBeneathAttr {
            allowed_access: rights & all,
            parent_fd: fd,
        };
        let added = unsafe {
            libc::syscall(
                ADD_RULE,
                ruleset,
                RULE_PATH_BENEATH,
                &rule as *const PathBeneathAttr,
                0u32,
            )
        };
        let result = if added == 0 {
            Ok(())
        } else {
            Err(failed(&path.display().to_string()))
        };
        unsafe { libc::close(fd) };
        result
    };
    for p in SYSTEM {
        add(Path::new(p), READ, false)?;
    }
    let nvidia = std::fs::read_dir("/dev")
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| basename(p).starts_with("nvidia"));
    for p in DEVICES.iter().map(PathBuf::from).chain(nvidia) {
        add(&p, READ_FILE | WRITE_FILE | READ_DIR, false)?;
    }
    // The X11 cookie, by its own name: the app's home folder isn't the person's.
    if let Some(p) = std::env::var_os("XAUTHORITY") {
        add(Path::new(&p), READ_FILE, false)?;
    }
    add(program, READ_FILE | EXECUTE, true)?;
    for p in write {
        // Nothing an app writes is run as a program.
        add(p, all & !EXECUTE, true)?;
    }
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(failed("no_new_privs"));
    }
    if unsafe { libc::syscall(RESTRICT_SELF, ruleset, 0u32) } != 0 {
        return Err(failed("landlock_restrict_self"));
    }
    unsafe { libc::close(ruleset) };
    Ok(())
}

fn basename(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Whether a confined app gets this variable: what it needs to draw, speak its language and find its own bus, and
/// nothing that names another socket (`SWAYSOCK`, `SSH_AUTH_SOCK`) or holds a secret.
fn kept(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "PATH",
        "LANG",
        "LANGUAGE",
        "TZ",
        "USER",
        "LOGNAME",
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_DATA_DIRS",
        "XDG_CONFIG_DIRS",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_TYPE",
        "DBUS_SESSION_BUS_ADDRESS",
        "AT_SPI_BUS_ADDRESS",
        "GIO_EXTRA_MODULES",
        "LIBGL_ALWAYS_SOFTWARE",
        "NO_AT_BRIDGE",
    ];
    const FAMILIES: &[&str] = &["LC_", "GDK_", "GSK_", "GTK_", "QT_", "XCURSOR_"];
    NAMES.contains(&name) || FAMILIES.iter().any(|f| name.starts_with(f))
}

/// The command line that starts `argv` confined.
pub fn command(argv: &[String]) -> Result<Vec<String>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut v = vec![
        exe.to_string_lossy().into_owned(),
        "confine".into(),
        access::app_home().to_string_lossy().into_owned(),
        access::handoff_dir().to_string_lossy().into_owned(),
    ];
    v.extend(argv.iter().cloned());
    Ok(v)
}

/// Runs the program in the folders given; only a failure returns.
pub fn run(args: &[String]) -> i32 {
    let [home, handoff, program, rest @ ..] = args else {
        eprintln!("usage: local-studio-computer confine <home> <handoff> <program> [args...]");
        return 2;
    };
    let (home, handoff) = (Path::new(home), Path::new(handoff));
    let tmp = home.join("tmp");
    let found = if program.contains('/') {
        Some(program.clone())
    } else {
        crate::engine::which(program)
    };
    let Some(found) = found else {
        eprintln!("no program {program}");
        return 127;
    };
    if std::env::var_os("XAUTHORITY").is_none() {
        let cookie = access::home().join(".Xauthority");
        if cookie.is_file() {
            std::env::set_var("XAUTHORITY", cookie);
        }
    }
    for d in [home, handoff, &tmp] {
        if let Err(e) = std::fs::create_dir_all(d) {
            eprintln!("{}: {e}", d.display());
            return 126;
        }
    }
    let _ = std::fs::set_permissions(home, std::os::unix::fs::PermissionsExt::from_mode(0o700));
    if let Err(e) = restrict(Path::new(&found), &[home, handoff]) {
        eprintln!("the app wasn't started: {e}");
        return 126;
    }
    let mut cmd = std::process::Command::new(&found);
    cmd.args(rest)
        .current_dir(home)
        .env_clear()
        .envs(std::env::vars_os().filter(|(k, _)| k.to_str().is_some_and(kept)))
        .env("HOME", home)
        .env("TMPDIR", &tmp)
        // Settings kept in the person's dconf are out of reach, and its service isn't on the app's bus.
        .env("GSETTINGS_BACKEND", "memory");
    let e = cmd.exec();
    eprintln!("{found}: {e}");
    126
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn a_confined_program_reaches_the_system_its_home_and_the_handoff_folder_only() {
        if version() == 0 {
            eprintln!("no Landlock on this kernel: not checked");
            return;
        }
        let root = std::env::temp_dir().join(format!("ls-confine-{}", std::process::id()));
        let (home, handoff, person) =
            (root.join("home"), root.join("handoff"), root.join("person"));
        for d in [&home, &handoff, &person] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(person.join("secret"), "s").unwrap();
        std::fs::write(handoff.join("given"), "g").unwrap();
        std::os::unix::fs::symlink(person.join("secret"), handoff.join("link")).unwrap();
        let own = root.join("tool");
        std::fs::write(&own, "#!/bin/sh\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&own, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let run = |line: String| {
            let (own, dirs) = (own.clone(), [home.clone(), handoff.clone()]);
            let mut cmd = Command::new(&own);
            cmd.arg(line).stdout(Stdio::null()).stderr(Stdio::null());
            unsafe {
                cmd.pre_exec(move || {
                    restrict(&own, &[&dirs[0], &dirs[1]]).map_err(std::io::Error::other)
                });
            }
            cmd.status().unwrap().success()
        };
        let at = |d: &Path, n: &str| d.join(n).display().to_string();
        for ok in [
            "cat /etc/passwd".to_string(),
            "ls /usr".to_string(),
            "echo x >/dev/null".to_string(),
            format!("cat {}", at(&handoff, "given")),
            format!("echo x >{}", at(&handoff, "made")),
            format!(
                "mkdir {0} && echo x >{0}/f && mv {0}/f {0}/g && rm -r {0}",
                at(&home, "d")
            ),
        ] {
            assert!(run(ok.clone()), "{ok}");
        }
        for no in [
            format!("cat {}", at(&person, "secret")),
            format!("cat {}", at(&handoff, "link")),
            format!("ls {}", person.display()),
            format!("echo x >{}", at(&person, "made")),
            format!("echo x >>{}", at(&person, "secret")),
            format!("mv {} {}", at(&person, "secret"), at(&handoff, "taken")),
            format!("ln {} {}", at(&person, "secret"), at(&handoff, "taken")),
            format!("rm {}", at(&person, "secret")),
            "ls /tmp".to_string(),
            "cat /proc/1/cmdline".to_string(),
            format!("echo x >>{}", own.display()),
        ] {
            assert!(!run(no.clone()), "{no}");
        }
        assert_eq!(std::fs::read_to_string(person.join("secret")).unwrap(), "s");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
