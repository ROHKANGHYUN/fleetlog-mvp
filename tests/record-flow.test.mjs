import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';

function fixture(options = {}) {
  let instant = '2026-11-15T01:00:00.000Z';
  let storageFails = false;
  const backing = new MemoryStorage();
  const storage = {
    getItem: key => backing.getItem(key),
    setItem: (key, value) => {
      if (storageFails) throw new Error('quota');
      backing.setItem(key, value);
    },
    removeItem: key => backing.removeItem(key),
  };
  const now = () => instant;
  const controller = new FleetController({ storage, now, ...options });
  return {
    controller, storage, backing, now,
    at: value => { instant = value; },
    failStorage: value => { storageFails = value; },
  };
}

function finishLeg(c) {
  c.start(); c.setDriving(true); c.setDriving(false); c.finish();
}

test('delayed input and a failed save retry retain the finish boundary and create one record', () => {
  const f = fixture();
  const c = f.controller;
  c.start(); c.setDriving(true); c.setDriving(false);
  f.at('2026-11-15T01:10:00.000Z'); c.finish();
  const candidate = c.getState().current.candidateEnd;
  const tripId = c.getState().current.tripId;
  f.at('2026-11-15T01:45:00.000Z');
  c.setPurpose('business', '거래처 미팅'); c.review();
  f.failStorage(true);
  const review = c.getState();
  const persisted = f.backing.value;
  assert.throws(() => c.save(), /quota/);
  assert.deepEqual(c.getState(), review);
  assert.equal(f.backing.value, persisted);
  assert.equal(c.getState().screen, 'review');
  assert.equal(c.getState().records.length, 0);

  f.at('2026-11-15T02:00:00.000Z'); f.failStorage(false);
  c.save();
  const saved = c.getState();
  assert.throws(() => c.save(), /요약/);
  assert.deepEqual(c.getState(), saved);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.outbox.length, 1);
  assert.equal(saved.records[0].tripId, tripId);
  assert.equal(saved.records[0].payload.endedAt, candidate.endedAt);
  assert.equal(saved.records[0].payload.endOdometerM, candidate.endOdometerM);
  assert.equal(saved.records[0].ackedLocalRevision, 0);
});

test('a failed deferred save can retry once and remains unsent until its actual ACK', async () => {
  let acknowledge;
  const f = fixture({ sendEvent: event => new Promise(resolve => {
    acknowledge = () => resolve({
      eventId: event.eventId,
      ackedLocalRevision: event.localRevision,
      serverVersion: event.expectedServerVersion + 1,
    });
  }) });
  const c = f.controller;
  finishLeg(c);
  const candidate = c.getState().current.candidateEnd;
  c.setPurpose(null, '저장하지 않은 입력');
  f.failStorage(true);
  assert.throws(() => c.defer(), /quota/);
  assert.equal(c.getState().screen, 'purpose');
  assert.equal(c.getState().outbox.length, 0);
  f.failStorage(false);
  f.at('2026-11-15T03:00:00.000Z'); c.defer();
  assert.throws(() => c.defer(), /입력 중/);
  let state = c.getState();
  assert.equal(state.records.length, 1);
  assert.equal(state.outbox.length, 1);
  const record = state.records[0];
  assert.equal(record.payload.purpose, null);
  assert.equal(record.payload.note, '');
  assert.equal(record.payload.endedAt, candidate.endedAt);
  assert.equal(record.payload.endOdometerM, candidate.endOdometerM);
  assert.equal(record.ackedLocalRevision, 0);
  const sending = c.sync();
  state = c.getState();
  assert.equal(state.records[0].ackedLocalRevision, 0);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.screen, 'saved');
  acknowledge(); await sending;
  state = c.getState();
  assert.equal(state.records[0].ackedLocalRevision, 1);
  assert.equal(state.outbox.length, 0);
  assert.deepEqual(state.records[0].payload, record.payload);
});

test('delayed gap correction preserves every original field and queues only one new revision', async () => {
  const envelopes = [];
  const f = fixture();
  f.controller.start(); f.controller.setDriving(true);
  f.at('2026-11-15T02:00:00.000Z');
  const c = new FleetController({ storage: f.storage, now: f.now, sendEvent: async event => {
    envelopes.push(event);
    return { eventId: event.eventId, ackedLocalRevision: event.localRevision, serverVersion: event.expectedServerVersion + 1 };
  } });
  const original = c.getState().records[0];
  assert.equal(original.payload.quality, 'gap');
  c.editTrip(original.tripId);
  f.at('2026-11-15T12:00:00.000Z');
  c.setPurpose('personal', '장보기'); c.review(); c.save();
  assert.throws(() => c.save(), /요약/);
  const state = c.getState();
  assert.equal(state.records.length, 1);
  assert.equal(state.outbox.length, 2);
  assert.equal(state.records[0].tripId, original.tripId);
  assert.equal(state.records[0].localRevision, 2);
  assert.deepEqual(state.records[0].payload, { ...original.payload, purpose: 'personal', note: '장보기' });
  assert.deepEqual(state.outbox[0].payload, original.payload);
  assert.equal(state.outbox[1].preparedEvent, null);
  assert.equal(state.outbox[1].predecessorEventId, state.outbox[0].eventId);
  await c.sync();
  assert.deepEqual(envelopes.map(event => event.expectedServerVersion), [0, 1]);
  assert.equal(c.getState().records[0].ackedLocalRevision, 2);
  assert.deepEqual(c.getState().records[0].payload, { ...original.payload, purpose: 'personal', note: '장보기' });
});
