import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlServer } from '../interfaces/control/control-server.js';

async function runningServer(t, api = {}) {
  const implementation = {
    async initialize() {},
    async handleGet(pathname) { if (pathname === '/api/fail') throw new Error('secret C:\\private\\token.txt'); return { pathname }; },
    async handlePost(pathname, body) { return { pathname, body }; },
    ...api
  };
  const control = createControlServer({ api: implementation, port: 0 });
  const address = await control.start();
  t.after(() => control.stop());
  return { control, address };
}

test('control service refuses non-loopback binding', () => {
  assert.throws(() => createControlServer({ api: {}, host: '0.0.0.0' }), { code: 'UNSAFE_CONTROL_BIND' });
});

test('control service handles a preferred-port collision with a bounded fallback', async (t) => {
  const first = await runningServer(t);
  const api = { async initialize() {}, async handleGet() { return { ok: true }; }, async handlePost() { return { ok: true }; } };
  const second = createControlServer({ api, port: first.address.port, findAvailable: true });
  t.after(() => second.stop());
  const address = await second.start();
  assert.equal(address.host, '127.0.0.1');
  assert.notEqual(address.port, first.address.port);
});

test('control service serves the offline dashboard and safe GET API', async (t) => {
  const { address } = await runningServer(t);
  const page = await fetch(address.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Local control plane/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const response = await fetch(`${address.url}/api/health`);
  assert.deepEqual(await response.json(), { pathname: '/api/health' });
  assert.ok(response.headers.get('x-ai-router-control'));
});

test('state-changing API requires matching origin and process nonce', async (t) => {
  const { address } = await runningServer(t);
  const discovery = await fetch(`${address.url}/api/health`);
  const nonce = discovery.headers.get('x-ai-router-control');
  for (const headers of [
    { origin: 'http://evil.invalid', 'content-type': 'application/json', 'x-ai-router-control': nonce },
    { origin: address.url, 'content-type': 'application/json', 'x-ai-router-control': 'wrong' }
  ]) {
    const rejected = await fetch(`${address.url}/api/settings`, { method: 'POST', headers, body: '{}' });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /UNSAFE_CONTROL_ORIGIN|CONTROL_VERIFICATION_FAILED/);
  }
  const accepted = await fetch(`${address.url}/api/settings`, { method: 'POST', headers: { origin: address.url, 'content-type': 'application/json', 'x-ai-router-control': nonce }, body: '{"theme":"dark"}' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { pathname: '/api/settings', body: { theme: 'dark' } });
});

test('control service rejects invalid bodies and unsafe static paths', async (t) => {
  const { address } = await runningServer(t);
  const discovery = await fetch(`${address.url}/api/health`);
  const headers = { origin: address.url, 'content-type': 'application/json', 'x-ai-router-control': discovery.headers.get('x-ai-router-control') };
  const invalid = await fetch(`${address.url}/api/settings`, { method: 'POST', headers, body: '{' });
  assert.equal((await invalid.json()).error, 'INVALID_CONTROL_JSON');
  const traversal = await fetch(`${address.url}/..%2fpackage.json`);
  assert.equal(traversal.status, 404);
});

test('unexpected failures are sanitized without stack, path, or secret details', async (t) => {
  const { address } = await runningServer(t);
  const response = await fetch(`${address.url}/api/fail`);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'CONTROL_INTERNAL_ERROR', message: 'The local control service could not complete the request.' });
  assert.doesNotMatch(JSON.stringify(body), /private|token|stack/i);
});
