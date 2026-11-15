import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startMvpDemo } from '../scripts/demo-mvp.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chagok-mvp-test-'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>MVP 가상 연결</title>');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('MVP launcher owns a fresh database and ignores existing development database/port variables', async t => {
  const directory = await fixture(t), keep = join(directory, 'existing.sqlite');
  await writeFile(keep, 'do not change');
  const original = { ...process.env };
  process.env.FLEETLOG_DB_PATH = keep;process.env.PORT = '4000';process.env.HOST = '0.0.0.0';
  t.after(() => { for (const key of ['FLEETLOG_DB_PATH','PORT','HOST']) original[key] === undefined ? delete process.env[key] : process.env[key] = original[key]; });
  const demo = await startMvpDemo({ staticDir: directory, temporaryRoot: directory });
  t.after(() => demo.close());
  assert.notEqual(demo.address, 'http://127.0.0.1:4000');
  const state = await (await fetch(`${demo.address}/mvp-api/state`)).json();
  assert.equal(state.mode, 'mvp-demo');assert.equal(state.employees.length, 2);assert.equal(state.vehicles.length, 2);
  assert.deepEqual(state.connections, []);assert.ok(state.vehicles.every(vehicle => vehicle.connection === null));
  assert.equal((await fetch(`${demo.address}/api/trips`)).status, 404);
  await demo.close();await demo.close();
  await assert.rejects(access(demo.directory));await access(keep);
});

test('MVP launcher refuses an occupied port and removes only its own failed temporary directory', async t => {
  const directory = await fixture(t), server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail);server.listen(0,'127.0.0.1',ok); });
  t.after(() => new Promise(ok => server.close(ok)));
  const before = await readdir(directory);
  await assert.rejects(startMvpDemo({ port: server.address().port, staticDir: directory, temporaryRoot: directory }), /EADDRINUSE/);
  assert.equal(server.listening, true);assert.deepEqual(await readdir(directory), before);
});

test('MVP CLI prints actual screen URLs and SIGTERM cleans only its own listener and SQLite', async t => {
  const directory = await fixture(t), entry = new URL('../scripts/demo-mvp.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module','-e',
    `import {runMvpDemo} from ${JSON.stringify(entry)};await runMvpDemo({args:[],staticDir:process.argv[1]});`, directory],
    { cwd: resolve('.'), env: { ...process.env, MVP_BIND_HOST:'127.0.0.1', MVP_PUBLIC_BASE_URL:'' }, stdio:['ignore','pipe','pipe'] });
  let output='',errors='';child.stdout.on('data',chunk => output+=chunk);child.stderr.on('data',chunk => errors+=chunk);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const deadline=Date.now()+5000;
  while (!output.includes('종료: Ctrl+C') && child.exitCode === null && Date.now()<deadline) await new Promise(ok=>setTimeout(ok,10));
  assert.match(output,/Fleetlog MVP 데모: http:\/\/127\.0\.0\.1:\d+/,errors);
  const address=output.match(/Fleetlog MVP 데모: (http:\/\/127\.0\.0\.1:\d+)/)[1];
  const temporary=output.match(/새 임시 MVP DB: (.+)/)[1];
  for (const path of ['car','driver','admin','control']) assert.ok(output.includes(`${address}/mvp/${path}`));
  assert.equal((await fetch(`${address}/mvp-api/state`)).status,200);
  const exited=once(child,'exit');child.kill('SIGTERM');const [code]=await exited;
  assert.equal(code,0,errors);await assert.rejects(access(temporary));await assert.rejects(fetch(`${address}/mvp-api/state`));
});
