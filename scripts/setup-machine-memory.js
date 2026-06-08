#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DEPTH = 5;
const SOURCE_ID_PREFIX = 'mm';
const EXCLUDED_DISCOVERY_DIRS = new Set([
  '.cache',
  '.git',
  '.local',
  '.npm',
  '.pnpm-store',
  '.var',
  '.vscode',
  '__pycache__',
  'AppData',
  'Library',
  'build',
  'dist',
  'node_modules',
  'ops',
  'target',
  'vendor',
]);

function usage() {
  process.stdout.write(`BridgeBrain machine-memory setup.

Usage:
  node scripts/setup-machine-memory.js sync-once [options]
  node scripts/setup-machine-memory.js register [options]
  node scripts/setup-machine-memory.js candidates [options]

Options:
  --roots <paths>          Explicit path-list of roots to scan. Defaults to
                           GBRAIN_MACHINE_ROOTS only; no home/work defaults.
  --max-depth <n>          Discovery depth. Default: ${DEFAULT_MAX_DEPTH}.
  --no-register           Do not create missing GBrain sources.
  --no-sync               Register only; do not sync.
  --no-pull               Pass --no-pull to gbrain sync. Default on.
  --pull                  Allow gbrain sync to git pull.
  --no-embed              Pass --no-embed to gbrain sync.
  --terminate-serve <m>    Before sync: none or all. Default:
                           GBRAIN_MACHINE_TERMINATE_SERVE or none.
  --timeout-sec <n>        Per-source process timeout. Default: env or 600.
  --json                  Emit a final JSON summary.
  --dry-run               Print actions without mutating GBrain.

Environment:
  GBRAIN_BIN              gbrain executable path.
  GBRAIN_MACHINE_ROOTS    ${path.delimiter}-separated root list.
`);
}

function parseArgs(argv) {
  const opts = {
    command: 'sync-once',
    roots: null,
    maxDepth: DEFAULT_MAX_DEPTH,
    register: true,
    sync: true,
    noPull: true,
    noEmbed: false,
    terminateServe: process.env.GBRAIN_MACHINE_TERMINATE_SERVE || 'none',
    timeoutSec: Number(process.env.GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS || 600),
    json: false,
    dryRun: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) opts.command = args.shift();
  if (opts.command === 'register') opts.sync = false;
  if (opts.command === 'candidates') {
    opts.register = false;
    opts.sync = false;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      case '--roots':
        opts.roots = splitPathList(args[++i] || '');
        break;
      case '--max-depth':
        opts.maxDepth = positiveInt(args[++i], '--max-depth');
        break;
      case '--no-register':
        opts.register = false;
        break;
      case '--no-sync':
        opts.sync = false;
        break;
      case '--no-pull':
        opts.noPull = true;
        break;
      case '--pull':
        opts.noPull = false;
        break;
      case '--no-embed':
        opts.noEmbed = true;
        break;
      case '--terminate-serve':
        opts.terminateServe = args[++i] || '';
        break;
      case '--timeout-sec':
        opts.timeoutSec = positiveInt(args[++i], '--timeout-sec');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['sync-once', 'register', 'candidates'].includes(opts.command)) {
    throw new Error(`Unknown command: ${opts.command}`);
  }
  if (!['none', 'all'].includes(opts.terminateServe)) {
    throw new Error('--terminate-serve must be one of: none, all');
  }
  if (process.platform === 'win32' && opts.terminateServe !== 'none') {
    throw new Error('--terminate-serve=all is not supported on Windows; stop gbrain serve before scheduled sync or use none');
  }
  return opts;
}

function positiveInt(raw, name) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function splitPathList(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function defaultRoots() {
  return splitPathList(process.env.GBRAIN_MACHINE_ROOTS || '');
}

function log(message, opts) {
  if (!opts.json) process.stderr.write(`${message}\n`);
}

function normalizeKey(p) {
  const resolved = realpathSafe(p) || path.resolve(p);
  const normalized = resolved.replace(/[\\\/]+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasGitMarker(dir) {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

function shouldSkipEntry(name, dir) {
  if (name.startsWith('.')) return true;
  if (hasGitMarker(dir)) return false;
  if (EXCLUDED_DISCOVERY_DIRS.has(name)) return true;
  return false;
}

function discoverGitRepos(roots, maxDepth) {
  const repos = [];
  const seen = new Set();

  function addRepo(dir) {
    const key = normalizeKey(dir);
    if (seen.has(key)) return;
    seen.add(key);
    repos.push(realpathSafe(dir) || path.resolve(dir));
  }

  function walk(dir, depth) {
    if (!isDir(dir)) return;
    if (hasGitMarker(dir)) {
      addRepo(dir);
      return;
    }
    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const child = path.join(dir, entry.name);
        if (shouldSkipEntry(entry.name, child)) return;
        walk(child, depth + 1);
      });
  }

  roots.forEach((root) => walk(path.resolve(root), 0));
  return repos.sort((a, b) => a.localeCompare(b));
}

function sourceIdForRepo(repoPath) {
  const hash = crypto.createHash('sha256').update(normalizeKey(repoPath)).digest('hex').slice(0, 8);
  let slug = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'repo';
  const maxSlug = 32 - SOURCE_ID_PREFIX.length - 2 - hash.length;
  if (slug.length > maxSlug) slug = slug.slice(0, maxSlug).replace(/-+$/g, '');
  return `${SOURCE_ID_PREFIX}-${slug}-${hash}`;
}

function resolveSpawnCommand(command, args) {
  if (process.platform !== 'win32') return { command, args };

  const ext = path.extname(command).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')],
    };
  }
  if (ext === '.ps1') {
    return {
      command: process.env.POWERSHELL_BIN || process.env.PWSH_BIN || 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    };
  }
  return { command, args };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/[%"!]/.test(text)) {
    throw new Error('Windows cmd shim arguments must not contain %, !, or double quotes; use a .exe/.ps1 GBRAIN_BIN or rename the path');
  }
  return `"${text.replace(/([&|<>()^])/g, '^$1')}"`;
}

function run(command, args, opts = {}) {
  const resolved = resolveSpawnCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: opts.cwd || os.homedir(),
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_NO_BANNER: '1', ...(opts.env || {}) },
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  if (result.error) {
    const msg = result.error.code === 'ETIMEDOUT'
      ? `${command} ${args.join(' ')} timed out`
      : result.error.message;
    return { ...result, status: result.status ?? 1, stderr: `${result.stderr || ''}${msg}` };
  }
  return result;
}

function gbrain(args, opts = {}) {
  const bin = process.env.GBRAIN_BIN || 'gbrain';
  return run(bin, args, opts);
}

function requireOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function parseJsonObject(stdout, label) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error(`Could not parse ${label} JSON: ${err.message}`);
  }
}

function listSources() {
  const result = gbrain(['sources', 'list', '--json'], { timeoutMs: 60_000 });
  requireOk(result, 'gbrain sources list');
  const parsed = parseJsonObject(result.stdout, 'gbrain sources list');
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

function listArchivedSources() {
  const result = gbrain(['sources', 'archived', '--json'], { timeoutMs: 60_000 });
  requireOk(result, 'gbrain sources archived');
  const parsed = parseJsonObject(result.stdout, 'gbrain sources archived');
  return Array.isArray(parsed.archived) ? parsed.archived : [];
}

function listSyncStatusSources() {
  const result = gbrain(['status', '--json', '--section', 'sync'], { timeoutMs: 120_000 });
  requireOk(result, 'gbrain status');
  const parsed = parseJsonObject(result.stdout, 'gbrain status');
  if (!parsed.sync || !Array.isArray(parsed.sync.sources)) {
    throw new Error('gbrain status JSON missing sync.sources array');
  }
  return parsed.sync.sources;
}

function gbrainConfigPath() {
  const homeParent = process.env.GBRAIN_HOME || os.homedir();
  return path.join(homeParent, '.gbrain', 'config.json');
}

function readGbrainConfig() {
  try {
    return JSON.parse(fs.readFileSync(gbrainConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function sourceConfigCandidates(config) {
  const candidates = [];
  const containers = [
    config.sources,
    config.source_configs,
    config.sourceConfigs,
    config.repositories,
    config.repos,
    config.federated_sources,
    config.federation && config.federation.sources,
    config.multi_source && config.multi_source.sources,
    config.multiSource && config.multiSource.sources,
  ];

  for (const container of containers) {
    if (Array.isArray(container)) {
      container.filter((item) => item && typeof item === 'object').forEach((item) => candidates.push(item));
    } else if (container && typeof container === 'object') {
      for (const [id, value] of Object.entries(container)) {
        if (value && typeof value === 'object') candidates.push({ id, ...value });
      }
    }
  }
  return candidates;
}

function sourceLocalPath(source) {
  return source.local_path || source.localPath || source.path || source.repo || source.repository_path || '';
}

function sourceId(source) {
  return source.id || source.source_id || source.sourceId || '';
}

function mergeSourceConfig(source, configSources) {
  const sourcePath = sourceLocalPath(source);
  const config = configSources.find((candidate) => {
    if (candidate.id && sourceId(source) && candidate.id === sourceId(source)) return true;
    const candidatePath = sourceLocalPath(candidate);
    return candidatePath && sourcePath && samePath(candidatePath, sourcePath);
  });
  return config ? { ...source, __config: config } : source;
}

function disabledFlagFrom(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.disabled === true) return true;
  if (value.enabled === false) return true;
  if (value.syncEnabled === false) return true;
  if (value.sync_enabled === false) return true;
  if (value.sync && typeof value.sync === 'object') {
    if (value.sync.enabled === false) return true;
    if (value.sync.disabled === true) return true;
  }
  return false;
}

function sourceSyncDisabled(source) {
  return [
    source,
    source.config,
    source.settings,
    source.status,
    source.__active,
    source.__active && source.__active.config,
    source.__active && source.__active.settings,
    source.__active && source.__active.status,
    source.__syncStatus,
    source.__syncStatus && source.__syncStatus.config,
    source.__syncStatus && source.__syncStatus.settings,
    source.__syncStatus && source.__syncStatus.status,
    source.__config,
    source.__config && source.__config.config,
    source.__config && source.__config.settings,
    source.__config && source.__config.status,
  ].some(disabledFlagFrom);
}

function pathsOverlap(a, b) {
  const ak = normalizeKey(a);
  const bk = normalizeKey(b);
  if (ak === bk) return true;
  const sep = path.sep;
  return ak.startsWith(`${bk}${sep}`) || bk.startsWith(`${ak}${sep}`);
}

function samePath(a, b) {
  return normalizeKey(a) === normalizeKey(b);
}

function buildSourceIndex(sources) {
  const byId = new Map();
  const byPath = new Map();
  for (const source of sources) {
    const id = sourceId(source);
    const localPath = sourceLocalPath(source);
    if (id) byId.set(id, source);
    if (localPath) byPath.set(normalizeKey(localPath), source);
  }
  return { byId, byPath };
}

function matchingIndexedSource(source, index) {
  const id = sourceId(source);
  const localPath = sourceLocalPath(source);
  if (id && index.byId.has(id)) return index.byId.get(id);
  if (localPath && index.byPath.has(normalizeKey(localPath))) return index.byPath.get(normalizeKey(localPath));
  return null;
}

function registerRepos(repos, sources, opts) {
  const byPath = new Map();
  for (const source of sources) {
    if (source.local_path) byPath.set(normalizeKey(source.local_path), source);
  }

  const registered = [];
  const skipped = [];
  for (const repo of repos) {
    const existing = byPath.get(normalizeKey(repo));
    if (existing) {
      registered.push({ id: existing.id, path: repo, existing: true });
      continue;
    }

    const overlap = sources.find((source) => source.local_path && pathsOverlap(repo, source.local_path));
    if (overlap) {
      skipped.push({ path: repo, reason: `overlaps source ${overlap.id}` });
      continue;
    }

    const id = sourceIdForRepo(repo);
    const name = path.basename(repo);
    if (opts.dryRun) {
      log(`[dry-run] gbrain sources add ${id} --path ${repo}`, opts);
      sources.push({ id, local_path: repo, __planned: true });
      byPath.set(normalizeKey(repo), { id, local_path: repo, __planned: true });
      registered.push({ id, path: repo, dryRun: true });
      continue;
    }

    const result = gbrain(['sources', 'add', id, '--path', repo, '--name', name, '--federated'], {
      timeoutMs: 60_000,
    });
    if (result.status !== 0) {
      const text = `${result.stderr || ''}${result.stdout || ''}`;
      if (/source.*taken|duplicate key|already exists/i.test(text)) {
        skipped.push({ path: repo, reason: `source id already exists: ${id}` });
        continue;
      }
      throw new Error(`Could not add source ${id} for ${repo}: ${text.trim()}`);
    }
    log(`registered ${id} -> ${repo}`, opts);
    registered.push({ id, path: repo, existing: false });
    sources.push({ id, local_path: repo });
    byPath.set(normalizeKey(repo), { id, local_path: repo });
  }
  return { registered, skipped };
}

function findServeProcesses() {
  if (process.platform === 'win32') return [];
  const result = run('ps', ['-eo', 'pid=', '-o', 'ppid=', '-o', 'args='], { timeoutMs: 10_000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] };
    })
    .filter((proc) => proc && proc.pid !== process.pid && /\bgbrain\b.*\bserve\b/.test(proc.args));
}

function terminateServe(mode, opts) {
  if (mode === 'none' || process.platform === 'win32') return [];
  const candidates = findServeProcesses();
  if (candidates.length === 0) return [];
  if (opts.dryRun) {
    candidates.forEach((proc) => log(`[dry-run] terminate gbrain serve pid=${proc.pid} ppid=${proc.ppid}`, opts));
    return candidates.map((proc) => proc.pid);
  }
  for (const proc of candidates) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      log(`terminated gbrain serve pid=${proc.pid} ppid=${proc.ppid}`, opts);
    } catch {
      // Process already exited.
    }
  }
  for (let i = 0; i < 20; i++) {
    const remaining = findServeProcesses().filter((proc) => candidates.some((c) => c.pid === proc.pid));
    if (remaining.length === 0) break;
    run('sleep', ['0.25'], { timeoutMs: 1_000 });
  }
  return candidates.map((proc) => proc.pid);
}

function syncSources(sources, repoPaths, opts) {
  const configSources = sourceConfigCandidates(readGbrainConfig());
  const syncStatusIndex = buildSourceIndex(listSyncStatusSources());
  const archivedIds = new Set(listArchivedSources().map((source) => sourceId(source)).filter(Boolean));
  const skipped = [];
  const syncable = [];
  for (const source of sources
    .map((source) => mergeSourceConfig(source, configSources))
    .filter((source) => source.local_path)
    .filter((source) => repoPaths.some((repoPath) => samePath(source.local_path, repoPath)))) {
    const id = sourceId(source);
    const syncStatusSource = source.__planned ? source : matchingIndexedSource(source, syncStatusIndex);
    if (id && archivedIds.has(id)) {
      skipped.push({ id, path: source.local_path, status: 'skipped', reason: 'archived source' });
      continue;
    }
    if (!syncStatusSource) {
      skipped.push({ id, path: source.local_path, status: 'skipped', reason: 'not present in gbrain sync status' });
      continue;
    }
    const syncStatusPath = sourceLocalPath(syncStatusSource);
    if (syncStatusPath && !samePath(syncStatusPath, source.local_path)) {
      skipped.push({ id, path: source.local_path, status: 'skipped', reason: 'sync status path mismatch' });
      continue;
    }
    const sourceWithStatus = { ...source, __syncStatus: syncStatusSource };
    if (sourceSyncDisabled(sourceWithStatus)) {
      skipped.push({ id, path: source.local_path, status: 'skipped', reason: 'sync disabled' });
      continue;
    }
    syncable.push(source);
  }

  const results = [...skipped];
  for (const source of syncable) {
    const args = ['sync', '--source', source.id, '--strategy', 'auto', '--yes', '--json'];
    if (opts.noPull) args.push('--no-pull');
    if (opts.noEmbed) args.push('--no-embed');

    if (opts.dryRun) {
      log(`[dry-run] gbrain ${args.join(' ')}`, opts);
      results.push({ id: source.id, status: 'dry_run' });
      continue;
    }

    log(`sync ${source.id} (${source.local_path})`, opts);
    const result = gbrain(args, {
      cwd: source.local_path,
      timeoutMs: Math.max((opts.timeoutSec + 30) * 1000, 60_000),
    });
    const record = {
      id: source.id,
      path: source.local_path,
      exitCode: result.status,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
    };
    if (result.status !== 0) {
      log(`sync failed ${source.id}: ${record.stderr || record.stdout}`, opts);
      record.status = 'error';
    } else {
      record.status = 'ok';
    }
    results.push(record);
  }
  return results;
}

function validateRunRoots(roots) {
  if (process.env.BRIDGEBRAIN_ENABLE_MACHINE_MEMORY !== '1') {
    throw new Error('machine memory is locked. Set BRIDGEBRAIN_ENABLE_MACHINE_MEMORY=1 and pass --roots or GBRAIN_MACHINE_ROOTS for this exact run.');
  }
  if (roots.length === 0) {
    throw new Error('machine-memory roots are required. Pass --roots or set GBRAIN_MACHINE_ROOTS; no default roots are scanned.');
  }
  const home = normalizeKey(os.homedir());
  const homeParent = normalizeKey(path.dirname(os.homedir()));
  const fsRoot = normalizeKey(path.parse(os.homedir()).root);
  if (process.env.BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS === '1') return;
  for (const root of roots) {
    const key = normalizeKey(root);
    if (key === home || key === homeParent || key === fsRoot) {
      throw new Error(`wide machine-memory root blocked: ${root}. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review.`);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const roots = opts.roots || defaultRoots();
  validateRunRoots(roots);
  const repos = discoverGitRepos(roots, opts.maxDepth);
  const summary = {
    roots,
    repos,
    terminatedServePids: [],
    registered: [],
    skipped: [],
    sync: [],
  };

  if (opts.command === 'candidates') {
    if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else repos.forEach((repo) => process.stdout.write(`${repo}\n`));
    return;
  }

  if (opts.sync) {
    summary.terminatedServePids = terminateServe(opts.terminateServe, opts);
  }

  let sources = listSources();
  if (opts.register) {
    const registration = registerRepos(repos, sources, opts);
    summary.registered = registration.registered;
    summary.skipped = registration.skipped;
    if (!opts.dryRun) sources = listSources();
  }

  if (opts.sync) {
    summary.sync = syncSources(sources, repos, opts);
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  const failed = summary.sync.filter((item) => item.status === 'error');
  if (failed.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  process.stderr.write(`machine-memory setup failed: ${err.message}\n`);
  process.exit(1);
}
