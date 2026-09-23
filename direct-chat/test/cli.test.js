'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { jsonRead } = require('../core');
const { argumentsFor } = require('../cli');
const cli = path.resolve(__dirname, '..', 'cli.js');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-cli-')), root = path.join(temp, 'project'), config = path.join(temp, 'private', 'config.json'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--config', config], { encoding: 'utf8', timeout: 12000 });
  return { temp, root, config, run };
}
test('CLI dry run does not create state, config or a listener', t => {
  const f = fixture(t), result = f.run('init', '--root', `sample=${f.root}`, '--dry-run');
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).dry_run, true); assert.equal(fs.existsSync(path.dirname(f.config)), false);
});
test('CLI initializes read-only by default and never overwrites config', t => {
  const f = fixture(t); assert.equal(f.run('init', '--root', `sample=${f.root}`).status, 0);
  const config = jsonRead(f.config); assert.equal(config.permissions.exec, false); assert.equal(config.permissions.write, false); assert.ok(config.localBearerToken.length > 32);
  const before = fs.readFileSync(f.config, 'utf8'); assert.equal(f.run('init', '--root', `sample=${f.root}`).status, 1); assert.equal(fs.readFileSync(f.config, 'utf8'), before);
});
test('CLI trusted capabilities, pause/resume and revocation are explicit', t => {
  const f = fixture(t); assert.equal(f.run('init', '--root', `sample=${f.root}`, '--trusted-computer').status, 0);
  let c = jsonRead(f.config); const old = c.localBearerToken; assert.ok(Object.values(c.permissions).every(Boolean));
  assert.equal(f.run('pause').status, 0); assert.equal(jsonRead(f.config).paused, true);
  assert.equal(f.run('resume').status, 0); assert.equal(jsonRead(f.config).paused, false);
  const revoke = f.run('revoke'); assert.equal(revoke.status, 0); assert.notEqual(jsonRead(f.config).localBearerToken, old); assert.equal(revoke.stdout.includes(old), false);
});
test('CLI doctor does not claim a live ChatGPT connection or expose token', t => {
  const f = fixture(t); f.run('init', '--root', `sample=${f.root}`); const result = f.run('doctor');
  assert.equal(result.status, 0, result.stderr); assert.match(JSON.parse(result.stdout).chatgpt_connection, /not verified/); assert.equal(result.stdout.includes(jsonRead(f.config).localBearerToken), false);
});
test('CLI stdio process serves tools and releases its lock on EOF', t => {
  const f = fixture(t); f.run('init', '--root', `sample=${f.root}`);
  const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } };
  const result = spawnSync(process.execPath, [cli, 'serve', '--stdio', '--config', f.config], { input: JSON.stringify(req) + '\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.isError, false);
  assert.equal(fs.existsSync(path.join(jsonRead(f.config).stateDir, 'server-lock.json')), false);
});
test('CLI refuses a second server without disrupting the first', async t => {
  const f = fixture(t); f.run('init', '--root', `sample=${f.root}`);
  const first = spawn(process.execPath, [cli, 'serve', '--stdio', '--config', f.config], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  first.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n'); await once(first.stdout, 'data');
  const second = f.run('serve', '--stdio'); assert.equal(second.status, 1); assert.match(second.stderr, /Another bridge server/);
  first.stdin.end(); await once(first, 'exit'); assert.equal(fs.existsSync(path.join(jsonRead(f.config).stateDir, 'server-lock.json')), false);
});
test('CLI refuses whole-home and whole-drive roots and unknown flags', t => {
  const f = fixture(t); assert.equal(f.run('init', '--root', `all=${os.homedir()}`).status, 1);
  assert.equal(f.run('init', '--root', `all=${path.parse(f.root).root}`).status, 1);
  assert.throws(() => argumentsFor(['init', '--make-up']), /Unknown option/);
});
