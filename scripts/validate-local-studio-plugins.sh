#!/bin/sh
# Loads plugin folders with Local Studio's own plugin loader: core/src/plugins.rs from a Local Studio checkout,
# compiled unchanged (a #[path] include) with a two-item stand-in for the crate's model and store modules, so a
# plugin.toml Local Studio would refuse fails here. The rest of the core (its terminal and GUI dependencies, which
# need zig) is not built. Needs a Local Studio checkout and cargo; CI has neither, so CI runs
# cli/test/local-studio-plugins.test.mjs, which mirrors the loader's rules.
#   scripts/validate-local-studio-plugins.sh [plugins-folder]
# LOCAL_STUDIO_CHECKOUT (default ~/Projects/local-studio) names the checkout. The validator crate is built under
# ${XDG_CACHE_HOME:-~/.cache}/local-studio-browser/ls-validate and reuses the checkout's Cargo.lock.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
plugins=${1:-$here/plugins}
plugins=$(cd "$plugins" && pwd)
checkout=${LOCAL_STUDIO_CHECKOUT:-$HOME/Projects/local-studio}
[ -f "$checkout/core/src/plugins.rs" ] || { echo "No Local Studio checkout at $checkout (set LOCAL_STUDIO_CHECKOUT)." >&2; exit 2; }
work=${XDG_CACHE_HOME:-$HOME/.cache}/local-studio-browser/ls-validate
mkdir -p "$work/src"
echo "Local Studio loader: $checkout/core/src/plugins.rs at $(git -C "$checkout" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$work/Cargo.toml" <<TOML
[package]
name = "local-studio-ls-validate"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
toml = "1"

[workspace]
TOML
cp "$checkout/Cargo.lock" "$work/Cargo.lock"
cat > "$work/src/main.rs" <<RS
// The loader, unchanged.
#[path = "$checkout/core/src/plugins.rs"]
#[allow(dead_code)]
mod plugins;

// What plugins.rs takes from the rest of the crate: the slash command type and the home folder.
#[allow(dead_code)]
mod model {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum CommandKind {
        Plugin,
    }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SlashCommand {
        pub name: String,
        pub description: String,
        pub source: String,
        pub kind: CommandKind,
    }
}
#[allow(dead_code)]
mod store {
    pub fn home_dir() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME").map(Into::into)
    }
}

fn main() {
    let root = std::env::args().nth(1).expect("usage: local-studio-ls-validate <plugins-folder>");
    let scan = plugins::scan(std::path::Path::new(&root));
    for p in &scan.plugins {
        let skills: Vec<&str> = p.skills.iter().map(|s| s.name.as_str()).collect();
        let prompts: Vec<&str> = p.prompts.iter().map(|s| s.name.as_str()).collect();
        let commands: Vec<String> = plugins::commands(std::slice::from_ref(p)).iter().map(|c| format!("/{} ({})", c.name, c.source)).collect();
        println!("ok {} {} skills={skills:?} prompts={prompts:?} commands={commands:?}", p.id, p.version);
    }
    for f in &scan.failures {
        println!("FAIL {}: {:?}", f.dir.display(), f.errors);
    }
    if !scan.failures.is_empty() || scan.plugins.is_empty() {
        std::process::exit(1);
    }
}
RS
cargo build --quiet --manifest-path "$work/Cargo.toml" --target-dir "$work/target"
"$work/target/debug/local-studio-ls-validate" "$plugins"
