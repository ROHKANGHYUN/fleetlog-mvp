import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as reserveServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';
import { startServer } from '../services/api/src/server.mjs';
import { DEMO_DRIVER_ID, DEMO_VEHICLE_ID } from '../packages/contracts/index.mjs';
import { AdminQuery } from '../apps/web/src/admin/query.mjs';
import { defaultFilters, selectTrips } from '../apps/web/src/admin/model.mjs';

const headers = { 'X-FleetLog-Dev': 'local-only', 'Content-Type': 'application/json' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function unusedPort() {
  const reservation = reserveServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chagok-reliability-http-'));
  let running;
  try {
    // Reserve an OS-selected port rather than touching a developer server.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        running = await startServer({ host: '127.0.0.1', port: await unusedPort(), filename: join(directory, 'temporary.sqlite'), staticDir: null });
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || attempt === 2) throw error;
      }
    }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async input => {
    const response = await fetch(`${running.address}/api/trip-events`, { method: 'POST', headers, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const send = async input => {
    const response = await post(input);
    if (response.status !== 200) throw Object.assign(Error(response.body.error.message), { status: response.status, code: response.body.error.code });
    return response.body;
  };
  const get = async path => {
    const response = await fetch(`${running.address}${path}`, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const query = new AdminQuery({ fetchTrips: async () => (await get('/api/trips')).trips });
  t.after(() => query.cancel());
  const receipts = () => running.store.db.prepare('SELECT * FROM event_receipts ORDER BY event_id').all().map(row => ({ ...row }));
  return { running, post, send, get, query, receipts };
}
function event(overrides = {}, payload = {}) {
  return { schemaVersion: 1, eventType: 'TRIP_UPSERT', eventId: randomUUID(), tripId: randomUUID(), localRevision: 1,
    expectedServerVersion: 0, source: 'mock', payload: { vehicleId: DEMO_VEHICLE_ID, driverId: DEMO_DRIVER_ID,
      startedAt: '2026-11-15T01:00:00.000Z', endedAt: '2026-11-15T02:00:00.000Z', startOdometerM: 100000,
      endOdometerM: 123400, purpose: null, note: '', quality: 'valid', ...payload }, ...overrides };
}
function finish(controller) {
  if (!controller.getState().active) controller.start();
  controller.setDriving(true); controller.setDriving(false); controller.finish();
}
function correct(controller, tripId, purpose = 'business', note = '운전자 보완') {
  controller.editTrip(tripId); controller.setPurpose(purpose, note); controller.review(); controller.save();
}

test('HTTP commit followed by lost ACK retries the identical prepared event after reload without a duplicate row or receipt', async t => {
  const f = await fixture(t), storage = new MemoryStorage(), bodies = [], acknowledgements = [];
  let loseResponse = true;
  const sendEvent = async input => {
    bodies.push(JSON.stringify(input));
    const ack = await f.send(input); acknowledgements.push(ack);
    if (loseResponse) throw Error('응답 유실 모의 · 서버는 이미 저장함');
    return ack;
  };
  const c = new FleetController({ storage, sendEvent });
  finish(c); c.defer(); await c.sync();
  let local = c.getState();
  assert.equal(local.records[0].ackedLocalRevision, 0);
  assert.equal(local.outbox.length, 1);
  assert.ok(local.outbox[0].preparedEvent);
  const firstReceipt = f.receipts();
  assert.equal(firstReceipt.length, 1);
  await f.query.load();
  assert.equal(f.query.getState().trips.length, 1);
  assert.equal(selectTrips(f.query.getState().trips).summary.needsReviewCount, 1);
  const restored = new FleetController({ storage, sendEvent });
  assert.equal(restored.getState().active, false);
  assert.equal(restored.getState().screen, 'ready');
  assert.equal(restored.getState().outbox[0].eventId, local.outbox[0].eventId);
  loseResponse = false; await restored.sync();
  local = restored.getState();
  assert.equal(local.records.length, 1); assert.equal(local.outbox.length, 0);
  assert.equal(local.records[0].ackedLocalRevision, 1);
  assert.equal(bodies.length, 2); assert.equal(bodies[1], bodies[0]);
  assert.deepEqual(acknowledgements[1], acknowledgements[0]);
  assert.deepEqual(f.receipts(), firstReceipt);
  await f.query.load();
  const summary = selectTrips(f.query.getState().trips).summary;
  assert.equal(summary.receivedCount, 1); assert.equal(summary.validDistanceM, 23400);
});

test('ACK received while local persistence fails remains unacknowledged and safely replays the prepared request after reopening', async t => {
  const f = await fixture(t), memory = new MemoryStorage(), bodies = [];
  let rejectWrites = false, failAfterAck = true;
  const storage = { getItem: key => memory.getItem(key), removeItem: key => memory.removeItem(key),
    setItem: (key, value) => { if (rejectWrites) throw Error('quota after ACK'); memory.setItem(key, value); } };
  const sendEvent = async input => {
    bodies.push(JSON.stringify(input));
    const ack = await f.send(input);
    if (failAfterAck) rejectWrites = true;
    return ack;
  };
  const c = new FleetController({ storage, sendEvent }); finish(c); c.defer();
  // Whether sync reports the local I/O problem by rejection or state, it must
  // never claim the ACK was persisted or remove the only replayable request.
  await c.sync().catch(() => {});
  assert.equal(c.getState().records[0].ackedLocalRevision, 0);
  assert.equal(c.getState().outbox.length, 1);
  const persisted = JSON.parse(memory.value);
  assert.equal(persisted.records[0].ackedLocalRevision, 0);
  assert.equal(persisted.outbox.length, 1);
  assert.equal(JSON.stringify(persisted.outbox[0].preparedEvent), bodies[0]);
  const storedBeforeRetry = await f.get('/api/trips'), receiptBeforeRetry = f.receipts();
  assert.equal(storedBeforeRetry.trips.length, 1); assert.equal(receiptBeforeRetry.length, 1);
  rejectWrites = false; failAfterAck = false;
  const restored = new FleetController({ storage, sendEvent });
  assert.equal(restored.getState().active, false);
  await restored.sync();
  assert.equal(restored.getState().outbox.length, 0);
  assert.equal(restored.getState().records[0].ackedLocalRevision, 1);
  assert.equal(bodies[1], bodies[0]);
  assert.deepEqual(await f.get('/api/trips'), storedBeforeRetry);
  assert.deepEqual(f.receipts(), receiptBeforeRetry);
});

test('an in-flight older ACK cannot mark a newer correction received and only then prepares the successor version', async t => {
  const f = await fixture(t), firstStored = deferred(), releaseFirst = deferred(), secondStarted = deferred(), releaseSecond = deferred();
  const bodies = [];
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async input => {
    bodies.push(structuredClone(input));
    if (bodies.length === 1) {
      const ack = await f.send(input); firstStored.resolve(); await releaseFirst.promise; return ack;
    }
    secondStarted.resolve(); await releaseSecond.promise; return f.send(input);
  } });
  t.after(() => { releaseFirst.resolve(); releaseSecond.resolve(); });
  finish(c); c.defer();
  const tripId = c.getState().records[0].tripId;
  const syncing = c.sync(); await firstStored.promise;
  correct(c, tripId, 'personal', '전송 중 새 보완');
  assert.equal(c.getState().records[0].localRevision, 2);
  assert.equal(c.getState().outbox[1].preparedEvent, null);
  // A second explicit sync must not launch a concurrent duplicate request.
  await c.sync(); assert.equal(bodies.length, 1);
  releaseFirst.resolve(); await secondStarted.promise;
  const intermediate = c.getState();
  assert.equal(intermediate.records[0].ackedLocalRevision, 1);
  assert.equal(intermediate.records[0].localRevision, 2);
  assert.equal(intermediate.outbox.length, 1);
  assert.equal(bodies[1].expectedServerVersion, 1);
  assert.equal(bodies[1].localRevision, 2);
  const oldServer = await f.get('/api/trips');
  assert.equal(oldServer.trips[0].serverVersion, 1); assert.equal(oldServer.trips[0].payload.purpose, null);
  releaseSecond.resolve(); await syncing;
  assert.equal(c.getState().records[0].ackedLocalRevision, 2); assert.equal(c.getState().outbox.length, 0);
  await f.query.load();
  const model = selectTrips(f.query.getState().trips, { ...defaultFilters(), purpose: 'personal' });
  assert.equal(model.summary.receivedCount, 1); assert.equal(model.summary.validDistanceM, 23400);
  assert.equal(model.rows[0].serverVersion, 2); assert.equal(model.rows[0].payload.note, '전송 중 새 보완');
  assert.equal(f.receipts().length, 2);
});

test('one trip conflict holds its dependent revision but does not block an unrelated trip over HTTP', async t => {
  const f = await fixture(t), sentIds = [];
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async input => { sentIds.push(input.tripId); return f.send(input); } });
  finish(c); c.defer();
  const original = c.getState().records[0];
  const external = event({ tripId: original.tripId }, { ...original.payload, purpose: 'commute', note: '먼저 수신된 변경' });
  assert.equal((await f.post(external)).status, 200);
  correct(c, original.tripId, 'personal', '선행 충돌 뒤 보완');
  finish(c); c.defer();
  const unrelated = c.getState().records[1];
  const blockedEventIds = c.getState().outbox.filter(item => item.tripId === original.tripId).map(item => item.eventId);
  await c.sync();
  let state = c.getState();
  assert.deepEqual(sentIds, [original.tripId, unrelated.tripId]);
  assert.equal(state.outbox.length, 2);
  assert.equal(state.outbox[0].status, 'conflict');
  assert.equal(state.outbox[1].preparedEvent, null);
  assert.equal(state.records.find(row => row.tripId === original.tripId).ackedLocalRevision, 0);
  assert.equal(state.records.find(row => row.tripId === unrelated.tripId).ackedLocalRevision, 1);
  await c.sync(); state = c.getState();
  assert.deepEqual(sentIds, [original.tripId, unrelated.tripId]);
  assert.deepEqual(state.outbox.map(item => item.eventId), blockedEventIds);
  await f.query.load();
  assert.equal(selectTrips(f.query.getState().trips).summary.receivedCount, 2);
  assert.equal(f.query.getState().trips.find(row => row.tripId === original.tripId).payload.note, '먼저 수신된 변경');
  assert.equal(f.receipts().length, 2);
});

test('receipt insertion failure rolls back both a new trip and a later trip update in the same SQLite transaction', async t => {
  const f = await fixture(t), first = event();
  const failReceipt = () => f.running.store.db.exec("CREATE TRIGGER fail_test_receipt BEFORE INSERT ON event_receipts BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;");
  const allowReceipt = () => f.running.store.db.exec('DROP TRIGGER fail_test_receipt;');
  failReceipt();
  assert.equal((await f.post(first)).status, 500);
  assert.deepEqual((await f.get('/api/trips')).trips, []);
  assert.equal(f.receipts().length, 0);
  allowReceipt();
  assert.equal((await f.post(first)).status, 200);
  const originalRows = await f.get('/api/trips'), originalReceipts = f.receipts();
  const update = event({ tripId: first.tripId, localRevision: 2, expectedServerVersion: 1 }, { ...first.payload, purpose: 'business', note: '정상 보완' });
  failReceipt();
  assert.equal((await f.post(update)).status, 500);
  assert.deepEqual(await f.get('/api/trips'), originalRows);
  assert.deepEqual(f.receipts(), originalReceipts);
  allowReceipt();
  assert.equal((await f.post(update)).status, 200);
  assert.equal((await f.get('/api/trips')).trips[0].serverVersion, 2);
  assert.equal(f.receipts().length, 2);
});

test('HTTP purpose amendments cannot overwrite original times, odometers or gap quality', async t => {
  const f = await fixture(t), first = event({}, { quality: 'gap' });
  assert.equal((await f.post(first)).status, 200);
  const originalRows = await f.get('/api/trips'), originalReceipts = f.receipts();
  for (const changes of [
    { startedAt: '2026-11-15T00:00:00.000Z' }, { endedAt: '2026-11-15T03:00:00.000Z' },
    { startOdometerM: 100001 }, { endOdometerM: 124000 }, { quality: 'valid' },
  ]) {
    const amended = event({ tripId: first.tripId, localRevision: 2, expectedServerVersion: 1 }, { ...first.payload, purpose: 'business', ...changes });
    const rejected = await f.post(amended);
    assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'RAW_FIELDS_IMMUTABLE');
    assert.deepEqual(await f.get('/api/trips'), originalRows); assert.deepEqual(f.receipts(), originalReceipts);
  }
  const corrected = event({ tripId: first.tripId, localRevision: 2, expectedServerVersion: 1 }, { ...first.payload, purpose: 'business', note: '원본을 보존한 용도 보완' });
  assert.equal((await f.post(corrected)).status, 200);
  await f.query.load();
  const admin = selectTrips(f.query.getState().trips);
  assert.equal(admin.summary.receivedCount, 1); assert.equal(admin.summary.unconfirmedCount, 0);
  assert.equal(admin.summary.invalidDistanceCount, 1); assert.equal(admin.summary.validDistanceM, null);
  assert.equal(admin.exceptions.length, 1); assert.equal(admin.rows[0].serverVersion, 2);
  assert.equal(admin.rows[0].payload.quality, 'gap'); assert.equal(f.receipts().length, 2);
});

test('ending the collection session while an HTTP ACK is delayed cannot resume capture or lose the receipt', async t => {
  const f = await fixture(t), stored = deferred(), release = deferred();
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async input => {
    const ack = await f.send(input); stored.resolve(); await release.promise; return ack;
  } });
  t.after(() => release.resolve());
  finish(c); c.defer();
  const syncing = c.sync(); await stored.promise;
  c.stop(); assert.equal(c.getState().active, false); assert.equal(c.getState().screen, 'ready');
  release.resolve(); await syncing;
  const state = c.getState();
  assert.equal(state.active, false); assert.equal(state.current, null); assert.equal(state.screen, 'ready');
  assert.equal(state.records.length, 1); assert.equal(state.records[0].ackedLocalRevision, 1); assert.equal(state.outbox.length, 0);
  c.setDriving(true); assert.equal(c.getState().current, null); assert.equal(c.getState().records.length, 1);
  assert.equal((await f.get('/api/trips')).trips.length, 1); assert.equal(f.receipts().length, 1);
});

test('concurrent identical HTTP requests return one original ACK and create only one trip and receipt', async t => {
  const f = await fixture(t), input = event();
  const [first, second] = await Promise.all([f.post(input), f.post(input)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.deepEqual(first.body, second.body);
  assert.equal((await f.get('/api/trips')).trips.length, 1); assert.equal(f.receipts().length, 1);
});
