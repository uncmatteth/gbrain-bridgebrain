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

node_http_json() {
  local method="$1"
  local url="$2"
  local output="$3"
  local body="${4:-}"
  BRIDGEBRAIN_VERIFY_METHOD="$method" \
  BRIDGEBRAIN_VERIFY_URL="$url" \
  BRIDGEBRAIN_VERIFY_OUTPUT="$output" \
  BRIDGEBRAIN_VERIFY_BODY="$body" \
  BRIDGEBRAIN_VERIFY_AUTH_TOKEN="${REQUEST_AUTH_TOKEN:-}" \
  "$NODE_BIN" <<'NODE'
const fs = require('fs');
const http = require('http');
const https = require('https');
const method = process.env.BRIDGEBRAIN_VERIFY_METHOD || 'GET';
const rawUrl = process.env.BRIDGEBRAIN_VERIFY_URL || '';
const output = process.env.BRIDGEBRAIN_VERIFY_OUTPUT || '';
const body = process.env.BRIDGEBRAIN_VERIFY_BODY || '';
const url = new URL(rawUrl);
const client = url.protocol === 'https:' ? https : http;
const headers = {};
const authToken = process.env.BRIDGEBRAIN_VERIFY_AUTH_TOKEN || '';
if (body) {
  headers['content-type'] = 'application/json';
  headers['content-length'] = Buffer.byteLength(body);
}
if (authToken) {
  headers.authorization = `Bearer ${authToken}`;
}
const req = client.request(url, { method, headers, timeout: method === 'GET' ? 10000 : 20000 }, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error(`HTTP ${res.statusCode}`);
      process.exit(1);
    }
    try {
      JSON.parse(data);
    } catch (error) {
      console.error(`invalid JSON response: ${error.message}`);
      process.exit(1);
    }
    fs.writeFileSync(output, data);
  });
});
req.on('timeout', () => req.destroy(new Error('request timed out')));
req.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
if (body) req.write(body);
req.end();
NODE
}

base_url_path_token() {
  BRIDGEBRAIN_VERIFY_BASE_URL="$1" \
  "$NODE_BIN" <<'NODE'
const raw = process.env.BRIDGEBRAIN_VERIFY_BASE_URL || '';
try {
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 't' && (i === 0 || parts[i - 1] === 'v1')) {
      process.stdout.write(decodeURIComponent(parts[i + 1]));
      process.exit(0);
    }
  }
  process.exit(0);
} catch {
  process.exit(2);
}
NODE
}

service_health_url() {
  BRIDGEBRAIN_VERIFY_BASE_URL="$1" \
  BRIDGEBRAIN_VERIFY_AUTH_TOKEN="${REQUEST_AUTH_TOKEN:-}" \
  "$NODE_BIN" <<'NODE'
const raw = process.env.BRIDGEBRAIN_VERIFY_BASE_URL || '';
function redact(value) {
  try {
    const url = new URL(value);
    url.username = url.username ? '<redacted>' : '';
    url.password = url.password ? '<redacted>' : '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret/i.test(key)) {
        url.searchParams.set(key, '<redacted>');
      }
    }
    return url.toString()
      .replace(/\/v1\/t\/[^/]+/, '/v1/t/<redacted>')
      .replace(/\/t\/[^/]+/, '/t/<redacted>');
  } catch {
    return String(value)
      .replace(/\/v1\/t\/[^/\s"'`]+/g, '/v1/t/<redacted>')
      .replace(/\/t\/[^/\s"'`]+/g, '/t/<redacted>')
      .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@');
  }
}
function hasCredentialQuery(url) {
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret/i.test(key)) return true;
  }
  return false;
}
function hasCredentialMaterial(url) {
  return Boolean(
    url.username ||
    url.password ||
    /(^|\/)v1\/t\/[^/]+(?:\/|$)/.test(url.pathname) ||
    /(^|\/)t\/[^/]+(?:\/|$)/.test(url.pathname) ||
    hasCredentialQuery(url)
  );
}
function healthPath(url) {
  const match = url.pathname.match(/^(.*?)(?:\/v1(?:\/t\/[^/]+)?\/?)?$/);
  const prefix = match ? match[1].replace(/\/+$/, '') : '';
  return `${prefix}/health`;
}
function safeError(message) {
  const error = new Error(message);
  error.safe = true;
  throw error;
}
try {
	  const url = new URL(raw);
	  const hasHeaderCredential = Boolean(process.env.BRIDGEBRAIN_VERIFY_AUTH_TOKEN || '');
	  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
	  if (!['http:', 'https:'].includes(url.protocol)) {
	    safeError('provider URL protocol must be http or https');
	  }
	  if (url.search) {
	    safeError(`provider URL query strings are not supported: ${redact(raw)}`);
	  }
  if (!loopback && process.env.BRIDGEBRAIN_VERIFY_ALLOW_REMOTE !== '1') {
    safeError('provider URL must be loopback unless BRIDGEBRAIN_VERIFY_ALLOW_REMOTE=1');
  }
  if (!loopback && url.protocol === 'http:' && (hasCredentialMaterial(url) || hasHeaderCredential)) {
    safeError(`remote provider URLs must use https when credentials would be sent: ${redact(raw)}`);
  }
  process.stdout.write(`${url.protocol}//${url.host}${healthPath(url)}${url.search}\n`);
} catch (error) {
  console.error(error.safe ? error.message : `invalid embedding base URL: ${redact(raw)}`);
  process.exit(2);
}
NODE
}

if [[ "$PROFILE" == "compat" ]]; then
  MODEL_NAME="${GBRAIN_CHATGPT_EMBED_MODEL:-chatgpt-bridge-semantic-hash-768}"
  DIMENSIONS="${GBRAIN_CHATGPT_EMBED_DIMENSIONS:-768}"
fi

validate_gbrain_home
need_cmd node "$NODE_BIN"

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
REQUEST_AUTH_TOKEN=""
if [[ -n "$CONFIG_BASE_URL" ]]; then
  BASE_URL="$CONFIG_BASE_URL"
elif [[ -n "$TOKEN" ]]; then
  BASE_URL="http://127.0.0.1:${PORT}/v1"
fi
if ! BASE_URL_PATH_TOKEN="$(base_url_path_token "$BASE_URL")"; then
  fail "invalid embedding base URL"
fi
if [[ -n "$TOKEN" && -n "$BASE_URL_PATH_TOKEN" && "$TOKEN" != "$BASE_URL_PATH_TOKEN" ]]; then
  fail "BRIDGEBRAIN_API_TOKEN/GBRAIN_CHATGPT_EMBED_TOKEN does not match tokenized provider base URL."
fi
if [[ -n "$TOKEN" && -z "$BASE_URL_PATH_TOKEN" ]]; then
  REQUEST_AUTH_TOKEN="$TOKEN"
fi
HEALTH_URL="$(service_health_url "$BASE_URL")"
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
if [[ "$PROFILE" != "mock" && "$SKIP_BRIDGE" -eq 1 ]]; then
  fail "--skip-bridge is only allowed for mock profile tests."
fi

if [[ "$PROFILE" != "mock" && "$SKIP_BRIDGE" -ne 1 ]]; then
  need_cmd codex "$CODEX_BIN"
  [[ -f "$BRIDGE_SCRIPT" ]] || fail "bridge script missing at $BRIDGE_SCRIPT"
fi

echo "Checking local embedding service..."
node_http_json GET "$HEALTH_URL" "$TMP_DIR/health.json"
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
node_http_json POST "$BASE_URL/embeddings" "$TMP_DIR/embedding-1536.json" \
  '{"model":"chatgpt-bridge-semantic-hash-1536","input":["BridgeBrain verification smoke test"]}'
BRIDGEBRAIN_VERIFY_EMBEDDING_JSON="$TMP_DIR/embedding-1536.json" "$NODE_BIN" <<'NODE'
const fs = require('fs');
const response = JSON.parse(fs.readFileSync(process.env.BRIDGEBRAIN_VERIFY_EMBEDDING_JSON, 'utf8'));
const embedding = response?.data?.[0]?.embedding;
if (!Array.isArray(embedding)) throw new Error('embedding is not an array');
if (embedding.length !== 1536) throw new Error(`expected 1536 dims, got ${embedding.length}`);
if (!embedding.some((n) => typeof n === 'number' && n !== 0)) throw new Error('embedding is all zero or invalid');
NODE

echo "Checking explicit 768 compatibility response..."
node_http_json POST "$BASE_URL/embeddings" "$TMP_DIR/embedding-768.json" \
  '{"model":"chatgpt-bridge-semantic-hash-768","input":["BridgeBrain compatibility smoke test"],"dimensions":768}'
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
function redact(value) {
  try {
    const url = new URL(value);
    url.username = url.username ? '<redacted>' : '';
    url.password = url.password ? '<redacted>' : '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret/i.test(key)) {
        url.searchParams.set(key, '<redacted>');
      }
    }
    return url.toString()
      .replace(/\/v1\/t\/[^/]+/, '/v1/t/<redacted>')
      .replace(/\/t\/[^/]+/, '/t/<redacted>');
  } catch {
    return String(value)
      .replace(/\/v1\/t\/[^/\s"'`]+/g, '/v1/t/<redacted>')
      .replace(/\/t\/[^/\s"'`]+/g, '/t/<redacted>')
      .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@');
  }
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (cfg.embedding_disabled) throw new Error('embedding_disabled is still true');
if (cfg.embedding_model !== `litellm:${model}`) throw new Error(`wrong embedding_model: ${cfg.embedding_model}`);
if (cfg.embedding_dimensions !== Number(dimsRaw)) throw new Error(`wrong embedding_dimensions: ${cfg.embedding_dimensions}`);
if (cfg.provider_base_urls?.litellm !== baseUrl) {
  throw new Error(`wrong litellm base url: ${redact(cfg.provider_base_urls?.litellm)} (expected ${redact(baseUrl)})`);
}
NODE

echo "Checking GBrain provider..."
"$GBRAIN_BIN" providers test

echo "Checking GBrain doctor summary..."
if ! "$GBRAIN_BIN" doctor --json 2>"$TMP_DIR/doctor-stderr.jsonl" >"$TMP_DIR/doctor.json"; then
  BRIDGEBRAIN_VERIFY_DOCTOR_JSON="$TMP_DIR/doctor.json" \
  BRIDGEBRAIN_VERIFY_DOCTOR_STDERR="$TMP_DIR/doctor-stderr.jsonl" \
  "$NODE_BIN" <<'NODE' >&2
const fs = require('fs');
function redact(value) {
  return String(value || '')
    .replace(/\/v1\/t\/[^/\s"'`]+/g, '/v1/t/<redacted>')
    .replace(/\/t\/[^/\s"'`]+/g, '/t/<redacted>')
    .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}
for (const label of ['BRIDGEBRAIN_VERIFY_DOCTOR_STDERR', 'BRIDGEBRAIN_VERIFY_DOCTOR_JSON']) {
  const file = process.env[label];
  if (!file || !fs.existsSync(file)) continue;
  const text = redact(fs.readFileSync(file, 'utf8')).trim();
  if (text) console.error(text.slice(0, 4000));
}
NODE
  fail "GBrain doctor failed"
fi
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
