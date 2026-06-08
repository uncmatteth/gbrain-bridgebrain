#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const defaultUpstreamRepo = 'https://github.com/garrytan/gbrain.git';

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

function commandFor(name) {
  if (process.platform !== 'win32') return name;
  if (path.basename(name).includes('.')) return name;
  if (name === 'npm') return 'npm.cmd';
  if (name === 'gbrain') return 'gbrain.cmd';
  return name;
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
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ''}`.trim();
  const snippet = text ? `\n${text.slice(0, 2000)}` : '';
  throw new Error(`${label} failed: ${result.command}${snippet}`);
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
  return path.join(gbrainDataDir(), 'backups');
}

function isInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOutsideRepo(label, candidate) {
  if (isInside(root, candidate)) {
    throw new Error(`${label} must be outside this repo: ${candidate}`);
  }
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    throw new Error(`could not read update state ${stateFile}: ${err.message}`);
  }
}

function writeJsonAtomic(file, data) {
  assertOutsideRepo('update state file', file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
      error: `${native.stderr || native.stdout || native.error || 'gbrain check-update failed'}`.trim(),
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
  if (report.lastAppliedUpstreamHead && report.lastAppliedUpstreamHead === report.upstreamHead) {
    return 'Already applied according to local BridgeBrain state.';
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
  const stateFile = path.resolve(opts.stateFile || defaultStateFile());
  const state = readState(stateFile);
  const version = readGbrainVersion(gbrainBin);
  const nativeUpdate = readNativeUpdate(gbrainBin);
  const upstreamHead = readUpstreamHead(gitBin, repo);
  const previousSeenUpstreamHead = state.last_seen_upstream_head || null;
  const lastAppliedUpstreamHead = state.last_applied_upstream_head || null;
  const now = new Date().toISOString();
  const stateWritten = !!opts.writeState;

  const report = {
    command: 'check',
    checkedAt: now,
    gbrainBin,
    gbrainVersion: version.version,
    gbrainVersionRaw: version.raw,
    upstreamRepo: repo,
    upstreamHead,
    stateFile,
    previousSeenUpstreamHead,
    lastAppliedUpstreamHead,
    newSinceLastCheck: previousSeenUpstreamHead ? previousSeenUpstreamHead !== upstreamHead : null,
    nativeUpdate,
    stateWritten,
  };
  report.recommendation = updateRecommendation(report);

  if (opts.writeState) {
    writeJsonAtomic(stateFile, {
      ...state,
      last_checked_at: now,
      last_seen_upstream_repo: repo,
      last_seen_upstream_head: upstreamHead,
      last_seen_gbrain_version: version.version,
      previous_seen_upstream_head: previousSeenUpstreamHead,
    });
  }

  return report;
}

function flattenDoctorChecks(parsed) {
  const checks = parsed && parsed.checks;
  if (Array.isArray(checks)) {
    return checks.map((check, index) => ({
      name: check.name || check.id || check.key || `check_${index}`,
      status: String(check.status || check.result || '').toLowerCase(),
      message: check.message || check.summary || check.reason || '',
    }));
  }
  if (checks && typeof checks === 'object') {
    return Object.entries(checks).map(([name, check]) => ({
      name,
      status: String((check && (check.status || check.result)) || '').toLowerCase(),
      message: (check && (check.message || check.summary || check.reason)) || '',
    }));
  }
  return [];
}

function summarizeDoctor(parsed) {
  const status = String(parsed.status || parsed.overallStatus || parsed.overall_status || '').toLowerCase();
  const checks = flattenDoctorChecks(parsed);
  const failures = checks.filter((check) => ['fail', 'failed', 'error', 'critical', 'unhealthy'].includes(check.status));
  const healthyStatuses = new Set(['healthy', 'ok', 'pass', 'passed']);
  const unhealthyStatuses = new Set(['unhealthy', 'fail', 'failed', 'error', 'critical']);
  let healthy;
  if (unhealthyStatuses.has(status)) {
    healthy = false;
  } else if (healthyStatuses.has(status)) {
    healthy = failures.length === 0;
  } else {
    healthy = failures.length === 0;
  }
  return {
    status: status || 'unknown',
    healthy,
    failureCount: failures.length,
    failures: failures.slice(0, 8),
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

function isSecretKey(key) {
  return /token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret|service[_-]?role|private[_-]?key|access[_-]?key|jwt|pat/i.test(String(key));
}

function redactString(value) {
  return String(value)
    .replace(/\/v1\/t\/[^/\s?#]+/g, '/v1/t/<redacted>')
    .replace(/([?&][^=&#?\s]*(?:token|secret|password|cookie|api[_-]?key|authorization|credential|bearer|client[_-]?secret)[^=&#?\s]*=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@');
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
    fs.copyFileSync(stateFile, path.join(backupDir, 'update-state-before.json'));
    files.push('update-state-before.json');
  }
  return files;
}

function createBackup(meta, opts = {}) {
  const sourceDir = gbrainDataDir();
  const backupBase = path.resolve(process.env.GBRAIN_BACKUP_DIR || defaultBackupDir());
  assertOutsideRepo('backup directory', backupBase);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupBase, `bridgebrain-gbrain-update-${stamp}`);
  const snapshotDir = path.join(backupDir, 'gbrain-home-snapshot');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const metadataFiles = writeMetadataBackup(sourceDir, backupDir, opts.stateFile);
  let snapshotCopied = false;
  if (opts.fullDataBackup && fs.existsSync(sourceDir)) {
    fs.cpSync(sourceDir, snapshotDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (candidate) => backupFilter(sourceDir, candidate),
    });
    snapshotCopied = true;
  }

  const manifest = {
    created_at: new Date().toISOString(),
    purpose: 'BridgeBrain guarded GBrain update backup',
    gbrain_parent_dir: gbrainParentDir(),
    gbrain_data_dir: sourceDir,
    backup_scope: opts.fullDataBackup ? 'full-private-gbrain-home' : 'metadata-redacted-only',
    full_data_backup: !!opts.fullDataBackup,
    metadata_files: metadataFiles,
    snapshot_copied: snapshotCopied,
    snapshot_note: opts.fullDataBackup
      ? 'Full .gbrain snapshot was explicitly requested. Keep this backup private.'
      : 'Default backup avoids copying GBrain databases, local memory, and raw provider tokens.',
    ...meta,
  };
  fs.writeFileSync(path.join(backupDir, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return {
    backupDir,
    backupScope: manifest.backup_scope,
    fullDataBackup: manifest.full_data_backup,
    metadataFiles,
    snapshotCopied,
  };
}

function applyUpdate(opts) {
  const steps = [];
  let backup = null;
  const gbrainBin = process.env.GBRAIN_BIN || 'gbrain';
  const npmBin = process.env.NPM_BIN || 'npm';
  const patchScript = path.resolve(process.env.BRIDGEBRAIN_UPDATE_PATCH_SCRIPT || path.join(root, 'scripts', 'patch-gbrain-litellm.js'));
  const report = checkForUpdate({ ...opts, writeState: false });

  if (!opts.force && report.lastAppliedUpstreamHead && report.lastAppliedUpstreamHead === report.upstreamHead) {
    throw new Error('local BridgeBrain state says this upstream commit was already applied. Use --force only after review.');
  }

  try {
    const versionBefore = report.gbrainVersion;
    const preDoctor = runDoctorGate('pre-upgrade gbrain doctor', { allowUnhealthy: opts.allowUnhealthyBefore });
    steps.push({ label: 'pre-upgrade gbrain doctor', status: preDoctor.healthy ? 'ok' : 'allowed-unhealthy', doctor: preDoctor });

    runRepoStep('pre-upgrade adapter tests', npmBin, ['test'], 120_000, opts, steps);
    runRepoStep('pre-upgrade package guard', npmBin, ['run', 'package:guard'], 120_000, opts, steps);

    const stateFile = path.resolve(opts.stateFile || defaultStateFile());
    backup = createBackup({
      gbrain_version_before: versionBefore,
      upstream_repo: report.upstreamRepo,
      upstream_head: report.upstreamHead,
    }, {
      fullDataBackup: opts.fullDataBackup,
      stateFile,
    });
    steps.push({
      label: 'local update backup',
      status: 'ok',
      backupDir: backup.backupDir,
      backupScope: backup.backupScope,
      snapshotCopied: backup.snapshotCopied,
    });

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
      last_seen_upstream_repo: report.upstreamRepo,
      last_seen_upstream_head: report.upstreamHead,
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
      const failure = { status: 'failed', error: err.message };
      if (err.backup) failure.backup = err.backup;
      if (err.steps) failure.steps = err.steps;
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    } else {
      process.stderr.write(`${err.message}\n`);
      if (err.backup) {
        process.stderr.write(`Backup: ${err.backup.backupDir}\n`);
      }
      process.stderr.write(`${usage()}\n`);
    }
    process.exit(1);
  }
}

main();
