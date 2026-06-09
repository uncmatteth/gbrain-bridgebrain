#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  if (result.status !== 0) return '';
  return (result.stdout || '').trim();
}

function commandPath(name) {
  if (process.platform === 'win32') {
    return run('where.exe', [name]).split(/\r?\n/).find(Boolean) || '';
  }
  return run('sh', ['-lc', `command -v ${name}`]);
}

function gbrainBinaryCandidates() {
  const candidates = [];
  if (process.env.GBRAIN_BIN) candidates.push(process.env.GBRAIN_BIN.trim());
  candidates.push(commandPath('gbrain'));
  return candidates.filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function realpathMaybe(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function walkForGbrainFiles(root, files, suffix) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full.length - root.length < 260) stack.push(full);
        continue;
      }
      const normalized = full.replace(/\\/g, '/');
      if (
        normalized.endsWith(`/gbrain/${suffix}`) ||
        (normalized.includes('garrytan-gbrain') && normalized.endsWith(`/${suffix}`))
      ) {
        files.add(full);
      }
    }
  }
}

function walkForGatewayFiles(root, files) {
  walkForGbrainFiles(root, files, 'src/core/ai/gateway.ts');
}

function walkForEmbeddingDimCheckFiles(root, files) {
  walkForGbrainFiles(root, files, 'src/core/embedding-dim-check.ts');
}

function activeGatewayFiles() {
  const files = new Set();
  const explicit = process.env.GBRAIN_GATEWAY_TS;
  if (explicit) files.add(explicit);

  for (const gbrainPath of gbrainBinaryCandidates()) {
    const resolved = realpathMaybe(gbrainPath);
    const normalized = resolved.replace(/\\/g, '/');
    if (normalized.endsWith('/src/cli.ts')) {
      files.add(path.join(path.dirname(resolved), 'core', 'ai', 'gateway.ts'));
    }
    const nodeModuleGuess = normalized.replace(/\/bin\/gbrain(?:\.cmd)?$/, '/node_modules/gbrain/src/core/ai/gateway.ts');
    if (nodeModuleGuess !== normalized) files.add(nodeModuleGuess);
  }

  const home = os.homedir();
  files.add(path.join(home, '.bun', 'install', 'global', 'node_modules', 'gbrain', 'src', 'core', 'ai', 'gateway.ts'));

  return [...files].map(realpathMaybe).filter((file, index, all) => file && all.indexOf(file) === index && fs.existsSync(file));
}

function activeEmbeddingDimCheckFiles() {
  const files = new Set();
  const explicit = process.env.GBRAIN_EMBEDDING_DIM_CHECK_TS;
  if (explicit) files.add(explicit);

  for (const gbrainPath of gbrainBinaryCandidates()) {
    const resolved = realpathMaybe(gbrainPath);
    const normalized = resolved.replace(/\\/g, '/');
    if (normalized.endsWith('/src/cli.ts')) {
      files.add(path.join(path.dirname(resolved), 'core', 'embedding-dim-check.ts'));
    }
    const nodeModuleGuess = normalized.replace(/\/bin\/gbrain(?:\.cmd)?$/, '/node_modules/gbrain/src/core/embedding-dim-check.ts');
    if (nodeModuleGuess !== normalized) files.add(nodeModuleGuess);
  }

  const home = os.homedir();
  files.add(path.join(home, '.bun', 'install', 'global', 'node_modules', 'gbrain', 'src', 'core', 'embedding-dim-check.ts'));

  return [...files].map(realpathMaybe).filter((file, index, all) => file && all.indexOf(file) === index && fs.existsSync(file));
}

function cacheGatewayFiles(activeFiles) {
  const files = new Set();
  const active = new Set(activeFiles.map(realpathMaybe));
  const home = os.homedir();
  walkForGatewayFiles(path.join(home, '.bun', 'install', 'cache'), files);

  return [...files]
    .map(realpathMaybe)
    .filter((file, index, all) => file && all.indexOf(file) === index && fs.existsSync(file) && !active.has(file));
}

function cacheEmbeddingDimCheckFiles(activeFiles) {
  const files = new Set();
  const active = new Set(activeFiles.map(realpathMaybe));
  const home = os.homedir();
  walkForEmbeddingDimCheckFiles(path.join(home, '.bun', 'install', 'cache'), files);

  return [...files]
    .map(realpathMaybe)
    .filter((file, index, all) => file && all.indexOf(file) === index && fs.existsSync(file) && !active.has(file));
}

function backupFile(file) {
  const backup = `${file}.bridgebrain.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not available on every filesystem.
  }
}

function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // chmod may fail on some filesystems.
  }
  fsyncDir(dir);
}

function patchGatewayFile(file, opts = {}) {
  const original = fs.readFileSync(file, 'utf8');
  if (original.includes('recipes like litellm intentionally accept arbitrary model ids from config')) {
    return 'already_patched';
  }

  const before = `  // Openai-compat recipes with empty models list require a user-provided model.
  const isUserProvided = (tp as any).user_provided_models === true;
  if (
    Array.isArray(tp.models) &&
    tp.models.length === 0 &&
    (recipe.id === 'litellm' || isUserProvided)
  ) {`;

  const after = `  // Openai-compat recipes with empty models list require a user-provided model.
  // A parsed \`provider:model\` string already proves the model half is present;
  // recipes like litellm intentionally accept arbitrary model ids from config.
  const isUserProvided = (tp as any).user_provided_models === true;
  if (
    Array.isArray(tp.models) &&
    tp.models.length === 0 &&
    (recipe.id === 'litellm' || isUserProvided) &&
    !parsed.modelId
  ) {`;

  if (!original.includes(before)) {
    return 'pattern_not_found';
  }

  if (opts.checkOnly) return 'patchable';
  backupFile(file);
  writeFileAtomic(file, original.replace(before, after));
  return 'patched';
}

function patchEmbeddingDimCheckFile(file, opts = {}) {
  const original = fs.readFileSync(file, 'utf8');
  if (original.includes('BridgeBrain proxy recipes declare their own vector width')) {
    return 'already_patched';
  }

  const before = `  // Tier 1: recipe-declared dims_options.
  if (dimsOptions && dimsOptions.length > 0) {`;

  const after = `  // BridgeBrain proxy recipes declare their own vector width at install time.
  // LiteLLM/user-provided model ids do not have a fixed upstream default dim.
  if (
    recipe.touchpoints?.embedding?.default_dims === 0 &&
    (recipe.id === 'litellm' || (recipe.touchpoints?.embedding as any)?.user_provided_models === true)
  ) {
    return { valid: true, error: '' };
  }

  // Tier 1: recipe-declared dims_options.
  if (dimsOptions && dimsOptions.length > 0) {`;

  if (!original.includes(before)) {
    return 'pattern_not_found';
  }

  if (opts.checkOnly) return 'patchable';
  backupFile(file);
  writeFileAtomic(file, original.replace(before, after));
  return 'patched';
}

function patchCacheFile(file, patcher) {
  try {
    return patcher(file);
  } catch (error) {
    console.log(`cache_error: ${file}: ${error.message}`);
    return 'cache_error';
  }
}

function preflightActivePatchSet(label, files, patcher) {
  let ok = 0;
  const failed = [];
  for (const file of files) {
    const status = patcher(file, { checkOnly: true });
    if (status === 'patchable' || status === 'already_patched') ok += 1;
    if (status === 'pattern_not_found') failed.push(file);
  }
  if (ok === 0) {
    console.error(`No active ${label} files are patchable. Upstream GBrain may have changed; stop and inspect before continuing.`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`Active ${label} file(s) did not match the expected patch pattern: ${failed.join(', ')}`);
    process.exit(1);
  }
}

const activeFiles = activeGatewayFiles();
if (activeFiles.length === 0) {
  console.error('Could not find installed gbrain gateway.ts. Set GBRAIN_GATEWAY_TS to the installed gateway.ts path if your install layout changed.');
  process.exit(1);
}
const activeDimFiles = activeEmbeddingDimCheckFiles();
if (activeDimFiles.length === 0) {
  console.error('Could not find installed gbrain embedding-dim-check.ts. Set GBRAIN_EMBEDDING_DIM_CHECK_TS if your install layout changed.');
  process.exit(1);
}

preflightActivePatchSet('gateway.ts', activeFiles, patchGatewayFile);
preflightActivePatchSet('embedding-dim-check.ts', activeDimFiles, patchEmbeddingDimCheckFile);

let patched = 0;
let ok = 0;
let failed = 0;
for (const file of activeFiles) {
  const status = patchGatewayFile(file);
  console.log(`${status}: ${file}`);
  if (status === 'patched') patched += 1;
  if (status === 'patched' || status === 'already_patched') ok += 1;
  if (status === 'pattern_not_found') failed += 1;
}

if (ok === 0) {
  console.error('No gbrain gateway files were patched. Upstream GBrain may have changed; stop and inspect before continuing.');
  process.exit(1);
}

if (failed > 0) {
  console.error('The active gbrain gateway.ts did not match the expected patch pattern. Review the active install before continuing.');
  process.exit(1);
}

let cachePatched = 0;
let cacheOk = 0;
let cacheSkipped = 0;
for (const file of cacheGatewayFiles(activeFiles)) {
  const status = patchCacheFile(file, patchGatewayFile);
  console.log(`cache_${status}: ${file}`);
  if (status === 'patched') cachePatched += 1;
  if (status === 'patched' || status === 'already_patched') cacheOk += 1;
  if (status === 'pattern_not_found') cacheSkipped += 1;
}

console.log(
  `BridgeBrain GBrain LiteLLM patch ready (${patched} active patched, ${ok - patched} active already patched, ` +
    `${cachePatched} cache patched, ${cacheOk - cachePatched} cache already patched, ${cacheSkipped} cache skipped).`,
);

let dimPatched = 0;
let dimOk = 0;
let dimFailed = 0;
for (const file of activeDimFiles) {
  const status = patchEmbeddingDimCheckFile(file);
  console.log(`dim_${status}: ${file}`);
  if (status === 'patched') dimPatched += 1;
  if (status === 'patched' || status === 'already_patched') dimOk += 1;
  if (status === 'pattern_not_found') dimFailed += 1;
}

if (dimOk === 0) {
  console.error('No gbrain embedding dim-check files were patched. Upstream GBrain may have changed; stop and inspect before continuing.');
  process.exit(1);
}

if (dimFailed > 0) {
  console.error('The active gbrain embedding-dim-check.ts did not match the expected patch pattern. Review the active install before continuing.');
  process.exit(1);
}

let cacheDimPatched = 0;
let cacheDimOk = 0;
let cacheDimSkipped = 0;
for (const file of cacheEmbeddingDimCheckFiles(activeDimFiles)) {
  const status = patchCacheFile(file, patchEmbeddingDimCheckFile);
  console.log(`cache_dim_${status}: ${file}`);
  if (status === 'patched') cacheDimPatched += 1;
  if (status === 'patched' || status === 'already_patched') cacheDimOk += 1;
  if (status === 'pattern_not_found') cacheDimSkipped += 1;
}

console.log(
  `BridgeBrain GBrain dimension patch ready (${dimPatched} active patched, ${dimOk - dimPatched} active already patched, ` +
    `${cacheDimPatched} cache patched, ${cacheDimOk - cacheDimPatched} cache already patched, ${cacheDimSkipped} cache skipped).`,
);
