#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const publish = process.argv.includes('--publish');

function run(label, command, args) {
  const result = spawnSync(command, args, {
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
  if (typeof result.status !== 'number') {
    console.error(`${label} exited without a status`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}`);
    process.exit(result.status);
  }
}

run('package guard', process.execPath, ['scripts/package-guard.js', ...(publish ? ['--publish'] : [])]);
