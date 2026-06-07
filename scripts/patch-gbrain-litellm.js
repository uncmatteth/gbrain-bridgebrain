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

function walkForGatewayFiles(root, files) {
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
        normalized.endsWith('/gbrain/src/core/ai/gateway.ts') ||
        (normalized.includes('garrytan-gbrain') && normalized.endsWith('/src/core/ai/gateway.ts'))
      ) {
        files.add(full);
      }
    }
  }
}

function candidateGatewayFiles() {
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
  walkForGatewayFiles(path.join(home, '.bun', 'install', 'cache'), files);

  return [...files].map(realpathMaybe).filter((file, index, all) => file && all.indexOf(file) === index && fs.existsSync(file));
}

function patchFile(file) {
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

  const backup = `${file}.bridgebrain.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, original.replace(before, after));
  return 'patched';
}

const files = candidateGatewayFiles();
if (files.length === 0) {
  console.error('Could not find installed gbrain gateway.ts. Set GBRAIN_GATEWAY_TS to the installed gateway.ts path if your install layout changed.');
  process.exit(1);
}

let patched = 0;
let ok = 0;
let failed = 0;
for (const file of files) {
  const status = patchFile(file);
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
  console.error('At least one gateway.ts did not match the expected patch pattern. Review the files above before continuing.');
  process.exit(1);
}

console.log(`BridgeBrain GBrain LiteLLM patch ready (${patched} patched, ${ok - patched} already patched).`);
