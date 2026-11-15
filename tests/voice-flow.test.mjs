import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';
import { VoiceFlow } from '../packages/domain/voice-flow.mjs';

class Clock {
  milliseconds = 0;
  nextId = 0;
  timers = new Map();
  now = () => new Date(Date.parse('2026-11-15T01:00:00.000Z') + this.milliseconds).toISOString();
  schedule = (fn, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { fn, at: this.milliseconds + delay });
    return id;
  };
  unschedule = id => this.timers.delete(id);
  advance(amount) {
    const until = this.milliseconds + amount;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.milliseconds = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.milliseconds = until;
  }
}

// Deliberately retain callbacks after cancellation/finish to model an unsafe SDK.
class HostileAdapter {
  prompts = [];
  recognitions = [];
  stopped = [];
  cancelled = [];
  finished = [];
  startPrompt(context, emit) { this.prompts.push({ context, emit }); }
  stopPrompt(context) { this.stopped.push(context); }
  startRecognition(context, emit) { this.recognitions.push({ context, emit }); }
  finishRecognition(context) { this.finished.push(context); }
  cancelRecognition(context) { this.cancelled.push(context); }
  prompt(event = {}, index = this.prompts.length - 1) {
    const run = this.prompts[index];
    run.emit({ ...run.context, type: 'prompt-complete', ...event });
  }
  recognize(event, index = this.recognitions.length - 1) {
    const run = this.recognitions[index];
    run.emit({ ...run.context, ...event });
  }
}

function fixture(t) {
  const clock = new Clock();
  const controller = new FleetController({ storage: new MemoryStorage(), now: clock.now });
  const adapter = new HostileAdapter();
  let nextSession = 0;
  const flow = new VoiceFlow({ controller, adapter, id: () => `input-${++nextSession}`,
    schedule: clock.schedule, unschedule: clock.unschedule,
    promptTimeoutMs: 100, recognitionTimeoutMs: 200 });
  flow.connect();
  t.after(() => flow.disconnect());
  controller.start(); controller.setDriving(true); controller.setDriving(false); controller.finish();
  return { clock, controller, adapter, flow };
}

function listen(f) {
  assert.equal(f.flow.start(), true);
  f.adapter.prompt();
  assert.equal(f.flow.getState().phase, 'listening');
}

test('cleanup while idle does not claim the driver cancelled an input that never started', t => {
  const f = fixture(t);
  f.flow.cancel();
  assert.equal(f.flow.getState().cancelReason, null);
  f.flow.start();f.flow.cancel();
  assert.equal(f.flow.getState().cancelReason, 'user');
  assert.deepEqual(f.controller.getState().draft, { purpose: null, note: '' });
});

test('prompt completion starts recognition; interim is preview only and final needs explicit save', t => {
  const f = fixture(t);
  const { controller: c, flow, adapter, clock } = f;
  const candidate = c.getState().current.candidateEnd;
  const tripId = c.getState().current.tripId;
  assert.equal(flow.start(), true);
  assert.equal(flow.getState().phase, 'prompting');
  assert.equal(adapter.recognitions.length, 0);
  adapter.prompt();
  assert.equal(adapter.recognitions.length, 1);
  assert.equal(adapter.recognitions[0].context.tripId, tripId);
  adapter.recognize({ type: 'interim', text: '일반 업무' });
  assert.equal(flow.getState().interim, '일반 업무');
  assert.deepEqual(c.getState().draft, { purpose: null, note: '' });
  assert.equal(c.getState().records.length, 0);
  assert.equal(c.getState().outbox.length, 0);
  assert.throws(() => c.save(), /요약/);

  adapter.recognize({ type: 'final', text: '일반 업무, 거래처 미팅' });
  assert.equal(flow.getState().phase, 'processing');
  assert.equal(c.getState().draft.purpose, null);
  clock.advance(0);
  assert.equal(flow.getState().phase, 'draft');
  assert.equal(flow.getState().transcript, '일반 업무, 거래처 미팅');
  assert.deepEqual(c.getState().draft, { purpose: 'business', note: '거래처 미팅' });
  assert.equal(c.getState().records.length, 0);
  assert.equal(adapter.finished.length, 1);
  clock.advance(60 * 60 * 1000);
  c.review(); c.save();
  assert.equal(c.getState().records[0].tripId, tripId);
  assert.equal(c.getState().records[0].payload.endedAt, candidate.endedAt);
  assert.equal(c.getState().records[0].payload.endOdometerM, candidate.endOdometerM);
});

test('ambiguous final preserves transcript and requires a person to select the purpose', t => {
  const f = fixture(t);
  listen(f);
  f.adapter.recognize({ type: 'final', text: '일반 업무 또는 개인 용도' });
  f.clock.advance(0);
  assert.equal(f.flow.getState().reason, 'ambiguous');
  assert.equal(f.flow.getState().transcript, '일반 업무 또는 개인 용도');
  assert.equal(f.controller.getState().draft.purpose, null);
  assert.throws(() => f.controller.review(), /용도/);
  f.controller.setPurpose('personal', '사용자가 입력한 메모');
  f.controller.review(); f.controller.save();
  assert.equal(f.controller.getState().records.length, 1);
  assert.equal(f.controller.getState().records[0].payload.purpose, 'personal');
});

for (const [name, leave] of [
  ['user cancellation', f => f.flow.cancel()],
  ['redeparture', f => f.controller.setDriving(true)],
  ['hidden application or vehicle-tab exit', f => f.flow.setForeground(false)],
  ['input-screen exit', f => f.controller.continueDriving()],
  ['recording-session stop', f => f.controller.stop()],
  ['unmount/disconnect', f => f.flow.disconnect()],
]) {
  test(`${name} ignores hostile late interim/final/prompt callbacks`, t => {
    const f = fixture(t);
    listen(f);
    leave(f);
    const afterLeave = f.controller.getState();
    f.adapter.recognize({ type: 'interim', text: '개인 용도' });
    f.adapter.recognize({ type: 'final', text: '개인 용도, 장보기' });
    f.adapter.prompt();
    f.clock.advance(1000);
    assert.deepEqual(f.controller.getState(), afterLeave);
    assert.equal(f.flow.getState().phase, 'idle');
    assert.equal(f.adapter.recognitions.length, 1);
    assert.equal(f.adapter.cancelled.length, 1);
  });
}

test('a prior session and wrong trip/session identifiers cannot alter the new session', t => {
  const f = fixture(t);
  listen(f);
  const oldContext = f.adapter.recognitions[0].context;
  listen(f);
  const newContext = f.adapter.recognitions[1].context;
  assert.notEqual(oldContext.sessionId, newContext.sessionId);
  const before = f.controller.getState();
  f.adapter.recognize({ type: 'final', text: '개인 용도, 장보기' }, 0);
  f.adapter.recognize({ type: 'final', text: '개인 용도', tripId: 'another-trip' });
  f.adapter.recognize({ type: 'final', text: '개인 용도', sessionId: oldContext.sessionId });
  f.clock.advance(0);
  assert.deepEqual(f.controller.getState(), before);
  assert.equal(f.flow.getState().phase, 'listening');
  f.adapter.recognize({ type: 'final', text: '출퇴근' }); f.clock.advance(0);
  assert.deepEqual(f.controller.getState().draft, { purpose: 'commute', note: '' });
});

test('changing the edited trip rejects the old callback even when both drafts are identical', t => {
  const f = fixture(t);
  f.controller.defer();
  const firstTrip = f.controller.getState().records[0].tripId;
  f.controller.setDriving(true); f.controller.setDriving(false); f.controller.finish(); f.controller.defer();
  const secondTrip = f.controller.getState().records[1].tripId;
  f.controller.editTrip(firstTrip); listen(f);
  f.controller.editTrip(secondTrip);
  const before = f.controller.getState();
  f.adapter.recognize({ type: 'final', text: '개인 용도, 장보기' });
  f.clock.advance(1000);
  assert.deepEqual(f.controller.getState(), before);
  assert.equal(f.controller.getState().editingTripId, secondTrip);
});

for (const timing of ['listening', 'processing']) {
  test(`manual draft edits during ${timing} invalidate an older final result`, t => {
    const f = fixture(t);
    listen(f);
    if (timing === 'processing') f.adapter.recognize({ type: 'final', text: '일반 업무, 거래처 미팅' });
    f.controller.setPurpose('personal', '직접 수정한 메모');
    f.adapter.recognize({ type: 'final', text: '일반 업무, 거래처 미팅' });
    f.clock.advance(1000);
    assert.deepEqual(f.controller.getState().draft, { purpose: 'personal', note: '직접 수정한 메모' });
    assert.equal(f.controller.getState().records.length, 0);
    assert.equal(f.flow.getState().phase, 'idle');
  });
}

test('duplicate finals apply once and never save; repeated save requests create one record', t => {
  const f = fixture(t);
  let changes = 0;
  const originalSetPurpose = f.controller.setPurpose.bind(f.controller);
  f.controller.setPurpose = (...args) => { changes++; originalSetPurpose(...args); };
  listen(f);
  const final = { type: 'final', text: '개인 용도, 장보기' };
  f.adapter.recognize(final); f.adapter.recognize(final);
  f.clock.advance(0);
  f.adapter.recognize(final); f.clock.advance(1000);
  assert.equal(changes, 1);
  assert.equal(f.controller.getState().records.length, 0);
  assert.equal(f.controller.getState().outbox.length, 0);
  f.controller.review(); f.controller.save();
  assert.throws(() => f.controller.save(), /요약/);
  assert.equal(f.controller.getState().records.length, 1);
  assert.equal(f.controller.getState().outbox.length, 1);
});

for (const [name, fail, expected] of [
  ['recognition failure', f => f.adapter.recognize({ type: 'error', code: 'failed' }), 'failed'],
  ['unavailable recognition', f => f.adapter.recognize({ type: 'error', code: 'unavailable' }), 'unavailable'],
  ['ended without result', f => f.adapter.recognize({ type: 'ended' }), 'empty'],
  ['empty final', f => { f.adapter.recognize({ type: 'final', text: '  ' }); f.clock.advance(0); }, 'empty'],
  ['listening timeout', f => f.clock.advance(200), 'timeout'],
]) {
  test(`${name} allows manual recording and ignores a late successful result`, t => {
    const f = fixture(t);
    listen(f); fail(f);
    assert.equal(f.flow.getState().phase, 'error');
    assert.equal(f.flow.getState().error, expected);
    f.controller.setPurpose('commute', '직접 입력');
    f.adapter.recognize({ type: 'final', text: '개인 용도, 장보기' });
    f.clock.advance(1000);
    assert.deepEqual(f.controller.getState().draft, { purpose: 'commute', note: '직접 입력' });
    f.controller.review(); f.controller.save();
    assert.equal(f.controller.getState().records.length, 1);
  });
}

test('prompt timeout never starts recognition and still allows deferred storage', t => {
  const f = fixture(t);
  f.flow.start(); f.clock.advance(100);
  assert.equal(f.flow.getState().error, 'timeout');
  f.adapter.prompt();
  assert.equal(f.adapter.recognitions.length, 0);
  f.controller.defer();
  assert.equal(f.controller.getState().records[0].payload.purpose, null);
  assert.equal(f.controller.getState().outbox.length, 1);
});

test('recognition failure can retry in a fresh session or defer without using failed text', t => {
  const f = fixture(t);
  listen(f); f.adapter.recognize({ type: 'error', code: 'failed' });
  const firstSession = f.flow.getState().sessionId;
  listen(f);
  assert.notEqual(f.flow.getState().sessionId, firstSession);
  f.adapter.recognize({ type: 'interim', text: '일반 업무, 거래처 미팅' });
  f.flow.cancel(); f.controller.defer();
  assert.equal(f.controller.getState().records[0].payload.purpose, null);
  assert.equal(f.controller.getState().records[0].payload.note, '');
  assert.equal(f.controller.getState().outbox.length, 1);
});
