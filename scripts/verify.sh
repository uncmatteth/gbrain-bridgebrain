#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
GBRAIN_HOME_PARENT="${GBRAIN_HOME:-$HOME}"
GBRAIN_CONFIG_DIR="${GBRAIN_HOME_PARENT%/}/.gbrain"
CONFIG_FILE="$GBRAIN_CONFIG_DIR/config.json"
SKILL_NAME="unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
BRIDGE_SCRIPT="${BRIDGE_SCRIPT:-$CODEX_HOME/skills/$SKILL_NAME/scripts/gpt-web-login-bridge.js}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
GBRAIN_BIN="${GBRAIN_BIN:-$(command -v gbrain || true)}"
PORT="${GBRAIN_CHATGPT_EMBED_PORT:-4127}"
PROFILE="${BRIDGEBRAIN_PROFILE:-${GBRAIN_CHATGPT_EMBED_PROFILE:-quality}}"
MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-1536}"
DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-1536}"
TOKEN="${BRIDGEBRAIN_API_TOKEN:-${GBRAIN_CHATGPT_EMBED_TOKEN:-}}"
BASE_URL="http://127.0.0.1:${PORT}/v1"
HEALTH_URL="${BASE_URL}/health"
SKIP_GBRAIN=0
SKIP_BRIDGE=0
PROFILE_ENV_SET=0
MODEL_ENV_SET=0
DIMENSIONS_ENV_SET=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

[[ -n "${BRIDGEBRAIN_PROFILE:-}${GBRAIN_CHATGPT_EMBED_PROFILE:-}" ]] && PROFILE_ENV_SET=1
[[ -n "${GBRAIN_CHATGPT_EMBED_MODEL:-}" ]] && MODEL_ENV_SET=1
[[ -n "${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-}" ]] && DIMENSIONS_ENV_SET=1

usage() {
  cat <<'EOF'
BridgeBrain verifier.

Usage:
  scripts/verify.sh [--skip-gbrain] [--skip-bridge]

Use --skip-gbrain for adapter-only CI.
Use --skip-bridge only for mock profile tests.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-gbrain) SKIP_GBRAIN=1 ;;
    --skip-bridge) SKIP_BRIDGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

fail() {
  echo "VERIFY FAILED: $*" >&2
  exit 1
}

validate_gbrain_home() {
  [[ "$GBRAIN_HOME_PARENT" = /* ]] || fail "GBRAIN_HOME must be an absolute path when set."
  if [[ "$GBRAIN_HOME_PARENT" == ".." || "$GBRAIN_HOME_PARENT" == "../"* || "$GBRAIN_HOME_PARENT" == *"/.."* ]]; then
    fail "GBRAIN_HOME must not contain '..' path segments."
  fi
}

need_cmd() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || fail "$name is missing"
}

if [[ "$PROFILE" == "compat" ]]; then
  MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-768}"
  DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-768}"
fi

validate_gbrain_home
need_cmd node "$NODE_BIN"
command -v curl >/dev/null 2>&1 || fail "curl is missing"

mapfile -t CONFIG_INFO < <("$NODE_BIN" - "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const baseUrl = cfg.provider_base_urls?.litellm || '';
  const model = String(cfg.embedding_model || '').replace(/^litellm:/, '');
  const dimensions = cfg.embedding_dimensions ? String(cfg.embedding_dimensions) : '';
  process.stdout.write(`${baseUrl}\n${model}\n${dimensions}\n`);
} catch {
  process.stdout.write('\n\n\n');
}
NODE
)
CONFIG_BASE_URL="${CONFIG_INFO[0]:-}"
CONFIG_MODEL="${CONFIG_INFO[1]:-}"
CONFIG_DIMENSIONS="${CONFIG_INFO[2]:-}"
if [[ -n "$CONFIG_BASE_URL" ]]; then
  BASE_URL="$CONFIG_BASE_URL"
elif [[ -n "$TOKEN" ]]; then
  BASE_URL="http://127.0.0.1:${PORT}/v1/t/${TOKEN}"
fi
HEALTH_URL="${BASE_URL%/}/health"
if [[ "$MODEL_ENV_SET" -ne 1 && "$PROFILE_ENV_SET" -ne 1 && -n "$CONFIG_MODEL" ]]; then
  MODEL_NAME="$CONFIG_MODEL"
fi
if [[ "$DIMENSIONS_ENV_SET" -ne 1 && "$PROFILE_ENV_SET" -ne 1 && -n "$CONFIG_DIMENSIONS" ]]; then
  DIMENSIONS="$CONFIG_DIMENSIONS"
fi
if [[ "$PROFILE_ENV_SET" -ne 1 ]]; then
  if [[ "$MODEL_NAME" == *-768 || "$DIMENSIONS" == "768" ]]; then
    PROFILE="compat"
  elif [[ "$PROFILE" != "mock" ]]; then
    PROFILE="quality"
  fi
fi

if [[ "$PROFILE" != "mock" && "$SKIP_BRIDGE" -ne 1 ]]; then
  need_cmd codex "$CODEX_BIN"
  [[ -f "$BRIDGE_SCRIPT" ]] || fail "bridge script missing at $BRIDGE_SCRIPT"
  echo "Checking ChatGPT web-login bridge..."
  GPT_WEB_LOGIN_CODEX_BIN="$CODEX_BIN" "$NODE_BIN" "$BRIDGE_SCRIPT" status
fi

echo "Checking local embedding service..."
curl -fsS "$HEALTH_URL" >"$TMP_DIR/health.json"
BRIDGEBRAIN_VERIFY_HEALTH_JSON="$TMP_DIR/health.json" "$NODE_BIN" - "$MODEL_NAME" "$DIMENSIONS" "$PROFILE" <<'NODE'
const fs = require('fs');
const [expectedModel, expectedDimsRaw, expectedProfile] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(process.env.BRIDGEBRAIN_VERIFY_HEALTH_JSON, 'utf8'));
if (!health.ok) throw new Error('health.ok is false');
if (health.model !== expectedModel) throw new Error(`model mismatch: ${health.model} !== ${expectedModel}`);
if (health.dimensions !== Number(expectedDimsRaw)) throw new Error(`dimension mismatch: ${health.dimensions} !== ${expectedDimsRaw}`);
if (health.profile !== expectedProfile) throw new Error(`profile mismatch: ${health.profile} !== ${expectedProfile}`);
NODE

echo "Checking default 1536 embedding response..."
curl -fsS -X POST "$BASE_URL/embeddings" \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-bridge-semantic-hash-1536","input":["BridgeBrain verification smoke test"]}' \
  >"$TMP_DIR/embedding-1536.json"
BRIDGEBRAIN_VERIFY_EMBEDDING_JSON="$TMP_DIR/embedding-1536.json" "$NODE_BIN" <<'NODE'
const fs = require('fs');
const response = JSON.parse(fs.readFileSync(process.env.BRIDGEBRAIN_VERIFY_EMBEDDING_JSON, 'utf8'));
const embedding = response?.data?.[0]?.embedding;
if (!Array.isArray(embedding)) throw new Error('embedding is not an array');
if (embedding.length !== 1536) throw new Error(`expected 1536 dims, got ${embedding.length}`);
if (!embedding.some((n) => typeof n === 'number' && n !== 0)) throw new Error('embedding is all zero or invalid');
NODE

echo "Checking explicit 768 compatibility response..."
curl -fsS -X POST "$BASE_URL/embeddings" \
  -H 'content-type: application/json' \
  -d '{"model":"chatgpt-bridge-semantic-hash-768","input":["BridgeBrain compatibility smoke test"],"dimensions":768}' \
  >"$TMP_DIR/embedding-768.json"
BRIDGEBRAIN_VERIFY_EMBEDDING_JSON="$TMP_DIR/embedding-768.json" "$NODE_BIN" <<'NODE'
const fs = require('fs');
const response = JSON.parse(fs.readFileSync(process.env.BRIDGEBRAIN_VERIFY_EMBEDDING_JSON, 'utf8'));
const embedding = response?.data?.[0]?.embedding;
if (!Array.isArray(embedding)) throw new Error('compat embedding is not an array');
if (embedding.length !== 768) throw new Error(`expected 768 dims, got ${embedding.length}`);
if (!embedding.some((n) => typeof n === 'number' && n !== 0)) throw new Error('compat embedding is all zero or invalid');
NODE

if [[ "$SKIP_GBRAIN" -eq 1 ]]; then
  echo "Skipping GBrain checks."
  echo "BridgeBrain adapter verified."
  exit 0
fi

need_cmd gbrain "$GBRAIN_BIN"

echo "Checking GBrain config..."
"$NODE_BIN" - "$CONFIG_FILE" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL" <<'NODE'
const fs = require('fs');
const [file, model, dimsRaw, baseUrl] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (cfg.embedding_disabled) throw new Error('embedding_disabled is still true');
if (cfg.embedding_model !== `litellm:${model}`) throw new Error(`wrong embedding_model: ${cfg.embedding_model}`);
if (cfg.embedding_dimensions !== Number(dimsRaw)) throw new Error(`wrong embedding_dimensions: ${cfg.embedding_dimensions}`);
if (cfg.provider_base_urls?.litellm !== baseUrl) throw new Error(`wrong litellm base url: ${cfg.provider_base_urls?.litellm}`);
NODE

echo "Checking GBrain provider..."
"$GBRAIN_BIN" providers test

echo "Checking GBrain doctor summary..."
"$GBRAIN_BIN" doctor --json 2>"$TMP_DIR/doctor-stderr.jsonl" >"$TMP_DIR/doctor.json"
BRIDGEBRAIN_VERIFY_DOCTOR_JSON="$TMP_DIR/doctor.json" "$NODE_BIN" - "$MODEL_NAME" <<'NODE'
const fs = require('fs');
const expectedModel = process.argv[2];
const doctor = JSON.parse(fs.readFileSync(process.env.BRIDGEBRAIN_VERIFY_DOCTOR_JSON, 'utf8'));
const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
const provider = checks.find((check) => check.name === 'embedding_provider');
const width = checks.find((check) => check.name === 'embedding_width_consistency');
if (!provider || provider.status !== 'ok') throw new Error(`embedding_provider not ok: ${provider && provider.message}`);
if (!String(provider.message || '').includes(`litellm:${expectedModel}`)) throw new Error(`wrong provider: ${provider.message}`);
if (!width || width.status !== 'ok') throw new Error(`embedding_width_consistency not ok: ${width && width.message}`);
NODE

echo "BridgeBrain verified."
