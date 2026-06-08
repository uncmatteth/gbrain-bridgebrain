#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          resolve(JSON.parse(body));
        });
      })
      .on('error', reject);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const health = await getJson(`http://127.0.0.1:${port}/health`);
      if (health.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('eval auth smoke server did not become healthy');
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-auth-'));
  const port = await freePort();
  const token = 'eval-auth-smoke-token';
  const gbrainHome = path.join(temp, 'gbrain-home');
  const cacheDir = path.join(temp, 'cache');
  const configDir = path.join(gbrainHome, '.gbrain');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider_base_urls: {
        litellm: `http://127.0.0.1:${port}/v1/t/${token}`,
      },
    }),
  );

  const child = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(port),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      GBRAIN_CHATGPT_EMBED_MODEL: 'chatgpt-bridge-semantic-hash-1536',
      GBRAIN_CHATGPT_EMBED_DIMENSIONS: '1536',
      BRIDGEBRAIN_API_TOKEN: token,
      CACHE_DIR: cacheDir,
    },
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForHealth(port);
    const env = { ...process.env, GBRAIN_HOME: gbrainHome };
    delete env.BRIDGEBRAIN_EVAL_BASE_URL;
    delete env.BRIDGEBRAIN_API_TOKEN;
    delete env.GBRAIN_CHATGPT_EMBED_TOKEN;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'eval.js'), '--live'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      fail(`live eval auth smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nserver stderr:\n${stderr}`);
    }
    const summary = JSON.parse(result.stdout);
    if (summary.mode !== 'live') fail(`expected live eval mode, got ${summary.mode}`);
    if (summary.base_url !== `http://127.0.0.1:${port}/v1/t/<redacted>`) {
      fail(`eval output did not redact tokenized base URL: ${summary.base_url}`);
    }
    if (summary.recall_at_k !== 1) fail(`unexpected recall_at_k: ${summary.recall_at_k}`);
    console.log('live eval auth smoke passed');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
