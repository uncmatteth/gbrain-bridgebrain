#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOST = process.env.GBRAIN_CHATGPT_EMBED_HOST || '127.0.0.1';
const PORT = Number(process.env.GBRAIN_CHATGPT_EMBED_PORT || 4127);
const CACHE_SCHEMA_VERSION = 2;
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || 6000);
const BRIDGE_TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 300000);
const CODEX_BIN = process.env.GPT_WEB_LOGIN_CODEX_BIN || 'codex';
const SUPPORTED_DIMENSIONS = new Set([768, 1536]);
const API_TOKEN = process.env.BRIDGEBRAIN_API_TOKEN || process.env.GBRAIN_CHATGPT_EMBED_TOKEN || '';
const SKILL_NAME = 'unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit';
const BRIDGE_SCRIPT =
  process.env.BRIDGE_SCRIPT ||
  path.join(os.homedir(), '.codex', 'skills', SKILL_NAME, 'scripts', 'gpt-web-login-bridge.js');
const CACHE_DIR =
  process.env.CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'gbrain-bridgebrain');

function normalizeProfile(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'compat' || value === '768') return 'compat';
  if (value === 'mock' || value === 'test') return 'mock';
  return 'quality';
}

function parseSupportedDimensions(raw, label) {
  const value = Number(raw);
  if (Number.isInteger(value) && SUPPORTED_DIMENSIONS.has(value)) return value;
  throw new Error(`${label} must be one of: 768, 1536`);
}

const PROFILE = normalizeProfile(
  process.env.BRIDGEBRAIN_PROFILE ||
    process.env.GBRAIN_CHATGPT_EMBED_PROFILE ||
    process.env.GBRAIN_CHATGPT_EMBED_MODE ||
    (process.env.BRIDGEBRAIN_MOCK_SIGNATURES === '1' ? 'mock' : 'quality'),
);
const DEFAULT_DIMENSIONS = parseSupportedDimensions(
  process.env.GBRAIN_CHATGPT_EMBED_DIMENSIONS || (PROFILE === 'compat' ? 768 : 1536),
  'GBRAIN_CHATGPT_EMBED_DIMENSIONS',
);
const MODEL_NAME =
  process.env.GBRAIN_CHATGPT_EMBED_MODEL ||
  process.env.MODEL_NAME ||
  `chatgpt-bridge-semantic-hash-${DEFAULT_DIMENSIONS}`;
const ALLOW_UNAUTHENTICATED =
  PROFILE === 'mock' || process.env.BRIDGEBRAIN_ALLOW_UNAUTHENTICATED === '1';

const stats = {
  started_at: new Date().toISOString(),
  profile: PROFILE,
  requests: 0,
  embeddings: 0,
  bridge_calls: 0,
  cache_hits: 0,
  cache_misses: 0,
  cache_writes: 0,
};

function chmodMaybe(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // chmod is best-effort on some filesystems.
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodMaybe(dir, 0o700);
}

function hardenCacheTree(dir) {
  ensurePrivateDir(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodMaybe(full, 0o700);
      let children = [];
      try {
        children = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const childPath = path.join(full, child.name);
        if (child.isDirectory()) chmodMaybe(childPath, 0o700);
        else chmodMaybe(childPath, 0o600);
      }
    } else {
      chmodMaybe(full, 0o600);
    }
  }
}

if (!ALLOW_UNAUTHENTICATED && !API_TOKEN) {
  throw new Error('BRIDGEBRAIN_API_TOKEN is required unless BRIDGEBRAIN_ALLOW_UNAUTHENTICATED=1');
}

hardenCacheTree(CACHE_DIR);

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function cacheFlavor() {
  return PROFILE === 'mock' ? 'mock-v2' : 'bridge-fingerprint-v2';
}

function cacheFileFor(text) {
  const key = sha256Hex(`${cacheFlavor()}\n${text}`);
  return path.join(CACHE_DIR, `${key.slice(0, 2)}`, `${key}.json`);
}

function readCache(text) {
  const file = cacheFileFor(text);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      parsed &&
      parsed.schema_version === CACHE_SCHEMA_VERSION &&
      parsed.flavor === cacheFlavor() &&
      parsed.signature
    ) {
      stats.cache_hits += 1;
      return parsed.signature;
    }
  } catch {
    return null;
  }
  return null;
}

function writeCache(text, signature) {
  const file = cacheFileFor(text);
  ensurePrivateDir(path.dirname(file));
  const payload = {
    schema_version: CACHE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    source_sha256: sha256Hex(text),
    flavor: cacheFlavor(),
    signature,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  chmodMaybe(tmp, 0o600);
  fs.renameSync(tmp, file);
  chmodMaybe(file, 0o600);
  stats.cache_writes += 1;
}

function normalizeText(input) {
  if (typeof input === 'string') return input.slice(0, MAX_TEXT_CHARS);
  return JSON.stringify(input ?? '').slice(0, MAX_TEXT_CHARS);
}

function requestError(statusCode, type, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorType = type;
  return error;
}

function embeddingInputsFromRequest(rawInput) {
  if (typeof rawInput === 'string') return [rawInput];
  if (Array.isArray(rawInput) && rawInput.every((item) => typeof item === 'string')) return rawInput;
  throw requestError(400, 'invalid_request_error', 'input must be a string or an array of strings');
}

function isTrustedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function assertAuthorizedEmbeddingRequest(req, pathToken) {
  if (ALLOW_UNAUTHENTICATED && !API_TOKEN) return;
  const supplied = pathToken || bearerToken(req);
  if (!API_TOKEN || !constantTimeEquals(supplied, API_TOKEN)) {
    throw requestError(401, 'unauthorized', 'valid BridgeBrain bearer token is required');
  }
}

function assertTrustedEmbeddingRequest(req, pathToken) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw requestError(415, 'unsupported_media_type', 'content-type must be application/json');
  }
  assertAuthorizedEmbeddingRequest(req, pathToken);
  if (!isTrustedOrigin(req.headers.origin)) {
    throw requestError(403, 'forbidden_origin', 'origin is not allowed');
  }
}

function routeFromUrl(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'v1' && parts[1] === 't' && parts[2]) {
    return {
      pathname: `/${['v1', ...parts.slice(3)].join('/')}`,
      token: decodeURIComponent(parts[2]),
    };
  }
  if (parts[0] === 't' && parts[1]) {
    return {
      pathname: `/${parts.slice(2).join('/')}`,
      token: decodeURIComponent(parts[1]),
    };
  }
  return { pathname: url.pathname, token: '' };
}

function extractJsonObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function fallbackSignature(text) {
  const normalized = normalizeText(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ' ')
    .replace(/[^a-z0-9_./:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalized.split(' ').filter((word) => word.length > 1);
  const uniq = [...new Set(words)];
  return {
    summary: uniq.slice(0, 32).join(' '),
    entities: uniq
      .filter((word) => word.includes('/') || word.includes('-') || word.includes('.') || /[0-9]/.test(word))
      .slice(0, 12),
    topics: uniq.slice(0, 12),
    actions: uniq
      .filter((word) => /(install|use|run|patch|verify|search|embed|bridge|avoid|configure|copy|publish|benchmark)/.test(word))
      .slice(0, 12),
    constraints: uniq
      .filter((word) => /(no|not|avoid|without|never|disabled|only|must|mustn)/.test(word))
      .slice(0, 12),
    synonyms: [],
    queries: [uniq.slice(0, 12).join(' ')],
  };
}

function runBridge(prompt) {
  stats.bridge_calls += 1;
  if (PROFILE === 'mock') {
    const textsMarker = '\nTexts:\n';
    const textsIdx = prompt.indexOf(textsMarker);
    if (textsIdx !== -1) {
      const parsed = JSON.parse(prompt.slice(textsIdx + textsMarker.length));
      return JSON.stringify({
        items: parsed.map((item) => ({
          id: item.id,
          signature: fallbackSignature(item.text),
        })),
      });
    }
    return JSON.stringify(fallbackSignature(prompt));
  }

  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    throw new Error(`ChatGPT bridge script not found: ${BRIDGE_SCRIPT}`);
  }

  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT, 'ask'], {
    input: prompt,
    encoding: 'utf8',
    timeout: BRIDGE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GPT_WEB_LOGIN_PROVIDER: process.env.GPT_WEB_LOGIN_PROVIDER || 'codex',
      GPT_WEB_LOGIN_CODEX_BIN: CODEX_BIN,
      GPT_WEB_LOGIN_CWD: process.env.GPT_WEB_LOGIN_CWD || os.homedir(),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(details || `bridge exited ${result.status}`);
  }
  const output = String(result.stdout || '').trim();
  if (!output) throw new Error('bridge returned empty output');
  return output;
}

function fingerprintPrompt(items) {
  return `Create deterministic semantic retrieval fingerprints for these texts.

Rules:
- Use the already-authenticated ChatGPT bridge only.
- Do not ask for keys or secrets.
- Do not explain.
- Return strict JSON only.
- Output shape: {"items":[{"id":0,"signature":{"summary":"...","entities":["..."],"topics":["..."],"actions":["..."],"constraints":["..."],"synonyms":["..."],"queries":["..."]}}]}
- All strings should be lowercase plain text.
- Keep each array short: max 12 entries.
- Preserve names, products, projects, actions, dates, technical terms, and intent.
- Normalize synonyms when obvious.
- Include likely user search phrases in "queries".
- Include negative requirements in "constraints" when present.
- Favor retrieval usefulness over pretty prose.

Texts:
${JSON.stringify(items.map((item) => ({ id: item.id, text: item.text })))}`;
}

function singleFingerprintPrompt(text) {
  return `Create one deterministic semantic retrieval fingerprint for this text.

Rules:
- Return strict JSON only.
- Output shape: {"summary":"...","entities":["..."],"topics":["..."],"actions":["..."],"constraints":["..."],"synonyms":["..."],"queries":["..."]}
- All strings should be lowercase plain text.
- Keep each array short: max 12 entries.
- Preserve names, products, projects, actions, dates, technical terms, and intent.
- Normalize synonyms when obvious.
- Include likely user search phrases in "queries".
- Include negative requirements in "constraints" when present.
- Favor retrieval usefulness over pretty prose.

Text:
${text}`;
}

function sanitizeSignature(signature) {
  if (typeof signature === 'string') return fallbackSignature(signature);
  if (!signature || typeof signature !== 'object') return fallbackSignature('');
  const out = {};
  for (const field of ['summary', 'entities', 'topics', 'actions', 'constraints', 'synonyms', 'queries']) {
    const value = signature[field];
    if (field === 'summary') {
      out[field] = typeof value === 'string' ? value.slice(0, 1000) : '';
      continue;
    }
    if (Array.isArray(value)) {
      out[field] = value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.slice(0, 240))
        .slice(0, 16);
    } else if (typeof value === 'string') {
      out[field] = [value.slice(0, 240)];
    } else {
      out[field] = [];
    }
  }
  return out;
}

function bridgeSignatures(missing) {
  const output = runBridge(fingerprintPrompt(missing));
  const parsed = extractJsonObject(output);
  if (parsed && Array.isArray(parsed.items)) {
    const byId = new Map();
    for (const item of parsed.items) {
      if (item && Number.isInteger(item.id) && item.signature) {
        byId.set(item.id, sanitizeSignature(item.signature));
      }
    }
    if (missing.every((item) => byId.has(item.id))) {
      return missing.map((item) => byId.get(item.id));
    }
  }

  return missing.map((item) => {
    const single = runBridge(singleFingerprintPrompt(item.text)).trim();
    return sanitizeSignature(extractJsonObject(single) || single);
  });
}

function flattenSignature(signature) {
  if (!signature || typeof signature !== 'object') return '';
  const parts = [];
  const fields = ['summary', 'entities', 'topics', 'actions', 'constraints', 'synonyms', 'queries'];
  for (const field of fields) {
    const value = signature[field];
    if (typeof value === 'string') parts.push(`${field} ${value}`);
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') parts.push(`${field} ${entry}`);
      }
    }
  }
  return parts.join(' ');
}

function weightedPhrases(signature) {
  if (!signature || typeof signature !== 'object') return [];
  const weights = {
    summary: 1.5,
    entities: 3.8,
    topics: 2.5,
    actions: 2.4,
    constraints: 2.7,
    synonyms: 1.8,
    queries: 3.2,
  };
  const phrases = [];
  for (const [field, weight] of Object.entries(weights)) {
    const value = signature[field];
    if (typeof value === 'string') phrases.push({ phrase: value, weight });
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') phrases.push({ phrase: entry, weight });
      }
    }
  }
  return phrases;
}

function tokenize(textInput) {
  const text = String(textInput || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ' ');
  const tokens = text.match(/[a-z0-9][a-z0-9_./:-]{1,80}/g) || [];
  return tokens.filter((token) => token.length > 1);
}

function addFeature(vector, feature, weight) {
  const hash = sha256(feature);
  const index = hash.readUInt32BE(0) % vector.length;
  const sign = hash[4] & 1 ? 1 : -1;
  vector[index] += sign * weight;
}

function supportedDimensions(dimensions) {
  const requested = Number(dimensions);
  if (Number.isInteger(requested) && SUPPORTED_DIMENSIONS.has(requested)) return requested;
  throw new Error(`unsupported embedding dimensions: ${dimensions}`);
}

function vectorFromSignature(signature, dimensions) {
  const dim = supportedDimensions(dimensions);
  const vector = new Array(dim).fill(0);
  const flattened = flattenSignature(signature);
  const tokens = tokenize(flattened);

  if (tokens.length === 0) {
    addFeature(vector, `empty:${sha256Hex(flattened).slice(0, 16)}`, 1);
  }

  for (const token of tokens) addFeature(vector, `u:${token}`, 1);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    addFeature(vector, `b:${tokens[i]} ${tokens[i + 1]}`, 1.45);
  }
  for (let i = 0; i < tokens.length - 2; i += 1) {
    addFeature(vector, `t:${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`, 1.9);
  }

  const compact = tokens.join(' ');
  for (let i = 0; i < compact.length - 4; i += 2) {
    addFeature(vector, `c:${compact.slice(i, i + 5)}`, 0.18);
  }

  for (const { phrase, weight } of weightedPhrases(signature)) {
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0) continue;
    addFeature(vector, `p:${phraseTokens.join(' ')}`, weight);
    for (const token of phraseTokens) addFeature(vector, `pf:${token}`, weight * 0.4);
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function approximateTokens(texts) {
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function getEmbeddings(inputs, dimensions) {
  const normalized = inputs.map(normalizeText);
  const signatures = new Array(normalized.length);
  const missing = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const cached = readCache(normalized[i]);
    if (cached) {
      signatures[i] = cached;
    } else {
      stats.cache_misses += 1;
      missing.push({ id: i, text: normalized[i] });
    }
  }

  if (missing.length > 0) {
    const fresh = bridgeSignatures(missing);
    for (let i = 0; i < missing.length; i += 1) {
      const item = missing[i];
      const signature = sanitizeSignature(fresh[i]);
      signatures[item.id] = signature;
      writeCache(item.text, signature);
    }
  }

  stats.embeddings += normalized.length;
  return signatures.map((signature) => vectorFromSignature(signature, dimensions));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function resolveDimensions(request) {
  if (Object.prototype.hasOwnProperty.call(request, 'dimensions')) {
    const requested = Number(request.dimensions);
    if (Number.isInteger(requested) && SUPPORTED_DIMENSIONS.has(requested)) return requested;
    throw requestError(400, 'invalid_request_error', 'dimensions must be one of: 768, 1536');
  }
  const model = String(request.model || MODEL_NAME);
  if (model.endsWith('-768')) return 768;
  if (model.endsWith('-1536')) return 1536;
  return DEFAULT_DIMENSIONS;
}

function modelList() {
  return [
    {
      id: 'chatgpt-bridge-semantic-hash-1536',
      object: 'model',
      owned_by: 'local-chatgpt-bridge',
    },
    {
      id: 'chatgpt-bridge-semantic-hash-768',
      object: 'model',
      owned_by: 'local-chatgpt-bridge',
    },
  ];
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const route = routeFromUrl(url);
  stats.requests += 1;

  if (req.method === 'GET' && (route.pathname === '/health' || route.pathname === '/v1/health')) {
    sendJson(res, 200, {
      ok: true,
      profile: PROFILE,
      model: MODEL_NAME,
      dimensions: DEFAULT_DIMENSIONS,
      default_model: 'chatgpt-bridge-semantic-hash-1536',
      compat_model: 'chatgpt-bridge-semantic-hash-768',
      bridge: PROFILE === 'mock' ? 'mock' : 'codex',
      cache: { enabled: true, schema_version: CACHE_SCHEMA_VERSION },
      stats,
    });
    return;
  }

  if (req.method === 'GET' && (route.pathname === '/stats' || route.pathname === '/v1/stats')) {
    sendJson(res, 200, stats);
    return;
  }

  if (req.method === 'GET' && (route.pathname === '/models' || route.pathname === '/v1/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: modelList(),
    });
    return;
  }

  if (req.method === 'POST' && (route.pathname === '/embeddings' || route.pathname === '/v1/embeddings')) {
    try {
      assertTrustedEmbeddingRequest(req, route.token);
      const request = await readJson(req);
      const inputs = embeddingInputsFromRequest(request.input);
      const normalizedInputs = inputs.map(normalizeText);
      const dimensions = resolveDimensions(request);
      const embeddings = getEmbeddings(inputs, dimensions);
      sendJson(res, 200, {
        object: 'list',
        model: request.model || MODEL_NAME,
        data: embeddings.map((embedding, index) => ({
          object: 'embedding',
          embedding,
          index,
        })),
        usage: {
          prompt_tokens: approximateTokens(normalizedInputs),
          total_tokens: approximateTokens(normalizedInputs),
        },
      });
    } catch (error) {
      const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 503;
      const type = (error && error.errorType) || 'chatgpt_bridge_embedding_error';
      sendJson(res, status, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type,
        },
      });
    }
    return;
  }

  sendJson(res, 404, { error: { message: 'not found', type: 'not_found' } });
}

function startServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'internal_error',
        },
      });
    });
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(`BridgeBrain embeddings listening on http://${HOST}:${PORT} profile=${PROFILE} model=${MODEL_NAME}\n`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  fallbackSignature,
  getEmbeddings,
  normalizeProfile,
  resolveDimensions,
  startServer,
  vectorFromSignature,
};
