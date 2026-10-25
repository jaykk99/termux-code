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

# A re-run must refresh a stale gateway token: since stateless tokens
# replaced the old stored ones, a config written by an older install holds
# a token that can never validate again, and re-running the install used
# to leave it untouched. When the installer carries a gateway and/or token
# (the site's command always carries both), merge them into the config,
# keeping everything else (model choice, inbox key) intact.
if [ -n "${TERMUX_CODE_GATEWAY:-}" ] || [ -n "${TERMUX_CODE_TOKEN:-}" ]; then
  CONFIG_FILE="$CONFIG" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const file = process.env.CONFIG_FILE;
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (process.env.TERMUX_CODE_GATEWAY) cfg.gateway = process.env.TERMUX_CODE_GATEWAY;
    if (process.env.TERMUX_CODE_TOKEN) cfg.gatewayToken = process.env.TERMUX_CODE_TOKEN;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  '
  say "Saved gateway to $CONFIG"
elif [ ! -f "$CONFIG" ]; then
  DEFAULT_GATEWAY="${TERMUX_CODE_GATEWAY:-}"
  DEFAULT_TOKEN="${TERMUX_CODE_TOKEN:-}"
  if [ -t 0 ] && [ -z "$DEFAULT_GATEWAY" ]; then
    printf '\033[38;5;179m›\033[0m Deployment URL that holds your keys (enter to skip): '
    read -r DEFAULT_GATEWAY </dev/tty || DEFAULT_GATEWAY=""
  fi
  if [ -n "$DEFAULT_GATEWAY" ]; then
    # The deployment is owner-gated: the gateway token (minted on its
    # landing page after GitHub sign-in) is what lets this phone in as the owner.
    if [ -n "$DEFAULT_TOKEN" ]; then
      printf '{\n  "gateway": "%s",\n  "gatewayToken": "%s"\n}\n' "$DEFAULT_GATEWAY" "$DEFAULT_TOKEN" > "$CONFIG"
    else
      printf '{\n  "gateway": "%s"\n}\n' "$DEFAULT_GATEWAY" > "$CONFIG"
    fi
    say "Saved gateway to $CONFIG"
  else
    printf '{}\n' > "$CONFIG"
    say "No gateway set. Add one later with /gateway inside the CLI."
  fi
fi

say "Installed. cd into a project and run: termux-code"
