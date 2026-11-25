#!/bin/sh
# Runs a command inside a private headless desktop: its own runtime folder, session bus, accessibility bus and display,
# so nothing reaches the desktop the person is using.
#
#   headless-session.sh x11  -- <command...>   Xvfb with openbox (EWMH)
#   headless-session.sh sway -- <command...>   sway on the headless wlroots backend, software rendering
#
# A "person" window (fixture.py --person) starts first and holds focus, the way the person's own app would.
set -eu

kind=${1:-x11}
shift
[ "${1:-}" = "--" ] && shift
here=$(cd "$(dirname "$0")" && pwd)

if [ -z "${HANDS_SESSION_INNER:-}" ]; then
	rt=$(mktemp -d "${TMPDIR:-/tmp}/hands-session.XXXXXX")
	chmod 700 "$rt"
	# A document portal the session's bus started mounts itself in the runtime folder; unmount it before removing it.
	trap 'for u in fusermount3 fusermount; do "$u" -u -z "$rt/doc" 2>/dev/null && break; done; rm -rf "$rt" 2>/dev/null || { sleep 1; rm -rf "$rt"; }' EXIT INT TERM
	# Nothing of the person's session comes in: no display, compositor, bus or accessibility address.
	env -u DISPLAY -u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u SWAYSOCK -u I3SOCK -u AT_SPI_BUS_ADDRESS \
		-u DBUS_SESSION_BUS_ADDRESS -u XAUTHORITY -u NO_AT_BRIDGE -u GTK_A11Y -u XDG_SESSION_TYPE -u XDG_CURRENT_DESKTOP -u DESKTOP_SESSION \
		-u GDK_BACKEND -u GDK_SCALE -u GDK_DPI_SCALE -u QT_QPA_PLATFORM -u QT_SCALE_FACTOR -u QT_IM_MODULE -u GTK_IM_MODULE \
		XDG_RUNTIME_DIR="$rt" HANDS_SESSION_INNER=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local GVFS_DISABLE_FUSE=1 \
		LIBGL_ALWAYS_SOFTWARE=1 GSK_RENDERER=cairo WLR_RENDERER=pixman \
		dbus-run-session -- "$0" "$kind" -- "$@"
	exit $?
fi

pids=""
cleanup() {
	for p in $pids; do kill "$p" 2>/dev/null || true; done
	# HANDS_SESSION_LOGS keeps the display server, window manager and registry logs after the session ends.
	if [ -n "${HANDS_SESSION_LOGS:-}" ]; then
		mkdir -p "$HANDS_SESSION_LOGS"
		cp "$XDG_RUNTIME_DIR"/*.log "$HANDS_SESSION_LOGS"/ 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

case "$kind" in
x11)
	fd="$XDG_RUNTIME_DIR/display"
	Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp 3>"$fd" >"$XDG_RUNTIME_DIR/xvfb.log" 2>&1 &
	pids="$pids $!"
	for _ in $(seq 50); do [ -s "$fd" ] && break; sleep 0.1; done
	DISPLAY=":$(cat "$fd")"
	export DISPLAY
	openbox --sm-disable ${HANDS_SESSION_LOGS:+--debug} >"$XDG_RUNTIME_DIR/openbox.log" 2>&1 &
	pids="$pids $!"
	sleep 0.5
	;;
sway)
	cfg="$XDG_RUNTIME_DIR/sway.conf"
	printf 'output * resolution 1280x800\nfocus_follows_mouse no\n' >"$cfg"
	WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway -c "$cfg" >"$XDG_RUNTIME_DIR/sway.log" 2>&1 &
	pids="$pids $!"
	for _ in $(seq 100); do
		sock=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock 2>/dev/null | head -n1 || true)
		[ -n "$sock" ] && [ -S "$XDG_RUNTIME_DIR/wayland-1" ] && break
		sleep 0.1
	done
	[ -n "${sock:-}" ] || { cat "$XDG_RUNTIME_DIR/sway.log" >&2; exit 1; }
	SWAYSOCK=$sock WAYLAND_DISPLAY=wayland-1 GDK_BACKEND=wayland XDG_CURRENT_DESKTOP=sway
	export SWAYSOCK WAYLAND_DISPLAY GDK_BACKEND XDG_CURRENT_DESKTOP
	;;
*)
	echo "usage: headless-session.sh x11|sway -- <command...>" >&2
	exit 2
	;;
esac

# The accessibility bus, then its registry. dbus-broker would start the registry through a systemd user manager, which
# this private session doesn't have, so it starts here (a second copy exits when one already owns the name).
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.a11y.Bus.GetAddress >/dev/null
for r in /usr/libexec/at-spi2-registryd /usr/lib/at-spi2-registryd /usr/lib/at-spi2-core/at-spi2-registryd; do
	if [ -x "$r" ]; then
		"$r" >"$XDG_RUNTIME_DIR/registryd.log" 2>&1 &
		pids="$pids $!"
		break
	fi
done
sleep 0.5

python3 "$here/fixture.py" --person >"$XDG_RUNTIME_DIR/person.log" 2>&1 &
pids="$pids $!"
sleep 1

"$@"
