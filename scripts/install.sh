#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS_NAME="$(uname -s)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SERVICE_HOME="$CODEX_HOME/services/gbrain-chatgpt-embeddings"
SKILL_NAME="unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
SKILL_DEST="$CODEX_HOME/skills/$SKILL_NAME"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain || true)}"
PORT="${GBRAIN_CHATGPT_EMBED_PORT:-4127}"
PROFILE="${BRIDGEBRAIN_PROFILE:-${GBRAIN_CHATGPT_EMBED_PROFILE:-quality}}"
MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-1536}"
DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-1536}"
BASE_URL="http://127.0.0.1:${PORT}/v1"
INSTALL_GBRAIN=0
SKIP_SERVICE=0
SKIP_VERIFY=0

usage() {
  cat <<'EOF'
BridgeBrain installer for Linux and macOS.

Usage:
  scripts/install.sh [--install-gbrain] [--skip-service] [--skip-verify]

Defaults:
  profile: quality
  model: chatgpt-bridge-semantic-hash-1536
  dimensions: 1536
  url: http://127.0.0.1:4127/v1

Compatibility mode:
  BRIDGEBRAIN_PROFILE=compat GBRAIN_CHATGPT_EMBED_DIMENSIONS=768 \
  GBRAIN_CHATGPT_EMBED_MODEL=chatgpt-bridge-semantic-hash-768 scripts/install.sh

This installer never copies Codex auth files, browser cookies, API keys, session
files, or GBrain databases. The target machine must already have its own Codex
ChatGPT login. If login is missing, the installer stops.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-gbrain) INSTALL_GBRAIN=1 ;;
    --skip-service) SKIP_SERVICE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

fail() {
  echo "INSTALL FAILED: $*" >&2
  exit 1
}

need_cmd() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || fail "$name is required."
}

sed_escape() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

case "$PROFILE" in
  quality|compat|mock) ;;
  *) fail "BRIDGEBRAIN_PROFILE must be quality, compat, or mock." ;;
esac

if [[ "$PROFILE" == "compat" ]]; then
  MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-768}"
  DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-768}"
fi

need_cmd node "$NODE_BIN"
need_cmd codex "$CODEX_BIN"

if [[ -z "$GBRAIN_BIN" ]]; then
  if [[ "$INSTALL_GBRAIN" -ne 1 ]]; then
    fail "gbrain is missing. Install it first, or rerun with --install-gbrain."
  fi
  if ! command -v bun >/dev/null 2>&1; then
    fail "bun is missing. Install Bun first, then rerun --install-gbrain."
  fi
  bun install -g github:garrytan/gbrain
  export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  GBRAIN_BIN="$(command -v gbrain || true)"
fi
need_cmd gbrain "$GBRAIN_BIN"

mkdir -p "$SERVICE_HOME" "$SKILL_DEST/scripts" "$SKILL_DEST/agents"

install -m 0755 "$ROOT/src/gbrain-chatgpt-embeddings-server.js" "$SERVICE_HOME/server.js"
install -m 0644 "$ROOT/bridge-skill/$SKILL_NAME/SKILL.md" "$SKILL_DEST/SKILL.md"
install -m 0644 "$ROOT/bridge-skill/$SKILL_NAME/agents/openai.yaml" "$SKILL_DEST/agents/openai.yaml"
install -m 0755 "$ROOT/bridge-skill/$SKILL_NAME/scripts/gpt-web-login-bridge.js" "$SKILL_DEST/scripts/gpt-web-login-bridge.js"

"$NODE_BIN" "$SKILL_DEST/scripts/gpt-web-login-bridge.js" status
"$NODE_BIN" "$ROOT/scripts/patch-gbrain-litellm.js"

mkdir -p "$HOME/.gbrain"
if [[ ! -f "$HOME/.gbrain/config.json" ]]; then
  "$GBRAIN_BIN" init --pglite --no-embedding
fi

"$NODE_BIN" "$ROOT/scripts/configure-gbrain.js" "$HOME/.gbrain/config.json" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL"

pages="unknown"
identity_file="$(mktemp)"
if "$GBRAIN_BIN" call get_brain_identity '{}' >"$identity_file" 2>/dev/null; then
  pages="$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(j.page_count ?? j.pages ?? 0)" "$identity_file")"
fi
rm -f "$identity_file"

if [[ "$pages" != "0" && "$pages" != "unknown" ]]; then
  echo "Existing GBrain pages detected: $pages" >&2
  echo "Config updated only. No database wipe or reinit was performed." >&2
  echo "If existing embeddings use another width, run a supported migration/reindex before importing new content." >&2
fi

if [[ "$SKIP_SERVICE" -ne 1 ]]; then
  NODE_ESC="$(sed_escape "$NODE_BIN")"
  CODEX_HOME_ESC="$(sed_escape "$CODEX_HOME")"
  CODEX_BIN_ESC="$(sed_escape "$CODEX_BIN")"
  HOME_ESC="$(sed_escape "$HOME")"
  PORT_ESC="$(sed_escape "$PORT")"
  PROFILE_ESC="$(sed_escape "$PROFILE")"
  MODEL_NAME_ESC="$(sed_escape "$MODEL_NAME")"
  DIMENSIONS_ESC="$(sed_escape "$DIMENSIONS")"
  if [[ "$OS_NAME" == "Linux" ]]; then
    USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
    UNIT_NAME="gbrain-chatgpt-embeddings.service"
    mkdir -p "$USER_SYSTEMD_DIR"
    sed \
      -e "s|@NODE_BIN@|$NODE_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_ESC|g" \
      -e "s|@CODEX_BIN@|$CODEX_BIN_ESC|g" \
      -e "s|@HOME@|$HOME_ESC|g" \
      -e "s|@PORT@|$PORT_ESC|g" \
      -e "s|@PROFILE@|$PROFILE_ESC|g" \
      -e "s|@MODEL_NAME@|$MODEL_NAME_ESC|g" \
      -e "s|@DIMENSIONS@|$DIMENSIONS_ESC|g" \
      "$ROOT/systemd/gbrain-chatgpt-embeddings.service.template" > "$USER_SYSTEMD_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    systemctl --user restart "$UNIT_NAME"
  elif [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST="$LAUNCHD_DIR/com.gbrain.bridgebrain.embeddings.plist"
    mkdir -p "$LAUNCHD_DIR"
    sed \
      -e "s|@NODE_BIN@|$NODE_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_ESC|g" \
      -e "s|@CODEX_BIN@|$CODEX_BIN_ESC|g" \
      -e "s|@HOME@|$HOME_ESC|g" \
      -e "s|@PORT@|$PORT_ESC|g" \
      -e "s|@PROFILE@|$PROFILE_ESC|g" \
      -e "s|@MODEL_NAME@|$MODEL_NAME_ESC|g" \
      -e "s|@DIMENSIONS@|$DIMENSIONS_ESC|g" \
      "$ROOT/launchd/com.gbrain.bridgebrain.embeddings.plist.template" > "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    launchctl start com.gbrain.bridgebrain.embeddings || true
  else
    fail "Unsupported Unix platform: $OS_NAME. Use scripts/install.ps1 on Windows."
  fi
fi

sleep 2
curl -fsS "http://127.0.0.1:${PORT}/health" >/tmp/bridgebrain-health.json

if [[ "$SKIP_VERIFY" -ne 1 ]]; then
  "$ROOT/scripts/verify.sh"
fi

echo "BridgeBrain installed."
echo "Model: litellm:${MODEL_NAME}"
echo "Dimensions: ${DIMENSIONS}"
echo "Endpoint: ${BASE_URL}"
