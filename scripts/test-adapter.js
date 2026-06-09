#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js');
let port = Number(process.env.BRIDGEBRAIN_TEST_PORT || 0);
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-cache-'));
process.env.CACHE_DIR = cacheDir;
process.env.GBRAIN_CHATGPT_EMBED_PROFILE = process.env.GBRAIN_CHATGPT_EMBED_PROFILE || 'mock';
process.env.BRIDGEBRAIN_ALLOW_UNAUTHENTICATED = process.env.BRIDGEBRAIN_ALLOW_UNAUTHENTICATED || '1';
const { fallbackSignature } = require(serverPath);
const apiToken = 'tok1234';
const embeddingsPath = `/v1/t/${apiToken}/embeddings`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function request(method, pathname, body, extraHeaders = {}, targetPort = port) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = payload
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...extraHeaders,
        }
      : { ...extraHeaders };
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port: targetPort,
        path: pathname,
        headers,
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

function rawRequest(method, pathname, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = payload
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...extraHeaders,
        }
      : { ...extraHeaders };
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port,
        path: pathname,
        headers,
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

async function waitForHealth(targetPort = port) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health', null, {}, targetPort);
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

function assertMode(file, expected, label) {
  const actual = fs.statSync(file).mode & 0o777;
  assert(actual === expected, `${label} mode ${actual.toString(8)} !== ${expected.toString(8)}`);
}

function firstCacheFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childDir = path.join(dir, entry.name);
    for (const child of fs.readdirSync(childDir, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.json')) return path.join(childDir, child.name);
    }
  }
  return '';
}

function assertFallbackSignatureTokenClassification() {
  const plain = fallbackSignature('node user guide');
  assert(!plain.actions.includes('user'), 'fallback signature treated user as use action');
  assert(!plain.constraints.includes('node'), 'fallback signature treated node as no/not constraint');
  const constrained = fallbackSignature('never use unsafe shortcuts');
  assert(constrained.actions.includes('use'), 'fallback signature missed exact use action');
  assert(constrained.constraints.includes('never'), 'fallback signature missed exact never constraint');
}

function assertCachePermissionHardeningSource() {
  const source = fs.readFileSync(serverPath, 'utf8');
  if (!source.includes('stat.uid !== process.getuid()')) {
    throw new Error('cache hardening must verify POSIX cache ownership');
  }
  if (!source.includes('stat.mode & 0o077')) {
    throw new Error('cache hardening must reject group/other cache permissions');
  }
  if (!source.includes('CACHE_DIR could not set private permissions')) {
    throw new Error('cache hardening must fail closed on chmod errors');
  }
}

async function assertInvalidStartupDimensions() {
  const invalidPort = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(invalidPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      GBRAIN_CHATGPT_EMBED_DIMENSIONS: '1024',
      CACHE_DIR: cacheDir,
    },
  });
  const { code, stderr } = await waitForClose(child);
  assert(code !== null && code !== 0, 'invalid startup dimensions should fail before serving');
  assert(stderr.includes('GBRAIN_CHATGPT_EMBED_DIMENSIONS must be one of'), 'invalid startup dimensions error missing');
}

async function assertInvalidStartupLimit() {
  const invalidPort = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(invalidPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      MAX_TEXT_CHARS: 'NaN',
      CACHE_DIR: cacheDir,
    },
  });
  const { code, stderr } = await waitForClose(child);
  assert(code !== null && code !== 0, 'invalid MAX_TEXT_CHARS should fail before serving');
  assert(stderr.includes('MAX_TEXT_CHARS must be a positive integer'), 'invalid MAX_TEXT_CHARS error missing');
}

async function assertMalformedBridgeFailsClosed() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-bad-bridge-'));
  const badBridge = path.join(temp, 'bad-bridge.js');
  const badCache = path.join(temp, 'cache');
  const badPort = await freePort();
  const originalText = 'Malformed bridge output must fail closed';
  fs.writeFileSync(
    badBridge,
    [
      '#!/usr/bin/env node',
      'if (process.argv[2] !== "ask") process.exit(2);',
      'console.log("successful non-json bridge output that must not become the signature");',
    ].join('\n'),
    { mode: 0o755 },
  );
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(badPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'quality',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      BRIDGE_SCRIPT: badBridge,
      CACHE_DIR: badCache,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(badPort);
    const result = await request(
      'POST',
      '/v1/embeddings',
      { model: 'chatgpt-bridge-semantic-hash-1536', input: originalText },
      {},
      badPort,
    );
    assert(result.status === 503, `bad bridge embedding status ${result.status}; stderr=${stderr}`);
    assert(
      result.json?.error?.type === 'chatgpt_bridge_embedding_error',
      `bad bridge error type ${result.json?.error?.type}`,
    );
    assert(
      String(result.json?.error?.message || '').includes('malformed'),
      `bad bridge error message ${result.json?.error?.message}`,
    );
    const cacheFile = firstCacheFile(badCache);
    assert(!cacheFile, 'malformed bridge output should not be cached');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertEarlyExitBridgeDoesNotCrashServer() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-early-bridge-'));
  const badBridge = path.join(temp, 'bad-bridge.js');
  const badCache = path.join(temp, 'cache');
  const badPort = await freePort();
  fs.writeFileSync(
    badBridge,
    [
      '#!/usr/bin/env node',
      'process.exit(1);',
    ].join('\n'),
    { mode: 0o755 },
  );
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(badPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'quality',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      BRIDGE_SCRIPT: badBridge,
      CACHE_DIR: badCache,
      MAX_TEXT_CHARS: '200000',
      BRIDGE_BATCH_CHAR_BUDGET: '200000',
      BRIDGE_TIMEOUT_MS: '5000',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(badPort);
    const result = await request(
      'POST',
      '/v1/embeddings',
      { model: 'chatgpt-bridge-semantic-hash-1536', input: 'early bridge exit '.repeat(8000) },
      {},
      badPort,
    );
    assert(result.status === 503, `early bridge exit status ${result.status}; stderr=${stderr}`);
    const health = await waitForHealth(badPort);
    assert(health.ok, 'server did not remain healthy after early bridge exit');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertMigratesUnmarkedLegacyCache() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-existing-cache-'));
  const oldCache = path.join(temp, 'cache');
  const shard = path.join(oldCache, 'aa');
  const oldCacheFile = path.join(shard, `${'a'.repeat(64)}.json`);
  const cachePort = await freePort();
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(oldCacheFile, '{"schema_version":1}\n');
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(cachePort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      CACHE_DIR: oldCache,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(cachePort);
    assert(fs.existsSync(path.join(oldCache, '.bridgebrain-cache')), 'legacy cache marker was not created');
    assertMode(oldCache, 0o700, `legacy cache dir; stderr=${stderr}`);
    assertMode(oldCacheFile, 0o600, 'legacy cache file');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertRejectedUnmarkedNonCacheDir() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-non-cache-'));
  const badCache = path.join(temp, 'cache');
  const cachePort = await freePort();
  fs.mkdirSync(badCache, { recursive: true });
  fs.writeFileSync(path.join(badCache, 'notes.txt'), 'not a bridgebrain cache\n');
  fs.chmodSync(badCache, 0o755);
  const beforeMode = fs.statSync(badCache).mode & 0o777;
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(cachePort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      CACHE_DIR: badCache,
    },
  });
  try {
    const { code, stderr } = await waitForClose(child);
    assert(code !== null && code !== 0, 'unmarked non-cache dir should fail before serving');
    assert(stderr.includes('CACHE_DIR contains entries outside the BridgeBrain cache format'), `non-cache dir error missing; stderr=${stderr}`);
    assertMode(badCache, beforeMode, 'rejected non-cache dir mode');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertMarkedExistingCacheHardened() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-marked-cache-'));
  const oldCache = path.join(temp, 'cache');
  const shard = path.join(oldCache, 'aa');
  const oldCacheFile = path.join(shard, `${'a'.repeat(64)}.json`);
  const cachePort = await freePort();
  fs.mkdirSync(shard, { recursive: true, mode: 0o777 });
  fs.writeFileSync(path.join(oldCache, '.bridgebrain-cache'), 'BridgeBrain cache directory\n');
  fs.writeFileSync(oldCacheFile, '{"schema_version":1}\n');
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(cachePort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      CACHE_DIR: oldCache,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(cachePort);
    assertMode(oldCache, 0o700, `marked cache dir; stderr=${stderr}`);
    assertMode(oldCacheFile, 0o600, 'marked old cache file');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function waitForClose(child, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on('close', (value) => {
      clearTimeout(timer);
      resolve({ code: value, stdout, stderr });
    });
  });
}

async function assertWaitForCloseDrainsStderr() {
  const child = spawn(process.execPath, [
    '-e',
    "process.stderr.write('x'.repeat(256 * 1024), () => process.stderr.write('DRAINED_STDERR_SENTINEL', () => process.exit(7)));",
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const { code, stderr } = await waitForClose(child);
  assert(code === 7, `waitForClose observed wrong code: ${code}`);
  assert(stderr.includes('DRAINED_STDERR_SENTINEL'), 'waitForClose missed drained stderr sentinel');
}

async function assertRejectedCacheSymlink() {
  if (process.platform === 'win32') return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-bad-cache-'));
  const badCache = path.join(temp, 'cache');
  const shard = path.join(badCache, 'aa');
  const badPort = await freePort();
  fs.mkdirSync(shard, { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(shard, `${'b'.repeat(64)}.json`));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(badPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      CACHE_DIR: badCache,
    },
  });
  try {
    const { code, stderr } = await waitForClose(child);
    assert(code !== null && code !== 0, 'symlinked cache payload should fail before serving');
    assert(
      stderr.includes('CACHE_DIR contains entries outside the BridgeBrain cache format') ||
        stderr.includes('CACHE_DIR contains non-cache entry'),
      'symlinked cache error missing',
    );
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertRejectedCacheMarkerSymlink() {
  if (process.platform === 'win32') return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-bad-marker-'));
  const badCache = path.join(temp, 'cache');
  const badPort = await freePort();
  fs.mkdirSync(badCache, { recursive: true });
  fs.symlinkSync(path.join(temp, 'missing-marker-target'), path.join(badCache, '.bridgebrain-cache'));
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(badPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      CACHE_DIR: badCache,
    },
  });
  try {
    const { code, stderr } = await waitForClose(child);
    assert(code !== null && code !== 0, 'symlinked cache marker should fail before serving');
    assert(stderr.includes('CACHE_DIR marker must be a regular file'), 'symlinked cache marker error missing');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function assertBridgeChildEnvScrubbed() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-clean-bridge-'));
  const bridge = path.join(temp, 'bridge.js');
  const childCache = path.join(temp, 'cache');
  const childPort = await freePort();
  fs.writeFileSync(
    bridge,
    [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      'fs.readFileSync(0, "utf8");',
      'const leaked = Boolean(process.env.BRIDGEBRAIN_API_TOKEN || process.env.GBRAIN_CHATGPT_EMBED_TOKEN);',
      'const summary = leaked ? "leaked" : "clean";',
      'console.log(JSON.stringify({ items: [{ id: 0, signature: { summary, entities: [], topics: [], actions: [], constraints: [], synonyms: [], queries: [] } }] }));',
    ].join('\n'),
    { mode: 0o755 },
  );
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(childPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'quality',
      BRIDGEBRAIN_API_TOKEN: apiToken,
      BRIDGEBRAIN_ALLOW_PATH_TOKEN: '1',
      BRIDGE_SCRIPT: bridge,
      CACHE_DIR: childCache,
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await waitForHealth(childPort);
    const result = await request(
      'POST',
      embeddingsPath,
      { model: 'chatgpt-bridge-semantic-hash-1536', input: 'bridge child env scrub smoke' },
      {},
      childPort,
    );
    assert(result.status === 200, `bridge child env scrub status ${result.status}; stderr=${stderr}`);
    const cacheFile = firstCacheFile(childCache);
    assert(cacheFile, 'bridge child env scrub cache file missing');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert(cached.signature.summary === 'clean', `bridge child saw service token: ${cached.signature.summary}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  if (!port) port = await freePort();
  assertFallbackSignatureTokenClassification();
  assertCachePermissionHardeningSource();
  await assertWaitForCloseDrainsStderr();
  await assertInvalidStartupDimensions();
  await assertInvalidStartupLimit();
  await assertMalformedBridgeFailsClosed();
  await assertEarlyExitBridgeDoesNotCrashServer();
  await assertMigratesUnmarkedLegacyCache();
  await assertRejectedUnmarkedNonCacheDir();
  await assertMarkedExistingCacheHardened();
  await assertRejectedCacheSymlink();
  await assertRejectedCacheMarkerSymlink();
  await assertBridgeChildEnvScrubbed();

	  const child = spawn(process.execPath, [serverPath], {
	    cwd: root,
	    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(port),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      GBRAIN_CHATGPT_EMBED_MODEL: 'chatgpt-bridge-semantic-hash-1536',
      GBRAIN_CHATGPT_EMBED_DIMENSIONS: '1536',
      BRIDGEBRAIN_API_TOKEN: apiToken,
      BRIDGEBRAIN_ALLOW_PATH_TOKEN: '1',
      BRIDGE_BATCH_CHAR_BUDGET: '900',
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

    const unauthenticated = await request('POST', '/v1/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain unauthenticated request test'],
    });
    assert(unauthenticated.status === 401, `unauthenticated embedding status ${unauthenticated.status}`);

    const wrongToken = await request('POST', '/v1/t/bad/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain wrong token request test'],
    });
    assert(wrongToken.status === 401, `wrong token embedding status ${wrongToken.status}`);

    const malformedPathToken = await request('POST', '/v1/t/%E0/embeddings', {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain malformed path token test'],
    });
    assert(malformedPathToken.status === 400, `malformed token path status ${malformedPathToken.status}`);
    assert(
      malformedPathToken.json.error.type === 'invalid_request_error',
      `malformed token path error type ${malformedPathToken.json.error.type}`,
    );

    const first = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain adapter smoke test with semantic retrieval'],
    });
    assert(first.status === 200, `first embedding status ${first.status}`);
    assert(first.json.data[0].embedding.length === 1536, `expected 1536 dims, got ${first.json.data[0].embedding.length}`);
    assertMode(cacheDir, 0o700, 'cache dir');
    const cacheFile = firstCacheFile(cacheDir);
    assert(cacheFile, 'cache file missing');
    assertMode(path.dirname(cacheFile), 0o700, 'cache shard dir');
    assertMode(cacheFile, 0o600, 'cache file');

    const single = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: 'BridgeBrain single string input',
    });
    assert(single.status === 200, `single string embedding status ${single.status}`);
    assert(single.json.data[0].embedding.length === 1536, `expected 1536 dims, got ${single.json.data[0].embedding.length}`);

    const wrongContentType = await request(
      'POST',
      embeddingsPath,
      {
        model: 'chatgpt-bridge-semantic-hash-1536',
        input: 'BridgeBrain wrong content type test',
      },
      { 'content-type': 'text/plain' },
    );
    assert(wrongContentType.status === 415, `wrong content-type status ${wrongContentType.status}`);

    const badOrigin = await request(
      'POST',
      embeddingsPath,
      {
        model: 'chatgpt-bridge-semantic-hash-1536',
        input: 'BridgeBrain bad origin test',
      },
      { origin: 'https://example.com' },
    );
    assert(badOrigin.status === 403, `bad origin status ${badOrigin.status}`);

    const nullOrigin = await request(
      'POST',
      embeddingsPath,
      {
        model: 'chatgpt-bridge-semantic-hash-1536',
        input: 'BridgeBrain opaque origin test',
      },
      { origin: 'null' },
    );
    assert(nullOrigin.status === 403, `null origin status ${nullOrigin.status}`);

    const malformedJson = await rawRequest('POST', embeddingsPath, '{"model":');
    assert(malformedJson.status === 400, `malformed JSON status ${malformedJson.status}`);
    assert(
      malformedJson.json.error.type === 'invalid_request_error',
      `malformed JSON error type ${malformedJson.json.error.type}`,
    );

    const explicitDefault = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: 'BridgeBrain explicit default dimensions',
      dimensions: 1536,
    });
    assert(explicitDefault.status === 200, `explicit default embedding status ${explicitDefault.status}`);
    assert(
      explicitDefault.json.data[0].embedding.length === 1536,
      `expected 1536 dims, got ${explicitDefault.json.data[0].embedding.length}`,
    );

    const tokenArray = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: [1, 2, 3],
    });
    assert(tokenArray.status === 400, `token array embedding status ${tokenArray.status}`);

    const tokenArrayBatch = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: [[1, 2, 3]],
    });
    assert(tokenArrayBatch.status === 400, `token array batch embedding status ${tokenArrayBatch.status}`);

    const tooLong = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: 'x'.repeat(6001),
    });
    assert(tooLong.status === 413, `too-long input status ${tooLong.status}`);
    assert(
      tooLong.json.error.type === 'request_entity_too_large',
      `too-long input error type ${tooLong.json.error.type}`,
    );

    const tooManyInputs = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: Array.from({ length: 2049 }, (_, index) => `item ${index}`),
    });
    assert(tooManyInputs.status === 413, `too-many-inputs status ${tooManyInputs.status}`);

    const tooMuchTotalText = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: Array.from({ length: 80 }, () => 'y'.repeat(3000)),
    });
    assert(tooMuchTotalText.status === 413, `too-much-total-text status ${tooMuchTotalText.status}`);

    const compat = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-768',
      input: ['BridgeBrain adapter compatibility smoke test'],
      dimensions: 768,
    });
    assert(compat.status === 200, `compat embedding status ${compat.status}`);
    assert(compat.json.data[0].embedding.length === 768, `expected 768 dims, got ${compat.json.data[0].embedding.length}`);

    const conflictingDimensions = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['BridgeBrain conflicting dimensions smoke test'],
      dimensions: 768,
    });
    assert(conflictingDimensions.status === 400, `conflicting dimensions status ${conflictingDimensions.status}`);

    const unicode = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: ['東京 猫 ramen search', 'Москва кошка borscht search'],
    });
    assert(unicode.status === 200, `unicode embedding status ${unicode.status}`);
    assert(
      JSON.stringify(unicode.json.data[0].embedding) !== JSON.stringify(unicode.json.data[1].embedding),
      'unicode embeddings collapsed to identical vectors',
    );

    const beforeChunkStats = await request('GET', '/stats');
    const chunked = await request('POST', embeddingsPath, {
      model: 'chatgpt-bridge-semantic-hash-1536',
      input: [
        `BridgeBrain chunk split smoke one ${'alpha '.repeat(140)}`,
        `BridgeBrain chunk split smoke two ${'bravo '.repeat(140)}`,
        `BridgeBrain chunk split smoke three ${'charlie '.repeat(140)}`,
      ],
    });
    assert(chunked.status === 200, `chunked embedding status ${chunked.status}`);
    assert(chunked.json.data.length === 3, `expected 3 chunked embeddings, got ${chunked.json.data.length}`);
    assert(chunked.json.data.every((row) => row.embedding.length === 1536), 'chunked embedding dimensions wrong');
    const afterChunkStats = await request('GET', '/stats');
    assert(
      afterChunkStats.json.bridge_calls - beforeChunkStats.json.bridge_calls >= 3,
      'chunked request did not split into multiple bridge calls',
    );

    for (const dimensions of [1024, 4096, 0, -1, 'NaN', 100_000_000]) {
      const invalidDimensions = await request('POST', embeddingsPath, {
        model: 'chatgpt-bridge-semantic-hash-1536',
        input: ['BridgeBrain rejected dimensions smoke test'],
        dimensions,
      });
      assert(
        invalidDimensions.status === 400,
        `invalid dimensions ${dimensions} status ${invalidDimensions.status}`,
      );
    }

    const beforeStats = await request('GET', '/stats');
    const repeat = await request('POST', embeddingsPath, {
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
