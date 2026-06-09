#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const repoRoot = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`HYGIENE FAIL: ${message}`);
  failures += 1;
}

const privatePathDirs = new Set(['.codex', '.gbrain', '.openclaw', '.clawpatch']);
const credentialFilePattern =
  /(^|\/)(auth\.json|cookies\.sqlite|session\.sqlite|.*\.sqlite3?|.*\.db|.*\.(?:sqlite3?|sqlite|db)(?:-|\.)(?:wal|shm|journal)|.*\.pglite|\.env(?:\/|\.|$).*|id_(?:rsa|ed25519|ecdsa|dsa)|.*\.(?:pem|key|crt|p12|pfx))$/;

function repoFiles(root = process.cwd()) {
  const files = [];
  const blockedPaths = [];
  const unreadablePaths = [];
  const excludedDirs = new Set(['.git', 'node_modules']);
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadablePaths.push(path.relative(root, dir).replace(/\\/g, '/') || '.');
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        blockedPaths.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (privatePathDirs.has(entry.name)) {
          blockedPaths.push(`${relativePath}/`);
          continue;
        }
        if (entry.name.endsWith('.pglite')) {
          blockedPaths.push(`${relativePath}/`);
          continue;
        }
        if (excludedDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (credentialFilePattern.test(relativePath)) {
        blockedPaths.push(relativePath);
        continue;
      }
      try {
        fs.accessSync(fullPath, fs.constants.R_OK);
      } catch {
        unreadablePaths.push(relativePath);
        continue;
      }
      files.push(relativePath);
    }
  }
  walk(root);
  return { files: files.sort(), blockedPaths: blockedPaths.sort(), unreadablePaths: unreadablePaths.sort() };
}

function readText(file) {
  try {
    return fs.readFileSync(path.join(repoRoot, file), 'utf8');
  } catch {
    return '';
  }
}

function exactHit(files, label, value) {
  if (!value || value.length < 4) return;
  const hits = files.filter((file) => readText(file).includes(value));
  if (hits.length > 0) fail(`${label}: ${hits.join(', ')}`);
}

function regexHit(files, label, pattern) {
  const hits = files.filter((file) => pattern.test(readText(file)));
  if (hits.length > 0) fail(`${label}: ${hits.join(', ')}`);
}

let failures = 0;
const { files, blockedPaths, unreadablePaths } = repoFiles(repoRoot);
const blockerFiles = files.filter((file) => file !== 'scripts/hygiene-scan.js');

console.log('Reviewing broad sensitive-word surface...');
const broadPattern =
  /(?:\/home|\/Users)\/[^\s"<>]+|[A-Za-z]:\\Users\\[^\s"<>]+|auth|cookie|token|api[_-]?key|session|\.gbrain|\.codex|\.openclaw|ollama|chatgpt-bridge-semantic-hash-768|embedding_dimensions.*768|not to win academic|best practical/i;
for (const file of files) {
  if (broadPattern.test(readText(file))) console.log(`sensitive surface file: ${file}`);
}

console.log('\nChecking hard public-release blockers...');
if (blockedPaths.length > 0) fail(`private or credential-like path present: ${blockedPaths.join(', ')}`);
if (unreadablePaths.length > 0) fail(`unreadable repo path present: ${unreadablePaths.join(', ')}`);
exactHit(blockerFiles, 'current local home path', process.env.HOME || '');
exactHit(blockerFiles, 'current local user name', process.env.USER || '');
exactHit(blockerFiles, 'current local logname', process.env.LOGNAME || '');
exactHit(blockerFiles, 'blocked owner placeholder leaked', process.env.BRIDGEBRAIN_BLOCKED_OWNER || '');

const privateBlocklist = process.env.BRIDGEBRAIN_PRIVATE_BLOCKLIST || '';
if (privateBlocklist) {
  if (!fs.existsSync(privateBlocklist)) {
    fail('private blocklist file not found');
  } else {
    for (const line of fs.readFileSync(privateBlocklist, 'utf8').split(/\r?\n/)) {
      const value = line.replace(/\r$/, '');
      if (!value || value.startsWith('#') || value.length < 4) continue;
      exactHit(blockerFiles, 'private blocklist match', value);
    }
  }
}

regexHit(blockerFiles, 'old academic-benchmark dodge', /not to win academic/);
regexHit(blockerFiles, 'old lazy quality framing', /best practical/);
regexHit(blockerFiles, 'Ollama instruction instead of No Ollama boundary', /\bollama\s+(pull|run|serve|install|embedding)\b/i);
regexHit(blockerFiles, 'email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
regexHit(blockerFiles, 'phone-number-shaped text', /(?<![0-9])(?:\+1[\s.-]?)?(?:\(?[0-9]{3}\)?[\s.-]?)?[0-9]{3}[\s.-][0-9]{4}(?![0-9])/);
regexHit(blockerFiles, 'street-address-shaped text', /\b[0-9]{1,6}\s+[A-Z][A-Za-z0-9 .'-]{1,50}\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Place|Pl|Way|Circle|Cir)\b/);
const privateKeyMarkerPattern = new RegExp(
  '-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED |PRIVATE )?PRIVATE KEY-----|' +
  '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----',
);
regexHit(blockerFiles, 'private key marker', privateKeyMarkerPattern);
regexHit(blockerFiles, 'OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}\b/);
regexHit(blockerFiles, 'GitHub token', /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/);
regexHit(blockerFiles, 'AWS access key id', /\bAKIA[0-9A-Z]{16}\b/);
regexHit(blockerFiles, 'JWT-shaped token', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/);
regexHit(blockerFiles, 'bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/);
regexHit(blockerFiles, 'tokenized local bridge URL', /(?:\/v1)?\/t\/(?!redacted\b)[^\s/"'<>?#`$}{]{8,}\b/);

if (failures > 0) {
  console.error(`Hygiene scan failed with ${failures} blocker(s).`);
  process.exit(1);
}

console.log('Hygiene scan blockers clear. Review broad hits above before publishing.');
