//! `local-studio-computer hold <sway-socket> <argv...>`: how an agent's app starts on a Sway without sandbox criteria (before
//! 1.10). There the only rule that can name one app is `[pid=N]`, and Sway keeps rules for its whole session. So this
//! process starts the app stopped, adds the rules for its pid, tells the helper the pid, lets it run, and then never
//! reaps it: when the app exits it stays a zombie, and Linux gives no other process its pid while it does. This process
//! exits when the Sway process that holds the rules does, and only then is the pid free.
//!
//! Once a rule may name the pid, nothing here reaps the app: a failure after that point kills it unstarted and keeps
//! holding. A missed IPC reply proves nothing about the rules, so the end is Sway's process going away, not Sway going
//! quiet, and the signals a service teardown sends are ignored.

use crate::{access, desktop};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::time::{Duration, Instant};

const STOP_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGHUP, libc::SIGINT];

pub fn run(args: &[String]) -> i32 {
    let (Some(sock), Some(_)) = (args.first(), args.get(1)) else {
        eprintln!("usage: local-studio-computer hold <sway-socket> <program> [args...]");
        return 2;
    };
    let sock = Path::new(sock);
    // The process whose rules these will be. Its pid and start time name it even after its pid is reused.
    let Some((sway, since)) = desktop::sway_process(sock) else {
        println!("error can't tell which process serves {}", sock.display());
        return 1;
    };
    for s in STOP_SIGNALS {
        unsafe { libc::signal(s, libc::SIG_IGN) };
    }
    let mut out = std::io::stdout();
    let status = match start(sock, &args[1..], &mut out) {
        Started::Done(status) => return status,
        Started::Hold(status, _) => status,
    };
    // Nothing more goes to the helper: point standard output at /dev/null so its pipe closes.
    if let Ok(null) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
        use std::os::fd::AsRawFd;
        unsafe { libc::dup2(null.as_raw_fd(), 1) };
    }
    while access::start_time(sway) == Some(since) {
        std::thread::sleep(Duration::from_secs(5));
    }
    status
}

pub enum Started {
    /// No rule names the pid: exit now.
    Done(i32),
    /// A rule may name the app's pid (the second field, which the tests read): hold it until Sway exits.
    Hold(i32, #[allow(dead_code)] u32),
}

/// Starts `argv` stopped, adds its rules, writes its pid (or `error ...`) to `out`, and lets it run. Leaves the app
/// unreaped on every path where a rule may already name it.
pub fn start(sock: &Path, argv: &[String], out: &mut dyn Write) -> Started {
    // An ignored SIGCHLD, inherited across exec, would have the kernel reap the app at once.
    unsafe { libc::signal(libc::SIGCHLD, libc::SIG_DFL) };
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", "kill -STOP $$; exec \"$@\"", "sh"])
        .args(argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    unsafe {
        // Ignored signals carry across exec: the app gets the defaults back.
        cmd.pre_exec(|| {
            for s in STOP_SIGNALS {
                libc::signal(s, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(out, "error can't start {}: {e}", argv[0]);
            return Started::Done(1);
        }
    };
    let pid = child.id();
    // Dropping a Child never waits for it: the zombie, and with it the pid, stays held.
    drop(child);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !stopped(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !stopped(pid) {
        // No rule was sent: the pid can go.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        }
        let _ = writeln!(out, "error the app didn't reach its start in 2 s");
        return Started::Done(1);
    }
    // The pid goes to the helper before the app runs: a helper that has gone away can't track it, so it never runs.
    let told = desktop::sway_claim_pid(sock, pid).and_then(|()| {
        writeln!(out, "{pid}")
            .and_then(|()| out.flush())
            .map_err(|e| format!("the helper stopped listening: {e}"))
    });
    match told {
        Ok(()) => {
            unsafe { libc::kill(pid as i32, libc::SIGCONT) };
            Started::Hold(0, pid)
        }
        Err(e) => {
            // Its windows could land on the person's workspace: it never runs, and its pid stays held.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            let _ = writeln!(out, "error {e}");
            let _ = out.flush();
            Started::Hold(1, pid)
        }
    }
}

/// True when `pid` is stopped (state T in /proc/<pid>/stat).
fn stopped(pid: u32) -> bool {
    state(pid) == Some('T')
}

fn state(pid: u32) -> Option<char> {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|t| {
            t.rsplit(')')
                .next()
                .and_then(|r| r.trim_start().chars().next())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixListener;

    /// A stand-in for Sway's IPC socket that answers each command with `success` from `answers`, in order.
    fn fake_sway(answers: Vec<bool>) -> (tempdir::Dir, std::path::PathBuf) {
        let dir = tempdir::Dir::new();
        let sock = dir.0.join("sway.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            for ok in answers {
                let Ok((mut s, _)) = listener.accept() else {
                    return;
                };
                let mut head = [0u8; 14];
                if s.read_exact(&mut head).is_err() {
                    return;
                }
                let len = u32::from_ne_bytes([head[6], head[7], head[8], head[9]]) as usize;
                let mut body = vec![0u8; len];
                let _ = s.read_exact(&mut body);
                let reply = format!("[{{\"success\":{ok}}}]");
                let mut msg = b"i3-ipc".to_vec();
                msg.extend_from_slice(&(reply.len() as u32).to_ne_bytes());
                msg.extend_from_slice(&0u32.to_ne_bytes());
                msg.extend_from_slice(reply.as_bytes());
                let _ = s.write_all(&msg);
            }
        });
        (dir, sock)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!(
                    "local-studio-hold-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    struct Closed;
    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn argv() -> Vec<String> {
        vec!["/bin/sleep".into(), "30".into()]
    }

    /// Waits for `pid` to reach state `want`, then reaps it so the test leaves nothing behind.
    fn settles_as(pid: u32, want: char) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while state(pid) != Some(want) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let seen = state(pid) == Some(want);
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
            libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
        }
        seen
    }

    fn pid_in(out: &[u8]) -> Option<u32> {
        String::from_utf8_lossy(out).trim().parse().ok()
    }

    #[test]
    fn a_rule_that_fails_after_another_went_in_kills_the_app_but_keeps_its_pid() {
        let (_dir, sock) = fake_sway(vec![true, false]);
        let mut out = Vec::new();
        let Started::Hold(1, pid) = start(&sock, &argv(), &mut out) else {
            panic!(
                "expected to hold after a failed rule: {}",
                String::from_utf8_lossy(&out)
            );
        };
        assert!(String::from_utf8_lossy(&out).starts_with("error sway refused: no_focus"));
        // The app is this process's child, so a reaped pid would have no /proc entry at all.
        assert!(settles_as(pid, 'Z'), "the app died unreaped");
    }

    #[test]
    fn a_helper_that_stopped_listening_never_sees_the_app_run() {
        let (_dir, sock) = fake_sway(vec![true, true]);
        let Started::Hold(1, pid) = start(&sock, &argv(), &mut Closed) else {
            panic!("expected to hold after the pid couldn't be written");
        };
        assert!(settles_as(pid, 'Z'), "the app died unreaped");
    }

    #[test]
    fn a_placed_app_runs_and_the_helper_hears_its_pid_first() {
        let (_dir, sock) = fake_sway(vec![true, true]);
        let mut out = Vec::new();
        let Started::Hold(0, pid) = start(&sock, &argv(), &mut out) else {
            panic!(
                "expected the app to start: {}",
                String::from_utf8_lossy(&out)
            );
        };
        assert_eq!(pid_in(&out), Some(pid), "the helper hears the app's pid");
        assert!(
            settles_as(pid, 'S'),
            "the app should be running (sleeping), not stopped"
        );
    }
}
