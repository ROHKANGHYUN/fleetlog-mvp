import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreConflict } from './store.mjs';
import { validateTripEvent } from '../../../packages/contracts/index.mjs';

export const MAX_BODY_BYTES = 16 * 1024;
export const DEVELOPMENT_HEADER = 'x-fleetlog-dev';
export const DEVELOPMENT_HEADER_VALUE = 'local-only';
const CROSS_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function normaliseHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function jsonResponse(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body,
  };
}

function errorResponse(status, code, message, headers = {}, details) {
  return jsonResponse(status, { error: { code, message, ...(details ? { details } : {}) } }, headers);
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

/** Exposed independently of HTTP for deterministic, networkless integration tests. */
export function createApi({ store, staticDir = DEFAULT_STATIC_DIR, port = 4000 } = {}) {
  if (!store) throw new TypeError('A TripStore is required.');
  const sameOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function staticResponse(pathname, method) {
    if (!staticDir) return errorResponse(404, 'NOT_FOUND', '경로를 찾을 수 없습니다.');
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { return errorResponse(400, 'INVALID_PATH', '잘못된 경로입니다.'); }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) {
      return errorResponse(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
    }
    const root = resolve(staticDir);
    let candidate = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!contained(root, candidate)) return errorResponse(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
    try {
      const realRoot = await realpath(root);
      let metadata;
      try { metadata = await stat(candidate); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        if (extname(decoded)) return errorResponse(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
        candidate = resolve(root, 'index.html');
        metadata = await stat(candidate);
      }
      if (!metadata.isFile()) return errorResponse(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
      const realCandidate = await realpath(candidate);
      if (!contained(realRoot, realCandidate)) return errorResponse(403, 'INVALID_PATH', '허용되지 않은 파일 경로입니다.');
      const contents = await readFile(realCandidate);
      return {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream',
          'Content-Length': String(contents.byteLength),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        },
        body: method === 'HEAD' ? Buffer.alloc(0) : contents,
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return errorResponse(404, 'WEB_BUILD_MISSING', '웹 번들이 없습니다. 먼저 웹 빌드를 실행해 주세요.');
      }
      return errorResponse(500, 'STATIC_READ_FAILED', '정적 파일을 읽지 못했습니다.');
    }
  }

  return async function dispatch(request = {}) {
    const method = (request.method ?? 'GET').toUpperCase();
    const rawPath = request.path ?? '/';
    if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
      return errorResponse(400, 'INVALID_PATH', '잘못된 요청 경로입니다.');
    }
    const pathname = rawPath.split('?')[0];
    const headers = normaliseHeaders(request.headers);
    const origin = headers.origin;
    const corsHeaders = { Vary: 'Origin' };
    if (origin && !CROSS_ORIGINS.has(origin) && !sameOrigins.has(origin)) {
      return errorResponse(403, 'ORIGIN_NOT_ALLOWED', '허용된 로컬 개발 화면에서만 접근할 수 있습니다.', corsHeaders);
    }
    if (CROSS_ORIGINS.has(origin)) corsHeaders['Access-Control-Allow-Origin'] = origin;

    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      const requestedMethod = headers['access-control-request-method'];
      const requestedHeaders = String(headers['access-control-request-headers'] ?? '')
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (!origin || !['GET', 'POST'].includes(requestedMethod) ||
          requestedHeaders.some((name) => !['content-type', DEVELOPMENT_HEADER].includes(name))) {
        return errorResponse(403, 'PREFLIGHT_NOT_ALLOWED', '허용되지 않은 개발 요청입니다.', corsHeaders);
      }
      return {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-FleetLog-Dev',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        },
        body: null,
      };
    }

    if (pathname === '/api/health' && method === 'GET') {
      return jsonResponse(200, { ok: true, source: 'mock', mode: 'local-development-only' }, corsHeaders);
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (headers[DEVELOPMENT_HEADER] !== DEVELOPMENT_HEADER_VALUE) {
        return errorResponse(403, 'DEVELOPMENT_HEADER_REQUIRED', 'X-FleetLog-Dev: local-only 헤더가 필요합니다.', corsHeaders);
      }
      try {
        if (pathname === '/api/trips' && method === 'GET') return jsonResponse(200, { trips: store.list() }, corsHeaders);
        if (pathname === '/api/exceptions' && method === 'GET') return jsonResponse(200, { trips: store.exceptions() }, corsHeaders);
        if (pathname === '/api/review-summary' && method === 'GET') return jsonResponse(200, store.summary(), corsHeaders);
        if (pathname === '/api/trip-events' && method === 'POST') {
          if (!/^application\/json(?:\s*;|$)/i.test(String(headers['content-type'] ?? ''))) {
            return errorResponse(415, 'JSON_REQUIRED', 'Content-Type: application/json이 필요합니다.', corsHeaders);
          }
          let parsed;
          try {
            const raw = Buffer.isBuffer(request.body) ? request.body.toString('utf8')
              : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
            if (raw === undefined) throw new Error('Empty body');
            if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
              return errorResponse(413, 'BODY_TOO_LARGE', '요청 본문은 16 KiB 이하여야 합니다.', corsHeaders);
            }
            parsed = JSON.parse(raw);
          } catch {
            return errorResponse(400, 'INVALID_JSON', '올바른 JSON 본문이 필요합니다.', corsHeaders);
          }
          try { validateTripEvent(parsed); }
          catch {
            return errorResponse(400, 'INVALID_EVENT', '요청이 mock 운행 이벤트 계약과 일치하지 않습니다.', corsHeaders);
          }
          try {
            const ack = store.upsert(parsed);
            return jsonResponse(200, ack, corsHeaders);
          } catch (error) {
            if (error instanceof StoreConflict) {
              return errorResponse(409, error.code, error.message, corsHeaders, error.details);
            }
            // Never expose SQLite or filesystem details to the client.
            throw error;
          }
        }
        const knownPaths = new Set(['/api/health', '/api/trips', '/api/exceptions', '/api/review-summary', '/api/trip-events']);
        return knownPaths.has(pathname)
          ? errorResponse(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 HTTP 메서드입니다.', corsHeaders)
          : errorResponse(404, 'NOT_FOUND', 'API 경로를 찾을 수 없습니다.', corsHeaders);
      } catch {
        return errorResponse(500, 'STORE_FAILED', '로컬 저장소 처리에 실패했습니다.', corsHeaders);
      }
    }
    if (!['GET', 'HEAD'].includes(method)) return errorResponse(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 HTTP 메서드입니다.');
    return staticResponse(pathname, method);
  };
}
