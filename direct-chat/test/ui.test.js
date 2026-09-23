'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { dispatch } = require('../transport');
// Opt-in real browser test. No account, Internet, local HTTP server, or existing profile.
test('real Chromium through MCP: start, tabs, snapshot, screenshot, stop', { skip: process.env.BRIDGEBRAIN_UI_TESTS !== '1' }, async t => {
  const f = fixture(t); f.config.chromiumExecutable = process.env.BRIDGEBRAIN_TEST_CHROMIUM || null;
  const call = args => f.call('browser', args);
  const tabs = await call({ operation: 'start', headless: true }); assert.equal(tabs[0].url, 'about:blank');
  const page = await call({ operation: 'snapshot' }); assert.equal(page.url, 'about:blank');
  const shot = await dispatch(f.bridge, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser', arguments: { operation: 'screenshot' } } });
  assert.equal(shot.result.isError, false); assert.ok(JSON.parse(shot.result.content[0].text).native_width > 0); assert.equal(shot.result.content[1].type, 'image');
  await assert.rejects(call({ operation: 'navigate', url: 'file:///etc/passwd' }), /HTTP/);
  await call({ operation: 'stop' });
});
