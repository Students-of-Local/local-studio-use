#!/usr/bin/env python3
"""A GTK 3 window with one of each control the hands verbs act on, for the live tests.

    fixture.py            the fixture: menu bar, text field, buttons, check box, combo box, spin button, list, dialog
    fixture.py --person   a plain window standing in for the person's own app (it takes focus, as a person's would)

Every change the fixture sees lands in the "Status" label, so a test reads results back from the app itself.

The fixture is a single-instance app, like most editors and viewers: a second launch on the same session bus opens
another window in the running copy. That is what lets a test see whether the person's launch reaches an agent's copy.
"""

import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib  # noqa: E402

# The program name becomes the window's class (its app name), so it is set before GTK starts.
PERSON = "--person" in sys.argv[1:]
GLib.set_prgname("hands-person" if PERSON else "hands-fixture")

from gi.repository import Gtk  # noqa: E402


def labeled(grid, row, text, widget):
    label = Gtk.Label(label=text, xalign=0)
    label.set_mnemonic_widget(widget)
    grid.attach(label, 0, row, 1, 1)
    grid.attach(widget, 1, row, 1, 1)
    widget.get_accessible().set_name(text)


def fixture(app):
    win = Gtk.ApplicationWindow(application=app, title="Hands Fixture")
    win.set_default_size(520, 520)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    win.add(box)

    status = Gtk.Label(label="ready", xalign=0)
    status.get_accessible().set_name("Status")

    def say(text):
        status.set_text(text)

    bar = Gtk.MenuBar()
    for title, items in (("File", ("Reset", "Disabled Item")), ("Edit", ("Clear Note",))):
        top = Gtk.MenuItem(label=title)
        menu = Gtk.Menu()
        top.set_submenu(menu)
        for name in items:
            item = Gtk.MenuItem(label=name)
            if name == "Disabled Item":
                item.set_sensitive(False)
            menu.append(item)
            item.connect("activate", lambda _w, n=name: on_menu(n))
        bar.append(top)
    box.pack_start(bar, False, False, 0)

    grid = Gtk.Grid(column_spacing=8, row_spacing=6, margin=8)
    box.pack_start(grid, False, False, 0)

    note = Gtk.Entry()
    labeled(grid, 0, "Note", note)
    note.connect("activate", lambda _w: say("entered: " + note.get_text()))

    save = Gtk.Button(label="Save")
    grid.attach(save, 1, 1, 1, 1)
    save.connect("clicked", lambda _w: say("saved: " + note.get_text()))

    remember = Gtk.CheckButton(label="Remember me")
    grid.attach(remember, 1, 2, 1, 1)
    remember.connect("toggled", lambda w: say("remember: " + ("on" if w.get_active() else "off")))

    color = Gtk.ComboBoxText()
    for c in ("Red", "Green", "Blue"):
        color.append_text(c)
    color.set_active(0)
    labeled(grid, 3, "Color", color)
    color.connect("changed", lambda w: say("color: " + (w.get_active_text() or "")))

    volume = Gtk.SpinButton.new_with_range(0, 100, 1)
    volume.set_value(10)
    labeled(grid, 4, "Volume", volume)
    volume.connect("value-changed", lambda w: say("volume: %d" % w.get_value_as_int()))

    dialog_button = Gtk.Button(label="Open Dialog")
    grid.attach(dialog_button, 1, 5, 1, 1)

    def open_dialog(_w):
        d = Gtk.MessageDialog(transient_for=win, modal=True, message_type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.OK, text="Fixture dialog")
        d.connect("response", lambda dd, _r: (dd.destroy(), say("dialog closed")))
        d.show_all()

    dialog_button.connect("clicked", open_dialog)

    store = Gtk.ListStore(str)
    for i in range(1, 41):
        store.append(["Item %d" % i])
    tree = Gtk.TreeView(model=store)
    tree.append_column(Gtk.TreeViewColumn("Items", Gtk.CellRendererText(), text=0))
    tree.get_accessible().set_name("Items")
    tree.get_selection().connect("changed", lambda s: say("picked: " + (s.get_selected()[0][s.get_selected()[1]][0] if s.get_selected()[1] else "")))
    scroller = Gtk.ScrolledWindow()
    scroller.set_size_request(-1, 160)
    scroller.add(tree)
    box.pack_start(scroller, True, True, 0)

    box.pack_start(status, False, False, 8)

    def on_menu(name):
        if name == "Reset":
            note.set_text("")
            say("reset")
        elif name == "Clear Note":
            note.set_text("")
            say("note cleared")

    win.show_all()


def person():
    win = Gtk.Window(title="Person Window")
    win.set_default_size(300, 200)
    win.connect("destroy", Gtk.main_quit)
    win.add(Gtk.Entry())
    win.show_all()
    win.present()
    Gtk.main()


def main():
    if PERSON:
        person()
        return
    app = Gtk.Application(application_id="dev.localStudio.HandsFixture")
    app.connect("activate", fixture)
    sys.exit(app.run([sys.argv[0]]))


if __name__ == "__main__":
    main()
