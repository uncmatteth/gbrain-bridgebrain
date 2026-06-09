#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 5;
const SOURCE_ID_PREFIX = 'mm';
const GBRAIN_SERVE_WRAPPERS = new Set(['node', 'bun', 'bunx', 'deno', 'tsx', 'ts-node', 'npx', 'npm', 'pnpm', 'yarn']);
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
    timeoutSec: process.env.GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS
      ? positiveInt(process.env.GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS, 'GBRAIN_MACHINE_SYNC_TIMEOUT_SECONDS')
      : 600,
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
  if (privateRootReason(normalizeKey(dir))) return true;
  if (name.startsWith('.')) return true;
  if (EXCLUDED_DISCOVERY_DIRS.has(name)) return true;
  if (hasGitMarker(dir)) return false;
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

function sourceIdForRepo(repoPath, hashLength = 8) {
  const safeHashLength = Math.min(Math.max(Number(hashLength) || 8, 8), 24);
  const hash = crypto.createHash('sha256').update(normalizeKey(repoPath)).digest('hex').slice(0, safeHashLength);
  let slug = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'repo';
  const maxSlug = Math.max(1, 32 - SOURCE_ID_PREFIX.length - 2 - hash.length);
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
    maxBuffer: opts.maxBuffer || DEFAULT_MAX_BUFFER,
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

function redactString(value) {
  const tokenValues = [
    process.env.BRIDGEBRAIN_API_TOKEN,
    process.env.GBRAIN_CHATGPT_EMBED_TOKEN,
  ].filter(Boolean);
  let text = String(value || '')
    .replace(/\/v1\/t\/[^/\s"'`?#]+/g, '/v1/t/<redacted>')
    .replace(/\/t\/[^/\s"'`?#]+/g, '/t/<redacted>')
    .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@');
  for (const token of tokenValues) {
    text = text.split(token).join('<redacted>');
  }
  return text;
}

function requireOk(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${redactString((result.stderr || result.stdout || '').trim())}`);
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
  return path.join(process.env.GBRAIN_HOME || os.homedir(), '.gbrain', 'config.json');
}

function listConfigSources() {
  const configFile = gbrainConfigPath();
  if (!fs.existsSync(configFile)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse GBrain config JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const containers = [
    parsed.sources,
    parsed.source_configs,
    parsed.sourceConfigs,
    parsed.repositories,
    parsed.repos,
    parsed.federated_sources,
    parsed.federatedSources,
    parsed.federation && parsed.federation.sources,
    parsed.multi_source && parsed.multi_source.sources,
    parsed.multiSource && parsed.multiSource.sources,
    parsed.sync && parsed.sync.sources,
  ];
  return containers.flatMap(normalizeConfigSources);
}

function normalizeConfigSources(rawSources) {
  if (Array.isArray(rawSources)) return rawSources.filter((source) => source && typeof source === 'object');
  if (!rawSources || typeof rawSources !== 'object') return [];
  const sources = [];
  for (const [id, value] of Object.entries(rawSources)) {
    if (typeof value === 'string') {
      sources.push({ id, local_path: value });
    } else if (value && typeof value === 'object') {
      const source = { ...value };
      if (!sourceId(source)) source.id = id;
      sources.push(source);
    }
  }
  return sources;
}

function sourceLocalPath(source) {
  return source.local_path || source.localPath || source.path || source.repo || source.repository_path || '';
}

function sourceId(source) {
  return source.id || source.source_id || source.sourceId || '';
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

function enabledFlagFrom(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.disabled === true || value.enabled === false) return false;
  if (value.syncEnabled === false || value.sync_enabled === false) return false;
  if (value.syncEnabled === true || value.sync_enabled === true || value.enabled === true) return true;
  if (value.sync && typeof value.sync === 'object') {
    if (value.sync.disabled === true || value.sync.enabled === false) return false;
    if (value.sync.enabled === true) return true;
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

function sourceSyncExplicitlyEnabled(source) {
  return [
    source,
    source.config,
    source.settings,
    source.status,
  ].some(enabledFlagFrom);
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
  const byId = new Map();
  for (const source of sources) {
    const localPath = sourceLocalPath(source);
    const id = sourceId(source);
    if (localPath) byPath.set(normalizeKey(localPath), source);
    if (id) byId.set(id, source);
  }

  const registered = [];
  const skipped = [];
  for (const repo of repos) {
    const existing = byPath.get(normalizeKey(repo));
    if (existing) {
      registered.push({ id: sourceId(existing), path: repo, existing: true });
      continue;
    }

    const overlap = sources.find((source) => {
      const localPath = sourceLocalPath(source);
      return localPath && pathsOverlap(repo, localPath);
    });
    if (overlap) {
      skipped.push({ path: repo, reason: `overlaps source ${sourceId(overlap)}` });
      continue;
    }

    let id = sourceIdForRepo(repo);
    for (const hashLength of [8, 12, 16, 20, 24]) {
      const candidate = sourceIdForRepo(repo, hashLength);
      const collision = byId.get(candidate);
      if (!collision || samePath(sourceLocalPath(collision), repo)) {
        id = candidate;
        break;
      }
    }
    const name = path.basename(repo);
    if (opts.dryRun) {
      log(`[dry-run] gbrain sources add ${id} --path ${repo}`, opts);
      sources.push({ id, local_path: repo, __planned: true });
      byPath.set(normalizeKey(repo), { id, local_path: repo, __planned: true });
      byId.set(id, { id, local_path: repo, __planned: true });
      registered.push({ id, path: repo, dryRun: true });
      continue;
    }

    let result = null;
    let finalId = id;
    for (const hashLength of [8, 12, 16, 20, 24]) {
      finalId = sourceIdForRepo(repo, hashLength);
      const collision = byId.get(finalId);
      if (collision && !samePath(sourceLocalPath(collision), repo)) continue;
      result = gbrain(['sources', 'add', finalId, '--path', repo, '--name', name, '--federated'], {
        timeoutMs: 60_000,
      });
      const text = `${result.stderr || ''}${result.stdout || ''}`;
      if (result.status === 0 || !/source.*taken|duplicate key|already exists/i.test(text)) break;
    }
    if (!result || result.status !== 0) {
      const text = result ? `${result.stderr || ''}${result.stdout || ''}` : '';
      if (/source.*taken|duplicate key|already exists/i.test(text)) {
        skipped.push({ path: repo, reason: `source id collision after retries: ${finalId}` });
        continue;
      }
      throw new Error(`Could not add source ${finalId} for ${repo}: ${redactString(text.trim())}`);
    }
    log(`registered ${finalId} -> ${repo}`, opts);
    registered.push({ id: finalId, path: repo, existing: false });
    sources.push({ id: finalId, local_path: repo });
    byPath.set(normalizeKey(repo), { id: finalId, local_path: repo });
    byId.set(finalId, { id: finalId, local_path: repo });
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
    .filter((proc) => proc && proc.pid !== process.pid && isGbrainServeProcess(proc.args));
}

function shellWords(commandLine) {
  const words = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(commandLine))) {
    words.push((match[1] || match[2] || match[3] || '').replace(/\\"/g, '"'));
  }
  return words;
}

function normalizedBasename(word) {
  return path.basename(String(word || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

function isGbrainCommandWord(word) {
  return normalizedBasename(word) === 'gbrain';
}

function isWrapperCommandWord(word) {
  return GBRAIN_SERVE_WRAPPERS.has(normalizedBasename(word));
}

function isGbrainPathWord(word) {
  const normalized = String(word || '').replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(normalized);
  return /^gbrain(?:\.(?:exe|cmd|bat|[cm]?[jt]s))?$/.test(base) ||
    normalized.includes('/garrytan/gbrain/') ||
    normalized.includes('/@garrytan/gbrain/') ||
    normalized.includes('/node_modules/gbrain/') ||
    normalized.includes('/node_modules/.bin/gbrain');
}

function isGbrainServeProcess(commandLine) {
  const words = shellWords(commandLine);
  if (words.length < 2) return false;
  if (isGbrainCommandWord(words[0]) && words[1] === 'serve') return true;
  if (!isWrapperCommandWord(words[0])) return false;
  for (let i = 1; i < words.length - 1; i++) {
    if (isGbrainCommandWord(words[i]) && words[i + 1] === 'serve') return true;
  }
  for (let i = 1; i < words.length; i++) {
    if (words[i] !== 'serve') continue;
    if (words.slice(1, i).some(isGbrainPathWord)) return true;
  }
  return false;
}

function terminateServe(mode, opts = {}, deps = {}) {
  if (mode === 'none' || process.platform === 'win32') return [];
  const listProcesses = deps.findServeProcesses || findServeProcesses;
  const killProcess = deps.kill || process.kill.bind(process);
  const sleep = deps.sleep || (() => run('sleep', ['0.25'], { timeoutMs: 1_000 }));
  const candidates = listProcesses();
  if (candidates.length === 0) return [];
  const candidatePids = new Set(candidates.map((proc) => proc.pid));
  const remainingCandidates = () => listProcesses().filter((proc) => candidatePids.has(proc.pid));
  if (opts.dryRun) {
    candidates.forEach((proc) => log(`[dry-run] terminate gbrain serve pid=${proc.pid} ppid=${proc.ppid}`, opts));
    return candidates.map((proc) => proc.pid);
  }
  for (const proc of candidates) {
    try {
      killProcess(proc.pid, 'SIGTERM');
      log(`sent SIGTERM to gbrain serve pid=${proc.pid} ppid=${proc.ppid}`, opts);
    } catch {
      // Process already exited.
    }
  }
  for (let i = 0; i < 20; i++) {
    const remaining = remainingCandidates();
    if (remaining.length === 0) break;
    sleep();
  }
  const remaining = remainingCandidates();
  if (remaining.length > 0) {
    const pids = remaining.map((proc) => proc.pid).join(', ');
    throw new Error(`could not terminate gbrain serve process(es): ${pids}. Stop them before syncing machine memory.`);
  }
  candidates.forEach((proc) => log(`terminated gbrain serve pid=${proc.pid} ppid=${proc.ppid}`, opts));
  return candidates.map((proc) => proc.pid);
}

function syncSources(sources, repoPaths, opts) {
  const targetSources = sources
    .filter((source) => sourceLocalPath(source))
    .filter((source) => repoPaths.some((repoPath) => samePath(sourceLocalPath(source), repoPath)));
  const dryRunPlannedOnly = opts.dryRun && targetSources.every((source) => source.__planned);
  const configSourceIndex = dryRunPlannedOnly ? buildSourceIndex([]) : buildSourceIndex(listConfigSources());
  const syncStatusIndex = dryRunPlannedOnly ? buildSourceIndex([]) : buildSourceIndex(listSyncStatusSources());
  const archivedIds = dryRunPlannedOnly ? new Set() : new Set(listArchivedSources().map((source) => sourceId(source)).filter(Boolean));
  const skipped = [];
  const syncable = [];
  for (const source of targetSources) {
    const id = sourceId(source);
    const localPath = sourceLocalPath(source);
    if (opts.dryRun && source.__planned) {
      const configSource = matchingIndexedSource(source, configSourceIndex);
      if (sourceSyncDisabled({ ...source, __config: configSource })) {
        skipped.push({ id, path: localPath, status: 'skipped', reason: 'sync disabled' });
        continue;
      }
      if (!source.__planned && !sourceSyncExplicitlyEnabled(configSource || source)) {
        skipped.push({ id, path: localPath, status: 'skipped', reason: 'sync not explicitly enabled' });
        continue;
      }
      syncable.push(source);
      continue;
    }
    const syncStatusSource = source.__planned ? source : matchingIndexedSource(source, syncStatusIndex);
    if (id && archivedIds.has(id)) {
      skipped.push({ id, path: localPath, status: 'skipped', reason: 'archived source' });
      continue;
    }
    if (!syncStatusSource) {
      skipped.push({ id, path: localPath, status: 'skipped', reason: 'not present in gbrain sync status' });
      continue;
    }
    if (!source.__planned && !sourceSyncExplicitlyEnabled(syncStatusSource)) {
      skipped.push({ id, path: localPath, status: 'skipped', reason: 'sync not explicitly enabled' });
      continue;
    }
    const syncStatusPath = sourceLocalPath(syncStatusSource);
    if (syncStatusPath && !samePath(syncStatusPath, localPath)) {
      skipped.push({ id, path: localPath, status: 'skipped', reason: 'sync status path mismatch' });
      continue;
    }
    const configSource = matchingIndexedSource(source, configSourceIndex);
    const sourceWithStatus = { ...source, __syncStatus: syncStatusSource, __config: configSource };
    if (sourceSyncDisabled(sourceWithStatus)) {
      skipped.push({ id, path: localPath, status: 'skipped', reason: 'sync disabled' });
      continue;
    }
    syncable.push(source);
  }

  const results = [...skipped];
  for (const source of syncable) {
    const id = sourceId(source);
    const localPath = sourceLocalPath(source);
    const args = ['sync', '--source', id, '--strategy', 'auto', '--yes', '--json'];
    if (opts.noPull) args.push('--no-pull');
    if (opts.noEmbed) args.push('--no-embed');

    if (opts.dryRun) {
      log(`[dry-run] gbrain ${args.join(' ')}`, opts);
      results.push({ id, path: localPath, status: 'dry_run' });
      continue;
    }

    log(`sync ${id} (${localPath})`, opts);
    const result = gbrain(args, {
      cwd: os.homedir(),
      timeoutMs: Math.max((opts.timeoutSec + 30) * 1000, 60_000),
    });
    const record = {
      id,
      path: localPath,
      exitCode: result.status,
      stdout: redactString((result.stdout || '').trim()),
      stderr: redactString((result.stderr || '').trim()),
    };
    if (result.status !== 0) {
      log(`sync failed ${id}: ${record.stderr || record.stdout}`, opts);
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
  for (const root of roots) {
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      throw new Error(`machine-memory root does not exist or is unreadable: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`machine-memory root is not a directory: ${root}`);
    }
    const key = normalizeKey(root);
    const privateReason = privateRootReason(key);
    if (privateReason) {
      throw new Error(`private machine-memory root blocked: ${root} (${privateReason}). Use specific public repo/work roots.`);
    }
    if (process.env.BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS === '1') continue;
    if (key === home || key === homeParent || key === fsRoot || isDefaultBlockedWideRoot(key)) {
      throw new Error(`wide machine-memory root blocked: ${root}. Use specific repo/work roots, or set BRIDGEBRAIN_ALLOW_WIDE_MACHINE_MEMORY_ROOTS=1 after review.`);
    }
  }
}

function keyWithin(key, parent) {
  if (!parent) return false;
  return key === parent || key.startsWith(`${parent}${path.sep}`);
}

function privateRootReason(key) {
  const home = normalizeKey(os.homedir());
  const privateRoots = [
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    path.join(process.env.GBRAIN_HOME || os.homedir(), '.gbrain'),
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), '.agents'),
    path.join(os.homedir(), '.codex', 'memories'),
  ].map(normalizeKey);
  for (const privateRoot of privateRoots) {
    if (keyWithin(key, privateRoot)) return privateRoot;
  }
  const relativeToHome = path.relative(home, key);
  if (relativeToHome && !relativeToHome.startsWith('..') && !path.isAbsolute(relativeToHome)) {
    const hiddenSegment = relativeToHome.split(path.sep).find((segment) => segment.startsWith('.') && segment !== '.');
    if (hiddenSegment) return `hidden home directory ${hiddenSegment}`;
  }
  return '';
}

function isDefaultBlockedWideRoot(key) {
  const slashKey = key.replace(/\\/g, '/');
  return (
    /^[a-z]:$/i.test(slashKey) ||
    /^\/media\/[^/]+\/[^/]+$/i.test(slashKey) ||
    /^\/run\/media\/[^/]+\/[^/]+$/i.test(slashKey) ||
    /^\/mnt\/[^/]+$/i.test(slashKey) ||
    /^\/volumes\/[^/]+$/i.test(slashKey)
  );
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

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`machine-memory setup failed: ${err.message}\n`);
    process.exit(1);
  }
} else {
	  module.exports = {
	    isGbrainServeProcess,
	    shellWords,
	    terminateServe,
	  };
	}
