#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
  console.error('Node.js 18 or newer is required.');
  process.exit(1);
}
const tests = [
  ['adapter smoke', ['scripts/test-adapter.js']],
];

if (process.platform === 'win32') {
  console.log('Unix shell fixture smokes skipped on Windows; Node-safe checks and release gate still run.');
} else {
  tests.push(['bridge CLI smoke', ['scripts/test-bridge.js']]);
  tests.push(['installer smoke', ['scripts/test-installers.js']]);
}
tests.push(['GBrain update checker smoke', ['scripts/test-gbrain-update-check.js']]);
tests.push(['mock eval', ['scripts/eval.js']]);
tests.push(['live eval auth smoke', ['scripts/test-eval-auth.js']]);
tests.push(['release gate smoke', ['scripts/release-gate.js']]);

for (const [label, args] of tests) {
  console.log(`${label}...`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`${label} terminated by signal ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Node smoke tests completed.');
