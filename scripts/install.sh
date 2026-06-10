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
MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS="${GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS:-}"
GBRAIN_INSTALL_SPEC="${GBRAIN_INSTALL_SPEC:-github:garrytan/gbrain#1eb430a2df9f842a754dd6af9910f049ccac65a1}"
INSTALL_GBRAIN=0
SKIP_SERVICE=0
SKIP_VERIFY=0
SETUP_MACHINE_MEMORY=0
MACHINE_MEMORY_SYNC_NOW=0
DRY_RUN=0
VALIDATED_MACHINE_MEMORY_ROOTS=()

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

is_default_blocked_wide_root() {
  local resolved="${1%/}"
  [[ "$resolved" =~ ^/media/[^/]+/[^/]+$ ]] ||
    [[ "$resolved" =~ ^/run/media/[^/]+/[^/]+$ ]] ||
    [[ "$resolved" =~ ^/mnt/[^/]+$ ]] ||
    [[ "$resolved" =~ ^/Volumes/[^/]+$ ]]
}

path_within() {
  local child="${1%/}"
  local parent="${2%/}"
  [[ -n "$parent" ]] && { [[ "$child" == "$parent" ]] || [[ "$child" == "$parent"/* ]]; }
}

normalize_existing_or_raw() {
  local value="$1"
  local resolved
  if resolved="$(cd "$value" 2>/dev/null && pwd -P)"; then
    printf '%s' "$resolved"
  else
    printf '%s' "$value"
  fi
}

private_root_reason() {
  local resolved="${1%/}"
  local private_root normalized_private
	  for private_root in "$CODEX_HOME" "$GBRAIN_CONFIG_DIR" "$HOME/.openclaw" "$HOME/.agents" "$HOME/.codex/memories"; do
	    normalized_private="$(normalize_existing_or_raw "$private_root")"
	    if path_within "$resolved" "$normalized_private" || path_within "$normalized_private" "$resolved"; then
	      printf '%s' "$normalized_private"
	      return 0
	    fi
  done
  if [[ "$resolved" == "$HOME"/.* || "$resolved" == "$HOME"/.*/* ]]; then
    printf '%s' "hidden home directory"
    return 0
  fi
  return 1
}

validate_machine_memory_request() {
  [[ "$SETUP_MACHINE_MEMORY" -eq 1 ]] || return 0
  [[ "$MACHINE_MEMORY_UNLOCK" == "1" ]] || fail "machine memory is locked. Set BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 and GBRAIN_MACHINE_ROOTS for this exact install."
  [[ -n "$MACHINE_MEMORY_ROOTS" ]] || fail "GBRAIN_MACHINE_ROOTS is required for machine memory. No default roots are scanned."
  case "$MACHINE_MEMORY_TERMINATE_SERVE" in
    none|all) ;;
    *) fail "GBRAIN_MACHINE_TERMINATE_SERVE must be none or all." ;;
  esac
  positive_int GBRAIN_MACHINE_SYNC_INTERVAL_SECONDS "$MACHINE_MEMORY_INTERVAL_SECONDS"
  positive_int GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS "$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS"
  if [[ -n "$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS" ]]; then
    positive_int GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS "$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS"
    if (( MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS >= MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS )); then
      fail "GBRAIN_MACHINE_GBRAIN_TIMEOUT_SECONDS must be lower than GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS."
    fi
  fi

  local root resolved home_resolved home_parent fs_root private_reason
  VALIDATED_MACHINE_MEMORY_ROOTS=()
  home_resolved="$(normalize_existing_or_raw "$HOME")"
  home_parent="$(dirname "$home_resolved")"
  fs_root="/"
  IFS=':' read -r -a machine_roots <<< "$MACHINE_MEMORY_ROOTS"
  for root in "${machine_roots[@]}"; do
    [[ -n "$root" ]] || continue
    [[ "$root" = /* ]] || fail "machine memory root must be absolute: $root"
    [[ -d "$root" && -r "$root" ]] || fail "machine memory root does not exist or is unreadable: $root"
    resolved="$(normalize_existing_or_raw "$root")"
    if private_reason="$(private_root_reason "$resolved")"; then
      fail "private machine memory root blocked: $resolved ($private_reason). Use specific public repo/work roots."
    fi
    if [[ "$MACHINE_MEMORY_ALLOW_WIDE_ROOTS" != "1" ]]; then
      case "$resolved" in
        "$fs_root"|"$home_parent"|"$home_resolved")
          fail "wide machine memory root blocked: $resolved. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review."
          ;;
      esac
      if is_default_blocked_wide_root "$resolved"; then
        fail "wide machine memory root blocked: $resolved. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review."
      fi
    fi
    VALIDATED_MACHINE_MEMORY_ROOTS+=("$resolved")
  done
  [[ "${#VALIDATED_MACHINE_MEMORY_ROOTS[@]}" -gt 0 ]] || fail "GBRAIN_MACHINE_ROOTS must contain at least one non-empty path."
  local IFS=':'
  MACHINE_MEMORY_ROOTS="${VALIDATED_MACHINE_MEMORY_ROOTS[*]}"
}

sed_escape() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

systemd_exec_escape() {
  case "$1" in
    *$'\n'*|*$'\r'*) fail "systemd unit values must not contain newlines" ;;
  esac
  sed_escape "$1" | sed -e 's/%/%%/g' -e 's/"/\\"/g'
}

positive_int() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] || fail "$label must be a positive integer."
}

tcp_port() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ && "$value" -ge 1 && "$value" -le 65535 ]] || fail "$label must be an integer TCP port in 1..65535."
}

validate_token() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._~-]{8,256}$ ]] || fail "BridgeBrain token must be 8..256 URL-safe characters."
}

check_node_version() {
  "$NODE_BIN" -e '
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 18) process.exit(1);
' || fail "Node.js 18 or newer is required."
}

protect_gbrain_config() {
	  mkdir -p "$GBRAIN_CONFIG_DIR"
	  chmod 700 "$GBRAIN_CONFIG_DIR" || fail "could not restrict GBrain config directory permissions: $GBRAIN_CONFIG_DIR"
	  if [[ -f "$CONFIG_FILE" ]]; then
	    [[ ! -L "$CONFIG_FILE" ]] || fail "GBrain config file must not be a symlink: $CONFIG_FILE"
	    chmod 600 "$CONFIG_FILE" || fail "could not restrict GBrain config file permissions: $CONFIG_FILE"
	  fi
}

wait_for_health() {
  local url="http://127.0.0.1:${PORT}/health"
  local deadline=$((SECONDS + 20))
  local last=""
  local health_file
  health_file="$(mktemp)"
  while (( SECONDS < deadline )); do
    if curl --connect-timeout 2 --max-time 5 -fsS "$url" >"$health_file" 2>"$health_file.err"; then
      if "$NODE_BIN" -e '
const fs = require("fs");
const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expectedProfile = process.argv[2];
const expectedModel = process.argv[3];
const expectedDimensions = Number(process.argv[4]);
if (!health.ok || health.profile !== expectedProfile || health.model !== expectedModel || health.dimensions !== expectedDimensions) process.exit(1);
' "$health_file" "$PROFILE" "$MODEL_NAME" "$DIMENSIONS" >/dev/null 2>&1; then
        rm -f "$health_file" "$health_file.err"
        return 0
      fi
      last="health response did not match expected profile/model/dimensions"
    else
      last="$(cat "$health_file.err" 2>/dev/null || true)"
    fi
    sleep 0.25
  done
  rm -f "$health_file" "$health_file.err"
  fail "embedding service did not become healthy at $url: $last"
}

wait_for_authenticated_embeddings() {
  local deadline=$((SECONDS + 20))
  local last=""
  while (( SECONDS < deadline )); do
    if last="$(
	      BRIDGEBRAIN_VERIFY_PORT="$PORT" \
	      BRIDGEBRAIN_VERIFY_TOKEN="$TOKEN" \
	      BRIDGEBRAIN_VERIFY_MODEL="$MODEL_NAME" \
	      "$NODE_BIN" <<'NODE' 2>&1
const http = require('http');
	const token = process.env.BRIDGEBRAIN_VERIFY_TOKEN || '';
	const model = process.env.BRIDGEBRAIN_VERIFY_MODEL || 'chatgpt-bridge-semantic-hash-1536';
	const port = Number(process.env.BRIDGEBRAIN_VERIFY_PORT || 0);
	const payload = JSON.stringify({ model, input: [[1, 2, 3]] });
const req = http.request({
  method: 'POST',
  hostname: '127.0.0.1',
  port,
  path: '/v1/embeddings',
  timeout: 5000,
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    authorization: `Bearer ${token}`,
  },
}, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    if (res.statusCode === 400) {
      process.exit(0);
    }
    if (res.statusCode === 401) {
      console.error('configured token was rejected');
      process.exit(1);
    }
    if (res.statusCode !== 400) {
      console.error(`status ${res.statusCode}`);
      process.exit(1);
    }
  });
});
req.on('timeout', () => req.destroy(new Error('request timed out')));
req.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
req.end(payload);
NODE
    )"; then
      return 0
    fi
    sleep 0.25
  done
  fail "embedding service did not accept the configured token: $last"
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
Machine memory gbrain timeout: ${MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS:-<timeout minus 30s>}
Machine memory sync now: $([[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]] && echo "yes" || echo "no")
No files will be written. No services will be loaded or started. No GBrain sources will be registered or synced.
EOF
}

install_machine_memory() {
  mkdir -p "$MACHINE_MEMORY_HOME"
  install -m 0755 "$ROOT/scripts/setup-machine-memory.js" "$MACHINE_MEMORY_HOME/setup-machine-memory.js"

  MACHINE_MEMORY_INTERVAL_SECONDS_ESC="$(sed_escape "$MACHINE_MEMORY_INTERVAL_SECONDS")"

  if [[ "$OS_NAME" == "Linux" ]]; then
    USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
    SERVICE_TMP=""
    TIMER_TMP=""
    mkdir -p "$USER_SYSTEMD_DIR"
    NODE_SYSTEMD_EXEC_ESC="$(systemd_exec_escape "$NODE_BIN")"
    MACHINE_MEMORY_SCRIPT_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_HOME/setup-machine-memory.js")"
    CODEX_HOME_SYSTEMD_ESC="$(systemd_exec_escape "$CODEX_HOME")"
    GBRAIN_BIN_SYSTEMD_ESC="$(systemd_exec_escape "$GBRAIN_BIN")"
    GBRAIN_HOME_SYSTEMD_ESC="$(systemd_exec_escape "$GBRAIN_HOME_PARENT")"
    HOME_SYSTEMD_ESC="$(systemd_exec_escape "$HOME")"
    PATH_SYSTEMD_ESC="$(systemd_exec_escape "$PATH")"
    MACHINE_MEMORY_ROOTS_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_ROOTS")"
    MACHINE_MEMORY_ALLOW_WIDE_ROOTS_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_ALLOW_WIDE_ROOTS")"
    MACHINE_MEMORY_TERMINATE_SERVE_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_TERMINATE_SERVE")"
    MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS")"
    MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS_SYSTEMD_ESC="$(systemd_exec_escape "$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS")"
    SERVICE_TMP="$(mktemp "$USER_SYSTEMD_DIR/gbrain-machine-sync.service.XXXXXX")"
    TIMER_TMP="$(mktemp "$USER_SYSTEMD_DIR/gbrain-machine-sync.timer.XXXXXX")"
    chmod 600 "$SERVICE_TMP" "$TIMER_TMP"
    sed \
      -e "s|@NODE_BIN@|$NODE_SYSTEMD_EXEC_ESC|g" \
      -e "s|@CODEX_HOME@|$CODEX_HOME_SYSTEMD_ESC|g" \
      -e "s|@MACHINE_MEMORY_SCRIPT@|$MACHINE_MEMORY_SCRIPT_SYSTEMD_ESC|g" \
      -e "s|@GBRAIN_BIN@|$GBRAIN_BIN_SYSTEMD_ESC|g" \
      -e "s|@HOME@|$HOME_SYSTEMD_ESC|g" \
      -e "s|@PATH@|$PATH_SYSTEMD_ESC|g" \
      -e "s|@ALLOW_WIDE_ROOTS@|$MACHINE_MEMORY_ALLOW_WIDE_ROOTS_SYSTEMD_ESC|g" \
      -e "s|@GBRAIN_HOME@|$GBRAIN_HOME_SYSTEMD_ESC|g" \
      -e "s|@MACHINE_ROOTS@|$MACHINE_MEMORY_ROOTS_SYSTEMD_ESC|g" \
      -e "s|@TERMINATE_SERVE@|$MACHINE_MEMORY_TERMINATE_SERVE_SYSTEMD_ESC|g" \
      -e "s|@SYNC_TIMEOUT_SECONDS@|$MACHINE_MEMORY_SYNC_TIMEOUT_SECONDS_SYSTEMD_ESC|g" \
      -e "s|@GBRAIN_TIMEOUT_SECONDS@|$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS_SYSTEMD_ESC|g" \
      "$ROOT/systemd/gbrain-machine-sync.service.template" > "$SERVICE_TMP"
    sed \
      -e "s|@INTERVAL_SECONDS@|$MACHINE_MEMORY_INTERVAL_SECONDS_ESC|g" \
      "$ROOT/systemd/gbrain-machine-sync.timer.template" > "$TIMER_TMP"
    mv "$SERVICE_TMP" "$USER_SYSTEMD_DIR/gbrain-machine-sync.service"
    mv "$TIMER_TMP" "$USER_SYSTEMD_DIR/gbrain-machine-sync.timer"
    chmod 600 "$USER_SYSTEMD_DIR/gbrain-machine-sync.service" "$USER_SYSTEMD_DIR/gbrain-machine-sync.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now gbrain-machine-sync.timer
    if [[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]]; then
      systemctl --user start gbrain-machine-sync.service
    fi
  elif [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    PLIST="$LAUNCHD_DIR/com.gbrain.bridgebrain.machine-sync.plist"
    PLIST_TMP=""
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
    MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS_XML_ESC="$(sed_xml_escape "$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS")"
    PLIST_TMP="$(mktemp "$LAUNCHD_DIR/com.gbrain.bridgebrain.machine-sync.XXXXXX")"
    chmod 600 "$PLIST_TMP"
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
      -e "s|@GBRAIN_TIMEOUT_SECONDS@|$MACHINE_MEMORY_GBRAIN_TIMEOUT_SECONDS_XML_ESC|g" \
      -e "s|@INTERVAL_SECONDS@|$MACHINE_MEMORY_INTERVAL_SECONDS_XML_ESC|g" \
      "$ROOT/launchd/com.gbrain.bridgebrain.machine-sync.plist.template" > "$PLIST_TMP"
    mv "$PLIST_TMP" "$PLIST"
    chmod 600 "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    if [[ "$MACHINE_MEMORY_SYNC_NOW" -eq 1 ]]; then
      launchctl start com.gbrain.bridgebrain.machine-sync
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
tcp_port GBRAIN_CHATGPT_EMBED_PORT "$PORT"
if [[ -n "$TOKEN" ]]; then
  validate_token "$TOKEN"
fi
validate_machine_memory_request

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_dry_run_plan
  exit 0
fi

need_cmd node "$NODE_BIN"
check_node_version
need_cmd codex "$CODEX_BIN"

if [[ "$SKIP_SERVICE" -eq 1 && -z "$TOKEN" ]]; then
  fail "--skip-service requires BRIDGEBRAIN_API_TOKEN or GBRAIN_CHATGPT_EMBED_TOKEN so GBrain is not rewritten to a fresh token for an old service."
fi

if [[ -z "$TOKEN" ]]; then
  TOKEN="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fi
validate_token "$TOKEN"
BASE_URL="http://127.0.0.1:${PORT}/v1/t/${TOKEN}"

if [[ -z "$GBRAIN_BIN" ]]; then
  if [[ "$INSTALL_GBRAIN" -ne 1 ]]; then
    fail "gbrain is missing. Install it first, or rerun with --install-gbrain."
  fi
  if ! command -v bun >/dev/null 2>&1; then
    fail "bun is missing. Install Bun first, then rerun --install-gbrain."
  fi
	  bun install -g "$GBRAIN_INSTALL_SPEC"
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
  "$NODE_BIN" "$SKILL_DEST/scripts/gpt-web-login-bridge.js" smoke
"$NODE_BIN" "$ROOT/scripts/patch-gbrain-litellm.js"

mkdir -p "$GBRAIN_CONFIG_DIR"
protect_gbrain_config
CONFIG_EXISTED=0
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_EXISTED=1
fi
"$NODE_BIN" "$ROOT/scripts/configure-gbrain.js" "$CONFIG_FILE" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL"
protect_gbrain_config
if [[ "$CONFIG_EXISTED" -ne 1 ]]; then
  "$GBRAIN_BIN" init --pglite \
    --embedding-model "litellm:$MODEL_NAME" \
    --embedding-dimensions "$DIMENSIONS" \
    --skip-embed-check
  "$NODE_BIN" "$ROOT/scripts/configure-gbrain.js" "$CONFIG_FILE" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL"
  protect_gbrain_config
fi

pages="unknown"
identity_file="$(mktemp)"
if "$GBRAIN_BIN" call get_brain_identity '{}' >"$identity_file" 2>/dev/null; then
  if ! pages="$("$NODE_BIN" -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(j.page_count ?? j.pages ?? 0)" "$identity_file" 2>/dev/null)"; then
    pages="unknown"
  fi
fi
rm -f "$identity_file"

if [[ "$pages" != "0" && "$pages" != "unknown" ]]; then
  echo "Existing GBrain pages detected: $pages" >&2
  echo "Config updated only. No database wipe or reinit was performed." >&2
  echo "If existing embeddings use another width, run a supported migration/reindex before importing new content." >&2
fi

if [[ "$SKIP_SERVICE" -ne 1 ]]; then
  if [[ "$OS_NAME" == "Linux" ]]; then
    NODE_ESC="$(systemd_exec_escape "$NODE_BIN")"
    CODEX_HOME_ESC="$(systemd_exec_escape "$CODEX_HOME")"
    CODEX_BIN_ESC="$(systemd_exec_escape "$CODEX_BIN")"
    HOME_ESC="$(systemd_exec_escape "$HOME")"
    PORT_ESC="$(systemd_exec_escape "$PORT")"
    PROFILE_ESC="$(systemd_exec_escape "$PROFILE")"
    MODEL_NAME_ESC="$(systemd_exec_escape "$MODEL_NAME")"
    DIMENSIONS_ESC="$(systemd_exec_escape "$DIMENSIONS")"
    TOKEN_ESC="$(systemd_exec_escape "$TOKEN")"
    USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
    UNIT_NAME="gbrain-chatgpt-embeddings.service"
    UNIT_PATH="$USER_SYSTEMD_DIR/$UNIT_NAME"
    mkdir -p "$USER_SYSTEMD_DIR"
    UNIT_TMP="$(mktemp "$USER_SYSTEMD_DIR/$UNIT_NAME.XXXXXX")"
    chmod 600 "$UNIT_TMP"
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
      "$ROOT/systemd/gbrain-chatgpt-embeddings.service.template" > "$UNIT_TMP"
    mv "$UNIT_TMP" "$UNIT_PATH"
    chmod 600 "$UNIT_PATH"
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
    PLIST_TMP="$(mktemp "$LAUNCHD_DIR/com.gbrain.bridgebrain.embeddings.XXXXXX")"
    chmod 600 "$PLIST_TMP"
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
      "$ROOT/launchd/com.gbrain.bridgebrain.embeddings.plist.template" > "$PLIST_TMP"
    mv "$PLIST_TMP" "$PLIST"
    chmod 600 "$PLIST"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
	    launchctl start com.gbrain.bridgebrain.embeddings
  else
    fail "Unsupported Unix platform: $OS_NAME. Use scripts/install.ps1 on Windows."
  fi
fi

if [[ "$SKIP_SERVICE" -ne 1 ]]; then
  wait_for_health
  wait_for_authenticated_embeddings
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
