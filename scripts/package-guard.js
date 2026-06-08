#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`PACKAGE GUARD FAILED: ${message}`);
  process.exit(1);
}

const publishMode = process.argv.includes('--publish');
const pkg = require('../package.json');
const workflowsDir = path.join(process.cwd(), '.github', 'workflows');

if (fs.existsSync(workflowsDir)) {
  fail('GitHub Actions workflows are forbidden in this repo.');
}

if (publishMode) {
  if (process.env.BRIDGEBRAIN_ALLOW_PUBLIC_PUBLISH !== '1') {
    fail('public publish is locked. Set BRIDGEBRAIN_ALLOW_PUBLIC_PUBLISH=1 only after release review.');
  }
  if (pkg.private !== false) {
    fail('package.json still has private=true. Flip it only in the reviewed public-release commit.');
  }
}

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 30_000,
});

if (pack.status !== 0) {
  fail((pack.stderr || pack.stdout || 'npm pack dry-run failed').trim());
}

let files;
try {
  const parsed = JSON.parse(pack.stdout);
  files = parsed[0].files.map((entry) => entry.path);
} catch (err) {
  fail(`could not parse npm pack dry-run output: ${err.message}`);
}

const blocked = [
  /^AGENT_HANDOFF\.md$/,
  /^\.codex\//,
  /^\.gbrain\//,
  /^\.openclaw\//,
  /^\.clawpatch\//,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)auth\.json$/,
  /(^|\/)cookies\.sqlite$/,
  /(^|\/)session\.sqlite$/,
  /(^|\/)id_(rsa|ed25519)$/,
  /(^|\/).*\.(pem|key)$/,
  /(^|\/).*\.pglite(\/|$)/,
];

const hits = files.filter((file) => blocked.some((pattern) => pattern.test(file)));
if (hits.length > 0) {
  fail(`blocked package files: ${hits.join(', ')}`);
}

const contentChecks = [];
function addExactContentCheck(label, value) {
  if (value && value.length >= 4) {
    contentChecks.push({ label, value });
  }
}

addExactContentCheck('current local home path', process.env.HOME);
addExactContentCheck('current local username', process.env.USER);
addExactContentCheck('current local logname', process.env.LOGNAME);
addExactContentCheck('blocked owner value', process.env.BRIDGEBRAIN_BLOCKED_OWNER);

const privateBlocklist = process.env.BRIDGEBRAIN_PRIVATE_BLOCKLIST || '';
if (privateBlocklist) {
  if (!fs.existsSync(privateBlocklist)) {
    fail('private blocklist file not found');
  }
  const privateLines = fs.readFileSync(privateBlocklist, 'utf8').split(/\r?\n/);
  for (const line of privateLines) {
    if (!line || line.startsWith('#')) continue;
    addExactContentCheck('private blocklist match', line);
  }
}

const contentPatterns = [
  ['absolute Linux home path', /\/home\/[A-Za-z0-9._-]+/],
  ['absolute macOS user path', /\/Users\/[A-Za-z0-9._-]+/],
  ['absolute media mount path', /\/media\/[A-Za-z0-9._-]+/],
  ['absolute mnt path', /\/mnt\/[A-Za-z0-9._-]+/],
  ['absolute Windows user path', /[A-Za-z]:\\Users\\[^\\\s"<>]+/],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['phone-number-shaped text', /(?<![0-9])(?:\+1[\s.-]?)?(?:\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-][0-9]{4}(?![0-9])/],
  ['street-address-shaped text', /\b[0-9]{1,6}\s+[A-Z][A-Za-z0-9 .'-]{1,50}\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Place|Pl|Way|Circle|Cir)\b/],
];

const contentHits = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  for (const check of contentChecks) {
    if (text.includes(check.value)) {
      contentHits.push(`${file} (${check.label})`);
    }
  }
  for (const [label, pattern] of contentPatterns) {
    if (pattern.test(text)) {
      contentHits.push(`${file} (${label})`);
    }
  }
}

if (contentHits.length > 0) {
  fail(`blocked package content: ${contentHits.join(', ')}`);
}

process.stderr.write(`Package guard passed: ${files.length} files checked.\n`);
