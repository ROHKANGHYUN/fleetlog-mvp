import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';
import { VoiceFlow } from '../packages/domain/voice-flow.mjs';
import { createMockVoiceAdapter } from '../apps/web/src/voice/mock-adapter.mjs';

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

function fixture(t) {
  const clock = new Clock();
  const memory = new MemoryStorage();
  let failStorage = false, sessions = 0;
  const storage = {
    getItem: key => memory.getItem(key),
    setItem: (key, value) => {
      if (failStorage) throw Error('quota');
      memory.setItem(key, value);
    },
    removeItem: key => memory.removeItem(key),
  };
  const controller = new FleetController({ storage, now: clock.now });
  const adapter = createMockVoiceAdapter({ schedule: clock.schedule, unschedule: clock.unschedule, promptDelayMs: 900 });
  const flow = new VoiceFlow({ controller, adapter, schedule: clock.schedule, unschedule: clock.unschedule,
    id: () => `mock-input-${++sessions}`, promptTimeoutMs: 1000, recognitionTimeoutMs: 1500 });
  flow.connect();
  t.after(() => { flow.disconnect(); adapter.dispose(); });
  controller.start(); controller.setDriving(true); controller.setDriving(false);
  clock.advance(5000); controller.finish();
  return { clock, memory, controller, adapter, flow, failStorage: value => { failStorage = value; } };
}

function listen(f) {
  assert.equal(f.flow.start(), true);
  assert.equal(f.flow.getState().phase, 'prompting');
  f.clock.advance(900);
  assert.equal(f.flow.getState().phase, 'listening');
}

test('real mock adapter drives prompt, interim, final, editable draft and explicit save without moving the finish boundary', t => {
  const f = fixture(t);
  const { controller: c, adapter, flow, clock } = f;
  const boundary = c.getState().current.candidateEnd;
  const tripId = c.getState().current.tripId;
  const persistedBeforeVoice = f.memory.value;
  adapter.configure({ mode: 'ok', text: '일반 업무, 거래처 미팅' });
  assert.equal(flow.start(), true);
  clock.advance(899);
  assert.equal(flow.getState().phase, 'prompting');
  adapter.preview(); adapter.complete();
  assert.equal(flow.getState().phase, 'prompting');
  assert.equal(f.memory.value, persistedBeforeVoice);
  clock.advance(1);
  assert.equal(flow.getState().phase, 'listening');
  adapter.preview();
  assert.equal(flow.getState().interim, '일반 업무, 거래처 미팅');
  assert.equal(f.memory.value, persistedBeforeVoice);
  assert.equal(c.getState().records.length, 0);
  adapter.complete();
  assert.equal(flow.getState().phase, 'processing');
  assert.deepEqual(c.getState().draft, { purpose: null, note: '' });
  clock.advance(0);
  assert.equal(flow.getState().phase, 'draft');
  assert.equal(flow.getState().transcript, '일반 업무, 거래처 미팅');
  assert.deepEqual(c.getState().draft, { purpose: 'business', note: '거래처 미팅' });
  assert.equal(c.getState().records.length, 0);
  assert.equal(c.getState().outbox.length, 0);
  c.setPurpose('business', '사용자가 수정한 거래처 미팅');
  adapter.preview(); adapter.complete(); clock.advance(0);
  assert.equal(c.getState().draft.note, '사용자가 수정한 거래처 미팅');
  clock.advance(40 * 60 * 1000);
  c.review(); c.save();
  const saved = c.getState();
  assert.equal(saved.records.length, 1);
  assert.equal(saved.outbox.length, 1);
  assert.equal(saved.records[0].tripId, tripId);
  assert.equal(saved.records[0].payload.endedAt, boundary.endedAt);
  assert.equal(saved.records[0].payload.endOdometerM, boundary.endOdometerM);
  assert.equal(saved.records[0].payload.note, '사용자가 수정한 거래처 미팅');
  assert.equal(saved.records[0].ackedLocalRevision, 0);
});

test('real mock failure, empty, unavailable and timeout modes allow manual or deferred recording', t => {
  for (const [mode, expected, defer] of [
    ['failed', 'failed', false], ['empty', 'empty', true],
    ['unavailable', 'unavailable', false], ['timeout', 'timeout', true],
  ]) {
    const f = fixture(t);
    f.adapter.configure({ mode, text: '개인 용도, 장보기' });
    f.flow.start(); f.clock.advance(900);
    if (mode !== 'unavailable') {
      assert.equal(f.flow.getState().phase, 'listening', mode);
      f.adapter.complete();
    }
    if (mode === 'timeout') f.clock.advance(1500);
    assert.equal(f.flow.getState().phase, 'error', mode);
    assert.equal(f.flow.getState().error, expected, mode);
    assert.deepEqual(f.controller.getState().draft, { purpose: null, note: '' }, mode);
    assert.equal(f.controller.getState().records.length, 0, mode);
    if (defer) f.controller.defer();
    else { f.controller.setPurpose('commute', '직접 입력'); f.controller.review(); f.controller.save(); }
    const record = f.controller.getState().records[0];
    assert.equal(record.payload.purpose, defer ? null : 'commute', mode);
    assert.equal(record.payload.note, defer ? '' : '직접 입력', mode);
    assert.equal(f.controller.getState().outbox.length, 1, mode);
    assert.equal(record.ackedLocalRevision, 0, mode);
  }
});

test('disconnect cancels live mock operations and reconnect can reuse the adapter for a fresh session', t => {
  const f = fixture(t);
  f.flow.start();
  const firstSession = f.flow.getState().sessionId;
  f.clock.advance(100);
  f.flow.disconnect();
  assert.equal(f.clock.tasks.size, 0);
  f.adapter.complete(); f.clock.advance(2000);
  assert.equal(f.flow.getState().phase, 'idle');
  assert.deepEqual(f.controller.getState().draft, { purpose: null, note: '' });
  f.flow.connect();
  f.adapter.configure({ mode: 'ok', text: '출퇴근' });
  listen(f);
  assert.notEqual(f.flow.getState().sessionId, firstSession);
  f.flow.disconnect();
  assert.equal(f.clock.tasks.size, 0);
  f.adapter.preview(); f.adapter.complete(); f.clock.advance(2000);
  assert.deepEqual(f.controller.getState().draft, { purpose: null, note: '' });
  f.flow.connect(); listen(f);
  f.adapter.complete(); f.clock.advance(0);
  assert.equal(f.flow.getState().phase, 'draft');
  assert.deepEqual(f.controller.getState().draft, { purpose: 'commute', note: '' });
  assert.equal(f.clock.tasks.size, 0);
});

test('storage failure applying a real mock final leaves the original draft intact and allows retry or manual input', t => {
  const f = fixture(t);
  const before = f.controller.getState();
  const persisted = f.memory.value;
  f.adapter.configure({ mode: 'ok', text: '개인 용도, 장보기' });
  listen(f);
  f.failStorage(true);
  f.adapter.complete(); f.clock.advance(0);
  assert.equal(f.flow.getState().phase, 'error');
  assert.equal(f.flow.getState().error, 'draft-failed');
  assert.deepEqual(f.controller.getState(), before);
  assert.equal(f.memory.value, persisted);
  assert.equal(f.controller.getState().records.length, 0);
  f.failStorage(false);
  listen(f); f.adapter.complete(); f.clock.advance(0);
  assert.deepEqual(f.controller.getState().draft, { purpose: 'personal', note: '장보기' });
  f.controller.setPurpose('business', '직접 수정');
  f.controller.review(); f.controller.save();
  assert.equal(f.controller.getState().records.length, 1);
  assert.equal(f.controller.getState().records[0].payload.purpose, 'business');
  assert.equal(f.controller.getState().records[0].payload.note, '직접 수정');
});
