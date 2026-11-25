//! The one Wayland request the helper makes: a security-context listener (the staging protocol
//! `wp_security_context_manager_v1`). An app an agent starts on Sway connects through a socket of its own, and the
//! compositor tags every client that connects there with a sandbox instance id made for this launch alone. Sway's
//! `for_window` and `no_focus` rules then name that id instead of a process id, which another process can reuse.
//!
//! The wire protocol is written by hand: four objects and a dozen messages don't justify a client library, and the
//! binary stays static.

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MANAGER: &str = "wp_security_context_manager_v1";

/// A listener the compositor accepts on while `keep` (the write end of a pipe whose read end it holds) stays open.
/// Pass `keep` to the app so the listener lives exactly as long as the app does; `dir` holds the socket and is the
/// app's to remove when it exits.
pub struct AgentDisplay {
    pub socket: PathBuf,
    pub dir: PathBuf,
    /// Held, never read: the app inherits it at start, and dropping this copy leaves the app's as the last.
    #[allow(dead_code)]
    keep: OwnedFd,
}

/// The compositor's socket, from `WAYLAND_DISPLAY` (a name in `XDG_RUNTIME_DIR`, or an absolute path).
pub fn display_socket() -> Option<PathBuf> {
    let d = std::env::var("WAYLAND_DISPLAY")
        .ok()
        .filter(|d| !d.is_empty())?;
    if d.starts_with('/') {
        return Some(PathBuf::from(d));
    }
    let rt = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|d| !d.is_empty())?;
    Some(Path::new(&rt).join(d))
}

/// A random id that names one launch: 128 bits from the kernel.
pub fn instance_id() -> Result<String, String> {
    let mut b = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| format!("random id: {e}"))?;
    Ok(format!(
        "local-studio-{}",
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    ))
}

/// Makes a socket folder in `runtime`, asks the compositor at `display` to accept clients there under a security
/// context named `instance`, and answers once the compositor has taken the request without an error.
pub fn agent_display(
    display: &Path,
    runtime: &Path,
    instance: &str,
) -> Result<AgentDisplay, String> {
    let dir = runtime.join(format!("local-studio-wl.{}", &instance["local-studio-".len()..]));
    std::fs::create_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let socket = dir.join("wayland-0");
    let made = (|| {
        let listener =
            UnixListener::bind(&socket).map_err(|e| format!("{}: {e}", socket.display()))?;
        let (read, keep) = pipe()?;
        create_listener(display, listener.as_raw_fd(), read.as_raw_fd(), instance)?;
        // The compositor holds its own copies of the listening socket and the pipe's read end now.
        Ok::<OwnedFd, String>(keep)
    })();
    match made {
        Ok(keep) => Ok(AgentDisplay { socket, dir, keep }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e)
        }
    }
}

/// A pipe whose read end closes on exec and whose write end doesn't, so a child started next inherits the write end.
fn pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut fds = [0 as RawFd; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(format!("pipe: {}", std::io::Error::last_os_error()));
    }
    let (r, w) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    unsafe { libc::fcntl(r.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    Ok((r, w))
}

enum Arg<'a> {
    U(u32),
    S(&'a str),
}

fn encode(obj: u32, op: u16, args: &[Arg]) -> Vec<u8> {
    let mut body = Vec::new();
    for a in args {
        match a {
            Arg::U(v) => body.extend_from_slice(&v.to_ne_bytes()),
            Arg::S(s) => {
                body.extend_from_slice(&((s.len() + 1) as u32).to_ne_bytes());
                body.extend_from_slice(s.as_bytes());
                body.push(0);
                while body.len() % 4 != 0 {
                    body.push(0);
                }
            }
        }
    }
    let mut m = obj.to_ne_bytes().to_vec();
    m.extend_from_slice(&((((8 + body.len()) as u32) << 16) | op as u32).to_ne_bytes());
    m.extend_from_slice(&body);
    m
}

/// Sends `bytes` with `fds` attached (SCM_RIGHTS), as the Wayland wire protocol passes file descriptors.
fn send_fds(sock: &UnixStream, bytes: &[u8], fds: &[RawFd]) -> Result<(), String> {
    let space = unsafe { libc::CMSG_SPACE(std::mem::size_of_val(fds) as u32) } as usize;
    let mut control = vec![0u8; space];
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr() as *mut libc::c_void,
        iov_len: bytes.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = space as _;
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        (*c).cmsg_level = libc::SOL_SOCKET;
        (*c).cmsg_type = libc::SCM_RIGHTS;
        (*c).cmsg_len = libc::CMSG_LEN(std::mem::size_of_val(fds) as u32) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(c) as *mut RawFd, fds.len());
    }
    let n = unsafe { libc::sendmsg(sock.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) };
    if n < 0 || n as usize != bytes.len() {
        return Err(format!("wayland send: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

struct Event {
    obj: u32,
    op: u16,
    body: Vec<u8>,
}

fn read_event(sock: &mut UnixStream) -> Result<Event, String> {
    let mut head = [0u8; 8];
    sock.read_exact(&mut head)
        .map_err(|e| format!("wayland read: {e}"))?;
    let obj = u32::from_ne_bytes([head[0], head[1], head[2], head[3]]);
    let word = u32::from_ne_bytes([head[4], head[5], head[6], head[7]]);
    let size = (word >> 16) as usize;
    if size < 8 {
        return Err("wayland: a malformed event".into());
    }
    let mut body = vec![0u8; size - 8];
    sock.read_exact(&mut body)
        .map_err(|e| format!("wayland read: {e}"))?;
    Ok(Event {
        obj,
        op: (word & 0xffff) as u16,
        body,
    })
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|x| u32::from_ne_bytes([x[0], x[1], x[2], x[3]]))
}

/// A string argument at `at`, and the offset after it.
fn str_at(b: &[u8], at: usize) -> Option<(String, usize)> {
    let len = u32_at(b, at)? as usize;
    let s = b.get(at + 4..at + 4 + len.saturating_sub(1))?;
    Some((
        String::from_utf8_lossy(s).into_owned(),
        at + 4 + len.div_ceil(4) * 4,
    ))
}

/// Reads events until the callback `done` fires. Collects registry globals (object 2) into `globals` and turns
/// `wl_display.error` into an error.
fn roundtrip(
    sock: &mut UnixStream,
    done: u32,
    globals: &mut Vec<(u32, String)>,
) -> Result<(), String> {
    loop {
        let e = read_event(sock)?;
        match (e.obj, e.op) {
            (1, 0) => {
                let code = u32_at(&e.body, 4).unwrap_or(0);
                let text = str_at(&e.body, 8).map(|(s, _)| s).unwrap_or_default();
                return Err(format!("the compositor refused (error {code}): {text}"));
            }
            (2, 0) => {
                if let (Some(name), Some((iface, _))) = (u32_at(&e.body, 0), str_at(&e.body, 4)) {
                    globals.push((name, iface));
                }
            }
            (o, 0) if o == done => return Ok(()),
            _ => {}
        }
    }
}

fn create_listener(
    display: &Path,
    listen: RawFd,
    close: RawFd,
    instance: &str,
) -> Result<(), String> {
    let mut sock =
        UnixStream::connect(display).map_err(|e| format!("{}: {e}", display.display()))?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();
    // wl_display.get_registry (new id 2), then wl_display.sync (callback 3) to learn every global.
    let mut out = encode(1, 1, &[Arg::U(2)]);
    out.extend(encode(1, 0, &[Arg::U(3)]));
    sock.write_all(&out)
        .map_err(|e| format!("wayland send: {e}"))?;
    let mut globals = Vec::new();
    roundtrip(&mut sock, 3, &mut globals)?;
    let Some(name) = globals.iter().find(|(_, i)| i == MANAGER).map(|(n, _)| *n) else {
        return Err(format!("the compositor offers no {MANAGER}"));
    };
    // wl_registry.bind the manager as object 4.
    sock.write_all(&encode(
        2,
        0,
        &[Arg::U(name), Arg::S(MANAGER), Arg::U(1), Arg::U(4)],
    ))
    .map_err(|e| format!("wayland send: {e}"))?;
    // create_listener (new id 5) carries the listening socket and the pipe's read end.
    send_fds(&sock, &encode(4, 1, &[Arg::U(5)]), &[listen, close])?;
    let mut out = encode(5, 1, &[Arg::S("local-studio")]);
    out.extend(encode(5, 2, &[Arg::S("local-studio-agent")]));
    out.extend(encode(5, 3, &[Arg::S(instance)]));
    out.extend(encode(5, 4, &[]));
    out.extend(encode(5, 0, &[]));
    out.extend(encode(4, 0, &[]));
    out.extend(encode(1, 0, &[Arg::U(6)]));
    sock.write_all(&out)
        .map_err(|e| format!("wayland send: {e}"))?;
    roundtrip(&mut sock, 6, &mut globals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_follow_the_wire_format() {
        let m = encode(2, 0, &[Arg::U(7), Arg::S("abc"), Arg::U(1), Arg::U(4)]);
        // header 8, name 4, string 4 + "abc\0" 4, version 4, id 4
        assert_eq!(m.len(), 28);
        assert_eq!(u32_at(&m, 0), Some(2));
        assert_eq!(u32_at(&m, 4), Some((28 << 16) | 0));
        assert_eq!(str_at(&m, 12), Some(("abc".to_string(), 20)));
        let m = encode(5, 1, &[Arg::S("local-studio")]);
        // "local-studio\0" is 13 bytes, padded to 16
        assert_eq!(m.len(), 8 + 4 + 16);
    }

    #[test]
    fn instance_ids_name_one_launch() {
        let a = instance_id().unwrap();
        let b = instance_id().unwrap();
        assert!(a.starts_with("local-studio-") && a.len() == "local-studio-".len() + 32);
        assert_ne!(a, b);
    }
}
