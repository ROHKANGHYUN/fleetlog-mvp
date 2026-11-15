import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockVoiceAdapter } from '../apps/web/src/voice/mock-adapter.mjs';
import { parseVoiceText } from '../packages/domain/voice-text.mjs';

const context = { sessionId: 'session-a', tripId: 'trip-a' };
function fixture() {
  const scheduled = [];
  const adapter = createMockVoiceAdapter({
    schedule: callback => { const task = { callback, cancelled: false }; scheduled.push(task); return task; },
    unschedule: task => { task.cancelled = true; },
  });
  const events = [];
  return { adapter, scheduled, events, emit: event => events.push(event) };
}

test('mock separates prompt completion from recognition start and interim from final/end', () => {
  const { adapter, scheduled, events, emit } = fixture();
  adapter.startPrompt(context, emit);
  adapter.preview();adapter.complete();
  assert.deepEqual(events, []);
  scheduled[0].callback();
  assert.deepEqual(events, [{ ...context, type: 'prompt-complete' }]);
  adapter.preview();adapter.complete();
  assert.equal(events.length, 1);
  adapter.startRecognition(context, emit);
  adapter.preview();
  assert.equal(events.at(-1).type, 'interim');
  adapter.complete();adapter.complete();
  assert.deepEqual(events.map(event => event.type), ['prompt-complete', 'interim', 'final', 'ended']);
  assert.ok(events.every(event => event.sessionId === context.sessionId && event.tripId === context.tripId));
});

test('mock cancellation stops pending prompt and recognition, including scheduled late prompt callback', () => {
  const { adapter, scheduled, events, emit } = fixture();
  adapter.startPrompt(context, emit);adapter.stopPrompt(context);
  assert.equal(scheduled[0].cancelled, true);
  scheduled[0].callback();
  adapter.startRecognition(context, emit);adapter.cancelRecognition(context);
  adapter.preview();adapter.complete();
  assert.deepEqual(events, []);
  adapter.startPrompt(context, emit);
  adapter.startPrompt({ sessionId: 'session-b', tripId: 'trip-b' }, emit);
  scheduled[1].callback();scheduled[2].callback();
  assert.deepEqual(events, [{ sessionId: 'session-b', tripId: 'trip-b', type: 'prompt-complete' }]);
});

test('mock session captures configuration and ignores cancellation for another target', () => {
  const { adapter, events, emit } = fixture();
  adapter.configure({ mode: 'ok', text: '출퇴근' });adapter.startRecognition(context, emit);
  adapter.configure({ mode: 'failed', text: '개인 용도, 장보기' });
  adapter.cancelRecognition({ sessionId: 'other', tripId: context.tripId });
  adapter.complete();
  assert.equal(events[0].text, '출퇴근');
  assert.deepEqual(events.map(event => event.type), ['final', 'ended']);
});

test('mock represents recognition failure, empty end, unavailable and no-response timeout without real services', () => {
  for (const [mode, expected] of [
    ['failed', [{ ...context, type: 'error', code: 'failed' }]],
    ['empty', [{ ...context, type: 'ended' }]],
    ['unavailable', [{ ...context, type: 'error', code: 'unavailable' }]],
    ['timeout', []],
  ]) {
    const { adapter, events, emit } = fixture();
    adapter.configure({ mode });adapter.startRecognition(context, emit);adapter.complete();
    assert.deepEqual(events, expected);
    adapter.dispose();adapter.complete();assert.deepEqual(events, expected);
  }
});

test('final text parser preserves each explicit example and never fabricates a memo', () => {
  for (const [text, purpose, note] of [
    ['일반 업무, 거래처 미팅', 'business', '거래처 미팅'],
    ['출퇴근', 'commute', ''],
    ['개인 용도, 장보기', 'personal', '장보기'],
    ['  일반 업무 : 원문 메모  ', 'business', '원문 메모'],
  ]) {
    assert.deepEqual(parseVoiceText(text), { transcript: text, purpose, note, reason: 'matched' });
  }
});

test('text without an explicit single leading purpose requires a person to choose', () => {
  assert.deepEqual(parseVoiceText('거래처 미팅'), { transcript: '거래처 미팅', purpose: null, note: '거래처 미팅', reason: 'missing' });
  for (const text of ['업무 또는 개인 용도', '업무 아니에요', '아마 출퇴근', '개인인지 모르겠어요', '거래처 미팅, 일반 업무']) {
    const result = parseVoiceText(text);
    assert.equal(result.purpose, null, text);assert.equal(result.reason, 'ambiguous', text);assert.equal(result.transcript, text);
  }
  assert.equal(parseVoiceText('업무용 차량').purpose, null);
  assert.equal(parseVoiceText('   ').reason, 'empty');
});

test('overlong spoken memo is not silently truncated or made saveable', () => {
  const text = `일반 업무, ${'가'.repeat(121)}`;
  assert.deepEqual(parseVoiceText(text), { transcript: text, purpose: null, note: '', reason: 'too-long' });
});

test('negative or uncertain speech requires confirmation while similar place/noun names do not', () => {
  for (const text of [
    '출퇴근, 안 했습니다', '개인 용도, 안 썼습니다', '개인 용도, 안썼습니다',
    '일반 업무, 하지 않았습니다', '업무, 못 했습니다', '업무, 못했습니다',
    '출퇴근, 운행한 적 없습니다', '업무?', '업무인 것 같아요', '업무, 그런 것 같아요',
  ]) {
    const result = parseVoiceText(text);
    assert.equal(result.purpose, null, text);assert.equal(result.reason, 'ambiguous', text);
    assert.equal(result.transcript, text);
  }
  for (const note of ['안산 거래처 방문', '안전 교육 참석', '못골 거래처 미팅']) {
    assert.deepEqual(parseVoiceText(`업무, ${note}`), { transcript: `업무, ${note}`, purpose: 'business', note, reason: 'matched' });
  }
});
