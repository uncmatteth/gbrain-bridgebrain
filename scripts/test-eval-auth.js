#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function redact(text) {
  return String(text || '')
    .replace(/\/v1\/t\/[^/\s"'`]+/g, '/v1/t/<redacted>')
    .replace(/\/t\/[^/\s"'`]+/g, '/t/<redacted>')
    .replace(/hangtok|evaltok/g, '<redacted>');
}

function hasSecret(text) {
  return /hangtok|evaltok|(?:\/v1)?\/t\/(?!<redacted>)[^/\s"'`]+/.test(String(text || ''));
}

function getJson(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(reject, new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            finish(resolve, JSON.parse(body));
          } catch (error) {
            finish(reject, error);
          }
        });
      })
      .on('error', (error) => finish(reject, error));
    timer = setTimeout(() => {
      req.destroy(new Error('HTTP request timed out'));
    }, timeoutMs);
  });
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      stderr += `\nprocess timed out after ${options.timeoutMs || 30_000}ms`;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ status: null, signal: 'SIGKILL', stdout, stderr });
      }, 1000);
    }, options.timeoutMs || 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      finish({ status, signal, stdout, stderr });
    });
  });
}

function cleanEvalEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BRIDGEBRAIN_EVAL_')) delete env[key];
  }
  delete env.BRIDGEBRAIN_API_TOKEN;
  delete env.GBRAIN_CHATGPT_EMBED_TOKEN;
  return { ...env, ...extra };
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
  for (const [name, extraEnv, expected] of [
    ['bad recall', { BRIDGEBRAIN_EVAL_MIN_RECALL: 'bogus' }, 'BRIDGEBRAIN_EVAL_MIN_RECALL'],
    ['bad top k', { BRIDGEBRAIN_EVAL_TOP_K: '0' }, 'BRIDGEBRAIN_EVAL_TOP_K'],
    ['bad timeout', { BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS: '20' }, 'BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS'],
  ]) {
    const badConfig = spawnSync(process.execPath, [path.join(root, 'scripts', 'eval.js')], {
      cwd: root,
      env: cleanEvalEnv(extraEnv),
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (badConfig.status === 0) fail(`eval accepted invalid config: ${name}`);
    if (!badConfig.stderr.includes(expected)) {
      fail(`eval invalid config error missing ${expected}: ${badConfig.stderr}`);
    }
  }

  const fixtureTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-fixture-'));
  try {
    const corpusFile = path.join(fixtureTemp, 'corpus.json');
    const queryFile = path.join(fixtureTemp, 'queries.json');
    fs.writeFileSync(corpusFile, JSON.stringify([{ id: 'doc', text: 'one document' }]));
    fs.writeFileSync(queryFile, JSON.stringify([]));
    const badFixture = spawnSync(process.execPath, [path.join(root, 'scripts', 'eval.js')], {
      cwd: root,
      env: {
        ...cleanEvalEnv(),
        BRIDGEBRAIN_EVAL_CORPUS: corpusFile,
        BRIDGEBRAIN_EVAL_QUERY_SET: queryFile,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (badFixture.status === 0) fail('eval accepted an empty query set');
    if (!badFixture.stderr.includes('eval query set')) {
      fail(`eval empty-query error missing fixture message: ${badFixture.stderr}`);
    }
  } finally {
    fs.rmSync(fixtureTemp, { recursive: true, force: true });
  }

  const fractionalTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-fractional-'));
  try {
    const corpusFile = path.join(fractionalTemp, 'corpus.json');
    const queryFile = path.join(fractionalTemp, 'queries.json');
    fs.writeFileSync(corpusFile, JSON.stringify([
      { id: 'doc-a', text: 'alpha project notes' },
      { id: 'doc-b', text: 'beta project notes' },
      { id: 'doc-c', text: 'gamma project notes' },
    ]));
    fs.writeFileSync(queryFile, JSON.stringify([
      { id: 'all-docs', query: 'project notes', relevant: ['doc-a', 'doc-b', 'doc-c'] },
    ]));
    const fractionalPort = await freePort();
    const fractionalEval = await runNode([path.join(root, 'scripts', 'eval.js')], {
      env: cleanEvalEnv({
        BRIDGEBRAIN_EVAL_CORPUS: corpusFile,
        BRIDGEBRAIN_EVAL_QUERY_SET: queryFile,
        BRIDGEBRAIN_EVAL_TOP_K: '2',
        BRIDGEBRAIN_EVAL_MIN_RECALL: '0.66668',
        BRIDGEBRAIN_EVAL_PORT: String(fractionalPort),
      }),
      timeoutMs: 30_000,
    });
    if (fractionalEval.status === 0) fail('eval accepted fractional recall below raw threshold');
    if (!fractionalEval.stderr.includes('below minimum')) {
      fail(`fractional recall gate error missing threshold message: ${redact(fractionalEval.stderr)}`);
    }
    const fractionalSummary = JSON.parse(fractionalEval.stdout);
    if (fractionalSummary.recall_at_k !== 0.6667) {
      fail(`fractional recall summary should stay rounded for output: ${fractionalSummary.recall_at_k}`);
    }
  } finally {
    fs.rmSync(fractionalTemp, { recursive: true, force: true });
  }

  const inheritedProfilePort = await freePort();
  const inheritedProfileEval = await runNode([path.join(root, 'scripts', 'eval.js')], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_EVAL_PORT: String(inheritedProfilePort),
      BRIDGEBRAIN_PROFILE: 'quality',
      GBRAIN_CHATGPT_EMBED_PROFILE: 'quality',
      GBRAIN_CHATGPT_EMBED_MODE: 'quality',
      BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
      GPT_WEB_LOGIN_CODEX_BIN: 'definitely-not-codex-for-mock-eval',
      BRIDGE_TIMEOUT_MS: '1000',
    }),
    timeoutMs: 30_000,
  });
  if (inheritedProfileEval.status !== 0) {
    fail(`mock eval inherited live profile\nstdout:\n${redact(inheritedProfileEval.stdout)}\nstderr:\n${redact(inheritedProfileEval.stderr)}`);
  }
  const inheritedProfileSummary = JSON.parse(inheritedProfileEval.stdout);
  if (inheritedProfileSummary.mode !== 'mock') {
    fail(`mock eval reported wrong mode after inherited profile: ${inheritedProfileSummary.mode}`);
  }

  const hangingPort = await freePort();
  const hangingServer = http.createServer((req, res) => {
    if (req.url.includes('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"never":"ends"');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => hangingServer.listen(hangingPort, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    const hungEval = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
      env: cleanEvalEnv({
        BRIDGEBRAIN_EVAL_BASE_URL: `http://127.0.0.1:${hangingPort}/v1/t/hangtok`,
        BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS: '250',
      }),
      timeoutMs: 10_000,
    });
    if (hungEval.status === 0) fail('eval accepted a hanging embeddings response');
    if (hasSecret(`${hungEval.stdout}${hungEval.stderr}`)) fail('eval timeout leaked tokenized base URL');
    if (!hungEval.stderr.includes('timed out')) fail(`eval timeout error missing timeout message: ${redact(hungEval.stderr)}`);
    if (Date.now() - started > 5000) fail('eval timeout took too long');
  } finally {
    await new Promise((resolve) => hangingServer.close(resolve));
  }

  const malformedPort = await freePort();
  const malformedServer = http.createServer((req, res) => {
    if (req.url.includes('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"embedding":["not-a-number"]}]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => malformedServer.listen(malformedPort, '127.0.0.1', resolve));
  try {
    const malformedEval = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
      env: cleanEvalEnv({
        BRIDGEBRAIN_EVAL_BASE_URL: `http://127.0.0.1:${malformedPort}/v1`,
        BRIDGEBRAIN_EVAL_REQUEST_TIMEOUT_MS: '1000',
      }),
      timeoutMs: 10_000,
    });
    if (malformedEval.status === 0) fail('eval accepted malformed embedding response');
    if (!malformedEval.stderr.includes('invalid embedding')) {
      fail(`malformed embedding error missing validation message: ${redact(malformedEval.stderr)}`);
    }
  } finally {
    await new Promise((resolve) => malformedServer.close(resolve));
  }

  const remoteHttpBaseUrl = ['http://user:evaltok', 'example.invalid/v1/t/evaltok?api_key=evaltok'].join('@');
  const remoteHttp = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_API_TOKEN: 'evaltok',
      BRIDGEBRAIN_EVAL_ALLOW_REMOTE: '1',
      BRIDGEBRAIN_EVAL_BASE_URL: remoteHttpBaseUrl,
    }),
    timeoutMs: 10_000,
  });
  if (remoteHttp.status === 0) fail('eval allowed remote HTTP URL with Authorization token');
  if (!remoteHttp.stderr.includes('remote eval URLs must use https')) {
    fail(`remote HTTP auth error missing https message: ${redact(remoteHttp.stderr)}`);
  }
  if (hasSecret(`${remoteHttp.stdout}${remoteHttp.stderr}`)) fail('remote HTTP auth failure leaked tokenized URL');

  const remotePathTokenOnly = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_EVAL_ALLOW_REMOTE: '1',
      BRIDGEBRAIN_EVAL_BASE_URL: 'http://example.invalid/v1/t/evaltok',
    }),
    timeoutMs: 10_000,
  });
  if (remotePathTokenOnly.status === 0) fail('eval allowed remote HTTP URL with tokenized path credential');
  if (!remotePathTokenOnly.stderr.includes('remote eval URLs must use https')) {
    fail(`remote HTTP path-token error missing https message: ${redact(remotePathTokenOnly.stderr)}`);
  }
  if (hasSecret(`${remotePathTokenOnly.stdout}${remotePathTokenOnly.stderr}`)) {
    fail('remote HTTP path-token failure leaked tokenized URL');
  }

  const remoteShortPathTokenOnly = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_EVAL_ALLOW_REMOTE: '1',
      BRIDGEBRAIN_EVAL_BASE_URL: 'http://example.invalid/t/evaltok',
    }),
    timeoutMs: 10_000,
  });
  if (remoteShortPathTokenOnly.status === 0) fail('eval allowed remote HTTP URL with short tokenized path credential');
  if (!remoteShortPathTokenOnly.stderr.includes('remote eval URLs must use https')) {
    fail(`remote HTTP short-token error missing https message: ${redact(remoteShortPathTokenOnly.stderr)}`);
  }
  if (hasSecret(`${remoteShortPathTokenOnly.stdout}${remoteShortPathTokenOnly.stderr}`)) {
    fail('remote HTTP short-token failure leaked tokenized URL');
  }

  const remoteQueryCredential = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_EVAL_ALLOW_REMOTE: '1',
      BRIDGEBRAIN_EVAL_BASE_URL: 'http://example.invalid/v1?api_key=evaltok',
    }),
    timeoutMs: 10_000,
  });
  if (remoteQueryCredential.status === 0) fail('eval allowed remote HTTP URL with query credential');
  if (!remoteQueryCredential.stderr.includes('remote eval URLs must use https')) {
    fail(`remote HTTP query-credential error missing https message: ${redact(remoteQueryCredential.stderr)}`);
  }
  if (hasSecret(`${remoteQueryCredential.stdout}${remoteQueryCredential.stderr}`)) {
    fail('remote HTTP query-credential failure leaked tokenized URL');
  }

  const malformedTokenUrl = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_EVAL_BASE_URL: 'http://127.0.0.1:bad/v1/t/evaltok',
    }),
    timeoutMs: 10_000,
  });
  if (malformedTokenUrl.status === 0) fail('eval accepted malformed tokenized base URL');
  if (!malformedTokenUrl.stderr.includes('eval base URL must be valid')) {
    fail(`malformed tokenized URL error missing validation message: ${redact(malformedTokenUrl.stderr)}`);
  }
  if (hasSecret(`${malformedTokenUrl.stdout}${malformedTokenUrl.stderr}`)) {
    fail('malformed tokenized URL failure leaked tokenized URL');
  }

  const mockPort = await freePort();
  const mockEval = await runNode([path.join(root, 'scripts', 'eval.js')], {
    env: cleanEvalEnv({
      BRIDGEBRAIN_API_TOKEN: 'evaltok',
      BRIDGEBRAIN_EVAL_BASE_URL: remoteHttpBaseUrl,
      BRIDGEBRAIN_EVAL_PORT: String(mockPort),
      GBRAIN_CHATGPT_EMBED_HOST: '203.0.113.1',
    }),
    timeoutMs: 30_000,
  });
  if (mockEval.status !== 0) {
    fail(`mock eval with ambient auth failed\nstdout:\n${redact(mockEval.stdout)}\nstderr:\n${redact(mockEval.stderr)}`);
  }
  if (hasSecret(`${mockEval.stdout}${mockEval.stderr}`)) fail('mock eval leaked ambient token/base URL');
  const mockSummary = JSON.parse(mockEval.stdout);
  if (mockSummary.mode !== 'mock') fail(`expected mock eval mode, got ${mockSummary.mode}`);
  if (mockSummary.base_url !== `http://127.0.0.1:${mockPort}/v1`) {
    fail(`mock eval did not ignore ambient base URL: ${mockSummary.base_url}`);
  }

  const bearerPort = await freePort();
  const bearerCache = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-bearer-cache-'));
  const bearerGbrainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-bearer-gbrain-'));
  const bearerChild = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(bearerPort),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      BRIDGEBRAIN_API_TOKEN: 'evaltok',
      CACHE_DIR: bearerCache,
    },
  });
  let bearerStderr = '';
  bearerChild.stderr.on('data', (chunk) => {
    bearerStderr += chunk;
  });
  try {
    await waitForHealth(bearerPort);
    const bearerEval = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
      env: cleanEvalEnv({
        GBRAIN_HOME: bearerGbrainHome,
        BRIDGEBRAIN_API_TOKEN: 'evaltok',
        BRIDGEBRAIN_EVAL_PORT: String(bearerPort),
      }),
      timeoutMs: 30_000,
    });
    if (hasSecret(`${bearerEval.stdout}${bearerEval.stderr}${bearerStderr}`)) {
      fail('live eval bearer fallback leaked token');
    }
    if (bearerEval.status !== 0) {
      fail(`live eval bearer fallback failed\nstdout:\n${redact(bearerEval.stdout)}\nstderr:\n${redact(bearerEval.stderr)}\nserver stderr:\n${redact(bearerStderr)}`);
    }
    const bearerSummary = JSON.parse(bearerEval.stdout);
    if (bearerSummary.base_url !== `http://127.0.0.1:${bearerPort}/v1`) {
      fail(`live eval bearer fallback used wrong base URL: ${bearerSummary.base_url}`);
    }
  } finally {
    await stopChild(bearerChild);
    fs.rmSync(bearerCache, { recursive: true, force: true });
    fs.rmSync(bearerGbrainHome, { recursive: true, force: true });
  }

  let ipv6Port = null;
  try {
    ipv6Port = await freePort('::1');
  } catch {
    ipv6Port = null;
  }
  if (ipv6Port) {
    const ipv6Cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-ipv6-cache-'));
    const ipv6GbrainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-ipv6-gbrain-'));
    const ipv6Child = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        GBRAIN_CHATGPT_EMBED_HOST: '::1',
        GBRAIN_CHATGPT_EMBED_PORT: String(ipv6Port),
        GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
        BRIDGEBRAIN_ALLOW_UNAUTHENTICATED: '1',
        CACHE_DIR: ipv6Cache,
      },
    });
    let ipv6Stderr = '';
    ipv6Child.stderr.on('data', (chunk) => {
      ipv6Stderr += chunk;
    });
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          const health = await getJson(`http://[::1]:${ipv6Port}/health`);
          if (health.ok) break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        break;
      }
      const ipv6Eval = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
        env: cleanEvalEnv({
          GBRAIN_HOME: ipv6GbrainHome,
          BRIDGEBRAIN_EVAL_BASE_URL: `http://[::1]:${ipv6Port}/v1`,
        }),
        timeoutMs: 30_000,
      });
      if (ipv6Eval.status !== 0) {
        fail(`live eval IPv6 loopback failed\nstdout:\n${redact(ipv6Eval.stdout)}\nstderr:\n${redact(ipv6Eval.stderr)}\nserver stderr:\n${redact(ipv6Stderr)}`);
      }
      const ipv6Summary = JSON.parse(ipv6Eval.stdout);
      if (ipv6Summary.base_url !== `http://[::1]:${ipv6Port}/v1`) {
        fail(`live eval IPv6 loopback used wrong base URL: ${ipv6Summary.base_url}`);
      }
    } finally {
      await stopChild(ipv6Child);
      fs.rmSync(ipv6Cache, { recursive: true, force: true });
      fs.rmSync(ipv6GbrainHome, { recursive: true, force: true });
    }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgebrain-eval-auth-'));
  const port = await freePort();
  const token = 'evaltok';
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
      embedding_model: 'litellm:chatgpt-bridge-semantic-hash-768',
      embedding_dimensions: 768,
    }),
  );

  const child = spawn(process.execPath, [path.join(root, 'src', 'gbrain-chatgpt-embeddings-server.js')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GBRAIN_CHATGPT_EMBED_PORT: String(port),
      GBRAIN_CHATGPT_EMBED_PROFILE: 'mock',
      GBRAIN_CHATGPT_EMBED_MODEL: 'chatgpt-bridge-semantic-hash-768',
      GBRAIN_CHATGPT_EMBED_DIMENSIONS: '768',
      BRIDGEBRAIN_API_TOKEN: token,
      BRIDGEBRAIN_ALLOW_PATH_TOKEN: '1',
      CACHE_DIR: cacheDir,
    },
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    await waitForHealth(port);
    const env = cleanEvalEnv({ GBRAIN_HOME: gbrainHome });
    const result = await runNode([path.join(root, 'scripts', 'eval.js'), '--live'], {
      env,
      timeoutMs: 30_000,
    });
    if (hasSecret(`${result.stdout}${result.stderr}${stderr}`)) fail('live eval auth smoke leaked tokenized output');
    if (result.status !== 0) {
      fail(`live eval auth smoke failed\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}\nserver stderr:\n${redact(stderr)}`);
    }
    const summary = JSON.parse(result.stdout);
    if (summary.mode !== 'live') fail(`expected live eval mode, got ${summary.mode}`);
    if (summary.base_url !== `http://127.0.0.1:${port}/v1/t/<redacted>`) {
      fail(`eval output did not redact tokenized base URL: ${summary.base_url}`);
    }
    if (summary.eval_model !== 'chatgpt-bridge-semantic-hash-768') {
      fail(`eval did not use installed compat model: ${summary.eval_model}`);
    }
    if (summary.eval_dimensions !== 768) {
      fail(`eval did not use installed compat dimensions: ${summary.eval_dimensions}`);
    }
    if (summary.hit_rate_at_k !== 1) fail(`unexpected hit_rate_at_k: ${summary.hit_rate_at_k}`);
    if (summary.recall_at_k !== 1) fail(`unexpected recall_at_k: ${summary.recall_at_k}`);
    console.log('live eval auth smoke passed');
  } finally {
    await stopChild(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(redact(error.message));
  process.exit(1);
});
