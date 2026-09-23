'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { fixture } = require('./helpers');
const { jsonWrite, hash } = require('../core');
const { dispatch, startStdio, startHTTP, approveOAuth, loadOAuth, publicOrigin, validRedirect } = require('../transport');
const origin = 'https://bridge.example.invalid';
const redirect = 'https://chatgpt.com/connector_platform/oauth_redirect';
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
async function httpFixture(t) {
  const f = fixture(t); f.config.publicUrl = origin; jsonWrite(f.configFile, f.config);
  const server = startHTTP(f.bridge, 0); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { redirect: 'manual', ...options });
  const mcp = (message, token = f.config.localBearerToken, headers = {}) => request('/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(message) });
  const form = data => request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  async function pairing(scope = 'bridge.read bridge.write bridge.exec') {
    const reg = await request('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
    assert.equal(reg.status, 201); const client = (await reg.json()).client_id;
    const verifier = crypto.randomBytes(48).toString('base64url');
    const query = new URLSearchParams({ client_id: client, redirect_uri: redirect, response_type: 'code', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), resource: origin + '/mcp', scope, state: 'csrf-test-state' });
    const auth = await request('/authorize?' + query); assert.equal(auth.status, 200);
    const page = await auth.text(); const id = /node cli\.js approve ([A-Za-z0-9_-]{43})/.exec(page)[1];
    assert.match(page, /local computer/); assert.equal((await request('/oauth/finish?id=' + id)).status, 200);
    approveOAuth(f.bridge, id);
    const finish = await request('/oauth/finish?id=' + id); assert.equal(finish.status, 302);
    const callback = new URL(finish.headers.get('location')); assert.equal(callback.searchParams.get('state'), 'csrf-test-state');
    const exchange = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: verifier, client_id: client, redirect_uri: redirect, resource: origin + '/mcp' };
    return { client, id, exchange };
  }
  return { ...f, server, request, mcp, form, pairing };
}
test('RPC validation, negotiation and notifications cannot execute writes', async t => {
  const f = fixture(t);
  assert.equal((await dispatch(f.bridge, {})).error.code, -32600);
  assert.equal((await dispatch(f.bridge, rpc('unknown'))).error.code, -32601);
  assert.equal((await dispatch(f.bridge, rpc('initialize', { protocolVersion: '2025-06-18' }))).result.protocolVersion, '2025-06-18');
  assert.equal((await dispatch(f.bridge, rpc('initialize', { protocolVersion: 'future' }))).result.protocolVersion, '2025-11-25');
  assert.equal(await dispatch(f.bridge, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'file_write', arguments: { project: 'sample', path: 'bad', content: 'no', expected_sha256: '' } } }), null);
  assert.equal(fs.existsSync(path.join(f.root, 'bad')), false);
});
test('stdio emits only JSON-RPC and supports multiple bounded requests', async t => {
  const f = fixture(t), input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', data => { text += data; });
  let done; const ended = new Promise(r => { done = r; }); startStdio(f.bridge, input, output, async () => done());
  input.end('not-json\n' + JSON.stringify(rpc('initialize')) + '\n' + JSON.stringify(rpc('tools/call', { name: 'bridge_status' }, 2)) + '\n');
  await ended; const replies = text.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3); assert.equal(replies[0].error.code, -32700);
  assert.equal(JSON.parse(replies.find(r => r.id === 2).result.content[0].text).invokes_codex, false);
});
test('HTTP is loopback-only and unauthenticated tools never execute', async t => {
  const f = await httpFixture(t); assert.equal(f.server.address().address, '127.0.0.1');
  const denied = await f.mcp(rpc('tools/list'), null); assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /resource_metadata/);
  assert.equal((await f.mcp(rpc('tools/list'), 'invalid')).status, 401);
  assert.equal((await f.mcp(rpc('ping'))).status, 200);
});
test('HTTP rejects hostile Origin/Host, bad versions and unsupported framing', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.mcp(rpc('ping'), undefined, { origin: 'https://attacker.invalid' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.server.address().port, path: '/mcp', headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await f.mcp(rpc('ping'), undefined, { 'mcp-protocol-version': 'made-up' })).status, 400);
  assert.equal((await f.mcp(rpc('ping'), undefined, { accept: 'text/html' })).status, 406);
  assert.equal((await f.request('/mcp', { headers: { authorization: `Bearer ${f.config.localBearerToken}` } })).status, 405);
  assert.equal((await f.mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});
test('OAuth discovery and per-tool scopes describe real write permissions', async t => {
  const f = await httpFixture(t);
  const meta = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json(); assert.equal(meta.resource, origin + '/mcp');
  const auth = await (await f.request('/.well-known/oauth-authorization-server')).json(); assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
  const list = await (await f.mcp(rpc('tools/list'))).json();
  assert.deepEqual(list.result.tools.find(t => t.name === 'file_write').securitySchemes, [{ type: 'oauth2', scopes: ['bridge.write'] }]);
});
test('OAuth requires local approval, correct PKCE/resource, and single-use code', async t => {
  const f = await httpFixture(t), p = await f.pairing();
  assert.equal((await f.form({ ...p.exchange, code_verifier: 'wrong'.repeat(12) })).status, 400);
  assert.equal((await f.form({ ...p.exchange, resource: 'https://wrong.invalid/mcp' })).status, 400);
  const response = await f.form(p.exchange); assert.equal(response.status, 200); const token = await response.json();
  assert.equal((await f.mcp(rpc('tools/call', { name: 'bridge_status' }), token.access_token)).status, 200);
  assert.equal((await f.form(p.exchange)).status, 400);
  const serialized = fs.readFileSync(path.join(f.bridge.state, 'oauth-state.json'), 'utf8');
  assert.equal(serialized.includes(token.access_token), false); assert.equal(serialized.includes(token.refresh_token), false); assert.equal(serialized.includes(p.exchange.code), false);
});
test('OAuth refresh rotates tokens and binds the client/resource', async t => {
  const f = await httpFixture(t), p = await f.pairing(); const first = await (await f.form(p.exchange)).json();
  const data = { grant_type: 'refresh_token', client_id: p.client, resource: origin + '/mcp', refresh_token: first.refresh_token };
  assert.equal((await f.form({ ...data, client_id: 'other' })).status, 400);
  const second = await (await f.form(data)).json(); assert.ok(second.access_token); assert.notEqual(first.refresh_token, second.refresh_token);
  assert.equal((await f.form(data)).status, 400);
});
test('read-only OAuth grants cannot write and return an actionable challenge', async t => {
  const f = await httpFixture(t), p = await f.pairing('bridge.read'); const token = await (await f.form(p.exchange)).json();
  const denied = await (await f.mcp(rpc('tools/call', { name: 'file_write', arguments: { project: 'sample', path: 'no', content: 'no', expected_sha256: '' } }), token.access_token)).json();
  assert.equal(denied.result.isError, true); assert.match(denied.result._meta['mcp/www_authenticate'][0], /insufficient_scope/);
  assert.equal(fs.existsSync(path.join(f.root, 'no')), false);
});
test('expired and locally revoked tokens cannot call tools', async t => {
  const f = await httpFixture(t), p = await f.pairing(); const token = await (await f.form(p.exchange)).json();
  const store = loadOAuth(f.bridge); store.tokens[hash(token.access_token)].expires = 1; jsonWrite(path.join(f.bridge.state, 'oauth-state.json'), store);
  assert.equal((await f.mcp(rpc('ping'), token.access_token)).status, 401);
  const old = f.config.localBearerToken; f.config.localBearerToken = crypto.randomBytes(32).toString('base64url'); jsonWrite(f.configFile, f.config);
  assert.equal((await f.mcp(rpc('ping'), old)).status, 401);
});
test('registration and public URL checks reject credential/redirect leaks', async t => {
  const f = await httpFixture(t);
  for (const value of ['https://attacker.invalid/callback', redirect + '?leak=1', 'http://chatgpt.com/connector_platform/oauth_redirect', 'https://chatgpt.com@attacker.invalid/connector_platform/oauth_redirect']) assert.equal(validRedirect(value), false);
  const res = await f.request('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://attacker.invalid/callback'] }) }); assert.equal(res.status, 400);
  for (const value of ['http://unsafe.invalid', 'https://user:pass@host.invalid', 'https://host.invalid/path']) assert.throws(() => publicOrigin(value));
});
