import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AiRouterError } from '../../core/errors.js';

const DASHBOARD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, value, nonce) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    ...(nonce ? { 'x-ai-router-control': nonce } : {})
  });
  response.end(body);
}

function safeError(error) {
  if (error instanceof AiRouterError) {
    const status = error.code === 'CONTROL_ENDPOINT_NOT_FOUND' ? 404 : error.code?.includes('NOT_FOUND') ? 404 : error.code?.includes('EXISTS') ? 409 : 400;
    return { status, body: { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
  }
  return { status: 500, body: { error: 'CONTROL_INTERNAL_ERROR', message: 'The local control service could not complete the request.' } };
}

async function bodyJson(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new AiRouterError('JSON content type is required.', 'INVALID_CONTROL_CONTENT_TYPE');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AiRouterError('Request body is too large.', 'CONTROL_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new AiRouterError('Request body is not valid JSON.', 'INVALID_CONTROL_JSON'); }
}

export function createControlServer({ api, host = '127.0.0.1', port = 43127, findAvailable = false, dashboardRoot = DASHBOARD_ROOT, onShutdown = null }) {
  if (host !== '127.0.0.1') throw new AiRouterError('The control service may bind only to 127.0.0.1.', 'UNSAFE_CONTROL_BIND');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AiRouterError('Control port is invalid.', 'INVALID_CONTROL_PORT');
  const nonce = randomBytes(24).toString('base64url');
  let activePort = port;
  let stopping = false;

  const server = http.createServer(async (request, response) => {
    try {
      const hostHeader = request.headers.host ?? '';
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(hostHeader)) throw new AiRouterError('Invalid local host header.', 'UNSAFE_CONTROL_HOST');
      const url = new URL(request.url ?? '/', `http://${hostHeader}`);
      const expectedOrigin = `http://127.0.0.1:${activePort}`;
      const origin = request.headers.origin;
      if (origin && origin !== expectedOrigin) throw new AiRouterError('Cross-origin control requests are not allowed.', 'UNSAFE_CONTROL_ORIGIN');

      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const [name, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(path.join(dashboardRoot, name));
        response.writeHead(200, {
          'content-type': contentType, 'content-length': content.length, 'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        });
        response.end(content); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/')) return json(response, 200, await api.handleGet(url.pathname, url.searchParams), nonce);
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (origin !== expectedOrigin || request.headers['x-ai-router-control'] !== nonce) throw new AiRouterError('Control request verification failed.', 'CONTROL_VERIFICATION_FAILED');
        const body = await bodyJson(request);
        if (url.pathname === '/api/shutdown') {
          json(response, 202, { status: 'stopping' });
          if (!stopping) { stopping = true; setImmediate(async () => { await onShutdown?.(); await stop(); }); }
          return;
        }
        return json(response, 200, await api.handlePost(url.pathname, body));
      }
      throw new AiRouterError('Endpoint not found.', 'CONTROL_ENDPOINT_NOT_FOUND');
    } catch (error) {
      const safe = safeError(error); json(response, safe.status, safe.body);
    }
  });

  function listen(candidate) {
    return new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening); server.listen(candidate, host);
    });
  }

  async function start() {
    await api.initialize?.();
    let candidate = port;
    while (true) {
      try { await listen(candidate); break; }
      catch (error) {
        if (!(findAvailable && error.code === 'EADDRINUSE' && candidate < Math.min(65535, port + 20))) throw error;
        candidate += 1;
      }
    }
    activePort = server.address().port;
    return { host, port: activePort, url: `http://${host}:${activePort}` };
  }

  function stop() {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return { start, stop, server, get address() { return server.listening ? { host, port: activePort, url: `http://${host}:${activePort}` } : null; } };
}

export { safeError };
