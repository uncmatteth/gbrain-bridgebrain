#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const expectedFiles = new Set([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'EVALS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'TROUBLESHOOTING.md',
  'bridge-skill/unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit/agents/openai.yaml',
  'bridge-skill/unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit/scripts/gpt-web-login-bridge.js',
  'bridge-skill/unclemattconnecttogptwebloginoffireforwebgptlogingtoyourshit/SKILL.md',
  'evals/fixture-corpus.json',
  'evals/query-set.json',
  'launchd/com.gbrain.bridgebrain.embeddings.plist.template',
  'launchd/com.gbrain.bridgebrain.machine-sync.plist.template',
  'package.json',
  'scripts/check.js',
  'scripts/check.sh',
  'scripts/configure-gbrain.js',
  'scripts/eval.js',
  'scripts/gbrain-update-check.js',
  'scripts/hygiene-scan.js',
  'scripts/hygiene-scan.sh',
  'scripts/install.ps1',
  'scripts/install.sh',
  'scripts/package-guard.js',
  'scripts/patch-gbrain-litellm.js',
  'scripts/release-gate.js',
  'scripts/setup-machine-memory.js',
  'scripts/test-adapter.js',
  'scripts/test-bridge.js',
  'scripts/test-eval-auth.js',
  'scripts/test-gbrain-update-check.js',
  'scripts/test-installers.js',
  'scripts/test-node.js',
  'scripts/verify.ps1',
  'scripts/verify.sh',
  'src/gbrain-chatgpt-embeddings-server.js',
  'systemd/gbrain-chatgpt-embeddings.service.template',
  'systemd/gbrain-machine-sync.service.template',
  'systemd/gbrain-machine-sync.timer.template',
]);

const blockedPackagePathPatterns = [
  /^AGENT_HANDOFF\.md$/,
  /^\.codex\//,
  /^\.gbrain\//,
  /^\.openclaw\//,
  /^\.clawpatch\//,
  /(^|\/)\.env(\/|\.|$)/,
  /(^|\/)auth\.json$/,
  /(^|\/)cookies\.sqlite$/,
  /(^|\/)session\.sqlite$/,
  /(^|\/).*\.sqlite3?$/,
  /(^|\/).*\.db$/,
  /(^|\/).*\.(?:sqlite3?|db)-(?:wal|shm|journal)$/,
  /(^|\/).*\.(?:sqlite3?|sqlite|db)\.(?:wal|shm|journal)$/,
  /(^|\/)(?:cookies|session)\.sqlite-(?:wal|shm|journal)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
  /(^|\/).*\.(pem|key|crt|p12|pfx)$/,
  /(^|\/).*\.pglite(?:\/|$)/,
];

const privateKeyMarkerPattern = new RegExp(
  '-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED |PRIVATE )?PRIVATE KEY-----|' +
    '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----',
);

const contentPatterns = [
  ['private key marker', privateKeyMarkerPattern],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['JWT-shaped token', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/],
  ['tokenized local bridge URL', /(?:\/v1)?\/t\/(?!redacted\b)[^\s/"'<>?#`$}{]{8,}\b/],
  ['absolute Linux home path', /\/home\/[A-Za-z0-9._-]+/],
  ['absolute macOS user path', /\/Users\/[A-Za-z0-9._-]+/],
  ['absolute media mount path', /\/media\/[A-Za-z0-9._-]+/],
  ['absolute mnt path', /\/mnt\/[A-Za-z0-9._-]+/],
  ['absolute Windows user path', /[A-Za-z]:\\Users\\[^\\\s"<>]+/],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['phone-number-shaped text', /(?<![0-9])(?:\+1[\s.-]?)?(?:\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-][0-9]{4}(?![0-9])/],
  ['street-address-shaped text', /\b[0-9]{1,6}\s+[A-Z][A-Za-z0-9 .'-]{1,50}\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Place|Pl|Way|Circle|Cir)\b/],
];

function commandFor(name) {
  if (process.platform !== 'win32') return name;
  if (path.basename(name).includes('.')) return name;
  if (name === 'npm') return 'npm.cmd';
  return name;
}

function packageFileProblems(files) {
  const unexpectedFiles = files.filter((file) => !expectedFiles.has(file));
  const missingFiles = [...expectedFiles].filter((file) => !files.includes(file));
  const blockedFiles = files.filter((file) => blockedPackagePathPatterns.some((pattern) => pattern.test(file)));
  return { unexpectedFiles, missingFiles, blockedFiles };
}

function addExactContentCheck(checks, label, value) {
  if (value && value.length >= 4) checks.push({ label, value });
}

function contentPolicyHits(entries, exactChecks = []) {
  const hits = [];
  for (const { file, text } of entries) {
    for (const check of exactChecks) {
      if (text.includes(check.value)) hits.push(`${file} (${check.label})`);
    }
    for (const [label, pattern] of contentPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) hits.push(`${file} (${label})`);
    }
  }
  return hits;
}

function collectExactContentChecks(env = process.env) {
  const checks = [];
  addExactContentCheck(checks, 'current local home path', env.HOME);
  addExactContentCheck(checks, 'current local user name', env.USER);
  addExactContentCheck(checks, 'current local logname', env.LOGNAME);
  addExactContentCheck(checks, 'blocked owner value', env.BRIDGEBRAIN_BLOCKED_OWNER);
  const privateBlocklist = env.BRIDGEBRAIN_PRIVATE_BLOCKLIST || '';
  if (privateBlocklist) {
    if (!fs.existsSync(privateBlocklist)) throw new Error('private blocklist file not found');
    const privateLines = fs.readFileSync(privateBlocklist, 'utf8').split(/\r?\n/);
    for (const line of privateLines) {
      if (!line || line.startsWith('#')) continue;
      addExactContentCheck(checks, 'private blocklist match', line);
    }
  }
  return checks;
}

function ensurePublishAllowed({ publishMode, packagePrivate, allowPublicPublish }) {
  if (!publishMode) return;
  if (allowPublicPublish !== '1') {
    throw new Error('public publish is locked. Set BRIDGEBRAIN_ALLOW_PUBLIC_PUBLISH=1 only after release review.');
  }
  if (packagePrivate !== false) {
    throw new Error('package.json still has private=true. Flip it only in the reviewed public-release commit.');
  }
}

function fail(message) {
  console.error(`PACKAGE GUARD FAILED: ${message}`);
  process.exit(1);
}

function runPack(cwd) {
  const pack = spawnSync(commandFor('npm'), ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (pack.error) throw new Error(`npm pack dry-run failed to start: ${pack.error.message}`);
  if (pack.signal) throw new Error(`npm pack dry-run terminated by signal ${pack.signal}`);
  if (pack.status !== 0) throw new Error((pack.stderr || pack.stdout || 'npm pack dry-run failed').trim());
  const parsed = JSON.parse(pack.stdout);
  return parsed[0].files.map((entry) => entry.path);
}

function runHygiene(cwd) {
  const hygiene = spawnSync(process.execPath, ['scripts/hygiene-scan.js'], {
    cwd,
    stdio: 'inherit',
  });
  if (hygiene.error) throw new Error(`hygiene scan failed to start: ${hygiene.error.message}`);
  if (hygiene.signal) throw new Error(`hygiene scan terminated by signal ${hygiene.signal}`);
  if (typeof hygiene.status !== 'number') throw new Error('hygiene scan exited without a status');
  if (hygiene.status !== 0) throw new Error(`hygiene scan failed with exit code ${hygiene.status}`);
}

function main() {
  const cwd = process.cwd();
  const publishMode = process.argv.includes('--publish');
  const pkg = require('../package.json');
  const workflowsDir = path.join(cwd, '.github', 'workflows');
  try {
    if (fs.existsSync(workflowsDir)) throw new Error('GitHub Actions workflows are forbidden in this repo.');
    ensurePublishAllowed({
      publishMode,
      packagePrivate: pkg.private,
      allowPublicPublish: process.env.BRIDGEBRAIN_ALLOW_PUBLIC_PUBLISH,
    });
    const files = runPack(cwd);
    const problems = packageFileProblems(files);
    if (problems.unexpectedFiles.length > 0) throw new Error(`unexpected package files: ${problems.unexpectedFiles.join(', ')}`);
    if (problems.missingFiles.length > 0) throw new Error(`expected package files missing: ${problems.missingFiles.join(', ')}`);
    if (problems.blockedFiles.length > 0) throw new Error(`blocked package files: ${problems.blockedFiles.join(', ')}`);

    const exactChecks = collectExactContentChecks(process.env);
    const entries = files.map((file) => ({ file, text: fs.readFileSync(path.join(cwd, file), 'utf8') }));
    const contentHits = contentPolicyHits(entries, exactChecks);
    if (contentHits.length > 0) throw new Error(`blocked package content: ${contentHits.join(', ')}`);

    process.stderr.write(`Package guard passed: ${files.length} files checked.\n`);
    runHygiene(cwd);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    contentPolicyHits,
    collectExactContentChecks,
    ensurePublishAllowed,
    expectedFiles,
    packageFileProblems,
  };
}
