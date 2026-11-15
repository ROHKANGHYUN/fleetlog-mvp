/**
 * Development-only speech fixture. No microphone, recording, network or SDK calls.
 * Prompt completion and recognition start are deliberately separate operations.
 */
export function createMockVoiceAdapter({ schedule = setTimeout, unschedule = clearTimeout, promptDelayMs = 900 } = {}) {
  let prompt = null;
  let recognition = null;
  let disposed = false;
  let configuration = { mode: 'ok', text: '일반 업무, 거래처 미팅' };
  const same = (operation, context) => operation && operation.context.sessionId === context.sessionId && operation.context.tripId === context.tripId;
  const emit = (operation, event) => operation.emit({ ...event, ...operation.context });
  function stopPrompt(context) {
    if (!same(prompt, context)) return;
    unschedule(prompt.timer);
    prompt = null;
  }
  function cancelRecognition(context) {
    if (same(recognition, context)) recognition = null;
  }
  function finishRecognition(context) {
    if (!same(recognition, context)) return;
    const operation = recognition;
    recognition = null;
    emit(operation, { type: 'ended' });
  }
  return {
    startPrompt(context, callback) {
      if (disposed) throw new Error('종료된 모의 음성 adapter입니다.');
      if (prompt) stopPrompt(prompt.context);
      const operation = { context: { ...context }, emit: callback, timer: null };
      prompt = operation;
      operation.timer = schedule(() => {
        if (prompt !== operation || disposed) return;
        prompt = null;
        emit(operation, { type: 'prompt-complete' });
      }, promptDelayMs);
    },
    stopPrompt,
    startRecognition(context, callback) {
      if (disposed) throw new Error('종료된 모의 음성 adapter입니다.');
      // Each operation captures the configured fixture so later developer changes
      // cannot mutate an already running recognition session.
      const operation = { context: { ...context }, emit: callback, ...configuration };
      recognition = operation;
      if (operation.mode === 'unavailable') {
        recognition = null;
        emit(operation, { type: 'error', code: 'unavailable' });
      }
    },
    finishRecognition,
    cancelRecognition,
    configure(next) {
      const modes = ['ok', 'failed', 'empty', 'timeout', 'unavailable'];
      if (next.mode !== undefined && !modes.includes(next.mode)) throw new Error('지원하지 않는 모의 음성 상태입니다.');
      if (next.text !== undefined && typeof next.text !== 'string') throw new Error('모의 인식 문장은 문자열이어야 합니다.');
      configuration = { ...configuration, ...next };
    },
    preview() {
      if (!recognition || recognition.mode !== 'ok') return;
      emit(recognition, { type: 'interim', text: recognition.text });
    },
    complete() {
      const operation = recognition;
      if (!operation || operation.mode === 'timeout') return;
      if (operation.mode === 'failed') {
        recognition = null;
        emit(operation, { type: 'error', code: 'failed' });
        return;
      }
      if (operation.mode === 'empty') {
        finishRecognition(operation.context);
        return;
      }
      // A final result is an input result, never a trip save. The orchestrator
      // can cancel this operation while consuming final; avoid a stale ended.
      emit(operation, { type: 'final', text: operation.text });
      if (recognition === operation) finishRecognition(operation.context);
    },
    dispose() {
      if (prompt) stopPrompt(prompt.context);
      recognition = null;
      disposed = true;
    },
  };
}
