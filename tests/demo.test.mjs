import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, access, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDemo } from '../scripts/demo.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chagok-demo-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Fleetlog MOCK</title>WEB MOCK');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const headers = { 'X-FleetLog-Dev': 'local-only', 'Content-Type': 'application/json' };

test('demo owns an empty independent SQLite, serves mock assets and removes only its own directory', async t => {
  const root = await fixture(t);
  const unrelated = join(root, 'keep.txt');await writeFile(unrelated, '기존 파일');
  const originalDb = process.env.FLEETLOG_DB_PATH, originalPort = process.env.PORT;
  process.env.FLEETLOG_DB_PATH = unrelated;process.env.PORT = '4000';
  t.after(() => {
    if (originalDb === undefined) delete process.env.FLEETLOG_DB_PATH; else process.env.FLEETLOG_DB_PATH = originalDb;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  });
  const demo = await startDemo({ staticDir: root, temporaryRoot: root });
  t.after(() => demo.close());
  assert.notEqual(demo.address, 'http://127.0.0.1:4000');
  assert.match(await (await fetch(demo.address)).text(), /WEB MOCK/);
  const getTrips = async () => (await (await fetch(`${demo.address}/api/trips`, { headers })).json()).trips;
  assert.deepEqual(await getTrips(), []);
  const event = { schemaVersion:1,eventType:'TRIP_UPSERT',eventId:randomUUID(),tripId:randomUUID(),localRevision:1,expectedServerVersion:0,source:'mock',
    payload:{vehicleId:'demo-car-001',driverId:'demo-driver-001',startedAt:'2026-11-15T01:00:00.000Z',endedAt:'2026-11-15T01:10:00.000Z',startOdometerM:1000,endOdometerM:2000,purpose:null,note:'',quality:'valid'} };
  const response = await fetch(`${demo.address}/api/trip-events`, { method:'POST',headers,body:JSON.stringify(event) });
  assert.equal(response.status,200);assert.equal((await getTrips()).length,1);
  await demo.close();await demo.close();
  await assert.rejects(access(demo.directory));
  await access(unrelated); // No inherited database path or unrelated data is removed.
});

test('occupied or invalid demo ports fail instead of reusing a process or leaving a temporary DB', async t => {
  const root = await fixture(t);
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail);server.listen(0,'127.0.0.1',ok); });
  t.after(() => new Promise(ok => server.close(ok)));
  const baseline = await readdir(root);
  await assert.rejects(startDemo({ port:server.address().port,staticDir:root,temporaryRoot:root }), /EADDRINUSE/);
  assert.deepEqual(await readdir(root),baseline);
  assert.equal(server.listening,true);
  await assert.rejects(startDemo({ port:0,staticDir:root,temporaryRoot:root }), /포트/);
  assert.deepEqual(await readdir(root),baseline);
});

test('demo CLI SIGTERM closes its own listener and cleans its temporary SQLite', async t => {
  const root = await fixture(t);
  // Invoke the same CLI lifecycle against a fixture web root: unit tests do not
  // depend on, modify or replace the user's existing Vite build.
  const entry = new URL('../scripts/demo.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module','-e',
    `import { runDemo } from ${JSON.stringify(entry)};await runDemo({args:[],staticDir:process.argv[1]});`,root],
    { cwd:resolve('.'),stdio:['ignore','pipe','pipe'] });
  let output='',errors='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now()+5000;
  while (!output.includes('종료: Ctrl+C') && child.exitCode === null && Date.now()<deadline) {
    await new Promise(ok=>setTimeout(ok,10));
  }
  assert.match(output,/Fleetlog WEB MOCK 데모:/,errors);
  const address=output.match(/Fleetlog WEB MOCK 데모: (http:\/\/127\.0\.0\.1:\d+)/)[1];
  const directory=output.match(/새 임시 DB: (.+)/)[1];
  assert.equal((await fetch(`${address}/api/health`)).status,200);
  const exited=once(child,'exit');child.kill('SIGTERM');const [code]=await exited;
  assert.equal(code,0,errors);
  await assert.rejects(access(directory));
  await assert.rejects(fetch(`${address}/api/health`));
});
