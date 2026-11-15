import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createPortReservation } from 'node:net';
import { startServer } from '../services/api/src/server.mjs';

const builtWeb = fileURLToPath(new URL('../apps/web/dist', import.meta.url));

async function unusedPort() {
  const reservation = createPortReservation();
  await new Promise((ok, fail) => {
    reservation.once('error', fail);
    reservation.listen(0, '127.0.0.1', ok);
  });
  const port = reservation.address().port;
  await new Promise((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
  return port;
}

/** Empty, disposable mock demo. Never accepts a database path or reuses a server. */
export async function startDemo({ port, staticDir = builtWeb, temporaryRoot = tmpdir() } = {}) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('데모 포트는 1~65535의 정수여야 합니다.');
  }
  if (!(await stat(join(staticDir, 'index.html'))).isFile()) throw new Error('먼저 npm run build를 실행하세요.');
  const directory = await mkdtemp(join(temporaryRoot, 'chagok-demo-'));
  let running;
  try {
    running = await startServer({ host: '127.0.0.1', port: port ?? await unusedPort(),
      filename: join(directory, 'demo.sqlite'), staticDir });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closing;
  return {
    address: running.address,
    directory,
    close() {
      closing ??= (async () => {
        try { await running.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      })();
      return closing;
    },
  };
}

function readPort(args) {
  if (args.length === 0) return undefined;
  const value = args.length === 1 && args[0].startsWith('--port=') ? args[0].slice(7)
    : args.length === 2 && args[0] === '--port' ? args[1] : null;
  if (!value || !/^\d+$/.test(value)) throw new Error('사용법: npm run demo -- --port=원하는포트 (생략하면 빈 포트 사용)');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('데모 포트는 1~65535의 정수여야 합니다.');
  return port;
}

export async function runDemo({ args = process.argv.slice(2), staticDir = builtWeb } = {}) {
  let demo;
  try {
    demo = await startDemo({ port: readPort(args), staticDir });
    console.log(`Fleetlog WEB MOCK 데모: ${demo.address}`);
    console.log(`새 임시 DB: ${demo.directory}`);
    console.log('새 시크릿 창/독립 브라우저 컨텍스트에서 여세요. 기존 기록은 초기화하지 않습니다.');
    console.log('Android 실행·Pleos 서비스·실차 검증이 아닙니다. 종료: Ctrl+C (이번 임시 DB만 정리)');
    const stop = () => demo.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await demo?.close();
    console.error(`데모 시작 실패: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDemo();
