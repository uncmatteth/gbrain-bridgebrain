'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DirectBridge, hash, jsonWrite, LIMIT } = require('../core');
const delay = ms => new Promise(r => setTimeout(r, ms));
function fixture(t, permissions = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-direct-test-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const config = { instanceId: crypto.randomUUID(), stateDir: path.join(temp, 'state'), projects: [{ id: 'sample', path: root }], permissions: { write: true, exec: true, browser: true, desktop: true, ...permissions }, localBearerToken: crypto.randomBytes(32).toString('base64url') };
  const configFile = path.join(temp, 'config.json'); jsonWrite(configFile, config);
  const bridge = new DirectBridge(config, configFile);
  t.after(async () => { await bridge.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, root, config, configFile, bridge, call: (name, args) => bridge.call(name, args) };
}
async function finish(bridge, id, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const job = bridge.readJob({ job_id: id });
    if (job.finishedAt) return job;
    await delay(30);
  }
  throw new Error('Job did not finish in test deadline');
}
function initGit(root) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Bridge Test', '-c', `user.email=bridge${'@'}example.invalid`, '-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Bridge Test'); git('config', 'user.email', `bridge${'@'}example.invalid`);
  fs.writeFileSync(path.join(root, 'code.txt'), 'original\n'); git('add', 'code.txt'); git('commit', '-qm', 'fixture');
  return git;
}

module.exports = { fixture, finish, initGit };
