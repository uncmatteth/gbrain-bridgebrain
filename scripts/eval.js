#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const port = Number(process.env.BRIDGEBRAIN_EVAL_PORT || 4138);
const topK = Number(process.env.BRIDGEBRAIN_EVAL_TOP_K || 3);
const minRecall = process.env.BRIDGEBRAIN_EVAL_MIN_RECALL
  ? Number(process.env.BRIDGEBRAIN_EVAL_MIN_RECALL)
  : null;
const authToken = process.env.BRIDGEBRAIN_API_TOKEN || process.env.GBRAIN_CHATGPT_EMBED_TOKEN || '';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gbrainConfigFile() {
  const homeParent = process.env.GBRAIN_HOME || os.homedir();
  return path.join(homeParent, '.gbrain', 'config.json');
}

function installedBaseUrl() {
  try {
    return readJson(gbrainConfigFile()).provider_base_urls?.litellm || '';
  } catch {
    return '';
  }
}

function defaultBaseUrl() {
  if (live) {
    const configured = installedBaseUrl();
    if (configured) return configured;
  }
  if (authToken) return `http://127.0.0.1:${port}/v1/t/${encodeURIComponent(authToken)}`;
  return `http://127.0.0.1:${port}/v1`;
}

function redactBaseUrl(url) {
  return url.replace(/\/v1\/t\/[^/]+/, '/v1/t/<redacted>');
}

const baseUrl = process.env.BRIDGEBRAIN_EVAL_BASE_URL || defaultBaseUrl();

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : '';
    const headers = payload
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }
      : {};
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const req = http.request(
      {
        method: body ? 'POST' : 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
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
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data ? JSON.parse(data) : null);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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
    model: 'chatgpt-bridge-semantic-hash-1536',
    input: texts,
  });
  return response.data.map((item) => item.embedding);
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
  const corpus = readJson(path.join(root, 'evals', 'fixture-corpus.json'));
  const queries = readJson(path.join(root, 'evals', 'query-set.json'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-cache-'));
  let child = null;

  if (!live) {
    child = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GBRAIN_CHATGPT_EMBED_PORT: String(port),
        GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
        GBRAIN_CHATGPT_EMBED_MODEL: 'chatgpt-bridge-semantic-hash-1536',
        GBRAIN_CHATGPT_EMBED_DIMENSIONS: '1536',
        CACHE_DIR: cacheDir,
      },
    });
    await waitForHealth();
  }

  try {
    const corpusVectors = await embed(corpus.map((doc) => doc.text));
    const queryVectors = await embed(queries.map((query) => query.query));
    const rows = queries.map((query, index) => {
      const ranked = score(corpus, corpusVectors, query, queryVectors[index]);
      const top = ranked.slice(0, topK);
      const firstRelevantRank = ranked.findIndex((row) => row.relevant) + 1;
      return {
        query: query.query,
        relevant: query.relevant,
        top: top.map((row) => ({ id: row.id, score: Number(row.score.toFixed(4)), relevant: row.relevant })),
        hit_at_k: top.some((row) => row.relevant),
        reciprocal_rank: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
      };
    });
    const recallAtK = rows.filter((row) => row.hit_at_k).length / rows.length;
    const mrr = rows.reduce((sum, row) => sum + row.reciprocal_rank, 0) / rows.length;
    const summary = {
      mode: live ? 'live' : 'mock',
      base_url: redactBaseUrl(baseUrl),
      corpus_size: corpus.length,
      query_count: queries.length,
      top_k: topK,
      recall_at_k: Number(recallAtK.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      rows,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (minRecall !== null && recallAtK < minRecall) {
      throw new Error(`recall_at_${topK} ${recallAtK.toFixed(4)} below minimum ${minRecall}`);
    }
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
