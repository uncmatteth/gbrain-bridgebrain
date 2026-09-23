'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DirectBridge, hash, jsonWrite, LIMIT } = require('../core');
const { fixture, finish, initGit } = require('./helpers');
test('identity declares direct tools without a model provider', async t => {
  const { call } = fixture(t); const status = await call('bridge_status', {});
  assert.equal(status.invokes_codex, false); assert.equal(status.makes_model_api_calls, false); assert.equal(status.model_provider, null);
  assert.ok(status.instance_id); assert.ok((await call('project_list', {}))[0].root);
});
test('new writes, read hashes and stale-write prevention', async t => {
  const { call } = fixture(t);
  const written = await call('file_write', { project: 'sample', path: 'a.txt', content: 'one', expected_sha256: '' });
  assert.equal(written.sha256, hash('one'));
  assert.equal((await call('file_read', { project: 'sample', path: 'a.txt' })).content, 'one');
  await assert.rejects(call('file_write', { project: 'sample', path: 'a.txt', content: 'two', expected_sha256: '' }), /changed/);
  assert.equal((await call('file_read', { project: 'sample', path: 'a.txt' })).content, 'one');
});
test('exact edits preserve dollar strings and reject ambiguity', async t => {
  const { root, call } = fixture(t); fs.writeFileSync(path.join(root, 'a.txt'), 'old');
  await call('file_edit', { project: 'sample', path: 'a.txt', expected_sha256: hash('old'), edits: [{ old: 'old', new: '$& literal' }] });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '$& literal');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x x');
  await assert.rejects(call('file_edit', { project: 'sample', path: 'a.txt', expected_sha256: hash('x x'), edits: [{ old: 'x', new: 'y' }] }), /exactly once/);
});
test('concurrent edits cannot silently overwrite each other', async t => {
  const { root, call } = fixture(t); fs.writeFileSync(path.join(root, 'a'), 'start');
  const results = await Promise.allSettled(['one', 'two'].map(content => call('file_write', { project: 'sample', path: 'a', content, expected_sha256: hash('start') })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('delete is backed up and restore is conflict-aware', async t => {
  const { root, call } = fixture(t); fs.writeFileSync(path.join(root, 'a'), 'keep me');
  const removed = await call('file_delete', { project: 'sample', path: 'a', expected_sha256: hash('keep me') });
  assert.equal(fs.existsSync(path.join(root, 'a')), false);
  await call('file_restore', { backup_id: removed.backup_id, expected_sha256: '' });
  assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'keep me');
  await assert.rejects(call('file_restore', { backup_id: removed.backup_id, expected_sha256: '' }), /changed/);
});
test('traversal, absolute paths, credentials and Git internals are rejected', async t => {
  const { call } = fixture(t);
  for (const name of ['../outside', '/outside', 'C:/outside', '.env', '.env.local', '.ssh/key', '.git/config', 'nested/auth.json', 'secrets.pem', 'data.db', 'x\\y']) {
    await assert.rejects(call('file_read', { project: 'sample', path: name }));
  }
});
test('symlinks and hard links cannot bypass file boundaries', async t => {
  const { temp, root, call } = fixture(t); const outside = path.join(temp, 'private'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(root, 'link')); fs.linkSync(outside, path.join(root, 'hard'));
  await assert.rejects(call('file_read', { project: 'sample', path: 'link' }), /Symlinks/);
  await assert.rejects(call('file_read', { project: 'sample', path: 'hard' }), /Hard-linked/);
});
test('read-only, paused and OAuth scope failures never mutate', async t => {
  const { root, config, configFile, call, bridge } = fixture(t, { write: false });
  const args = { project: 'sample', path: 'a', content: 'x', expected_sha256: '' };
  await assert.rejects(call('file_write', args), /disabled/); assert.equal(fs.existsSync(path.join(root, 'a')), false);
  config.permissions.write = true; jsonWrite(configFile, config);
  await assert.rejects(bridge.call('file_write', args, ['bridge.read']), /lacks/);
  config.paused = true; jsonWrite(configFile, config); await assert.rejects(call('bridge_status', {}), /paused/);
});
test('schema rejects unknown parameters and malformed arguments', async t => {
  const { call } = fixture(t);
  await assert.rejects(call('file_read', { project: 'sample', path: 'a', unexpected: 'x' }), /Unexpected/);
  await assert.rejects(call('file_read', {}), /required/);
  await assert.rejects(call('job_read', { job_id: 'bad', offset: -1 }), /range/);
});
test('search is literal, bounded and skips dependency and credential files', async t => {
  const { root, call } = fixture(t);
  fs.writeFileSync(path.join(root, 'code'), 'a.b\nA.B\nother'); fs.writeFileSync(path.join(root, '.env'), 'a.b');
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'hidden'), 'a.b');
  const result = await call('file_search', { project: 'sample', query: 'a.b', limit: 1 });
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].path, 'code'); assert.equal(result.truncated, true);
  assert.equal((await call('file_list', { project: 'sample' })).entries.some(e => e.name === '.env'), false);
});
test('binary artifact reads have byte cursors; oversized text is refused', async t => {
  const { root, call } = fixture(t); fs.writeFileSync(path.join(root, 'artifact.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const chunk = await call('file_read', { project: 'sample', path: 'artifact.bin', encoding: 'base64', offset: 1, length: 2 });
  assert.deepEqual(Buffer.from(chunk.content, 'base64'), Buffer.from([1, 2])); assert.equal(chunk.next_offset, 3);
  await assert.rejects(call('file_read', { project: 'sample', path: 'artifact.bin' }), /Binary/);
  fs.writeFileSync(path.join(root, 'big'), Buffer.alloc(LIMIT + 1, 65)); await assert.rejects(call('file_read', { project: 'sample', path: 'big' }), /2 MiB/);
});
test('checkpoint revisions persist across bridge instances', async t => {
  const { call, config } = fixture(t);
  await call('checkpoint_save', { project: 'sample', text: 'Run the existing render script.', expected_revision: 0 });
  const other = new DirectBridge(config);
  assert.equal((await other.call('checkpoint_get', { project: 'sample' })).revision, 1);
  await assert.rejects(other.call('checkpoint_save', { project: 'sample', text: 'stale', expected_revision: 0 }), /revision/);
  await other.close();
});
test('commands return real output and exit status, without AI invocation', async t => {
  const { call, bridge } = fixture(t);
  const started = await call('command_start', { project: 'sample', argv: [process.execPath, '-e', 'console.log("local execution");process.exitCode=3'], request_id: 'test-command' });
  const job = await finish(bridge, started.id); assert.equal(job.status, 'failed'); assert.equal(job.exitCode, 3); assert.match(job.output, /local execution/);
  await assert.rejects(call('command_start', { project: 'sample', argv: ['codex', 'exec'], request_id: 'no-codex' }), /does not launch AI/);
});
test('retry IDs are durable and changed arguments cannot reuse them', async t => {
  const { bridge, call, config } = fixture(t);
  const args = { project: 'sample', argv: [process.execPath, '-e', 'console.log("once")'], request_id: 'once' };
  const started = await call('command_start', args); await finish(bridge, started.id);
  assert.equal((await call('command_start', args)).id, started.id);
  const other = new DirectBridge(config); assert.equal((await other.call('command_start', args)).id, started.id);
  await assert.rejects(other.call('command_start', { ...args, argv: [process.execPath, '-e', 'console.log("twice")'] }), /different arguments/); await other.close();
});
test('provider credentials are not inherited by commands', async t => {
  const { bridge, call } = fixture(t); const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'not-a-real-key';
  try {
    const job = await call('command_start', { project: 'sample', argv: [process.execPath, '-e', 'console.log(String(process.env.OPENAI_API_KEY))'], request_id: 'env' });
    assert.equal((await finish(bridge, job.id)).output.trim(), 'undefined');
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
test('stdin interaction and EOF are supported', async t => {
  const { bridge, call } = fixture(t);
  const job = await call('command_start', { project: 'sample', argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], request_id: 'stdin' });
  await call('job_input', { job_id: job.id, text: 'hello\n', close: true });
  assert.equal((await finish(bridge, job.id)).output, 'hello\n');
});
test('command timeouts and owned-job cancellation are real', async t => {
  const { bridge, call } = fixture(t);
  const job = await call('command_start', { project: 'sample', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeout_seconds: 1, request_id: 'timeout' });
  assert.equal((await finish(bridge, job.id)).status, 'timed_out');
  const another = await call('command_start', { project: 'sample', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], request_id: 'cancel' });
  await call('job_cancel', { job_id: another.id }); assert.equal((await finish(bridge, another.id)).status, 'cancelled');
  await assert.rejects(call('job_cancel', { job_id: crypto.randomUUID() }), /owned/);
});
test('failed executable is reported as failure, not successful work', async t => {
  const { bridge, call } = fixture(t);
  const job = await call('command_start', { project: 'sample', argv: ['bridgebrain-no-such-executable'], request_id: 'missing' });
  const result = await finish(bridge, job.id); assert.equal(result.status, 'failed'); assert.match(result.output, /ENOENT/);
});
test('Git inspection, permanent worktree creation, isolation and clean removal', async t => {
  const { root, bridge, call } = fixture(t); initGit(root);
  const tree = await call('worktree_create', { project: 'sample', name: 'worker', branch: 'worker-feature' });
  assert.equal(tree.permanent, true); assert.ok(fs.existsSync(path.join(tree.path, 'code.txt')));
  await call('file_write', { project: 'worker', path: 'code.txt', content: 'worker change', expected_sha256: hash('original\n') });
  assert.equal(fs.readFileSync(path.join(root, 'code.txt'), 'utf8'), 'original\n');
  await assert.rejects(call('worktree_remove', { project: 'worker' }), /not clean/);
  await call('file_write', { project: 'worker', path: 'code.txt', content: 'original\n', expected_sha256: hash('worker change') });
  await call('worktree_remove', { project: 'worker' }); assert.equal(bridge.projects.has('worker'), false);
  assert.match((await call('git_read', { project: 'sample', operation: 'branches' })).stdout, /worker-feature/);
});
test('Git branch changes refuse dirty trees and unsafe refs', async t => {
  const { root, call } = fixture(t); initGit(root); fs.writeFileSync(path.join(root, 'other'), 'dirty');
  await assert.rejects(call('git_branch', { project: 'sample', branch: 'safe-name' }), /not clean/);
  await assert.rejects(call('git_branch', { project: 'sample', branch: '--bad' }), /Invalid Git/);
});
test('commits select individual paths and preserve unrelated edits', async t => {
  const { root, call } = fixture(t); const git = initGit(root);
  fs.writeFileSync(path.join(root, 'code.txt'), 'edited'); fs.writeFileSync(path.join(root, 'unrelated'), 'untouched');
  const head = git('rev-parse', 'HEAD');
  await call('git_commit', { project: 'sample', paths: ['code.txt'], message: 'selected change', expected_head: head });
  assert.equal(git('show', '--pretty=', '--name-only', 'HEAD'), 'code.txt'); assert.match(git('status', '--porcelain'), /unrelated/);
  fs.mkdirSync(path.join(root, 'dir')); await assert.rejects(call('git_commit', { project: 'sample', paths: ['dir'], message: 'no directory', expected_head: git('rev-parse', 'HEAD') }), /individual files/);
  git('add', 'unrelated'); await assert.rejects(call('git_commit', { project: 'sample', paths: ['code.txt'], message: 'no other index', expected_head: git('rev-parse', 'HEAD') }), /already contains/);
});
test('tool annotations honestly identify write and execution actions', async t => {
  const { bridge } = fixture(t);
  for (const name of ['command_start', 'file_write', 'desktop', 'browser', 'git_commit']) assert.equal(bridge.tools.find(t => t.name === name).annotations.readOnlyHint, false);
  assert.equal(bridge.tools.find(t => t.name === 'file_read').annotations.readOnlyHint, true);
});
test('worktree removal preserves ignored local assets and nested trees keep a stable source', async t => {
  const { root, call } = fixture(t); const git = initGit(root);
  fs.writeFileSync(path.join(root, '.gitignore'), 'local.dat\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore local assets');
  const parent = await call('worktree_create', { project: 'sample', name: 'parent', branch: 'parent-feature' });
  const child = await call('worktree_create', { project: 'parent', name: 'child', branch: 'child-feature' });
  fs.writeFileSync(path.join(parent.path, 'local.dat'), 'preserve me');
  await assert.rejects(call('worktree_remove', { project: 'parent' }), /ignored local files/);
  assert.equal(fs.readFileSync(path.join(parent.path, 'local.dat'), 'utf8'), 'preserve me');
  fs.unlinkSync(path.join(parent.path, 'local.dat'));
  await call('worktree_remove', { project: 'parent' });
  await call('worktree_remove', { project: 'child' });
  assert.equal(fs.existsSync(child.path), false);
});
