#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS_NAME="${BRIDGEBRAIN_INSTALL_OS:-$(uname -s)}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
GBRAIN_HOME_PARENT="${GBRAIN_HOME:-$HOME}"
GBRAIN_CONFIG_DIR="${GBRAIN_HOME_PARENT%/}/.gbrain"
CONFIG_FILE="$GBRAIN_CONFIG_DIR/config.json"
SERVICE_HOME="$CODEX_HOME/services/gbrain-chatgpt-embeddings"
MACHINE_MEMORY_HOME="$CODEX_HOME/services/gbrain-machine-memory"
SKILL_NAME="unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
SKILL_DEST="$CODEX_HOME/skills/$SKILL_NAME"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain || true)}"
PORT="${GBRAIN_CHATGPT_EMBED_PORT:-4127}"
PROFILE="${BRIDGEBRAIN_PROFILE:-${GBRAIN_CHATGPT_EMBED_PROFILE:-quality}}"
MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-1536}"
DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-1536}"
TOKEN="${BRIDGEBRAIN_API_TOKEN:-${GBRAIN_CHATGPT_EMBED_TOKEN:-}}"
MACHINE_MEMORY_INTERVAL_SECONDS="${GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS:-900}"
MACHINE_MEMORY_ROOTS="${GBRAIN_MACHINE_ROOTS:-}"
MACHINE_MEMORY_UNLOCK="${BRIDGEBRAIN_ENABLE_MACHINE_MEMORY:-}"
MACHINE_MEMORY_ALLOW_WIDE_ROOTS="${BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS:-}"
MACHINE_MEMORY_TERMINATE_SERVE="${GBRAIN_MACHINE_TERMINATE_SERVE:-none}"
MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS="${GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS:-600}"
INSTALL_GBRAIN=0
SKIP_SERVICE=0
SKIP_VERIFY=0
SETUP_MACHINE_MEMORY=0
MACHINE_MEMORY_SYNC_NOW=0
DRY_RUN=0

usage() {
  cat <<'EOF'
BridgeBrain installer for Linux and macOS.

Usage:
  scripts/install.sh [--install-gbrain] [--machine-memory] [--machine-memory-sync-now] [--skip-service] [--skip-verify] [--dry-run]

Defaults:
  profile: quality
  model: chatgpt-bridge-semantic-hash-1536
  dimensions: 1536
  url: http://127.0.0.1:4127/v1/t/<generated-token>

Compatibility mode:
  BRIDGEBRAIN_PROFILE=compat GBRAIN_CHATGPT_EMBED_DIMENSIONS=768 \
  GBRAIN_CHATGPT_EMBED_MODEL=chatgpt-bridge-semantic-hash-768 scripts/install.sh

Machine memory:
  --machine-memory installs a recurring source-registration/sync job only when
  BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 is also set. Set GBRAIN_MACHINE_ROOTS to
  an explicit path-list of work roots to scan, and
  GBRAIN_MACHINE_TERMINATE_SERVE=all if this PGLite setup should terminate
  active stdio gbrain serve processes before scheduled sync.

Dry run:
  --dry-run validates inputs and prints a redacted install plan. It does not
  write files, patch GBrain, install services, run verification, register
  sources, or sync anything.

This installer never copies Codex auth files, browser cookies, API keys, session
files, or GBrain databases. The target machine must already have its own Codex
ChatGPT login. If login is missing, the installer stops.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-gbrain) INSTALL_GBRAIN=1 ;;
    --machine-memory) SETUP_MACHINE_MEMORY=1 ;;
    --machine-memory-sync-now) SETUP_MACHINE_MEMORY=1; MACHINE_MEMORY_SYNC_NOW=1 ;;
    --skip-service) SKIP_SERVICE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --dry-run) DRY_RUN=1 ;;
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

validate_gbrain_home() {
  [[ "$GBRAIN_HOME_PARENT" = /* ]] || fail "GBRAIN_HOME must be an absolute path when set."
  if [[ "$GBRAIN_HOME_PARENT" == ".." || "$GBRAIN_HOME_PARENT" == "../"* || "$GBRAIN_HOME_PARENT" == *"/.."* ]]; then
    fail "GBRAIN_HOME must not contain '..' path segments."
  fi
}

validate_machine_memory_request() {
  [[ "$SETUP_MACHINE_MEMORY" -eq 1 ]] || return 0
  [[ "$MACHINE_MEMORY_UNLOCK" == "1" ]] || fail "machine memory is locked. Set BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 and GBRAIN_MACHINE_ROOTS for this exact install."
  [[ -n "$MACHINE_MEMORY_ROOTS" ]] || fail "GBRAIN_MACHINE_ROOTS is required for machine memory. No default roots are scanned."
  case "$MACHINE_MEMORY_TERMINATE_SERVE" in
    none|all) ;;
    *) fail "GBRAIN_MACHINE_TERMINATE_SERVE must be none or all." ;;
  esac

  local root resolved home_resolved home_parent fs_root
  home_resolved="$(cd "$HOME" 2>/dev/null && pwd -P || printf '%s' "$HOME")"
  home_parent="$(dirname "$home_resolved")"
  fs_root="/"
  IFS=':' read -r -a machine_roots <<< "$MACHINE_MEMORY_ROOTS"
  for root in "${machine_roots[@]}"; do
    [[ -n "$root" ]] || continue
    [[ "$root" = /* ]] || fail "machine memory root must be absolute: $root"
    resolved="$(cd "$root" 2>/dev/null && pwd -P || printf '%s' "$root")"
    if [[ "$MACHINE_MEMORY_ALLOW_WIDE_ROOTS" != "1" ]]; then
      case "$resolved" in
        "$fs_root"|"$home_parent"|"$home_resolved")
          fail "wide machine memory root blocked: $resolved. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review."
          ;;
      esac
    fi
  done
}

sed_escape() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

systemd_exec_escape() {
  sed_escape "$1" | sed 's/"/\\"/g'
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

sed_xml_escape() {
  sed_escape "$(xml_escape "$1")"
}

print_dry_run_plan() {
  cat <<EOF
BridgeBrain dry-run plan
Platform: $OS_NAME
Codex home: $CODEX_HOME
GBrain config: $CONFIG_FILE
Bridge service home: $SERVICE_HOME
Bridge skill destination: $SKILL_DEST
Profile: $PROFILE
Model: litellm:$MODEL_NAME
Dimensions: $DIMENSIONS
Endpoint: http://127.0.0.1:${PORT}/v1/t/<redacted>
Install GBrain: $([[ "$INSTALL_GBRAIN" -eq 1 ]] && echo "would install if missing" || echo "no")
Install embedding service: $([[ "$SKIP_SERVICE" -eq 1 ]] && echo "no" || echo "yes")
Run verify: $([[ "$SKIP_VERIFY" -eq 1 ]] && echo "no" || echo "yes")
Machine memory: $([[ "$SETUP_MACHINE_MEMORY" -eq 1 ]] && echo "yes" || echo "no")
Machine memory roots: ${MACHINE_MEMORY_ROOTS:-<unset>}
Machine memory sync now: $([[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]] && echo "yes" || echo "no")
No files will be written. No services will be loaded or started. No GBrain sources will be registered or synced.
EOF
}

install_machine_memory() {
  mkdir -p "$MACHINE_MEMORY_HOME"
  install -m 0755 "$ROOT/scripts/setup-machine-memory.js" "$MACHINE_MEMORY_HOME/setup-machine-memory.js"

  NODE_ESC="$(sed_escape "$NODE_BIN")"
  CODEX_HOME_ESC="$(sed_escape "$CODEX_HOME")"
  GBRAIN_BIN_ESC="$(sed_escape "$GBRAIN_BIN")"
  GBRAIN_HOME_ESC="$(sed_escape "$GBRAIN_HOME_PARENT")"
  HOME_ESC="$(sed_escape "$HOME")"
  PATH_ESC="$(sed_escape "$PATH")"
  MACHINE_MEMORY_ROOTS_ESC="$(sed_escape "$MACHINE_MEMORY_ROOTS")"
  MACHINE_MEMORY_ALLOW_WIDE_ROOTS_ESC="$(sed_escape "$MACHINE_MEMORY_ALLOW_WIDE_ROOTS")"
  MACHINE_MEMORY_TERMINATE_SERVE_ESC="$(sed_escape "$MACHINE_MEMORY_TERMINATE_SERVE")"
  MACHINE_MEMORY_INTERVAL_SECONDS_ESC="$(sed_escape "$MACHINE_MEMORY_INTERVAL_SECONDS")"
  MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_ESC="$(sed_escape "$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS")"

  if [[ "$OS_NAME" == "Linux" ]]; then
    USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$USER_SYSTEMD_DIR"
    NODE_SYSTEMD_EXEC_ESC="$(systemd_exec_escape "$NODE_BIN")"
    MACHINE_MEMORY_SCRIPT_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_HOME/setup-machine-memory.js")"
    sed \
      -e "s|@NODE_BIN@|$NODE_SYSTEMD_EXEC_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_ESC|g" \
      -e "s|@MACHINE_MEMORY_SCRIPT@|$MACHINE_MEMORY_SCRIPT_SYSTEMD_ESC|g" \
      -e "s|@GBRAIN_BIN@|$GBRAIN_BIN_ESC|g" \
      -e "s|@HOME@|$HOME_ESC|g" \
      -e "s|@PATH@|$PATH_ESC|g" \
      -e "s|@ALLOW_WIDE_ROOTS@|$MACHINE_MEMORY_ALLOW_WIDE_ROOTS_ESC|g" \
      -e "s|@GBRAIN_HOME@|$GBRAIN_HOME_ESC|g" \
      -e "s|@MACHINE_ROOTS@|$MACHINE_MEMORY_ROOTS_ESC|g" \
      -e "s|@TERMINATE_SERVE@|$MACHINE_MEMORY_TERMINATE_SERVE_ESC|g" \
      -e "s|@SYNC_TIMEOUT_SECONDS@|$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_ESC|g" \
      "$ROOT/systemd/gbrain-machine-sync.service.template" > "$USER_SYSTEMD_DIR/gbrain-machine-sync.service"
    sed \
      -e "s|@INTERVAL_SECONDS@|$MACHINE_MEMORY_INTERVAL_SECONDS_ESC|g" \
      "$ROOT/systemd/gbrain-machine-sync.timer.template" > "$USER_SYSTEMD_DIR/gbrain-machine-sync.timer"
    chmod 600 "$USER_SYSTEMD_DIR/gbrain-machine-sync.service" "$USER_SYSTEMD_DIR/gbrain-machine-sync.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now gbrain-machine-sync.timer
    if [[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]]; then
      systemctl --user start gbrain-machine-sync.service
    fi
  elif [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST="$LAUNCHD_DIR/com.gbrain.bridgebrain.machine-sync.plist"
    mkdir -p "$LAUNCHD_DIR"
    NODE_XML_ESC="$(sed_xml_escape "$NODE_BIN")"
    CODEX_HOME_XML_ESC="$(sed_xml_escape "$CODEX_HOME")"
    GBRAIN_BIN_XML_ESC="$(sed_xml_escape "$GBRAIN_BIN")"
    GBRAIN_HOME_XML_ESC="$(sed_xml_escape "$GBRAIN_HOME_PARENT")"
    HOME_XML_ESC="$(sed_xml_escape "$HOME")"
    PATH_XML_ESC="$(sed_xml_escape "$PATH")"
    MACHINE_MEMORY_ROOTS_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_ROOTS")"
    MACHINE_MEMORY_ALLOW_WIDE_ROOTS_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_ALLOW_WIDE_ROOTS")"
    MACHINE_MEMORY_TERMINATE_SERVE_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_TERMINATE_SERVE")"
    MACHINE_MEMORY_INTERVAL_SECONDS_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_INTERVAL_SECONDS")"
    MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS")"
    sed \
      -e "s|@NODE_BIN@|$NODE_XML_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_XML_ESC|g" \
      -e "s|@GBRAIN_BIN@|$GBRAIN_BIN_XML_ESC|g" \
      -e "s|@HOME@|$HOME_XML_ESC|g" \
      -e "s|@PATH@|$PATH_XML_ESC|g" \
      -e "s|@ALLOW_WIDE_ROOTS@|$MACHINE_MEMORY_ALLOW_WIDE_ROOTS_XML_ESC|g" \
      -e "s|@GBRAIN_HOME@|$GBRAIN_HOME_XML_ESC|g" \
      -e "s|@MACHINE_ROOTS@|$MACHINE_MEMORY_ROOTS_XML_ESC|g" \
      -e "s|@TERMINATE_SERVE@|$MACHINE_MEMORY_TERMINATE_SERVE_XML_ESC|g" \
      -e "s|@SYNC_TIMEOUT_SECONDS@|$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_XML_ESC|g" \
      -e "s|@INTERVAL_SECONDS@|$MACHINE_MEMORY_INTERVAL_SECONDS_XML_ESC|g" \
      "$ROOT/launchd/com.gbrain.bridgebrain.machine-sync.plist.template" > "$PLIST"
    chmod 600 "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    if [[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]]; then
      launchctl start com.gbrain.bridgebrain.machine-sync || true
    fi
  else
    fail "Unsupported Unix platform for machine memory: $OS_NAME. Use scripts/install.ps1 on Windows."
  fi
}

case "$PROFILE" in
  quality|compat|mock) ;;
  *) fail "BRIDGEBRAIN_PROFILE must be quality, compat, or mock." ;;
esac

if [[ "$PROFILE" == "compat" ]]; then
  MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-768}"
  DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-768}"
fi

validate_gbrain_home
validate_machine_memory_request

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_dry_run_plan
  exit 0
fi

need_cmd node "$NODE_BIN"
need_cmd codex "$CODEX_BIN"

if [[ -z "$TOKEN" ]]; then
  TOKEN="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fi
BASE_URL="http://127.0.0.1:${PORT}/v1/t/${TOKEN}"

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

GPT_WEB_LOGIN_CODEX_BIN="$CODEX_BIN" GPT_WEB_LOGIN_CWD="$HOME" \
  "$NODE_BIN" "$SKILL_DEST/scripts/gpt-web-login-bridge.js" status
"$NODE_BIN" "$ROOT/scripts/patch-gbrain-litellm.js"

mkdir -p "$GBRAIN_CONFIG_DIR"
CONFIG_EXISTED=0
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_EXISTED=1
fi
"$NODE_BIN" "$ROOT/scripts/configure-gbrain.js" "$CONFIG_FILE" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL"
if [[ "$CONFIG_EXISTED" -ne 1 ]]; then
  "$GBRAIN_BIN" init --pglite \
    --embedding-model "litellm:$MODEL_NAME" \
    --embedding-dimensions "$DIMENSIONS" \
    --skip-embed-check
  "$NODE_BIN" "$ROOT/scripts/configure-gbrain.js" "$CONFIG_FILE" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL"
fi

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
  TOKEN_ESC="$(sed_escape "$TOKEN")"
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
      -e "s|@API_TOKEN@|$TOKEN_ESC|g" \
      "$ROOT/systemd/gbrain-chatgpt-embeddings.service.template" > "$USER_SYSTEMD_DIR/$UNIT_NAME"
    chmod 600 "$USER_SYSTEMD_DIR/$UNIT_NAME"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME"
    systemctl --user restart "$UNIT_NAME"
  elif [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST="$LAUNCHD_DIR/com.gbrain.bridgebrain.embeddings.plist"
    mkdir -p "$LAUNCHD_DIR"
    NODE_XML_ESC="$(sed_xml_escape "$NODE_BIN")"
    CODEX_HOME_XML_ESC="$(sed_xml_escape "$CODEX_HOME")"
    CODEX_BIN_XML_ESC="$(sed_xml_escape "$CODEX_BIN")"
    HOME_XML_ESC="$(sed_xml_escape "$HOME")"
    PORT_XML_ESC="$(sed_xml_escape "$PORT")"
    PROFILE_XML_ESC="$(sed_xml_escape "$PROFILE")"
    MODEL_NAME_XML_ESC="$(sed_xml_escape "$MODEL_NAME")"
    DIMENSIONS_XML_ESC="$(sed_xml_escape "$DIMENSIONS")"
    TOKEN_XML_ESC="$(sed_xml_escape "$TOKEN")"
    sed \
      -e "s|@NODE_BIN@|$NODE_XML_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_XML_ESC|g" \
      -e "s|@CODEX_BIN@|$CODEX_BIN_XML_ESC|g" \
      -e "s|@HOME@|$HOME_XML_ESC|g" \
      -e "s|@PORT@|$PORT_XML_ESC|g" \
      -e "s|@PROFILE@|$PROFILE_XML_ESC|g" \
      -e "s|@MODEL_NAME@|$MODEL_NAME_XML_ESC|g" \
      -e "s|@DIMENSIONS@|$DIMENSIONS_XML_ESC|g" \
      -e "s|@API_TOKEN@|$TOKEN_XML_ESC|g" \
      "$ROOT/launchd/com.gbrain.bridgebrain.embeddings.plist.template" > "$PLIST"
    chmod 600 "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    launchctl start com.gbrain.bridgebrain.embeddings || true
  else
    fail "Unsupported Unix platform: $OS_NAME. Use scripts/install.ps1 on Windows."
  fi
fi

if [[ "$SKIP_SERVICE" -ne 1 ]]; then
  sleep 2
  curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null
fi

if [[ "$SETUP_MACHINE_MEMORY" -eq 1 ]]; then
  install_machine_memory
fi

if [[ "$SKIP_VERIFY" -ne 1 ]]; then
  "$ROOT/scripts/verify.sh"
fi

echo "BridgeBrain installed."
echo "Model: litellm:${MODEL_NAME}"
echo "Dimensions: ${DIMENSIONS}"
echo "Endpoint: http://127.0.0.1:${PORT}/v1/t/<redacted>"
if [[ "$SETUP_MACHINE_MEMORY" -eq 1 ]]; then
  echo "Machine memory sync: installed"
fi
