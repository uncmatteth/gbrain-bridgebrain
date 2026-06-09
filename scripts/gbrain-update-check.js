#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultUpstreamRepo = 'https://github.com/garrytan/gbrain.git';
const secretKeyPatternSource = 'token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret|service[_-]?role(?:[_-]?key)?|private[_-]?key|access[_-]?key|jwt|pat';
const secretKeyPattern = new RegExp(secretKeyPatternSource, 'i');
const secretQueryValuePattern = new RegExp(`([?&][^=&#?\\s]*(?:${secretKeyPatternSource})[^=&#?\\s]*=)[^&#\\s]+`, 'gi');

function usage() {
  return [
    'Usage:',
    '  node scripts/gbrain-update-check.js check [--json] [--no-write-state] [--state-file <path>]',
    '  node scripts/gbrain-update-check.js apply [--json] [--force] [--allow-unhealthy-before] [--full-data-backup] [--state-file <path>]',
    '',
    'Environment:',
    '  GBRAIN_BIN              GBrain command path (default: gbrain)',
    '  GIT_BIN                 git command path (default: git)',
    '  NPM_BIN                 npm command path (default: npm)',
    '  GBRAIN_UPSTREAM_REPO    upstream git repo (default: garrytan/gbrain)',
    '  GBRAIN_BACKUP_DIR       backup directory outside this repo',
    '  BRIDGEBRAIN_UPDATE_FULL_DATA_BACKUP=1  opt into copying .gbrain data outside this repo',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'check';
  const opts = {
    command,
    json: false,
    force: false,
    allowUnhealthyBefore: process.env.BRIDGEBRAIN_UPDATE_ALLOW_UNHEALTHY_BEFORE === '1',
    fullDataBackup: process.env.BRIDGEBRAIN_UPDATE_FULL_DATA_BACKUP === '1',
    writeState: command === 'check',
    stateFile: process.env.GBRAIN_UPDATE_STATE_FILE || null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--allow-unhealthy-before') {
      opts.allowUnhealthyBefore = true;
    } else if (arg === '--full-data-backup') {
      opts.fullDataBackup = true;
    } else if (arg === '--no-write-state') {
      opts.writeState = false;
    } else if (arg === '--write-state') {
      opts.writeState = true;
    } else if (arg === '--state-file') {
      i += 1;
      if (!args[i]) throw new Error('--state-file needs a path');
      opts.stateFile = args[i];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!['check', 'apply'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === 'apply') {
    opts.writeState = true;
  }
  return opts;
}

function commandFor(name, platform = process.platform) {
  if (platform !== 'win32') return name;
  if (path.basename(name).includes('.')) return name;
  if (name === 'npm') return 'npm.cmd';
  if (name === 'gbrain') return 'gbrain.cmd';
  return name;
}

function redactString(value) {
  return String(value || '')
    .replace(/\/v1\/t\/[^/\s?#]+/g, '/v1/t/<redacted>')
    .replace(secretQueryValuePattern, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function runCapture(cmd, args, options = {}) {
  const result = spawnSync(commandFor(cmd), args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 60_000,
    windowsHide: true,
  });
  return {
    command: [cmd, ...args].join(' '),
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  };
}

function requireOk(label, result) {
  if (result.status === 0 && !result.error) return;
  const text = redactString(`${result.stdout}\n${result.stderr}\n${result.error || ''}`.trim());
  const snippet = text ? `\n${text.slice(0, 2000)}` : '';
  throw new Error(`${label} failed: ${redactString(result.command)}${snippet}`);
}

function parseJsonOutput(label, text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} did not return JSON: ${err.message}`);
  }
}

function gbrainParentDir() {
  return path.resolve(process.env.GBRAIN_HOME || os.homedir());
}

function gbrainDataDir() {
  return path.join(gbrainParentDir(), '.gbrain');
}

function defaultStateFile() {
  return path.join(gbrainDataDir(), 'bridgebrain-gbrain-update-state.json');
}

function defaultBackupDir() {
  return path.join(gbrainParentDir(), '.bridgebrain-gbrain-backups');
}

function isInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOutsideRepo(label, candidate) {
  const lexical = path.resolve(candidate);
  const resolved = resolveForSafety(candidate);
  if (isInside(root, lexical) || isInside(root, resolved)) {
    throw new Error(`${label} must be outside this repo: ${candidate}`);
  }
  return resolved;
}

function resolveForSafety(candidate) {
  const resolved = path.resolve(candidate);
  let current = resolved;
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const base = fs.realpathSync.native(current);
  return suffix.length ? path.join(base, ...suffix) : base;
}

function backupBaseDir() {
  return path.resolve(process.env.GBRAIN_BACKUP_DIR || defaultBackupDir());
}

function validateApplyPaths(opts) {
  const stateFile = resolveStateFile(opts);
  const backupBase = backupBaseDir();
  const resolvedStateFile = assertOutsideRepo('update state file', stateFile);
  const resolvedBackupBase = assertOutsideRepo('backup directory', backupBase);
  const resolvedGbrainData = resolveForSafety(gbrainDataDir());
  if (opts.fullDataBackup && isInside(resolvedGbrainData, resolvedBackupBase)) {
    throw new Error(`full-data backup directory must be outside the GBrain data directory: ${backupBase}`);
  }
  return { stateFile: resolvedStateFile, backupBase: resolvedBackupBase };
}

function resolveStateFile(opts = {}) {
  const stateFile = path.resolve(opts.stateFile || defaultStateFile());
  assertOutsideRepo('update state file', stateFile);
  assertAllowedStateFile(stateFile);
  return stateFile;
}

function assertAllowedStateFile(stateFile) {
  const base = path.basename(stateFile);
  if (
    base === 'config.json' ||
    /\.(?:sqlite3?|db|pglite)$/i.test(base) ||
    /\.(?:sqlite3?|sqlite|db)-(?:wal|shm|journal)$/i.test(base) ||
    /\.(?:sqlite3?|sqlite|db)\.(?:wal|shm|journal)$/i.test(base)
  ) {
    throw new Error(`update state file must not be a private config or database path: ${stateFile}`);
  }
  if (!fs.existsSync(stateFile) || path.resolve(stateFile) === path.resolve(defaultStateFile())) return;
  const parsed = parseStateFile(stateFile);
  if (parsed.bridgebrain_update_state !== true) {
    throw new Error(`custom update state file already exists but is not a BridgeBrain update-state file: ${stateFile}`);
  }
}

function parseStateFile(stateFile) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    throw new Error(`could not read update state ${stateFile}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`update state must be a JSON object: ${stateFile}`);
  }
  return parsed;
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};
  assertAllowedStateFile(stateFile);
  return parseStateFile(stateFile);
}

function writeJsonAtomic(file, data) {
  assertOutsideRepo('update state file', file);
  assertAllowedStateFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...data, bridgebrain_update_state: true }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function acquireUpdateLock(stateFile) {
  const lockDirs = [...new Set([installUpdateLockDir(), stateFileUpdateLockDir(stateFile)])];
  const acquired = [];
  try {
    for (const lockDir of lockDirs) {
      fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        state_file: stateFile,
      }, null, 2)}\n`, { mode: 0o600 });
      acquired.push(lockDir);
    }
  } catch (error) {
    for (const lockDir of acquired.reverse()) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
    if (error.code === 'EEXIST') {
      throw new Error('another GBrain update apply appears to be running');
    }
    throw error;
  }
  return () => {
    for (const lockDir of acquired.reverse()) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  };
}

function installUpdateLockDir() {
  return `${defaultStateFile()}.lock`;
}

function stateFileUpdateLockDir(stateFile) {
  return `${stateFile}.lock`;
}

function readGbrainVersion(gbrainBin) {
  const version = runCapture(gbrainBin, ['--version'], { timeout: 20_000 });
  requireOk('gbrain version', version);
  const text = version.stdout.trim() || version.stderr.trim();
  const match = text.match(/gbrain\s+([^\s]+)/i);
  return {
    raw: text,
    version: match ? match[1] : text,
  };
}

function readNativeUpdate(gbrainBin) {
  const native = runCapture(gbrainBin, ['check-update', '--json'], { timeout: 45_000 });
  if (native.status !== 0 || native.error) {
    return {
      ok: false,
      error: redactString(`${native.stderr || native.stdout || native.error || 'gbrain check-update failed'}`.trim()),
    };
  }
  try {
    return {
      ok: true,
      data: JSON.parse(native.stdout),
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not parse gbrain check-update JSON: ${err.message}`,
    };
  }
}

function readUpstreamHead(gitBin, repo) {
  const upstream = runCapture(gitBin, ['ls-remote', repo, 'HEAD'], { timeout: 60_000 });
  requireOk('upstream commit check', upstream);
  const match = upstream.stdout.trim().match(/^([0-9a-f]{40})\s+HEAD$/i);
  if (!match) {
    throw new Error(`could not parse upstream HEAD from git ls-remote output: ${upstream.stdout.trim()}`);
  }
  return match[1].toLowerCase();
}

function updateRecommendation(report) {
  if (report.lastUpgradeAttemptedUpstreamHead && report.lastUpgradeAttemptedUpstreamHead === report.upstreamHead) {
    return 'This upstream commit was already attempted locally. Re-run apply only after reviewing the installed GBrain version and doctor output.';
  }
  if (report.nativeUpdate && report.nativeUpdate.ok && report.nativeUpdate.data && report.nativeUpdate.data.update_available) {
    return 'GBrain reports a version update. Review, then run npm run gbrain:update:apply.';
  }
  if (report.previousSeenUpstreamHead && report.previousSeenUpstreamHead !== report.upstreamHead) {
    return 'New upstream GBrain commit detected. Review, then run npm run gbrain:update:apply.';
  }
  if (!report.previousSeenUpstreamHead) {
    if (report.stateWritten) {
      return 'No previous upstream commit was recorded. This check recorded the current upstream commit for the next comparison.';
    }
    return 'No previous upstream commit was recorded. This read-only check did not update local state.';
  }
  return 'No new upstream commit detected since the last BridgeBrain check.';
}

function checkForUpdate(opts = {}) {
  const gbrainBin = process.env.GBRAIN_BIN || 'gbrain';
  const gitBin = process.env.GIT_BIN || 'git';
  const repo = process.env.GBRAIN_UPSTREAM_REPO || defaultUpstreamRepo;
  const stateFile = resolveStateFile(opts);
  const state = readState(stateFile);
  const version = readGbrainVersion(gbrainBin);
  const nativeUpdate = readNativeUpdate(gbrainBin);
  const upstreamHead = readUpstreamHead(gitBin, repo);
  const previousSeenUpstreamHead = state.last_seen_upstream_head || null;
  const lastAppliedUpstreamHead = state.last_applied_upstream_head || null;
  const lastUpgradeAttemptedUpstreamHead = state.last_upgrade_attempted_upstream_head || null;
  const now = new Date().toISOString();
  const stateWritten = !!opts.writeState;

  const report = {
    command: 'check',
    checkedAt: now,
    gbrainBin,
    gbrainVersion: version.version,
    gbrainVersionRaw: version.raw,
    upstreamRepo: redactString(repo),
    upstreamHead,
    stateFile,
    previousSeenUpstreamHead,
    lastAppliedUpstreamHead,
    lastUpgradeAttemptedUpstreamHead,
    newSinceLastCheck: previousSeenUpstreamHead ? previousSeenUpstreamHead !== upstreamHead : null,
    nativeUpdate,
    stateWritten,
  };
  Object.defineProperty(report, 'upstreamRepoRaw', {
    value: repo,
    enumerable: false,
    configurable: true,
  });
  report.recommendation = updateRecommendation(report);

  if (opts.writeState) {
    const releaseLock = acquireUpdateLock(stateFile);
    try {
      const freshState = readState(stateFile);
      writeJsonAtomic(stateFile, {
        ...freshState,
        last_checked_at: now,
        last_seen_upstream_repo: redactString(repo),
        last_seen_upstream_head: upstreamHead,
        last_seen_gbrain_version: version.version,
        previous_seen_upstream_head: freshState.last_seen_upstream_head || previousSeenUpstreamHead,
      });
    } finally {
      releaseLock();
    }
  }

  return report;
}

function flattenDoctorChecks(parsed) {
  const checks = parsed && parsed.checks;
  if (Array.isArray(checks)) {
    return checks.map((check, index) => ({
      name: check.name || check.id || check.key || `check_${index}`,
      status: String(check.status || check.result || '').toLowerCase(),
      message: redactString(check.message || check.summary || check.reason || ''),
    }));
  }
  if (checks && typeof checks === 'object') {
    return Object.entries(checks).map(([name, check]) => ({
      name,
      status: String((check && (check.status || check.result)) || '').toLowerCase(),
      message: redactString((check && (check.message || check.summary || check.reason)) || ''),
    }));
  }
  return [];
}

function summarizeDoctor(parsed) {
  const status = String(parsed.status || parsed.overallStatus || parsed.overall_status || '').toLowerCase();
  const checks = flattenDoctorChecks(parsed);
  const failures = checks.filter((check) => ['fail', 'failed', 'error', 'critical', 'unhealthy'].includes(check.status));
  const passingStatuses = new Set(['ok', 'pass', 'passed', 'healthy', 'skipped', 'skip', 'disabled', 'n/a']);
  const healthyStatuses = new Set(['healthy', 'ok', 'pass', 'passed']);
  const unhealthyStatuses = new Set(['unhealthy', 'fail', 'failed', 'error', 'critical']);
  const unknowns = checks.filter((check) => !passingStatuses.has(check.status) && !failures.includes(check));
  let healthy;
  if (unhealthyStatuses.has(status)) {
    healthy = false;
  } else if (healthyStatuses.has(status)) {
    healthy = checks.length > 0 && failures.length === 0 && unknowns.length === 0;
  } else {
    healthy = false;
  }
  return {
    status: status || 'unknown',
    healthy,
    failureCount: failures.length,
    unknownCount: unknowns.length,
    failures: [...failures, ...unknowns].slice(0, 8),
  };
}

function runDoctorGate(label, opts) {
  const gbrainBin = process.env.GBRAIN_BIN || 'gbrain';
  const result = runCapture(gbrainBin, ['doctor', '--json'], { timeout: 180_000 });
  let parsed;
  try {
    parsed = parseJsonOutput(label, result.stdout);
  } catch (err) {
    requireOk(label, result);
    throw err;
  }
  const summary = summarizeDoctor(parsed);
  if (!summary.healthy && !opts.allowUnhealthy) {
    const failures = summary.failures
      .map((failure) => `${failure.name}:${failure.status}${failure.message ? `:${failure.message}` : ''}`)
      .join('\n');
    throw new Error(`${label} did not pass (status=${summary.status}). Fix GBrain doctor before upgrading.${failures ? `\n${failures}` : ''}`);
  }
  if ((result.status !== 0 || result.error) && summary.healthy) {
    requireOk(label, result);
  }
  return summary;
}

function runRepoStep(label, command, args, timeout, opts, steps) {
  if (!opts.json) {
    process.stderr.write(`${label}: ${command} ${args.join(' ')}\n`);
  }
  const result = runCapture(command, args, { cwd: root, timeout });
  requireOk(label, result);
  steps.push({ label, command: result.command, status: 'ok' });
}

function backupFilter(sourceRoot, candidate) {
  const rel = path.relative(sourceRoot, candidate);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  const base = path.basename(candidate);
  if (parts[0] === 'backups') return false;
  if (base === 'postmaster.pid') return false;
  if (base.endsWith('.log')) return false;
  if (base.endsWith('.lock')) return false;
  if (base.endsWith('.tmp')) return false;
  return true;
}

function liveDataIndicators(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) return [];
  const hits = [];
  const stack = [sourceRoot];
  while (stack.length > 0 && hits.length < 20) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const base = entry.name.toLowerCase();
      if (base === 'bridgebrain-gbrain-update-state.json.lock') {
        continue;
      }
      if (
        base === 'postmaster.pid' ||
        base === 'pglite.lock' ||
        base === 'lock' ||
        base.endsWith('.pid') ||
        base.endsWith('.lock') ||
        /\.(?:sqlite|sqlite3|db)-(?:wal|shm|journal)$/i.test(base) ||
        /\.(?:sqlite|sqlite3|db)\.(?:wal|shm|journal)$/i.test(base)
      ) {
        hits.push(path.relative(sourceRoot, full) || entry.name);
        if (hits.length >= 20) break;
      }
      if (entry.isDirectory() && !['backups', 'node_modules', '.git'].includes(base)) {
        stack.push(full);
      }
    }
  }
  return hits;
}

function assertFullDataBackupConsistent(sourceRoot) {
  const hits = liveDataIndicators(sourceRoot);
  if (hits.length > 0) {
    throw new Error(`full-data backup refused while live database indicators exist: ${hits.join(', ')}`);
  }
  return { liveDataIndicators: [] };
}

function isSecretKey(key) {
  return secretKeyPattern.test(String(key));
}

function redactConfig(value, key = '') {
  if (isSecretKey(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => {
      return [childKey, redactConfig(childValue, childKey)];
    }));
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

function safeConfigSummary(config) {
  const summary = {};
  for (const key of ['embedding_model', 'embedding_dimensions', 'search_embedding_column']) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      summary[key] = config[key];
    }
  }
  if (config.provider_base_urls && typeof config.provider_base_urls === 'object') {
    summary.provider_base_urls = redactConfig(config.provider_base_urls, 'provider_base_urls');
  }
  return summary;
}

function safeUpdateStateSummary(state) {
  return redactConfig(state);
}

function writeMetadataBackup(sourceDir, backupDir, stateFile) {
  const files = [];
  const configFile = path.join(sourceDir, 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      fs.writeFileSync(
        path.join(backupDir, 'config.redacted.json'),
        `${JSON.stringify(safeConfigSummary(parsed), null, 2)}\n`,
        { mode: 0o600 },
      );
      files.push('config.redacted.json');
    } catch (err) {
      fs.writeFileSync(
        path.join(backupDir, 'config.redacted.error.txt'),
        'Could not parse config.json for redacted backup. Raw config was not copied.\n',
        { mode: 0o600 },
      );
      files.push('config.redacted.error.txt');
    }
  }
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const parsed = parseStateFile(stateFile);
      fs.writeFileSync(
        path.join(backupDir, 'update-state-before.json'),
        `${JSON.stringify(safeUpdateStateSummary(parsed), null, 2)}\n`,
        { mode: 0o600 },
      );
      files.push('update-state-before.json');
    } catch (err) {
      fs.writeFileSync(
        path.join(backupDir, 'update-state-before.error.txt'),
        'Could not parse update state for redacted backup. Raw update state was not copied.\n',
        { mode: 0o600 },
      );
      files.push('update-state-before.error.txt');
    }
  }
  return files;
}

function createBackup(meta, opts = {}) {
  const sourceDir = gbrainDataDir();
  const backupBase = path.resolve(opts.backupBase || backupBaseDir());
  const resolvedBackupBase = assertOutsideRepo('backup directory', backupBase);
  const resolvedSourceDir = resolveForSafety(sourceDir);
  if (opts.fullDataBackup && isInside(resolvedSourceDir, resolvedBackupBase)) {
    throw new Error(`full-data backup directory must be outside the GBrain data directory: ${backupBase}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(resolvedBackupBase, `bridgebrain-gbrain-update-${stamp}`);
  const snapshotDir = path.join(backupDir, 'gbrain-home-snapshot');
  const partial = {
    backupDir,
    backupScope: opts.fullDataBackup ? 'full-private-gbrain-home' : 'metadata-redacted-only',
    fullDataBackup: !!opts.fullDataBackup,
    metadataFiles: [],
    snapshotCopied: false,
    consistencyGate: null,
  };

  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    partial.metadataFiles = writeMetadataBackup(sourceDir, backupDir, opts.stateFile);
    if (opts.fullDataBackup && fs.existsSync(sourceDir)) {
      partial.consistencyGate = assertFullDataBackupConsistent(sourceDir);
      fs.cpSync(sourceDir, snapshotDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (candidate) => backupFilter(sourceDir, candidate),
      });
      partial.snapshotCopied = true;
    }

    const manifest = {
      created_at: new Date().toISOString(),
      purpose: 'BridgeBrain guarded GBrain update backup',
      gbrain_parent_dir: gbrainParentDir(),
      gbrain_data_dir: sourceDir,
      backup_scope: partial.backupScope,
      full_data_backup: partial.fullDataBackup,
      metadata_files: partial.metadataFiles,
      snapshot_copied: partial.snapshotCopied,
      consistency_gate: partial.consistencyGate || null,
      snapshot_note: opts.fullDataBackup
        ? 'Full .gbrain snapshot was explicitly requested. Keep this backup private.'
        : 'Default backup avoids copying GBrain databases, local memory, and raw provider tokens.',
      ...meta,
    };
    fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return partial;
  } catch (error) {
    error.backup = partial;
    throw error;
  }
}

function writeAttemptState(stateFile, report, versionBefore, backup, status) {
  const state = readState(stateFile);
  writeJsonAtomic(stateFile, {
    ...state,
    last_checked_at: new Date().toISOString(),
    last_attempted_at: new Date().toISOString(),
    last_apply_status: status,
    last_seen_upstream_repo: redactString(report.upstreamRepoRaw || report.upstreamRepo),
    last_seen_upstream_head: report.upstreamHead,
    last_upgrade_attempted_upstream_head: report.upstreamHead,
    last_seen_gbrain_version: versionBefore,
    last_backup_dir: backup.backupDir,
    last_backup_scope: backup.backupScope,
  });
}

function applyUpdate(opts) {
  const steps = [];
  let backup = null;
  let releaseLock = null;
  const gbrainBin = process.env.GBRAIN_BIN || 'gbrain';
  const npmBin = process.env.NPM_BIN || 'npm';
  const patchScript = path.resolve(process.env.BRIDGEBRAIN_UPDATE_PATCH_SCRIPT || path.join(root, 'scripts', 'patch-gbrain-litellm.js'));
  const pathPlan = validateApplyPaths(opts);

  try {
    releaseLock = acquireUpdateLock(pathPlan.stateFile);
    const report = checkForUpdate({ ...opts, writeState: false, stateFile: pathPlan.stateFile });
    if (
      !opts.force &&
      report.upstreamHead &&
      (report.lastUpgradeAttemptedUpstreamHead === report.upstreamHead || report.lastAppliedUpstreamHead === report.upstreamHead)
    ) {
      throw new Error(`upstream ${report.upstreamHead} was already attempted locally; pass --force to rerun apply`);
    }

    const versionBefore = report.gbrainVersion;
    const preDoctor = runDoctorGate('pre-upgrade gbrain doctor', { allowUnhealthy: opts.allowUnhealthyBefore });
    steps.push({ label: 'pre-upgrade gbrain doctor', status: preDoctor.healthy ? 'ok' : 'allowed-unhealthy', doctor: preDoctor });

    runRepoStep('pre-upgrade adapter tests', npmBin, ['test'], 120_000, opts, steps);
    runRepoStep('pre-upgrade package guard', npmBin, ['run', 'package:guard'], 120_000, opts, steps);

    const stateFile = pathPlan.stateFile;
    backup = createBackup({
      gbrain_version_before: versionBefore,
      upstream_repo: report.upstreamRepo,
      upstream_head: report.upstreamHead,
    }, {
      fullDataBackup: opts.fullDataBackup,
      stateFile,
      backupBase: pathPlan.backupBase,
    });
    steps.push({
      label: 'local update backup',
      status: 'ok',
      backupDir: backup.backupDir,
      backupScope: backup.backupScope,
      snapshotCopied: backup.snapshotCopied,
    });

    writeAttemptState(stateFile, report, versionBefore, backup, 'attempted');

    runRepoStep('gbrain upgrade', gbrainBin, ['upgrade'], 600_000, opts, steps);
    runRepoStep('reapply BridgeBrain LiteLLM patch', process.execPath, [patchScript], 120_000, opts, steps);

    const postDoctor = runDoctorGate('post-upgrade gbrain doctor', { allowUnhealthy: false });
    steps.push({ label: 'post-upgrade gbrain doctor', status: 'ok', doctor: postDoctor });

    runRepoStep('post-upgrade repo check', npmBin, ['run', 'check'], 300_000, opts, steps);

    const versionAfter = readGbrainVersion(gbrainBin).version;
    const state = readState(stateFile);
    writeJsonAtomic(stateFile, {
      ...state,
      last_checked_at: new Date().toISOString(),
      last_applied_at: new Date().toISOString(),
      last_apply_status: 'applied',
      last_seen_upstream_repo: report.upstreamRepo,
      last_seen_upstream_head: report.upstreamHead,
      last_upgrade_attempted_upstream_head: report.upstreamHead,
      last_applied_upstream_head: report.upstreamHead,
      last_seen_gbrain_version: versionAfter,
      last_applied_gbrain_version: versionAfter,
      last_backup_dir: backup.backupDir,
      last_backup_scope: backup.backupScope,
    });

    return {
      command: 'apply',
      status: 'applied',
      upstreamRepo: report.upstreamRepo,
      upstreamHead: report.upstreamHead,
      versionBefore,
      versionAfter,
      backup,
      stateFile,
      steps,
    };
  } catch (err) {
    if (backup) err.backup = backup;
    err.steps = steps;
    throw err;
  } finally {
    if (releaseLock) releaseLock();
  }
}

function printCheck(report) {
  process.stdout.write(`GBrain version: ${report.gbrainVersion}\n`);
  process.stdout.write(`Upstream repo: ${report.upstreamRepo}\n`);
  process.stdout.write(`Upstream HEAD: ${report.upstreamHead}\n`);
  process.stdout.write(`Previous seen HEAD: ${report.previousSeenUpstreamHead || 'none'}\n`);
  process.stdout.write(`Last applied HEAD: ${report.lastAppliedUpstreamHead || 'none'}\n`);
  process.stdout.write(`New since last check: ${report.newSinceLastCheck === null ? 'first check' : report.newSinceLastCheck ? 'yes' : 'no'}\n`);
  if (report.nativeUpdate && !report.nativeUpdate.ok) {
    process.stdout.write(`GBrain release check: ${report.nativeUpdate.error}\n`);
  }
  process.stdout.write(`State file: ${report.stateFile}${report.stateWritten ? ' (updated)' : ' (not updated)'}\n`);
  process.stdout.write(`Recommendation: ${report.recommendation}\n`);
}

function printApply(report) {
  process.stdout.write(`GBrain update applied for upstream ${report.upstreamHead}.\n`);
  process.stdout.write(`Version: ${report.versionBefore} -> ${report.versionAfter}\n`);
  process.stdout.write(`Backup: ${report.backup.backupDir}\n`);
  process.stdout.write(`State file: ${report.stateFile}\n`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = opts.command === 'check' ? checkForUpdate(opts) : applyUpdate(opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (opts.command === 'check') {
      printCheck(result);
    } else {
      printApply(result);
    }
  } catch (err) {
    if (opts && opts.json) {
      const failure = { status: 'failed', error: redactString(err.message) };
      if (err.backup) failure.backup = err.backup;
      if (err.steps) failure.steps = err.steps;
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    } else {
      process.stderr.write(`${redactString(err.message)}\n`);
      if (err.backup) {
        process.stderr.write(`Backup: ${err.backup.backupDir}\n`);
      }
      process.stderr.write(`${usage()}\n`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    commandFor,
  };
}
