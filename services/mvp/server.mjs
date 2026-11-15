import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MvpStore, MvpError } from './store.mjs';

const DEFAULT_STATIC = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const fail = (status, code, message) => { throw new MvpError(status, code, message); };
function privateHost(host) {
  if (isIP(host) !== 4) return false;
  const [a,b] = host.split('.').map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}
export function validateMvpEnvironment({ host = '127.0.0.1', publicBaseUrl, nodeEnv = process.env.NODE_ENV } = {}) {
  if (String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production' || String(nodeEnv ?? '').trim().toLowerCase() === 'production') throw new Error('MVP demo refuses production mode.');
  if (host !== '127.0.0.1' && (!privateHost(host) || !publicBaseUrl)) throw new Error('MVP binds only loopback, or an explicitly selected private IPv4 with publicBaseUrl.');
  if (publicBaseUrl) {
    if (typeof publicBaseUrl !== 'string' || publicBaseUrl.length > 300) throw new Error('MVP_PUBLIC_BASE_URL must be at most 300 characters.');
    let value;
    try { value = new URL(publicBaseUrl); } catch { throw new Error('MVP_PUBLIC_BASE_URL must be an http(s) origin.'); }
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash || value.pathname !== '/' || value.origin === 'null') throw new Error('MVP_PUBLIC_BASE_URL must be an http(s) origin without a path, credentials, query or fragment.');
    return value.origin;
  }
  return null;
}
function contained(root, path) { const part = relative(root, path); return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); }
async function staticFile(pathname, staticDir, method) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { fail(400, 'INVALID_PATH', '잘못된 요청 경로입니다.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) fail(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
  const isMvpPage = ['/mvp', '/mvp/', '/mvp/car', '/mvp/driver', '/mvp/admin', '/mvp/control'].includes(decoded);
  if (!isMvpPage && !decoded.startsWith('/assets/')) fail(404, 'NOT_FOUND', 'MVP 경로를 찾을 수 없습니다.');
  const root = resolve(staticDir), candidate = resolve(root, `.${isMvpPage ? '/index.html' : decoded}`);
  if (!contained(root, candidate)) fail(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
  try {
    const [realRoot, realCandidate, metadata] = await Promise.all([realpath(root), realpath(candidate), stat(candidate)]);
    if (!metadata.isFile() || !contained(realRoot, realCandidate)) fail(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
    const contents = await readFile(realCandidate);
    return { status: 200, headers: { ...HEADERS, 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' }, body: method === 'HEAD' ? null : contents };
  } catch (error) {
    if (error instanceof MvpError) throw error;
    if (['ENOENT','ENOTDIR'].includes(error.code)) fail(404, 'WEB_BUILD_MISSING', '먼저 npm run build를 실행해 주세요.');
    throw error;
  }
}
async function jsonBody(request, keys) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? ''))) fail(415, 'JSON_REQUIRED', 'JSON 요청이 필요합니다.');
  const raw = await new Promise((ok, reject) => {
    let size = 0, rejected = false, chunks = [];
    request.on('data', chunk => {
      if (rejected) return;
      size += chunk.byteLength;
      if (size > 4096) { rejected = true;chunks = [];reject(new MvpError(413, 'BODY_TOO_LARGE', '요청 본문이 너무 큽니다.'));return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) ok(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', reject);
    request.on('aborted', () => reject(new MvpError(400, 'INVALID_REQUEST', '요청이 중단됐습니다.')));
  });
  let body;
  try { body = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', '올바른 JSON 요청이 필요합니다.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || keys && (Object.keys(body).length !== keys.length || keys.some(key => typeof body[key] !== 'string' || !body[key] || body[key].length > 200) || Object.keys(body).some(key => !keys.includes(key)))) fail(400, 'INVALID_REQUEST', '필수 요청 항목을 확인해 주세요.');
  return body;
}
function fields(body, required, optional=[]) {
  if (required.some(key=>typeof body[key]!=='string'||!body[key]||body[key].length>200) || Object.keys(body).some(key=>![...required,...optional].includes(key)) || optional.some(key=>key in body&&(typeof body[key]!=='string'||body[key].length>200))) fail(400,'INVALID_REQUEST','시연 요청 항목을 확인해 주세요.');
  return body;
}
function write(response, { status, headers = HEADERS, body }) {
  response.writeHead(status, headers);
  response.end(body === null || body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
function decode(value) { try { return decodeURIComponent(value); } catch { fail(400, 'INVALID_PATH', '잘못된 요청 경로입니다.'); } }

/** New MVP endpoint only; it does not load the old TripStore or run its APIs. */
export async function startMvpServer({ host = '127.0.0.1', port = 0, filename = ':memory:', staticDir = DEFAULT_STATIC, publicBaseUrl, now = () => Date.now(), tokenTtlMs = 600_000, shutdownGraceMs = 1000, nodeEnv } = {}) {
  const externalOrigin = validateMvpEnvironment({ host, publicBaseUrl, nodeEnv });
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MVP port must be 0~65535.');
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 0 || shutdownGraceMs > 30_000) throw new Error('shutdownGraceMs must be 0~30000.');
  const store = new MvpStore({ filename, now, tokenTtlMs });
  let address, baseUrl;
  const server = createServer(async (request, response) => {
    try {
      const allowedOrigins = new Set([address, baseUrl]);
      const allowedHosts = new Set([...allowedOrigins].map(value => new URL(value).host));
      // The explicit proxy-facing hostname may be forwarded unchanged; never trust arbitrary Host.
      if (!allowedHosts.has(request.headers.host)) fail(403, 'HOST_NOT_ALLOWED', '허용된 MVP 주소로 접속해 주세요.');
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) fail(403, 'ORIGIN_NOT_ALLOWED', '허용된 MVP 화면에서 요청해 주세요.');
      if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//')) fail(400, 'INVALID_PATH', '잘못된 요청 경로입니다.');
      const path = request.url.split('?')[0], method = request.method;
      let body;
      if (path === '/mvp-api/state' && method === 'GET') body = { ...store.state(), mode: 'mvp-demo', publicBaseUrl: baseUrl, pollIntervalMs: 1000 };
      else if (/^\/mvp-api\/vehicles\/[^/]+\/qr$/.test(path) && method === 'GET') body = store.qr(decode(path.split('/')[3]), baseUrl);
      else if (/^\/mvp-api\/qr\/[^/]+$/.test(path) && method === 'GET') body = store.resolve(decode(path.split('/')[3]));
      else if (/^\/mvp-api\/codes\/[^/]+$/.test(path) && method === 'GET') body = store.resolveCode(decode(path.split('/')[3]));
      else if (path === '/mvp-api/connections' && method === 'POST') {
        const value=await jsonBody(request);
        if ('code' in value && !('token' in value)) { fields(value,['code','employeeId']);body={connection:store.connectCode(value.code,value.employeeId)}; }
        else { fields(value,['token','employeeId']);body={connection:store.connect(value.token,value.employeeId)}; }
      }
      else if (/^\/mvp-api\/connections\/[^/]+\/disconnect$/.test(path) && method === 'POST') { const value = await jsonBody(request, ['employeeId']); body = { connection: store.disconnect(decode(path.split('/')[3]), value.employeeId) }; }
      else if (path === '/mvp-api/commands' && method === 'POST') body = store.workflow.command(fields(await jsonBody(request),['commandId','connectionId','type'],['value','tripId','promptId','conversationId']));
      else if (path === '/mvp-api/voice/claim' && method === 'POST') body = store.workflow.claim(fields(await jsonBody(request),['promptId','clientId']));
      else if (path === '/mvp-api/voice/complete' && method === 'POST') body = store.workflow.complete(fields(await jsonBody(request),['commandId','promptId','clientId','outcome']));
      else if (path === '/mvp-api/trip-events' && method === 'POST') body = store.workflow.receive(await jsonBody(request));
      else if (/^\/mvp-api\/trips\/[^/]+\/amendments$/.test(path) && method === 'POST') body = store.reporting.amend(decode(path.split('/')[3]), await jsonBody(request));
      else if (path === '/mvp-api/monthly' && method === 'GET') {
        const parameters = new URL(request.url, address).searchParams;
        if (parameters.getAll('month').length !== 1 || [...parameters.keys()].some(key => key !== 'month')) fail(400, 'INVALID_MONTH', '회사 전체 월별 자료에는 월만 지정해 주세요.');
        body = store.reporting.monthly(parameters.get('month'));
      }
      else if (path === '/mvp-api/reports' && method === 'POST') body = store.reporting.createReport(await jsonBody(request));
      else if (/^\/mvp-api\/reports\/[^/]+\/(trips|costs)\.csv$/.test(path) && method === 'GET') {
        const file = store.reporting.csv(decode(path.split('/')[3]), path.endsWith('/trips.csv') ? 'trips' : 'costs');
        if (!/^[A-Za-z0-9._-]+$/.test(file.filename)) throw new Error('Invalid report download filename');
        write(response, { status: 200, headers: { ...HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.filename}"` }, body: file.body });return;
      }
      else if (/^\/mvp-api\/reports\/[^/]+$/.test(path) && method === 'GET') body = { report: store.reporting.report(decode(path.split('/')[3])) };
      else if (path === '/mvp-api/submissions' && method === 'POST') body = store.reporting.submit(await jsonBody(request));
      else if (path === '/mvp-api/simulation/submission-outcome' && method === 'POST') body = store.reporting.setSimulationMode(await jsonBody(request));
      else if (/^\/mvp-api\/vehicles\/[^/]+\/upload-mode$/.test(path) && method === 'POST') {
        const value=await jsonBody(request);
        if (Object.keys(value).length!==1 || typeof value.blocked!=='boolean') fail(400,'INVALID_UPLOAD_MODE','업로드 차단 여부를 확인해 주세요.');
        body=store.workflow.setUploadMode(decode(path.split('/')[3]),value.blocked);
      }
      else if (path.startsWith('/mvp-api/')) fail(404, 'NOT_FOUND', 'MVP API 경로를 찾을 수 없습니다.');
      else if (method === 'GET' || method === 'HEAD') { write(response, await staticFile(path, staticDir, method)); return; }
      else fail(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청입니다.');
      write(response, { status: 200, body });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      write(response, { status: error instanceof MvpError ? error.status : 500, body: { error: { code: error instanceof MvpError ? error.code : 'MVP_FAILED', message: error instanceof MvpError ? error.message : 'MVP 요청을 처리하지 못했습니다. 입력과 기존 기록을 보존한 뒤 상태를 다시 확인해 주세요.' } } });
    }
  });
  server.requestTimeout = 15_000;server.headersTimeout = 10_000;server.keepAliveTimeout = 5_000;
  try { await new Promise((ok, failListen) => { server.once('error', failListen);server.listen(port, host, ok); }); }
  catch (error) { store.close();throw error; }
  address = `http://${host}:${server.address().port}`;
  baseUrl = externalOrigin ?? address;
  let closing;
  return { server, store, address, publicBaseUrl: baseUrl,
    close() {
      return closing ??= (async () => {
        let timer;
        try {
          await new Promise((ok, failClose) => {
            // Stop accepting first; then bound only this server's existing sockets.
            timer = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
            server.close(error => {
              clearTimeout(timer);
              if (error) failClose(error); else ok();
            });
            server.closeIdleConnections();
          });
        } finally {
          clearTimeout(timer);
          store.close();
        }
      })();
    },
  };
}
