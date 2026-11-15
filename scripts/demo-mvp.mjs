import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMvpServer } from '../services/mvp/server.mjs';

const builtWeb = fileURLToPath(new URL('../apps/web/dist', import.meta.url));

/** Owns only a newly created MVP directory. Never accepts an existing database. */
export async function startMvpDemo({ port = 0, host = '127.0.0.1', publicBaseUrl,
  staticDir = builtWeb, temporaryRoot = tmpdir(), now, tokenTtlMs } = {}) {
  if (!(await stat(join(staticDir, 'index.html'))).isFile()) throw new Error('먼저 npm run build를 실행하세요.');
  const directory = await mkdtemp(join(temporaryRoot, 'chagok-mvp-'));
  let running;
  try {
    running = await startMvpServer({ host, port, publicBaseUrl, filename: join(directory, 'mvp.sqlite'), staticDir, now, tokenTtlMs });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closing;
  return { ...running, directory, close() {
    closing ??= (async () => { try { await running.close(); } finally { await rm(directory, { recursive: true, force: true }); } })();
    return closing;
  } };
}

function readPort(args) {
  if (!args.length) return 0;
  const value = args.length === 1 && args[0].startsWith('--port=') ? args[0].slice(7)
    : args.length === 2 && args[0] === '--port' ? args[1] : '';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('사용법: npm run demo:mvp [-- --port=1~65535] (생략하면 빈 포트)');
  }
  return Number(value);
}

export async function runMvpDemo({ args = process.argv.slice(2), staticDir = builtWeb } = {}) {
  try {
    const demo = await startMvpDemo({ port: readPort(args), staticDir,
      host: process.env.MVP_BIND_HOST || '127.0.0.1', publicBaseUrl: process.env.MVP_PUBLIC_BASE_URL || undefined });
    console.log(`Fleetlog MVP 데모: ${demo.address}`);
    console.log(`차량 화면: ${demo.address}/mvp/car`);
    console.log(`모바일웹 (PC 역할): ${demo.address}/mvp/driver`);
    console.log(`회사 관리자: ${demo.address}/mvp/admin`);
    console.log(`시연 패널: ${demo.address}/mvp/control`);
    console.log(`QR용 기준 주소: ${demo.publicBaseUrl ?? demo.address}`);
    console.log(`새 임시 MVP DB: ${demo.directory}`);
    console.log('가상 계정 선택이며 실제 인증이 아닙니다. 데이터는 일회성입니다.');
    console.log('기본 127.0.0.1 QR은 PC용입니다. 휴대폰은 명시적 접근 주소/네트워크 설정이 필요합니다. 자동 터널·배포 없음.');
    console.log('종료: Ctrl+C (이번 서버·임시 DB만 정리, 기존 개발 데이터 유지)');
    const stop = () => demo.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', stop);process.once('SIGTERM', stop);
  } catch (error) {
    console.error(`MVP 시작 실패: ${error.message}`);process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runMvpDemo();
