import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';
import { VoiceFlow } from '../packages/domain/voice-flow.mjs';
import { createMockVoiceAdapter } from '../apps/web/src/voice/mock-adapter.mjs';
import { TripStore } from '../services/api/src/store.mjs';
import { createApi } from '../services/api/src/app.mjs';
import { AdminQuery } from '../apps/web/src/admin/query.mjs';
import { defaultFilters, exceptionReasons, selectTrips } from '../apps/web/src/admin/model.mjs';

class Clock {
  milliseconds = 0;
  nextId = 0;
  tasks = new Map();
  now = () => new Date(Date.parse('2026-11-15T01:00:00.000Z') + this.milliseconds).toISOString();
  schedule = (fn, delay) => {
    const id = ++this.nextId;
    this.tasks.set(id, { fn, at: this.milliseconds + delay });
    return id;
  };
  unschedule = id => this.tasks.delete(id);
  advance(duration) {
    const end = this.milliseconds + duration;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.milliseconds = next[1].at;
      this.tasks.delete(next[0]);
      next[1].fn();
    }
    this.milliseconds = end;
  }
}

// Real API dispatch and SQLite in a temporary directory. No existing server,
// development DB, localStorage, browser or network listener participates.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'chagok-admin-flow-'));
  const clock = new Clock();
  const store = new TripStore({ filename: join(directory, 'temporary.sqlite'), now: clock.now });
  const api = createApi({ store });
  const headers = { 'X-FleetLog-Dev': 'local-only', 'Content-Type': 'application/json' };
  const sendEvent = async event => {
    const result = await api({ method: 'POST', path: '/api/trip-events', headers, body: JSON.stringify(event) });
    if (result.status !== 200) throw Object.assign(Error(result.body.error.message), { status: result.status });
    return result.body;
  };
  const query = new AdminQuery({ now: clock.now, fetchTrips: async () => {
    const result = await api({ method: 'GET', path: '/api/trips', headers });
    assert.equal(result.status, 200);
    return result.body.trips;
  } });
  const createController = (storage = new MemoryStorage()) => new FleetController({ storage, now: clock.now, sendEvent });
  const controller = createController();
  const adapter = createMockVoiceAdapter({ schedule: clock.schedule, unschedule: clock.unschedule });
  const flow = new VoiceFlow({ controller, adapter, schedule: clock.schedule, unschedule: clock.unschedule });
  flow.connect();
  t.after(() => { flow.disconnect(); adapter.dispose(); query.cancel(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { clock, controller, adapter, flow, query, createController, store };
}
function finish(controller) {
  controller.start(); controller.setDriving(true); controller.setDriving(false); controller.finish();
}
function voiceFinal(f, text) {
  f.adapter.configure({ mode: 'ok', text });
  f.flow.start(); f.clock.advance(900);
  assert.equal(f.flow.getState().phase, 'listening');
  f.adapter.preview(); f.adapter.complete(); f.clock.advance(0);
}

test('voice draft, explicit offline save, actual ACK and corrected gap feed one consistent server-only admin dataset', async t => {
  const f = fixture(t);
  const { controller: c, query } = f;
  finish(c);
  c.setOnline(false);
  voiceFinal(f, '일반 업무, 거래처 미팅');
  assert.equal(c.getState().records.length, 0);
  assert.equal(c.getState().screen, 'purpose');
  c.review(); c.save();
  await query.load();
  assert.equal(query.getState().status, 'ready');
  assert.equal(selectTrips(query.getState().trips).summary.receivedCount, 0);
  await c.sync(); await query.load();
  assert.equal(query.getState().trips.length, 0);
  c.setOnline(true); await c.sync(); await query.load();
  let admin = selectTrips(query.getState().trips);
  assert.equal(admin.summary.receivedCount, 1);
  const normalId = c.getState().records[0].tripId;
  const normalDetail = admin.allLatest.find(trip => trip.tripId === normalId);
  assert.equal(normalDetail.payload.note, '거래처 미팅');
  assert.equal(normalDetail.payload.purpose, 'business');
  assert.equal(normalDetail.serverVersion, 1);
  assert.equal(c.getState().records[0].ackedLocalRevision, 1);

  // An interrupted separate client produces the existing controller's gap rule.
  const interruptedStorage = new MemoryStorage();
  const interrupted = f.createController(interruptedStorage);
  interrupted.start(); interrupted.setDriving(true);
  f.clock.advance(60000);
  const recovered = f.createController(interruptedStorage);
  const gapId = recovered.getState().records[0].tripId;
  const original = structuredClone(recovered.getState().records[0].payload);
  assert.equal(original.purpose, null); assert.equal(original.quality, 'gap');
  await recovered.sync(); await query.load();
  admin = selectTrips(query.getState().trips, defaultFilters(), { view: 'exceptions' });
  assert.equal(admin.rows.length, 1);
  assert.equal(admin.rows[0].tripId, gapId);
  assert.deepEqual(exceptionReasons(admin.rows[0]), ['용도 미확정', '거리 확인 필요 · gap']);
  assert.equal(admin.summary.receivedCount, 2);
  assert.equal(admin.summary.needsReviewCount, 1);
  assert.equal(admin.summary.unconfirmedCount, 1);
  assert.equal(admin.summary.invalidDistanceCount, 1);
  assert.equal(admin.summary.validDistanceM, 23400);
  const selectedId = gapId;
  recovered.editTrip(gapId); recovered.setPurpose('commute', '운전자 보완'); recovered.review(); recovered.save();
  await recovered.sync(); await query.load();
  admin = selectTrips(query.getState().trips);
  const refreshedDetail = admin.allLatest.find(trip => trip.tripId === selectedId);
  assert.equal(admin.summary.receivedCount, 2);
  assert.equal(refreshedDetail.serverVersion, 2);
  assert.equal(refreshedDetail.payload.note, '운전자 보완');
  assert.equal(refreshedDetail.payload.purpose, 'commute');
  assert.deepEqual(refreshedDetail.payload, { ...original, purpose: 'commute', note: '운전자 보완' });
  assert.equal(admin.summary.unconfirmedCount, 0);
  assert.equal(admin.summary.invalidDistanceCount, 1);
  assert.equal(admin.summary.needsReviewCount, 1);
  const filtered = selectTrips(query.getState().trips, { ...defaultFilters(), from:'2026-11-15',to:'2026-11-15',purpose:'commute',distance:'needs' });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.summary.receivedCount, 1);
  assert.equal(filtered.summary.validDistanceM, null);
  assert.equal(filtered.summary.excludedDistanceCount, 1);
  assert.equal(filtered.summary.groups.find(group => group.key === 'commute').count, 1);
  assert.equal(f.store.list().length, 2);
});

test('cancelled or redeparted mock input cannot create a server record; only a new confirmed draft can be sent', async t => {
  const f = fixture(t);
  const { controller: c, adapter, flow, clock, query } = f;
  finish(c);
  adapter.configure({ mode: 'ok', text: '개인 용도, 장보기' });
  flow.start(); clock.advance(900); adapter.preview();
  flow.cancel(); adapter.complete(); clock.advance(0);
  assert.deepEqual(c.getState().draft, { purpose: null, note: '' });
  assert.equal(c.getState().records.length, 0);
  flow.start(); clock.advance(900); adapter.preview();
  c.setDriving(true); adapter.complete(); clock.advance(0);
  assert.equal(c.getState().draft, null);
  assert.equal(c.getState().current.candidateEnd, undefined);
  assert.equal(c.getState().records.length, 0);
  await c.sync(); await query.load();
  assert.equal(query.getState().trips.length, 0);
  c.setDriving(false); c.finish();
  voiceFinal(f, '출퇴근'); c.review(); c.save();
  await c.sync(); await query.load();
  const result = selectTrips(query.getState().trips);
  assert.equal(result.summary.receivedCount, 1);
  assert.equal(result.rows[0].payload.purpose, 'commute');
  assert.equal(result.rows[0].payload.note, '');
  assert.equal(result.summary.validDistanceM, 46800);
});
