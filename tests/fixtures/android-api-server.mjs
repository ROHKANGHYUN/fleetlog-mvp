// Kotlin/JVM integration fixture. Never opens the development SQLite file.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startServer } from '../../services/api/src/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'chagok-android-http-'));
let running;
async function close() { await running?.close(); await rm(directory, { recursive: true, force: true }); }
try {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  running = await startServer({ port, filename: join(directory, 'test.sqlite') });
  console.log(JSON.stringify({ address: running.address }));
  process.stdin.resume();
  process.stdin.once('end', () => close().catch(error => { console.error(error.message); process.exitCode = 1; }));
  process.once('SIGTERM', () => close().catch(() => {}));
  process.once('SIGINT', () => close().catch(() => {}));
} catch (error) { await close(); throw error; }
