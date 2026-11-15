import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TripStore } from '../src/store.mjs';
import { createApi, MAX_BODY_BYTES } from '../src/app.mjs';
import { assertLocalDevelopment, startServer } from '../src/server.mjs';
import { DEMO_DRIVER_ID, DEMO_VEHICLE_ID } from '../../../packages/contracts/index.mjs';

const headers = { 'X-FleetLog-Dev': 'local-only', 'Content-Type': 'application/json' };
function event(overrides = {}, payloadOverrides = {}) {
  return {
    schemaVersion: 1,
    eventType: 'TRIP_UPSERT',
    eventId: randomUUID(),
    tripId: randomUUID(),
    localRevision: 1,
    expectedServerVersion: 0,
    source: 'mock',
    payload: {
      vehicleId: DEMO_VEHICLE_ID,
      driverId: DEMO_DRIVER_ID,
      startedAt: '2026-11-14T01:00:00.000Z',
      endedAt: '2026-11-14T01:30:00.000Z',
      startOdometerM: 100_000,
      endOdometerM: 123_000,
      purpose: null,
      note: '',
      quality: 'valid',
      ...payloadOverrides,
    },
    ...overrides,
  };
}
function fixture(t, options = {}) {
  const store = new TripStore(options);
  t.after(() => store.close());
  const dispatch = createApi({ store, staticDir: null });
  return { store, dispatch };
}
const post = (dispatch, body, requestHeaders = headers) => dispatch({ method: 'POST', path: '/api/trip-events', headers: requestHeaders, body });
const get = (dispatch, path) => dispatch({ method: 'GET', path, headers });

test('health is public while data APIs require the development marker', async (t) => {
  const { dispatch } = fixture(t);
  const health = await dispatch({ path: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.source, 'mock');
  assert.equal((await dispatch({ path: '/api/trips' })).status, 403);
  assert.equal((await dispatch({ path: '/api/trips', headers: { 'X-FleetLog-Dev': 'not-authentication' } })).status, 403);
  assert.deepEqual((await get(dispatch, '/api/trips')).body, { trips: [] });
});

test('unconfirmed records are received, listed as exceptions, and can be corrected', async (t) => {
  const { dispatch } = fixture(t);
  const first = event();
  const received = await post(dispatch, first);
  assert.equal(received.status, 200);
  assert.deepEqual(received.body, { eventId: first.eventId, ackedLocalRevision: 1, serverVersion: 1 });
  const stored = (await get(dispatch, '/api/trips')).body.trips;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload.purpose, null);
  assert.equal((await get(dispatch, '/api/exceptions')).body.trips.length, 1);
  const incomplete = (await get(dispatch, '/api/review-summary')).body;
  assert.equal(incomplete.unconfirmedCount, 1);
  assert.equal(incomplete.readyForPurposeReview, false);

  const update = event({ tripId: first.tripId, localRevision: 2, expectedServerVersion: 1 }, { purpose: 'business', note: 'OO상사 미팅' });
  assert.equal((await post(dispatch, update)).body.serverVersion, 2);
  assert.equal((await get(dispatch, '/api/exceptions')).body.trips.length, 0);
  const complete = (await get(dispatch, '/api/review-summary')).body;
  assert.equal(complete.readyForPurposeReview, true);
  assert.match(complete.notice, /마감.*세무신고 완료를 뜻하지 않습니다/);
});

test('gap records remain exceptions even after purpose confirmation', async (t) => {
  const { dispatch } = fixture(t);
  assert.equal((await post(dispatch, event({}, { purpose: 'personal', quality: 'gap' }))).status, 200);
  const summary = (await get(dispatch, '/api/review-summary')).body;
  assert.equal(summary.receivedCount, 1);
  assert.equal(summary.unconfirmedCount, 0);
  assert.equal(summary.invalidDistanceCount, 1);
  assert.equal(summary.readyForPurposeReview, false);
  assert.equal((await get(dispatch, '/api/exceptions')).body.trips.length, 1);
});

test('the same event returns its original ACK after later versions are stored', async (t) => {
  const { dispatch, store } = fixture(t);
  const first = event();
  const ack = (await post(dispatch, first)).body;
  const update = event({ tripId: first.tripId, localRevision: 3, expectedServerVersion: 1 }, { purpose: 'commute' });
  assert.equal((await post(dispatch, update)).body.serverVersion, 2);
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  reordered.payload = Object.fromEntries(Object.entries(first.payload).reverse());
  assert.deepEqual((await post(dispatch, reordered)).body, ack);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].serverVersion, 2);
  assert.equal(store.list()[0].payload.purpose, 'commute');
});

test('same event ID with different valid contents conflicts without changing storage', async (t) => {
  const { dispatch, store } = fixture(t);
  const original = event();
  await post(dispatch, original);
  const changed = structuredClone(original);
  changed.payload.note = 'different';
  const response = await post(dispatch, changed);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'EVENT_ID_REUSED');
  assert.equal(store.list()[0].payload.note, '');
});

test('optimistic version conflicts preserve data and do not consume the event ID', async (t) => {
  const { dispatch, store } = fixture(t);
  const original = event();
  await post(dispatch, original);
  const stale = event({ tripId: original.tripId, localRevision: 2, expectedServerVersion: 0 }, { purpose: 'business' });
  const conflict = await post(dispatch, stale);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'SERVER_VERSION_CONFLICT');
  assert.equal(conflict.body.error.details.currentServerVersion, 1);
  assert.equal(store.list()[0].payload.purpose, null);
  stale.expectedServerVersion = 1;
  assert.equal((await post(dispatch, stale)).status, 200);
});

test('new event IDs cannot move a local revision backwards', async (t) => {
  const { dispatch } = fixture(t);
  const original = event({ localRevision: 4 });
  await post(dispatch, original);
  const response = await post(dispatch, event({ tripId: original.tripId, expectedServerVersion: 1, localRevision: 3 }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'LOCAL_REVISION_CONFLICT');
});

test('purpose corrections cannot rewrite original trip times, distances, or quality', async (t) => {
  const { dispatch, store } = fixture(t);
  const original = event();
  await post(dispatch, original);
  const before = structuredClone(store.list()[0]);
  const changes = {
    startedAt: '2026-11-14T00:59:00.000Z',
    endedAt: '2026-11-14T01:31:00.000Z',
    startOdometerM: 100_001,
    endOdometerM: 124_000,
    quality: 'gap',
  };
  for (const [field, value] of Object.entries(changes)) {
    const amendment = event({ tripId: original.tripId, localRevision: 2, expectedServerVersion: 1 }, { [field]: value });
    const response = await post(dispatch, amendment);
    assert.equal(response.status, 409, field);
    assert.equal(response.body.error.code, 'RAW_FIELDS_IMMUTABLE', field);
    assert.deepEqual(response.body.error.details.changedFields, [field]);
    assert.deepEqual(store.list()[0], before);
  }
  const allowed = event({ tripId: original.tripId, localRevision: 2, expectedServerVersion: 1 }, { purpose: 'business', note: '목적만 보완' });
  assert.equal((await post(dispatch, allowed)).status, 200);
  assert.equal(store.list()[0].payload.startOdometerM, original.payload.startOdometerM);
  assert.equal(store.list()[0].payload.note, '목적만 보완');
});

test('a revision cannot relabel a collected gap as valid distance', async (t) => {
  const { dispatch, store } = fixture(t);
  const original = event({}, { quality: 'gap' });
  await post(dispatch, original);
  const promoted = event({ tripId: original.tripId, localRevision: 2, expectedServerVersion: 1 }, { purpose: 'business', quality: 'valid' });
  const response = await post(dispatch, promoted);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'RAW_FIELDS_IMMUTABLE');
  assert.equal(store.list()[0].payload.quality, 'gap');
  assert.equal(store.list()[0].serverVersion, 1);
  assert.equal((await get(dispatch, '/api/review-summary')).body.invalidDistanceCount, 1);
});

test('a revision cannot switch the original vehicle or driver identity', async (t) => {
  const { dispatch, store } = fixture(t);
  const original = event();
  await post(dispatch, original);
  for (const change of [{ vehicleId: 'demo-car-002' }, { driverId: 'demo-driver-002' }]) {
    const amendment = event({ tripId: original.tripId, localRevision: 2, expectedServerVersion: 1 }, change);
    // The shared mock contract rejects unregistered identities before storage.
    assert.equal((await post(dispatch, amendment)).status, 400);
  }
  assert.equal(store.list()[0].payload.vehicleId, DEMO_VEHICLE_ID);
  assert.equal(store.list()[0].payload.driverId, DEMO_DRIVER_ID);
  assert.equal(store.list()[0].serverVersion, 1);
});

test('SQLite persists both records and idempotent acknowledgements across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fleetlog-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'data', 'fleetlog.sqlite');
  const original = event();
  const first = new TripStore({ filename });
  const acknowledgement = first.upsert(original);
  first.close();
  const restarted = new TripStore({ filename });
  t.after(() => restarted.close());
  assert.equal(restarted.list().length, 1);
  assert.deepEqual(restarted.upsert(original), acknowledgement);
  assert.equal(restarted.list()[0].serverVersion, 1);
});

test('a failed receipt write rolls back the trip update in the same transaction', (t) => {
  const { store } = fixture(t);
  const original = event();
  store.db.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON event_receipts BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
  assert.throws(() => store.upsert(original));
  assert.equal(store.list().length, 0);
  store.db.exec('DROP TRIGGER fail_receipt');
  assert.equal(store.upsert(original).serverVersion, 1);
});

test('invalid contracts are rejected before any records are written', async (t) => {
  const { dispatch, store } = fixture(t);
  const cases = [
    event({ source: 'real' }),
    event({ expectedServerVersion: -1 }),
    event({ tripId: 'not-a-uuid' }),
    event({}, { vehicleId: 'another-company-car' }),
    event({}, { endOdometerM: 99_999 }),
    event({}, { startOdometerM: 1.5 }),
    event({}, { note: '가'.repeat(121) }),
    event({}, { purpose: 'inferred-business' }),
    event({}, { endedAt: '2026-11-13T01:00:00.000Z' }),
    { ...event(), extra: 'not-in-contract' },
  ];
  for (const value of cases) assert.equal((await post(dispatch, value)).status, 400);
  assert.equal(store.list().length, 0);
});

test('malformed JSON, wrong media types, and oversized bodies are rejected', async (t) => {
  const { dispatch } = fixture(t);
  assert.equal((await post(dispatch, '{')).status, 400);
  assert.equal((await post(dispatch, event(), { 'X-FleetLog-Dev': 'local-only' })).status, 415);
  assert.equal((await post(dispatch, 'x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
  assert.equal((await post(dispatch, Buffer.from('가'.repeat(6000)))).status, 413);
});

test('CORS allows only the two development origins, with same-origin serving separate', async (t) => {
  const { dispatch } = fixture(t);
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
    const response = await dispatch({ path: '/api/trips', headers: { ...headers, Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers['Access-Control-Allow-Origin'], origin);
  }
  const denied = await dispatch({ path: '/api/trips', headers: { ...headers, Origin: 'https://example.com' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined);
  const sameOrigin = await dispatch({ path: '/api/trips', headers: { ...headers, Origin: 'http://127.0.0.1:4000' } });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers['Access-Control-Allow-Origin'], undefined);
});

test('preflight permits the development marker without treating it as user authentication', async (t) => {
  const { dispatch } = fixture(t);
  const request = {
    method: 'OPTIONS', path: '/api/trip-events',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, X-FleetLog-Dev' },
  };
  assert.equal((await dispatch(request)).status, 204);
  request.headers['Access-Control-Request-Headers'] = 'Authorization';
  assert.equal((await dispatch(request)).status, 403);
});

test('static serving handles SPA routes and blocks traversal including symlink escape', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fleetlog-static-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'dist');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<html>mock app</html>');
  writeFileSync(join(directory, 'secret.txt'), 'must not leave this folder');
  symlinkSync(join(directory, 'secret.txt'), join(root, 'leak.txt'));
  const { store } = fixture(t);
  const dispatch = createApi({ store, staticDir: root });
  for (const path of ['/', '/trips/one']) {
    const result = await dispatch({ path });
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /mock app/);
  }
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/leak.txt', '/%5c..%5csecret.txt']) {
    assert.equal((await dispatch({ path })).status, 403, path);
  }
  assert.equal((await dispatch({ path: '/missing.js' })).status, 404);
  assert.equal((await dispatch({ path: '/', method: 'HEAD' })).body.byteLength, 0);
});

test('the runtime guard refuses production and all external bind addresses', () => {
  assert.doesNotThrow(() => assertLocalDevelopment({ host: '127.0.0.1', nodeEnv: 'development' }));
  for (const host of ['0.0.0.0', '::', '192.168.0.2', 'localhost']) assert.throws(() => assertLocalDevelopment({ host }));
  assert.throws(() => assertLocalDevelopment({ host: '127.0.0.1', nodeEnv: 'production' }));
  assert.throws(() => assertLocalDevelopment({ host: '127.0.0.1', nodeEnv: ' Production ' }));
});

test('startup options cannot override the real production environment', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(startServer({ nodeEnv: 'development' }), /refuses NODE_ENV=production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
