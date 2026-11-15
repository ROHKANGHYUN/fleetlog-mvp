import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminQuery } from '../apps/web/src/admin/query.mjs';

const trip = (version = 1) => ({ tripId: 'received-trip', serverVersion: version, localRevision: version,
  source: 'mock', updatedAt: '2026-11-15T04:00:00.000Z', payload: {
    vehicleId: 'car-a', driverId: 'driver-a', startedAt: '2026-11-15T01:00:00.000Z', endedAt: '2026-11-15T02:00:00.000Z',
    startOdometerM: 1000, endOdometerM: 3000, purpose: null, note: '', quality: 'gap',
  } });
function controlled() {
  const requests = [];
  const model = new AdminQuery({ fetchTrips: signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    now: () => '2026-11-15T05:00:00.000Z' });
  return { model, requests };
}

test('first loading and failed connection remain distinct from a successful empty result', async () => {
  const { model, requests } = controlled();
  assert.equal(model.getState().status, 'idle');
  const first = model.load();
  assert.equal(model.getState().status, 'loading');
  assert.equal(model.getState().hasLoaded, false);
  requests[0].reject(Error('connection refused')); await first;
  assert.equal(model.getState().status, 'error');
  assert.equal(model.getState().hasLoaded, false);
  assert.equal(model.getState().lastSuccessAt, null);
  assert.equal(model.getState().error, 'connection refused');
  const retry = model.load(); requests[1].resolve([]); await retry;
  assert.equal(model.getState().status, 'ready');
  assert.equal(model.getState().hasLoaded, true);
  assert.deepEqual(model.getState().trips, []);
  assert.equal(model.getState().lastSuccessAt, '2026-11-15T05:00:00.000Z');
});

test('refresh failure preserves the last received snapshot and successful query timestamp', async () => {
  const { model, requests } = controlled();
  const first = model.load(); requests[0].resolve([trip()]); await first;
  const before = model.getState();
  const refresh = model.load();
  assert.deepEqual(model.getState().trips, before.trips);
  assert.equal(model.getState().status, 'loading');
  requests[1].reject(Error('temporary failure')); await refresh;
  assert.equal(model.getState().status, 'error');
  assert.deepEqual(model.getState().trips, before.trips);
  assert.equal(model.getState().lastSuccessAt, before.lastSuccessAt);
  assert.equal(model.getState().hasLoaded, true);
  const recovery = model.load(); requests[2].resolve([trip(2)]); await recovery;
  assert.equal(model.getState().error, null);
  assert.equal(model.getState().trips.length, 1);
  assert.equal(model.getState().trips[0].serverVersion, 2);
});

test('an earlier success cannot replace a later revision even when transport ignores abort', async () => {
  const { model, requests } = controlled();
  const old = model.load();
  const latest = model.load();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve([trip(2)]); await latest;
  const received = model.getState();
  requests[0].resolve([trip()]); await old;
  assert.deepEqual(model.getState(), received);
});

test('an earlier failure cannot erase a later successful refresh or expose a stale error', async () => {
  const { model, requests } = controlled();
  const old = model.load(); const latest = model.load();
  requests[1].resolve([trip(2)]); await latest;
  const received = model.getState();
  requests[0].reject(Error('old failure')); await old;
  assert.deepEqual(model.getState(), received);
});

test('a successful empty snapshot stays distinguishable from a failed refresh, including a stale nonempty response', async () => {
  const { model, requests } = controlled();
  const initial = model.load(); requests[0].resolve([]); await initial;
  const timestamp = model.getState().lastSuccessAt;
  const old = model.load(); const latest = model.load();
  requests[2].reject(Error('latest request failed')); await latest;
  assert.equal(model.getState().status, 'error');
  assert.equal(model.getState().hasLoaded, true);
  assert.equal(model.getState().lastSuccessAt, timestamp);
  assert.deepEqual(model.getState().trips, []);
  requests[1].resolve([trip()]); await old;
  assert.equal(model.getState().error, 'latest request failed');
  assert.deepEqual(model.getState().trips, []);
});

test('cancel invalidates callbacks but the same read model supports effect reconnection', async () => {
  const { model, requests } = controlled();
  const old = model.load(); model.cancel();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(model.getState().status, 'idle');
  requests[0].resolve([trip()]); await old;
  assert.equal(model.getState().hasLoaded, false);
  const connected = model.load(); requests[1].resolve([trip(2)]); await connected;
  const refreshing = model.load(); model.cancel();
  assert.equal(model.getState().status, 'ready');
  requests[2].reject(Error('aborted')); await refreshing;
  assert.equal(model.getState().trips[0].serverVersion, 2);
});

test('a malformed record is a query error and cannot silently become zero records', async () => {
  const { model, requests } = controlled();
  const first = model.load(); requests[0].resolve([trip()]); await first;
  const refresh = model.load(); requests[1].resolve([{ tripId: 'broken' }]); await refresh;
  assert.equal(model.getState().status, 'error');
  assert.match(model.getState().error, /필수 항목/);
  assert.equal(model.getState().trips[0].tripId, 'received-trip');
  assert.equal(model.getState().hasLoaded, true);
});

test('read model snapshots cannot be mutated by callers or retained transport data', async () => {
  const received = [trip()];
  const model = new AdminQuery({ fetchTrips: async () => received });
  await model.load(); received[0].payload.note = 'external mutation';
  const snapshot = model.getState(); snapshot.trips[0].payload.note = 'snapshot mutation';
  assert.equal(model.getState().trips[0].payload.note, '');
});

test('default transport uses the server contract and rejects HTTP, JSON and body errors', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ trips: [trip()] }); };
  const model = new AdminQuery(); await model.load();
  assert.equal(calls[0].url, '/api/trips');
  assert.equal(calls[0].init.headers['X-FleetLog-Dev'], 'local-only');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(model.getState().status, 'ready');
  for (const response of [
    () => new Response('unavailable', { status: 503 }),
    () => new Response('not-json', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ unexpected: [] }),
    () => Response.json([]),
    () => Response.json({ trips: [{ ...trip(), serverVersion: 0 }] }),
  ]) {
    globalThis.fetch = async () => response();
    await model.load();
    assert.equal(model.getState().status, 'error');
    assert.equal(model.getState().hasLoaded, true);
    assert.equal(model.getState().trips.length, 1);
  }
});
