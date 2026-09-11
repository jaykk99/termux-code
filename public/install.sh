#!/data/data/com.termux/files/usr/bin/env bash
# termux-code installer
#
#   curl -fsSL https://<your-deployment>/install.sh | bash
#
# Clones the CLI, drops a launcher on your PATH, and asks which deployment
# should hold your model keys. No npm install: the CLI has no dependencies.

set -euo pipefail

REPO="${TERMUX_CODE_REPO:-https://github.com/jaykk99/termux-code.git}"
HOME_DIR="${HOME:?HOME is not set}"
DEST="$HOME_DIR/.termux-code/app"
CONFIG="$HOME_DIR/.termux-code/config.json"
BIN_DIR="${PREFIX:-/usr/local}/bin"

say()  { printf '\033[38;5;179m ›\033[0m %s\n' "$1"; }
warn() { printf '\033[38;5;174m›\033[0m %s\n' "$1" >&2; }

# --- prerequisites -----------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  warn "Node isn't installed. Run: pkg install nodejs git"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node $NODE_MAJOR is too old. termux-code needs 18 or newer."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git isn't installed. Run: pkg install git"
  exit 1
fi

# --- fetch -------------------------------------------------------------------

mkdir -p "$HOME_DIR/.termux-code"

if [ -d "$DEST/.git" ]; then
  say "Updating an existing install."
  git -C "$DEST" pull --ff-only --quiet
else
  say "Cloning into $DEST"
  rm -rf "$DEST"
  git clone --depth 1 --quiet "$REPO" "$DEST"
fi

# --- launcher ----------------------------------------------------------------

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/termux-code" <<LAUNCHER
#!/data/data/com.termux/files/usr/bin/env bash
exec node "$DEST/bin/termux-code.mjs" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/termux-code"

# --- gateway ----------------------------------------------------------------

if [ ! -f "$CONFIG" ]; then
  DEFAULT_GATEWAY="${TERMUX_CODE_GATEWAY:-}"
  if [ -t 0 ] && [ -z "$DEFAULT_GATEWAY" ]; then
    printf '\033[38;5;179m›\033[0m Deployment URL that holds your keys (enter to skip): '
    read -r DEFAULT_GATEWAY </dev/tty || DEFAULT_GATEWAY=""
  fi
  if [ -n "$DEFAULT_GATEWAY" ]; then
    printf '{\n  "gateway": "%s"\n}\n' "$DEFAULT_GATEWAY" > "$CONFIG"
    say "Saved gateway to $CONFIG"
  else
    printf '{}\n' > "$CONFIG"
    say "No gateway set. Add one later with /gateway inside the CLI."
  fi
fi

say "Installed. cd into a project and run: termux-code"
