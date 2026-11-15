import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Agent } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { MvpStore } from '../services/mvp/store.mjs';
import { startMvpServer, validateMvpEnvironment } from '../services/mvp/server.mjs';

const employee1 = 'mvp-employee-001', employee2 = 'mvp-employee-002';
const vehicle1 = 'mvp-vehicle-001', vehicle2 = 'mvp-vehicle-002';
const base = 'http://127.0.0.1:12345';
function memory(t, options) { const store = new MvpStore(options);t.after(() => store.close());return store; }
function code(fn, expected) { assert.throws(fn, error => error.code === expected); }
async function server(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chagok-mvp-api-test-'));
  const staticDir = join(root, 'web');await mkdir(staticDir);await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>MVP</title>');
  const app = await startMvpServer({ filename: join(root, 'mvp.sqlite'), staticDir, ...options });
  t.after(async () => { await app.close();await rm(root, { recursive: true, force: true }); });
  return { ...app, root, staticDir };
}
async function post(app, path, body, extra = {}) {
  return fetch(`${app.address}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function rawGet(url, headers) {
  return new Promise((ok, reject) => {
    const request = httpRequest(url, { headers }, response => { response.resume();response.on('end', () => ok(response.statusCode)); });
    request.on('error', reject);request.end();
  });
}

test('MVP starts with only the explicit virtual company, employees and vehicles, never historical trips', t => {
  const store = memory(t), state = store.state();
  assert.equal(state.company.id, 'mvp-company-001');assert.match(state.company.name, /가상/);
  assert.equal(state.employees.length, 2);assert.equal(state.vehicles.length, 2);assert.deepEqual(state.connections, []);
  assert.ok(state.employees.every(e => e.companyId === state.company.id && e.name.includes('가상') && e.department && e.title));
  assert.ok(state.vehicles.every(v => v.companyId === state.company.id && v.plate.includes('가상') && v.connection === null));
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('trips','event_receipts')").all().length, 0);
});

test('opening or polling an actual one-time URL never connects, and only token hashes enter SQLite', t => {
  const store = memory(t), qr = store.qr(vehicle1, base), next = store.qr(vehicle1, base);
  assert.equal(qr.token, next.token);assert.equal(new URL(qr.url).searchParams.get('token'), qr.token);
  assert.equal(new URL(qr.url).pathname, '/mvp/driver');assert.equal(qr.token.length, 43);
  assert.equal(store.resolve(qr.token).status, 'available');assert.deepEqual(store.state().connections, []);
  const rows = store.db.prepare('SELECT * FROM mvp_qr_tokens').all();assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, qr.token);assert.doesNotMatch(JSON.stringify(rows), new RegExp(qr.token));
});

test('same employee retries create one connection; another employee cannot reuse or overwrite it', t => {
  const store = memory(t), qr = store.qr(vehicle1, base), connected = store.connect(qr.token, employee1);
  assert.deepEqual(store.connect(qr.token, employee1), connected);
  code(() => store.connect(qr.token, employee2), 'TOKEN_USED');
  assert.equal(store.state().connections.length, 1);assert.deepEqual(store.state().vehicles[0].connection, connected);
  assert.deepEqual(store.qr(vehicle1, base), { vehicleId: vehicle1, status: 'connected', connection: connected });
});

test('expiry uses the injected server clock; renewed QR differs and the expired token cannot connect', t => {
  let now = 1000;const store = memory(t, { now: () => now, tokenTtlMs: 1000 });
  const qr = store.qr(vehicle1, base);now = 2000;
  code(() => store.resolve(qr.token), 'TOKEN_EXPIRED');code(() => store.connect(qr.token, employee1), 'TOKEN_EXPIRED');
  const renewed = store.qr(vehicle1, base);assert.notEqual(renewed.token, qr.token);
  code(() => store.connect(qr.token, employee1), 'TOKEN_EXPIRED');assert.equal(store.connect(renewed.token, employee1).status, 'active');
});

test('invalid token, unregistered employee/vehicle and a different company are rejected without mutation', t => {
  const store = memory(t), qr = store.qr(vehicle1, base);
  code(() => store.resolve('bad'), 'INVALID_TOKEN');code(() => store.resolve(randomBytes(32).toString('base64url')), 'INVALID_TOKEN');
  code(() => store.connect(qr.token, 'missing-employee'), 'EMPLOYEE_NOT_FOUND');code(() => store.qr('missing-car', base), 'VEHICLE_NOT_FOUND');
  store.db.exec("INSERT INTO mvp_companies VALUES('other-company','가상 외부 회사');INSERT INTO mvp_employees VALUES('other-person','가상 다른 회사 직원','other-company','가상팀','가상직책');");
  code(() => store.connect(qr.token, 'other-person'), 'COMPANY_MISMATCH');
  assert.deepEqual(store.state().connections, []);assert.equal(store.resolve(qr.token).status, 'available');
});

test('a selected employee cannot silently switch a second vehicle while already connected', t => {
  const store = memory(t), first = store.qr(vehicle1, base), second = store.qr(vehicle2, base);
  store.connect(first.token, employee1);code(() => store.connect(second.token, employee1), 'EMPLOYEE_CONNECTED');
  assert.equal(store.connect(second.token, employee2).vehicleId, vehicle2);assert.equal(store.state().connections.length, 2);
});

test('disconnect belongs to the exact connection; old tokens and late disconnects cannot modify a new one', t => {
  const store = memory(t), oldQr = store.qr(vehicle1, base), old = store.connect(oldQr.token, employee1);
  code(() => store.disconnect(old.id, employee2), 'EMPLOYEE_MISMATCH');
  const ended = store.disconnect(old.id, employee1);assert.equal(ended.status, 'disconnected');
  code(() => store.connect(oldQr.token, employee1), 'TOKEN_INVALIDATED');
  const fresh = store.qr(vehicle1, base);assert.notEqual(fresh.token, oldQr.token);
  const current = store.connect(fresh.token, employee2);
  assert.deepEqual(store.disconnect(old.id, employee1), ended);
  code(() => store.connect(oldQr.token, employee1), 'TOKEN_INVALIDATED');
  assert.deepEqual(store.state().vehicles[0].connection, current);assert.equal(store.state().connections.length, 2);
});

test('a connection write failure rolls back consumed token state and preserves a retryable request', t => {
  const store = memory(t), qr = store.qr(vehicle1, base);
  store.db.exec("CREATE TRIGGER fail_connection BEFORE INSERT ON mvp_connections BEGIN SELECT RAISE(ABORT,'simulated full');END;");
  assert.throws(() => store.connect(qr.token, employee1), /simulated full/);
  assert.deepEqual(store.state().connections, []);assert.equal(store.resolve(qr.token).status, 'available');
  store.db.exec('DROP TRIGGER fail_connection');assert.equal(store.connect(qr.token, employee1).status, 'active');
});

test('active state is reloadable from its own SQLite without retaining the plaintext QR', async t => {
  const root = await mkdtemp(join(tmpdir(), 'chagok-mvp-persist-'));t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'mvp.sqlite');const first = new MvpStore({ filename });
  const qr = first.qr(vehicle1, base), active = first.connect(qr.token, employee1);first.close();
  const reopened = new MvpStore({ filename });t.after(() => reopened.close());
  assert.deepEqual(reopened.state().vehicles[0].connection, active);assert.deepEqual(reopened.connect(qr.token, employee1), active);
});

test('real concurrent HTTP confirmation selects one winner and exact retry is idempotent', async t => {
  const app = await server(t), qr = await (await fetch(`${app.address}/mvp-api/vehicles/${vehicle1}/qr`)).json();
  const outcomes = await Promise.all([employee1, employee2].map(employeeId => post(app, '/mvp-api/connections', { token: qr.token, employeeId })));
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200,409]);
  const winner = await outcomes.find(r => r.status === 200).json();
  const again = await post(app, '/mvp-api/connections', { token: qr.token, employeeId: winner.connection.employeeId });
  assert.equal(again.status, 200);assert.deepEqual(await again.json(), winner);
  const state = await (await fetch(`${app.address}/mvp-api/state`)).json();
  assert.equal(state.mode, 'mvp-demo');assert.equal(state.connections.length, 1);assert.deepEqual(state.vehicles[0].connection, winner.connection);
});

test('HTTP invalid JSON, extra fields, body size, foreign origin and Host never change connections', async t => {
  const app = await server(t), path = '/mvp-api/connections';
  assert.equal((await post(app, path, '{')).status, 400);
  assert.equal((await post(app, path, { token:'bad', employeeId:employee1, companyId:'invented' })).status, 400);
  assert.equal((await post(app, path, 'x'.repeat(5000))).status, 413);
  assert.equal((await post(app, path, {}, { Origin:'https://foreign.example' })).status, 403);
  // Browser-compatible fetch normalizes Host; use actual HTTP to send the hostile field.
  assert.equal(await rawGet(`${app.address}/mvp-api/state`, { Host:'attacker.example' }), 403);
  assert.deepEqual(app.store.state().connections, []);
  assert.equal((await fetch(`${app.address}/api/trips`)).status, 404);
  assert.equal((await fetch(`${app.address}/mvp-api/qr/%ZZ`)).status, 400);
});

test('static MVP pages use the build while traversal and symlink escapes are rejected', async t => {
  const app = await server(t);await mkdir(join(app.staticDir, 'assets'));await writeFile(join(app.root, 'outside.txt'), 'private fixture');
  await symlink(join(app.root, 'outside.txt'), join(app.staticDir, 'assets', 'escape.txt'));
  const page = await fetch(`${app.address}/mvp/driver?token=ignored`);
  assert.equal(page.status, 200);assert.match(await page.text(), /<title>MVP<\/title>/);assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`${app.address}/assets/escape.txt`)).status, 403);
  assert.equal((await fetch(`${app.address}/assets/%2e%2e%2foutside.txt`)).status, 403);
  assert.equal((await fetch(`${app.address}/mvp-api/reset`, { method:'POST' })).status, 404);
});

test('public QR origin is explicit without weakening the original local API or permitting wildcard binds', async t => {
  for (const host of ['0.0.0.0','::','8.8.8.8','localhost']) assert.throws(() => validateMvpEnvironment({ host, publicBaseUrl:'http://192.168.1.2:1234' }), /loopback/);
  assert.throws(() => validateMvpEnvironment({ host:'192.168.1.2' }), /loopback/);
  assert.equal(validateMvpEnvironment({ host:'192.168.1.2',publicBaseUrl:'http://192.168.1.2:1234' }), 'http://192.168.1.2:1234');
  for (const publicBaseUrl of ['file:///tmp/test','https://user:secret@example.com','https://example.com/path','https://example.com/?x=y','https://example.com/#x']) assert.throws(() => validateMvpEnvironment({ publicBaseUrl }));
  assert.throws(() => validateMvpEnvironment({ nodeEnv:'production' }), /production/);
  const app = await server(t, { publicBaseUrl:'https://mvp.example.test' });
  const qr = await (await fetch(`${app.address}/mvp-api/vehicles/${vehicle1}/qr`)).json();
  assert.equal(new URL(qr.url).origin, 'https://mvp.example.test');
  assert.equal(await rawGet(`${app.address}/mvp-api/state`, { Origin:'https://mvp.example.test',Host:'mvp.example.test' }), 200);
  assert.equal((await fetch(`${app.address}/mvp-api/state`, { headers:{ Origin:'https://other.example.test' } })).status, 403);
});

test('MVP shutdown bounds incomplete requests and keepalive sockets without changing committed connections', { timeout: 2000 }, async t => {
  const app = await server(t, { shutdownGraceMs: 10 }), other = await server(t);
  const qr = app.store.qr(vehicle1, app.address), active = app.store.connect(qr.token, employee1);
  const agent = new Agent({ keepAlive: true });t.after(() => agent.destroy());
  await new Promise((ok, reject) => {
    const req = httpRequest(`${app.address}/mvp-api/state`, { agent }, res => { res.resume();res.on('end', ok); });
    req.on('error', reject);req.end();
  });
  const url = new URL(app.address), socket = connectSocket(Number(url.port), url.hostname);
  socket.on('error', () => {});t.after(() => socket.destroy());
  await once(socket, 'connect');
  const started = once(app.server, 'request');
  socket.write(`POST /mvp-api/connections HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: keep-alive\r\n\r\n{"token":`);
  await started; // The request is inside jsonBody, deliberately never completed.
  const closed = app.close();assert.equal(app.close(), closed);
  await closed;
  assert.equal(app.server.listening, false);
  await assert.rejects(fetch(`${app.address}/mvp-api/state`));
  assert.equal((await fetch(`${other.address}/mvp-api/state`)).status, 200);
  const persisted = new DatabaseSync(join(app.root, 'mvp.sqlite'), { readOnly: true });
  try {
    const rows = persisted.prepare('SELECT id,status,employee_id,vehicle_id FROM mvp_connections').all();
    assert.deepEqual(rows.map(row => ({ ...row })), [{ id:active.id,status:'active',employee_id:employee1,vehicle_id:vehicle1 }]);
    assert.equal(persisted.prepare("SELECT COUNT(*) AS count FROM mvp_qr_tokens WHERE status='used'").get().count, 1);
  } finally { persisted.close(); }
});
