#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [file, model, dimsRaw, baseUrl] = process.argv.slice(2);

if (!file || !model || !dimsRaw || !baseUrl) {
  console.error('Usage: configure-gbrain.js <config.json> <model> <dimensions> <base-url>');
  process.exit(2);
}

const targetFile = path.resolve(file);
const targetDir = path.dirname(targetFile);
const targetDirExists = fs.existsSync(targetDir);

const dimensions = Number(dimsRaw);
if (!Number.isInteger(dimensions) || dimensions <= 0) {
  console.error(`Invalid embedding dimensions: ${dimsRaw}`);
  process.exit(2);
}
if (![1536, 768].includes(dimensions)) {
  console.error(`Unsupported embedding dimensions: ${dimsRaw}. Expected 1536 or 768.`);
  process.exit(2);
}
const suffix = String(model).match(/-(1536|768)$/);
if (suffix && Number(suffix[1]) !== dimensions) {
  console.error(`Model/dimensions mismatch: ${model} cannot be configured with ${dimensions} dimensions.`);
  process.exit(2);
}
assertLoopbackBaseUrl(baseUrl);

let cfg = {};
if (fs.existsSync(targetFile)) {
  try {
    cfg = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  } catch {
    console.error('GBrain config JSON must be valid JSON.');
    process.exit(2);
  }
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
  console.error('GBrain config JSON must be an object.');
  process.exit(2);
}
if (
  Object.prototype.hasOwnProperty.call(cfg, 'provider_base_urls') &&
  (!cfg.provider_base_urls || typeof cfg.provider_base_urls !== 'object' || Array.isArray(cfg.provider_base_urls))
) {
  console.error('GBrain provider_base_urls must be an object when present.');
  process.exit(2);
}
delete cfg.embedding_disabled;
cfg.embedding_model = `litellm:${model}`;
cfg.embedding_dimensions = dimensions;
cfg.provider_base_urls = { ...(cfg.provider_base_urls || {}), litellm: baseUrl };
fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
if (!targetDirExists) {
  protectPrivateDir(targetDir);
} else {
  assertPrivateDir(targetDir);
}
writeConfigAtomic(targetFile, cfg);
protectPrivateFile(targetFile);

function assertLoopbackBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    console.error(`Invalid provider base URL: ${error.message}`);
    process.exit(2);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    console.error('Provider base URL protocol must be http or https.');
    process.exit(2);
  }
  if (parsed.search) {
    console.error('Provider base URL query strings are not supported.');
    process.exit(2);
  }
  if (parsed.username || parsed.password) {
    console.error('Provider base URL credentials are not supported.');
    process.exit(2);
  }
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    console.error('Provider base URL must be loopback.');
    process.exit(2);
  }
}

function writeConfigAtomic(target, config) {
  const dir = path.dirname(target);
  const tmpDir = fs.mkdtempSync(path.join(dir, '.config-tmp-'));
  protectPrivateDir(tmpDir);
  const tmp = path.join(tmpDir, 'config.json');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    protectPrivateFile(tmp);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is not available everywhere.
  }
}

function protectPrivateDir(dir) {
  fs.chmodSync(dir, 0o700);
}

function protectPrivateFile(filePath) {
  fs.chmodSync(filePath, 0o600);
}

function assertPrivateDir(dir) {
  if (process.platform === 'win32') return;
  const stat = fs.statSync(dir);
  if ((stat.mode & 0o022) !== 0) {
    console.error(`GBrain config directory must not be group/world writable: ${dir}`);
    process.exit(2);
  }
}
