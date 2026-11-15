import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApi, MAX_BODY_BYTES } from './app.mjs';
import { TripStore } from './store.mjs';

export function assertLocalDevelopment({ host = '127.0.0.1', nodeEnv = process.env.NODE_ENV } = {}) {
  if (String(nodeEnv ?? '').trim().toLowerCase() === 'production') {
    throw new Error('This mock API refuses NODE_ENV=production. Production authentication and controls are not implemented.');
  }
  if (host !== '127.0.0.1') throw new Error('This mock API may bind only to 127.0.0.1. External and wildcard bindings are forbidden.');
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    let chunks = [];
    request.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks = [];
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolveBody(Buffer.concat(chunks)); });
    request.on('aborted', () => reject(Object.assign(new Error('Request aborted'), { status: 400 })));
    request.on('error', reject);
  });
}

function writeResponse(response, result) {
  response.writeHead(result.status, result.headers);
  if (result.body === null || result.body === undefined) response.end();
  else if (Buffer.isBuffer(result.body) || typeof result.body === 'string') response.end(result.body);
  else response.end(JSON.stringify(result.body));
}

export async function startServer({
  host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 4000),
  filename = process.env.FLEETLOG_DB_PATH ?? fileURLToPath(new URL('../data/fleetlog.sqlite', import.meta.url)),
  staticDir,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  // An options object must not override the real process-level production guard.
  assertLocalDevelopment({ host, nodeEnv: process.env.NODE_ENV });
  assertLocalDevelopment({ host, nodeEnv });
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const store = new TripStore({ filename });
  const dispatch = createApi({ store, staticDir, port });
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const result = await dispatch({ method: request.method, path: request.url, headers: request.headers, body });
      writeResponse(response, result);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      writeResponse(response, {
        status: error.status ?? 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: { error: { code: error.status === 413 ? 'BODY_TOO_LARGE' : 'REQUEST_FAILED', message: error.status === 413 ? '요청 본문은 16 KiB 이하여야 합니다.' : '요청을 처리하지 못했습니다.' } },
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolveListen);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let closed = false;
  return {
    server,
    store,
    dispatch,
    address: `http://${host}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      store.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = await startServer();
    console.log(`Fleetlog mock API: ${running.address} (local development only)`);
    console.log('No production authentication, period closing, or tax filing is implemented.');
    const shutdown = () => running.close().catch((error) => { console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
