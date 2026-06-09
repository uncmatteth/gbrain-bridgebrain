#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertNode18() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 18) {
    fail('Node.js 18 or newer is required.');
  }
}

function walkFiles(startDirs, predicate) {
  const files = [];
  const stack = startDirs.map((dir) => path.join(root, dir));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '.clawpatch'].includes(entry.name)) stack.push(full);
      } else if (entry.isFile() && predicate(full)) {
        files.push(path.relative(root, full));
      }
    }
  }
  return files.sort();
}

function runCommand(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: options.stdio || 'inherit',
    encoding: options.encoding,
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.signal) fail(`${label} terminated by signal ${result.signal}`);
  if (typeof result.status !== 'number') fail(`${label} ended without an exit status`);
  if (result.status !== 0) process.exit(result.status || 1);
  return result;
}

function runJavaScriptSyntax() {
  for (const file of walkFiles(['src', 'scripts', 'bridge-skill'], (full) => full.endsWith('.js'))) {
    runCommand(`node --check ${file}`, process.execPath, ['--check', file]);
  }
}

function runShellSyntax() {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.error || bash.status !== 0) {
    fail('bash is required for BridgeBrain shell installer checks. Install bash or run the platform-specific scripts manually.');
  }
  for (const file of walkFiles(['scripts'], (full) => full.endsWith('.sh'))) {
    runCommand(`bash -n ${file}`, 'bash', ['-n', file]);
  }
}

function powershellCommand() {
  for (const candidate of ['pwsh', 'powershell']) {
    const result = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'ignore',
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return '';
}

function runPowerShellSyntax() {
  const shell = powershellCommand();
  if (!shell) {
    console.log('PowerShell not available; Windows installer syntax not locally parsed.');
    return;
  }
  runCommand('PowerShell syntax', shell, [
    '-NoProfile',
    '-Command',
    '$ErrorActionPreference="Stop"; foreach ($f in @("scripts/install.ps1","scripts/verify.ps1")) { if (Test-Path -LiteralPath $f) { [scriptblock]::Create((Get-Content -LiteralPath $f -Raw)) > $null } }',
  ]);
}

function buildCheckPlan(platform = process.platform) {
  const plan = [
    { id: 'js-syntax', label: 'JS syntax' },
    { id: 'powershell-syntax', label: 'PowerShell syntax' },
    { id: 'node-smoke', label: 'Node smoke tests' },
    { id: 'hygiene', label: 'Hygiene scan' },
    { id: 'release-gate', label: 'Release gate' },
  ];
  if (platform !== 'win32') {
    plan.splice(1, 0, { id: 'shell-syntax', label: 'Shell syntax' });
  }
  return plan;
}

function runPlan(plan) {
  for (const step of plan) {
    console.log(`${step.label}...`);
    if (step.id === 'js-syntax') runJavaScriptSyntax();
    else if (step.id === 'shell-syntax') runShellSyntax();
    else if (step.id === 'powershell-syntax') runPowerShellSyntax();
    else if (step.id === 'node-smoke') runCommand('scripts/test-node.js', process.execPath, ['scripts/test-node.js']);
    else if (step.id === 'hygiene') runCommand('scripts/hygiene-scan.js', process.execPath, ['scripts/hygiene-scan.js']);
    else if (step.id === 'release-gate') runCommand('scripts/release-gate.js', process.execPath, ['scripts/release-gate.js']);
    else fail(`unknown check step: ${step.id}`);
  }
}

function main() {
  assertNode18();
  runPlan(buildCheckPlan());
  console.log('All local checks completed.');
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    buildCheckPlan,
  };
}
