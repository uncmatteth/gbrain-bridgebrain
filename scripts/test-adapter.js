#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js');
const port = Number(process.env.BRIDGEBRAIN_TEST_PORT || 4137);
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-cache-'));

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port,
        path: pathname,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null });
          } catch (error) {
            reject(error);
          }
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
      const response = await request('GET', '/health');
      if (response.status === 200 && response.json.ok) return response.json;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('server did not become healthy');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const child = spawn(process.execPath, [serverPath], {
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

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForHealth();
    assert(health.profile === 'mock', `wrong profile ${health.profile}`);
    assert(health.dimensions === 1536, `wrong default dimensions ${health.dimensions}`);

    const models = await request('GET', '/v1/models');
    assert(models.status === 200, `models status ${models.status}`);
    assert(models.json.data.some((model) => model.id === 'chatgpt-bridge-semantic-hash-1536'), '1536 model missing');
    assert(models.json.data.some((model) => model.id === 'chatgpt-bridge-semantic-hash-768'), '768 model missing');

    const first = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain adapter smoke test with semantic retrieval'],
    });
    assert(first.status === 200, `first embedding status ${first.status}`);
    assert(first.json.data[0].embedding.length === 1536, `expected 1536 dims, got ${first.json.data[0].embedding.length}`);

    const single = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: 'BridgeBrain single string input',
    });
    assert(single.status === 200, `single string embedding status ${single.status}`);
    assert(single.json.data[0].embedding.length === 1536, `expected 1536 dims, got ${single.json.data[0].embedding.length}`);

    const tokenArray = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: [1, 2, 3],
    });
    assert(tokenArray.status === 400, `token array embedding status ${tokenArray.status}`);

    const tokenArrayBatch = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: [[1, 2, 3]],
    });
    assert(tokenArrayBatch.status === 400, `token array batch embedding status ${tokenArrayBatch.status}`);

    const compat = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-768',
      input: ['BridgeBrain adapter compatibility smoke test'],
      dimensions: 768,
    });
    assert(compat.status === 200, `compat embedding status ${compat.status}`);
    assert(compat.json.data[0].embedding.length === 768, `expected 768 dims, got ${compat.json.data[0].embedding.length}`);

    const beforeStats = await request('GET', '/stats');
    const repeat = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain adapter smoke test with semantic retrieval'],
    });
    assert(repeat.status === 200, `repeat embedding status ${repeat.status}`);
    const afterStats = await request('GET', '/stats');
    assert(afterStats.json.cache_hits > beforeStats.json.cache_hits, 'repeat did not hit cache');
    assert(afterStats.json.bridge_calls === beforeStats.json.bridge_calls, 'repeat called bridge instead of cache');

    console.log('adapter smoke passed');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    if (stderr.trim()) process.stderr.write(stderr);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
