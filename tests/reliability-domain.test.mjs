import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';

const ack = event => ({ eventId: event.eventId, ackedLocalRevision: event.localRevision, serverVersion: event.expectedServerVersion + 1 });
const paused = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
function storageFixture() {
  const memory = new MemoryStorage();
  let fail = () => false, writes = 0;
  return {
    memory,
    port: {
      getItem: key => memory.getItem(key),
      setItem: (key, value) => { writes++; if (fail(JSON.parse(value))) throw Error('검증용 저장 공간 부족'); memory.setItem(key, value); },
      removeItem: key => memory.removeItem(key),
    },
    fail: predicate => { fail = predicate; },
    writes: () => writes,
  };
}
function finish(c) { c.start(); c.setDriving(true); c.setDriving(false); c.finish(); }
function confirm(c, purpose = 'business', note = '사용자가 확인한 메모') { c.setPurpose(purpose, note); c.review(); c.save(); }
function deferred(c) { finish(c); c.defer(); }

// The same storage port commits record and Outbox as one serialized write.
test('a failed local record/Outbox commit retains the complete review draft and original stored bytes', () => {
  const s = storageFixture(), c = new FleetController({ storage: s.port });
  finish(c); c.setPurpose('commute', '초안 보존'); c.review();
  const before = c.getState(), stored = s.memory.value;
  s.fail(next => next.records.length > before.records.length);
  assert.throws(() => c.save(), /저장 공간/);
  assert.deepEqual(c.getState(), before);
  assert.equal(s.memory.value, stored);
  s.fail(() => false); c.save();
  assert.equal(c.getState().records.length, 1);
  assert.equal(c.getState().outbox.length, 1);
  assert.equal(c.getState().records[0].payload.note, '초안 보존');
});

test('failure to persist a prepared request sends nothing and leaves the original event available', async () => {
  const s = storageFixture(); let sends = 0;
  const c = new FleetController({ storage: s.port, sendEvent: async e => { sends++; return ack(e); } });
  deferred(c);
  const stored = s.memory.value, eventId = c.getState().outbox[0].eventId;
  s.fail(next => next.outbox.some(event => event.preparedEvent !== null));
  await assert.rejects(c.sync(), /저장 공간/);
  assert.equal(sends, 0);
  assert.equal(s.memory.value, stored);
  assert.equal(c.getState().syncing, false);
  assert.equal(c.getState().outbox[0].eventId, eventId);
  assert.equal(c.getState().outbox[0].preparedEvent, null);
  s.fail(() => false); await c.sync();
  assert.equal(sends, 1);
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);
});

test('ACK receipt cannot publish delivery when its local commit fails; retry uses the same prepared request', async () => {
  const s = storageFixture(), sent = [];
  const c = new FleetController({ storage: s.port, sendEvent: async e => { sent.push(structuredClone(e)); return ack(e); } });
  deferred(c);
  s.fail(next => next.records.some(record => record.ackedLocalRevision > 0));
  // A validated network ACK still needs a successful local commit. Its I/O
  // failure is reported without a second durable write that could hide it.
  await assert.rejects(c.sync(), /저장 공간/);
  let state = c.getState();
  assert.equal(state.records[0].ackedLocalRevision, 0);
  assert.equal(state.records[0].serverVersion, 0);
  assert.equal(state.outbox.length, 1);
  assert.deepEqual(state.receipts, {});
  assert.deepEqual(state.outbox[0].preparedEvent, sent[0]);
  assert.match(state.syncError, /저장하지 못했습니다/);
  assert.equal(state.inFlightEventId, null);
  assert.equal(JSON.parse(s.memory.value).records[0].ackedLocalRevision, 0);
  s.fail(() => false); await c.sync();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(c.getState().outbox.length, 0);
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);
  assert.equal(Object.keys(c.getState().receipts).length, 1);
  assert.equal(c.getState().syncError, null);
});

test('persistent quota failure after a network ACK preserves the prepared event and never claims durable receipt', async () => {
  const s = storageFixture(), response = paused(); let sent;
  const c = new FleetController({ storage: s.port, sendEvent: e => { sent = e; return response.promise; } });
  deferred(c); const syncing = c.sync();
  const preparedBytes = s.memory.value;
  s.fail(() => true); response.resolve(ack(sent));
  await assert.rejects(syncing, /저장 공간/);
  assert.equal(s.memory.value, preparedBytes);
  assert.equal(c.getState().records[0].ackedLocalRevision, 0);
  assert.equal(c.getState().outbox.length, 1);
  assert.equal(c.getState().syncing, false);
});

test('in-flight correction keeps its original payload and awaits the predecessor ACK before preparing the next version', async () => {
  const first = paused(), second = paused(), sent = [];
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: event => {
    sent.push(structuredClone(event)); return sent.length === 1 ? first.promise : second.promise;
  } });
  deferred(c);
  const tripId = c.getState().records[0].tripId;
  const syncing = c.sync();
  c.editTrip(tripId); confirm(c, 'personal', '전송 중 보완');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.purpose, null);
  assert.equal(c.getState().records[0].localRevision, 2);
  assert.equal(c.getState().outbox[1].preparedEvent, null);
  first.resolve(ack(sent[0]));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].expectedServerVersion, 1);
  assert.equal(sent[1].payload.note, '전송 중 보완');
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);
  assert.equal(c.getState().records[0].localRevision, 2);
  assert.equal(c.getState().outbox.length, 1);
  second.resolve(ack(sent[1])); await syncing;
  assert.equal(c.getState().records[0].ackedLocalRevision, 2);
  assert.equal(c.getState().records.length, 1);
});

test('a new leg saved during an in-flight request is not lost and parallel sync never sends the same event twice', async () => {
  const first = paused(), sent = [];
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: event => {
    sent.push(structuredClone(event)); return sent.length === 1 ? first.promise : Promise.resolve(ack(event));
  } });
  deferred(c); const syncing = c.sync();
  await c.sync(); await c.sync();
  assert.equal(sent.length, 1);
  c.setDriving(true); c.setDriving(false); c.finish(); confirm(c, 'commute', '새 운행');
  assert.equal(c.getState().records.length, 2);
  assert.equal(c.getState().outbox.length, 2);
  first.resolve(ack(sent[0])); await syncing;
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].tripId, sent[1].tripId);
  assert.equal(new Set(sent.map(e => e.eventId)).size, 2);
  assert.equal(c.getState().outbox.length, 0);
  assert.equal(c.getState().records.filter(r => r.ackedLocalRevision === 1).length, 2);
});

test('stopping collection before a late ACK keeps collection stopped and the original trip unchanged', async () => {
  const response = paused(); let event;
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: e => { event = e; return response.promise; } });
  deferred(c); const original = structuredClone(c.getState().records[0].payload);
  const syncing = c.sync(); c.stop(); response.resolve(ack(event)); await syncing;
  const state = c.getState();
  assert.equal(state.active, false); assert.equal(state.screen, 'ready'); assert.equal(state.current, null);
  assert.deepEqual(state.records[0].payload, original);
  assert.equal(state.records[0].ackedLocalRevision, 1);
  c.setDriving(true); assert.equal(c.getState().records.length, 1); assert.equal(c.getState().current, null);
});

test('reopening a stopped client retains prepared IDs and exact retry body without restarting capture', async () => {
  const memory = new MemoryStorage(), sent = [];
  const c = new FleetController({ storage: memory, sendEvent: async event => { sent.push(structuredClone(event)); throw Error('응답 유실'); } });
  deferred(c); c.stop(); await c.sync();
  const stored = JSON.parse(memory.value);
  const next = new FleetController({ storage: memory, sendEvent: async event => { sent.push(structuredClone(event)); return ack(event); } });
  assert.equal(next.getState().active, false);
  assert.equal(next.getState().current, null);
  assert.equal(next.getState().records[0].tripId, stored.records[0].tripId);
  assert.deepEqual(next.getState().outbox[0].preparedEvent, stored.outbox[0].preparedEvent);
  await next.sync(); assert.deepEqual(sent[1], sent[0]);
  assert.equal(next.getState().records.length, 1);
  assert.equal(next.getState().outbox.length, 0);
});

test('a reopened unfinished leg becomes gap at the last observation without inventing parked state or elapsed distance', () => {
  const memory = new MemoryStorage(); let now = '2026-11-15T01:00:00.000Z';
  const c = new FleetController({ storage: memory, now: () => now });
  c.start(); now = '2026-11-15T01:02:00.000Z'; c.setDriving(true);
  const observed = c.getState().odometerM;
  now = '2026-11-16T12:00:00.000Z';
  const next = new FleetController({ storage: memory, now: () => now });
  assert.equal(next.getState().active, false);
  assert.equal(next.getState().records[0].payload.quality, 'gap');
  assert.equal(next.getState().records[0].payload.endedAt, '2026-11-15T01:02:00.000Z');
  assert.equal(next.getState().records[0].payload.endOdometerM, observed);
  assert.equal(next.getState().records[0].payload.purpose, null);
});

test('nested corruption in valid JSON is rejected before any recovery write and preserves the original bytes', () => {
  const s = storageFixture(), c = new FleetController({ storage: s.port });
  deferred(c); c.stop();
  const valid = JSON.parse(s.memory.value);
  for (const corrupt of [
    state => { state.records[0].payload.note = 123; },
    state => { state.outbox[0].payload.quality = 'invented-quality'; },
    state => { state.outbox[0].tripId = crypto.randomUUID(); },
    state => { state.receipts = []; },
    state => { state.odometerM = -1; },
    state => { state.current = { tripId: null }; },
    state => { state.outbox[0].payload.note = '원본 초안과 다른 전송 내용'; },
    state => { state.outbox.push({ ...state.outbox[0], eventId: crypto.randomUUID() }); },
  ]) {
    const damaged = structuredClone(valid); corrupt(damaged);
    s.memory.value = JSON.stringify(damaged);
    const bytes = s.memory.value, writes = s.writes();
    assert.throws(() => new FleetController({ storage: s.port }), /로컬 데이터|손상/);
    assert.equal(s.memory.value, bytes);
    assert.equal(s.writes(), writes);
  }
});

test('stale instances cannot overwrite another writer even when attempting an unrelated setting change', () => {
  const memory = new MemoryStorage();
  const first = new FleetController({ storage: memory }), stale = new FleetController({ storage: memory });
  deferred(first); const stored = memory.value;
  assert.throws(() => stale.setOnline(false), /다른 창/);
  assert.equal(memory.value, stored);
  assert.equal(JSON.parse(memory.value).records.length, 1);
});

for (const status of [400, 401, 403, 413, 415]) {
  test(`HTTP ${status} is held for diagnosis instead of repeated blind retries`, async () => {
    let calls = 0;
    const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async () => {
      calls++; throw Object.assign(Error(`HTTP ${status}`), { status });
    } });
    deferred(c); await c.sync();
    const prepared = c.getState().outbox[0].preparedEvent;
    assert.equal(c.getState().outbox[0].status, 'blocked');
    await c.sync(); await c.sync();
    assert.equal(calls, 1);
    assert.equal(c.getState().records[0].ackedLocalRevision, 0);
    assert.deepEqual(c.getState().outbox[0].preparedEvent, prepared);
  });
}

test('transient network, timeout, 408, 429 and 5xx failures retry only once per explicit sync with the identical envelope', async () => {
  for (const failure of [
    () => Error('network disconnected'),
    () => Object.assign(Error('timeout'), { name: 'TimeoutError' }),
    ...[408, 429, 500, 503].map(status => () => Object.assign(Error(`HTTP ${status}`), { status })),
  ]) {
    const sent = [];
    const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async event => {
      sent.push(structuredClone(event)); if (sent.length === 1) throw failure(); return ack(event);
    } });
    deferred(c); await c.sync();
    assert.equal(sent.length, 1);
    assert.equal(c.getState().outbox[0].status, 'queued');
    assert.equal(c.getState().records[0].ackedLocalRevision, 0);
    await c.sync();
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(c.getState().outbox.length, 0);
    assert.equal(c.getState().records.length, 1);
  }
});

test('an invalid ACK is never accepted and a deliberate valid retry retains the original event identity', async () => {
  const sent = [];
  const c = new FleetController({ storage: new MemoryStorage(), sendEvent: async event => {
    sent.push(structuredClone(event));
    return sent.length === 1 ? { ...ack(event), ackedLocalRevision: event.localRevision + 1 } : ack(event);
  } });
  deferred(c); await c.sync();
  assert.equal(c.getState().records[0].ackedLocalRevision, 0);
  assert.equal(c.getState().records[0].serverVersion, 0);
  assert.deepEqual(c.getState().receipts, {});
  assert.equal(c.getState().outbox[0].status, 'queued');
  await c.sync();
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);
});

test('a non-JSON success response is held for diagnosis, while a non-JSON 503 remains a retryable server failure', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const [status, expectedStatus, expectedCalls] of [[200, 'blocked', 1], [503, 'queued', 2]]) {
    const bodies = [];
    globalThis.fetch = async (_url, init) => { bodies.push(init.body); return new Response('not-json', { status }); };
    const c = new FleetController({ storage: new MemoryStorage() });
    deferred(c); await c.sync();
    assert.equal(c.getState().outbox[0].status, expectedStatus);
    assert.equal(c.getState().records[0].ackedLocalRevision, 0);
    await c.sync(); assert.equal(bodies.length, expectedCalls);
    if (bodies.length === 2) assert.equal(bodies[1], bodies[0]);
  }
});

test('only the actual network request is marked in flight and that state never enters persisted storage', async () => {
  const memory = new MemoryStorage(), first = paused(), second = paused(), sent = [];
  const c = new FleetController({ storage: memory, sendEvent: event => {
    sent.push(structuredClone(event)); return sent.length === 1 ? first.promise : second.promise;
  } });
  deferred(c);
  c.setDriving(true); c.setDriving(false); c.finish(); c.defer();
  const syncing = c.sync();
  assert.equal(c.getState().inFlightEventId, sent[0].eventId);
  assert.equal(c.getState().outbox[1].attempts, 0);
  assert.equal(JSON.parse(memory.value).inFlightEventId, undefined);
  assert.equal(JSON.parse(memory.value).syncError, undefined);
  first.resolve(ack(sent[0])); await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(c.getState().inFlightEventId, sent[1].eventId);
  assert.notEqual(sent[0].eventId, sent[1].eventId);
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);
  assert.equal(c.getState().records[1].ackedLocalRevision, 0);
  second.resolve(ack(sent[1])); await syncing;
  assert.equal(c.getState().inFlightEventId, null);
  assert.equal(c.getState().syncing, false);
  assert.equal(c.getState().outbox.length, 0);
});
