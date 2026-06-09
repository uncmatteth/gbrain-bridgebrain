#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const port = Number(process.env.BRIDGEBRAIN_EVAL_PORT || 4138);
const authToken = process.env.BRIDGEBRAIN_API_TOKEN || process.env.GBRAIN_CHATGPT_EMBED_TOKEN || '';
let topK = 3;
let minRecall = null;
let requestTimeoutMs = 8000;
let evalModel = 'chatgpt-bridge-semantic-hash-1536';
let evalDimensions = 1536;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gbrainConfigFile() {
  const homeParent = process.env.GBRAIN_HOME || os.homedir();
  return path.join(homeParent, '.gbrain', 'config.json');
}

function installedBaseUrl() {
  try {
    return installedConfig().provider_base_urls?.litellm || '';
  } catch {
    return '';
  }
}

function installedConfig() {
  return readJson(gbrainConfigFile());
}

function defaultBaseUrl() {
  if (live) {
    const configured = installedBaseUrl();
    if (configured) return configured;
  }
  return `http://127.0.0.1:${port}/v1`;
}

function isLoopbackUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function isLoopbackParsedUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function hasTokenizedPath(parsed) {
  return /(^|\/)v1\/t\/[^/]+(?:\/|$)/.test(parsed.pathname) || /(^|\/)t\/[^/]+(?:\/|$)/.test(parsed.pathname);
}

function hasCredentialQuery(parsed) {
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret/i.test(key)) return true;
  }
  return false;
}

function hasCredentialMaterial(parsed) {
  return Boolean(parsed.username || parsed.password || authToken || hasTokenizedPath(parsed) || hasCredentialQuery(parsed));
}

function assertAllowedEvalUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`eval base URL must be valid: ${redactBaseUrl(url)}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`eval base URL protocol must be http or https: ${redactBaseUrl(url)}`);
  }
  const loopback = isLoopbackParsedUrl(parsed);
  if (!loopback && process.env.BRIDGEBRAIN_EVAL_ALLOW_REMOTE !== '1') {
    throw new Error(`live eval base URL must be loopback unless BRIDGEBRAIN_EVAL_ALLOW_REMOTE=1: ${redactBaseUrl(url)}`);
  }
  if (!loopback && parsed.protocol === 'http:' && process.env.BRIDGEBRAIN_EVAL_ALLOW_REMOTE_HTTP !== '1') {
    throw new Error(`remote eval URLs must use https unless BRIDGEBRAIN_EVAL_ALLOW_REMOTE_HTTP=1: ${redactBaseUrl(url)}`);
  }
  if (!loopback && parsed.protocol === 'http:' && hasCredentialMaterial(parsed)) {
    throw new Error(`remote eval URLs must use https when credentials would be sent: ${redactBaseUrl(url)}`);
  }
}

function redactBaseUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? '<redacted>' : '';
    parsed.password = parsed.password ? '<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret/i.test(key)) {
        parsed.searchParams.set(key, '<redacted>');
      }
    }
    return parsed.toString()
      .replace(/\/v1\/t\/[^/]+/, '/v1/t/<redacted>')
      .replace(/\/t\/[^/]+/, '/t/<redacted>');
  } catch {
    return redactSensitive(url);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitive(value) {
  let text = String(value || '')
    .replace(/\/v1\/t\/[^/\s"'`]+/g, '/v1/t/<redacted>')
    .replace(/\/t\/[^/\s"'`]+/g, '/t/<redacted>')
    .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@');
  if (authToken) text = text.replace(new RegExp(escapeRegExp(authToken), 'g'), '<redacted>');
  return text;
}

const baseUrl = live
  ? (process.env.BRIDGEBRAIN_EVAL_BASE_URL || defaultBaseUrl())
  : defaultBaseUrl();
if (!live && process.env.BRIDGEBRAIN_EVAL_BASE_URL) {
  process.stderr.write('Ignoring BRIDGEBRAIN_EVAL_BASE_URL in mock eval; mock mode always uses the local spawned service.\n');
}

function configuredModelAndDimensions() {
  let model = process.env.BRIDGEBRAIN_EVAL_MODEL || '';
  let dimensions = process.env.BRIDGEBRAIN_EVAL_DIMENSIONS || '';
  if ((!model || !dimensions) && live) {
    try {
      const cfg = installedConfig();
      if (!model && cfg.embedding_model) model = String(cfg.embedding_model).replace(/^litellm:/, '');
      if (!dimensions && cfg.embedding_dimensions) dimensions = String(cfg.embedding_dimensions);
    } catch {
      // Live eval can still run against an explicit base URL without installed config.
    }
  }
  model = model || 'chatgpt-bridge-semantic-hash-1536';
  dimensions = dimensions || (model.endsWith('-768') ? '768' : '1536');
  const numericDimensions = Number(dimensions);
  if (!Number.isInteger(numericDimensions) || ![1536, 768].includes(numericDimensions)) {
    throw new Error('BRIDGEBRAIN_EVAL_DIMENSIONS must be 1536 or 768');
  }
  const suffix = model.match(/-(1536|768)$/);
  if (suffix && Number(suffix[1]) !== numericDimensions) {
    throw new Error('BRIDGEBRAIN_EVAL_MODEL suffix must match BRIDGEBRAIN_EVAL_DIMENSIONS');
  }
  return { model, dimensions: numericDimensions };
}

function configureThresholds() {
  topK = Number(process.env.BRIDGEBRAIN_EVAL_TOP_K || 3);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error('BRIDGEBRAIN_EVAL_TOP_K must be an integer >= 1');
  }
  minRecall = process.env.BRIDGEBRAIN_EVAL_MIN_RECALL
    ? Number(process.env.BRIDGEBRAIN_EVAL_MIN_RECALL)
    : null;
  if (minRecall !== null && (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1)) {
    throw new Error('BRIDGEBRAIN_EVAL_MIN_RECALL must be a number in [0, 1]');
  }
  requestTimeoutMs = Number(process.env.BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS || (live ? 300000 : 8000));
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100) {
    throw new Error('BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS must be an integer >= 100');
  }
  const configured = configuredModelAndDimensions();
  evalModel = configured.model;
  evalDimensions = configured.dimensions;
}

function assertMockPortFree() {
  if (live) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', (error) => {
      reject(new Error(`mock eval port ${port} is not available: ${error.code || error.message}`));
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(resolve);
    });
  });
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:'
      ? https
      : parsed.protocol === 'http:'
        ? http
        : null;
    if (!client) {
      reject(new Error(`unsupported URL protocol for ${redactBaseUrl(url)}`));
      return;
    }
    const payload = body ? JSON.stringify(body) : '';
    const headers = payload
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }
      : {};
    if (live && authToken && (isLoopbackUrl(url) || process.env.BRIDGEBRAIN_EVAL_ALLOW_REMOTE === '1')) {
      headers.authorization = `Bearer ${authToken}`;
    }
    const req = client.request(
      {
        method: body ? 'POST' : 'GET',
        hostname: hostnameForRequest(parsed),
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${redactSensitive(data).slice(0, 2000)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (error) {
            reject(new Error(`invalid JSON response from ${redactBaseUrl(url)}: ${error.message}`));
          }
        });
      },
    );
    req.setTimeout(requestTimeoutMs, () => {
      req.destroy(new Error(`HTTP request timed out after ${requestTimeoutMs}ms: ${redactBaseUrl(url)}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function hostnameForRequest(parsed) {
  return parsed.hostname.replace(/^\[(.*)\]$/, '$1');
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(`${baseUrl}/health`);
      if (response.ok) return response;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('eval server did not become healthy');
}

async function embed(texts) {
  const response = await requestJson(`${baseUrl}/embeddings`, {
    model: evalModel,
    dimensions: evalDimensions,
    input: texts,
  });
  if (!response || !Array.isArray(response.data) || response.data.length !== texts.length) {
    throw new Error(`invalid embedding response shape from ${redactBaseUrl(baseUrl)}`);
  }
  return response.data.map((item, index) => {
    const embedding = item && item.embedding;
    if (!Array.isArray(embedding) || embedding.length !== evalDimensions) {
      throw new Error(`invalid embedding at index ${index}: expected ${evalDimensions} finite numbers`);
    }
    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid embedding at index ${index}: expected ${evalDimensions} finite numbers`);
      }
    }
    return embedding;
  });
}

function validateFixtures(corpus, queries) {
  if (!Array.isArray(corpus) || corpus.length === 0) {
    throw new Error('eval corpus must contain at least one document');
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('eval query set must contain at least one query');
  }
  const ids = new Set();
  for (const doc of corpus) {
    if (!doc || typeof doc.id !== 'string' || !doc.id || typeof doc.text !== 'string' || !doc.text) {
      throw new Error('eval corpus documents must have non-empty string id and text');
    }
    if (ids.has(doc.id)) throw new Error(`duplicate eval corpus id: ${doc.id}`);
    ids.add(doc.id);
  }
  for (const query of queries) {
    if (!query || typeof query.query !== 'string' || !query.query) {
      throw new Error('eval queries must have non-empty query text');
    }
    if (!Array.isArray(query.relevant) || query.relevant.length === 0) {
      throw new Error(`eval query must name at least one relevant id: ${query.query}`);
    }
    for (const id of query.relevant) {
      if (!ids.has(id)) throw new Error(`eval relevant id missing from corpus: ${id}`);
    }
  }
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / ((Math.sqrt(normA) || 1) * (Math.sqrt(normB) || 1));
}

function score(corpus, corpusVectors, query, queryVector) {
  return corpus
    .map((doc, index) => ({
      id: doc.id,
      score: cosine(queryVector, corpusVectors[index]),
      relevant: query.relevant.includes(doc.id),
    }))
    .sort((a, b) => b.score - a.score);
}

async function main() {
  configureThresholds();
  assertAllowedEvalUrl(baseUrl);
  await assertMockPortFree();
  const corpus = readJson(process.env.BRIDGEBRAIN_EVAL_CORPUS || path.join(root, 'evals', 'fixture-corpus.json'));
  const queries = readJson(process.env.BRIDGEBRAIN_EVAL_QUERY_SET || path.join(root, 'evals', 'query-set.json'));
  validateFixtures(corpus, queries);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-cache-'));
  let child = null;

  try {
    if (!live) {
      child = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...mockServerEnv(),
          GBRAIN_CHATGPT_EMBED_HOST: '127.0.0.1',
          GBRAIN_CHATGPT_EMBED_PORT: String(port),
          BRIDGEBRAIN_PROFILE: 'mock',
          GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
          GBRAIN_CHATGPT_EMBED_MODE: 'mock',
          BRIDGEBRAIN_MOCK_SIGNATURES: '1',
          GBRAIN_CHATGPT_EMBED_MODEL: evalModel,
          GBRAIN_CHATGPT_EMBED_DIMENSIONS: String(evalDimensions),
          CACHE_DIR: cacheDir,
        },
      });
      await waitForHealth();
    }

    const corpusVectors = await embed(corpus.map((doc) => doc.text));
    const queryVectors = await embed(queries.map((query) => query.query));
    const scoredRows = queries.map((query, index) => {
      const ranked = score(corpus, corpusVectors, query, queryVectors[index]);
      const top = ranked.slice(0, topK);
      const firstRelevantRank = ranked.findIndex((row) => row.relevant) + 1;
      const retrievedRelevant = top.filter((row) => row.relevant).length;
      const recall = retrievedRelevant / query.relevant.length;
      const reciprocalRank = firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
      return {
        hitAtK: top.some((row) => row.relevant),
        recall,
        reciprocalRank,
        output: {
          query: query.query,
          relevant: query.relevant,
          top: top.map((row) => ({ id: row.id, score: Number(row.score.toFixed(4)), relevant: row.relevant })),
          hit_at_k: top.some((row) => row.relevant),
          recall_at_k: Number(recall.toFixed(4)),
          reciprocal_rank: reciprocalRank,
        },
      };
    });
    const rows = scoredRows.map((row) => row.output);
    const hitRateAtK = scoredRows.filter((row) => row.hitAtK).length / scoredRows.length;
    const recallAtK = scoredRows.reduce((sum, row) => sum + row.recall, 0) / scoredRows.length;
    const mrr = scoredRows.reduce((sum, row) => sum + row.reciprocalRank, 0) / scoredRows.length;
    const summary = {
      mode: live ? 'live' : 'mock',
      base_url: redactBaseUrl(baseUrl),
      corpus_size: corpus.length,
      query_count: queries.length,
      eval_model: evalModel,
      eval_dimensions: evalDimensions,
      top_k: topK,
      hit_rate_at_k: Number(hitRateAtK.toFixed(4)),
      recall_at_k: Number(recallAtK.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      rows,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (minRecall !== null && recallAtK < minRecall) {
      throw new Error(`recall_at_${topK} ${recallAtK.toFixed(4)} below minimum ${minRecall}`);
    }
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function mockServerEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BRIDGEBRAIN_EVAL_')) delete env[key];
  }
  delete env.BRIDGEBRAIN_API_TOKEN;
  delete env.GBRAIN_CHATGPT_EMBED_TOKEN;
  delete env.BRIDGEBRAIN_PROFILE;
  delete env.GBRAIN_CHATGPT_EMBED_PROFILE;
  delete env.GBRAIN_CHATGPT_EMBED_MODE;
  delete env.BRIDGEBRAIN_MOCK_SIGNATURES;
  delete env.BRIDGEBRAIN_ALLOW_UNAUTHENTICATED;
  delete env.BRIDGEBRAIN_ALLOW_PATH_TOKEN;
  delete env.BRIDGEBRAIN_EVAL_ALLOW_REMOTE;
  delete env.GBRAIN_CHATGPT_EMBED_HOST;
  return env;
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
