#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILL_NAME="unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit"
BRIDGE_SCRIPT="${BRIDGE_SCRIPT:-$CODEX_HOME/skills/$SKILL_NAME/scripts/gpt-web-login-bridge.js}"
PORT="${GBRAIN_CHATGPT_EMBED_PORT:-4127}"
PROFILE="${BRIDGEBRAIN_PROFILE:-${GBRAIN_CHATGPT_EMBED_PROFILE:-quality}}"
MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-1536}"
DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-1536}"
BASE_URL="http://127.0.0.1:${PORT}/v1"
SKIP_GBRAIN=0
SKIP_BRIDGE=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

if [[ "$PROFILE" == "compat" ]]; then
  MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-768}"
  DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-768}"
fi

command -v node >/dev/null 2>&1 || fail "node is missing"
command -v curl >/dev/null 2>&1 || fail "curl is missing"

if [[ "$PROFILE" != "mock" && "$SKIP_BRIDGE" -ne 1 ]]; then
  command -v codex >/dev/null 2>&1 || fail "codex is missing"
  [[ -f "$BRIDGE_SCRIPT" ]] || fail "bridge script missing at $BRIDGE_SCRIPT"
  echo "Checking ChatGPT web-login bridge..."
  node "$BRIDGE_SCRIPT" status
fi

echo "Checking local embedding service..."
curl -fsS "http://127.0.0.1:${PORT}/health" >"$TMP_DIR/health.json"
BRIDGEBRAIN_VERIFY_HEALTH_JSON="$TMP_DIR/health.json" node - "$MODEL_NAME" "$DIMENSIONS" "$PROFILE" <<'NODE'
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
BRIDGEBRAIN_VERIFY_EMBEDDING_JSON="$TMP_DIR/embedding-1536.json" node <<'NODE'
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
BRIDGEBRAIN_VERIFY_EMBEDDING_JSON="$TMP_DIR/embedding-768.json" node <<'NODE'
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

command -v gbrain >/dev/null 2>&1 || fail "gbrain is missing"

echo "Checking GBrain config..."
node - "$HOME/.gbrain/config.json" "$MODEL_NAME" "$DIMENSIONS" "$BASE_URL" <<'NODE'
const fs = require('fs');
const [file, model, dimsRaw, baseUrl] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (cfg.embedding_disabled) throw new Error('embedding_disabled is still true');
if (cfg.embedding_model !== `litellm:${model}`) throw new Error(`wrong embedding_model: ${cfg.embedding_model}`);
if (cfg.embedding_dimensions !== Number(dimsRaw)) throw new Error(`wrong embedding_dimensions: ${cfg.embedding_dimensions}`);
if (cfg.provider_base_urls?.litellm !== baseUrl) throw new Error(`wrong litellm base url: ${cfg.provider_base_urls?.litellm}`);
NODE

echo "Checking GBrain provider..."
gbrain providers test

echo "Checking GBrain doctor summary..."
gbrain doctor --json 2>"$TMP_DIR/doctor-stderr.jsonl" >"$TMP_DIR/doctor.json"
BRIDGEBRAIN_VERIFY_DOCTOR_JSON="$TMP_DIR/doctor.json" node - "$MODEL_NAME" <<'NODE'
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
