import { parseVoiceText } from './voice-text.mjs';

const initial = () => ({ phase: 'idle', sessionId: null, tripId: null, interim: '', transcript: '', reason: null, error: null, cancelReason: null });
const target = state => state.editingTripId ?? state.current?.tripId;
const draftKey = state => JSON.stringify(state.draft);
const running = phase => ['prompting', 'listening', 'processing'].includes(phase);

/** Ephemeral input coordinator. Never stores audio, events or trips itself. */
export class VoiceFlow {
  #controller; #adapter; #id; #schedule; #unschedule; #promptTimeout; #recognitionTimeout;
  #state = initial(); #session = null; #listeners = new Set(); #unsubscribe = null; #foreground = true; #applying = false;
  constructor({ controller, adapter, id = () => crypto.randomUUID(), schedule = (fn, ms) => setTimeout(fn, ms), unschedule = timer => clearTimeout(timer),
    promptTimeoutMs = 10000, recognitionTimeoutMs = 15000 }) {
    this.#controller = controller; this.#adapter = adapter; this.#id = id;
    this.#schedule = schedule; this.#unschedule = unschedule;
    this.#promptTimeout = promptTimeoutMs; this.#recognitionTimeout = recognitionTimeoutMs;
  }
  // Explicit lifetime: React mount/unmount and deterministic tests share the same cleanup.
  connect() {
    if (!this.#unsubscribe) this.#unsubscribe = this.#controller.subscribe(state => {
      if (!this.#applying && this.#session && !this.#matches(state)) this.cancel('context-changed');
      else if (!this.#session && this.#state.tripId && (target(state) !== this.#state.tripId || state.screen !== 'purpose' || state.driving)) this.clear();
    });
    return () => this.disconnect();
  }
  disconnect() { this.cancel('inactive'); this.#unsubscribe?.(); this.#unsubscribe = null; }
  getState() { return structuredClone(this.#state); }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #set(patch) { this.#state = { ...this.#state, ...patch }; for (const listener of this.#listeners) listener(this.getState()); }
  #matches(state = this.#controller.getState()) {
    return this.#foreground && !state.driving && state.screen === 'purpose' && !!state.draft &&
      target(state) === this.#session?.tripId && state.active === this.#session?.active && draftKey(state) === this.#session?.draft;
  }
  #clearTimers(session) { for (const timer of session.timers) this.#unschedule(timer); session.timers.clear(); }
  #timer(session, fn, ms) {
    const timer = this.#schedule(() => { session.timers.delete(timer); if (this.#session === session) fn(); }, ms);
    session.timers.add(timer);
  }
  #release(cancel = true) {
    const session = this.#session;
    this.#session = null; // Invalidate before adapter cleanup: cleanup may call back synchronously.
    if (!session) return;
    this.#clearTimers(session);
    try { this.#adapter.stopPrompt(session.context); } catch { /* Invalidated already. */ }
    try { if (cancel) this.#adapter.cancelRecognition(session.context); } catch { /* Invalidated already. */ }
  }
  cancel(reason = 'user') {
    const cancelReason = reason === 'user' && !running(this.#state.phase) ? null : reason;
    this.#release(); this.#set({ ...initial(), cancelReason });
  }
  clear() { this.#release(); this.#set(initial()); }
  setForeground(value) { this.#foreground = value; if (!value) this.cancel('inactive'); }
  #fail(error) { this.#release(); this.#set({ phase: 'error', interim: '', error }); }
  start() {
    this.cancel('new-session');
    const state = this.#controller.getState();
    if (!this.#foreground || state.driving || state.screen !== 'purpose' || !state.draft || !target(state)) return false;
    const context = { sessionId: this.#id(), tripId: target(state) };
    const session = { ...context, context, active: state.active, draft: draftKey(state), timers: new Set(), final: false };
    this.#session = session;
    this.#set({ ...initial(), ...context, phase: 'prompting' });
    this.#timer(session, () => this.#fail('timeout'), this.#promptTimeout);
    try { this.#adapter.startPrompt(context, event => this.#receive(session, event)); }
    catch { if (this.#session === session) this.#fail('unavailable'); }
    return true;
  }
  #receive(session, event) {
    if (this.#session !== session || event.sessionId !== session.sessionId || event.tripId !== session.tripId) return;
    if (!this.#matches()) { this.cancel('context-changed'); return; }
    if (event.type === 'error') { if (!session.final) this.#fail(event.code === 'unavailable' ? 'unavailable' : 'failed'); return; }
    if (event.type === 'prompt-complete' && this.#state.phase === 'prompting') {
      this.#clearTimers(session);
      this.#set({ phase: 'listening' });
      this.#timer(session, () => this.#fail('timeout'), this.#recognitionTimeout);
      try {
        this.#adapter.stopPrompt(session.context);
        this.#adapter.startRecognition(session.context, next => this.#receive(session, next));
      } catch { if (this.#session === session) this.#fail('unavailable'); }
    } else if (event.type === 'interim' && this.#state.phase === 'listening' && !session.final) {
      this.#set({ interim: typeof event.text === 'string' ? event.text : '' });
    } else if (event.type === 'ended' && this.#state.phase === 'listening' && !session.final) {
      this.#fail('empty');
    } else if (event.type === 'final' && this.#state.phase === 'listening' && !session.final) {
      session.final = true;
      this.#clearTimers(session);
      this.#set({ phase: 'processing', interim: '' });
      // Defer parsing one controlled tick so processing is distinct and cancellable.
      this.#timer(session, () => {
        if (!this.#matches()) { this.cancel('context-changed'); return; }
        const parsed = parseVoiceText(typeof event.text === 'string' ? event.text : '');
        if (parsed.reason === 'empty') { this.#fail('empty'); return; }
        try {
          this.#applying = true;
          this.#controller.setPurpose(parsed.purpose, parsed.note);
        } catch {
          this.#fail('draft-failed'); return;
        } finally { this.#applying = false; }
        this.#release();
        this.#set({ phase: 'draft', transcript: parsed.transcript, reason: parsed.reason, error: null });
      }, 0);
      try { this.#adapter.finishRecognition(session.context); }
      catch { /* A final result was already received; no automatic save. */ }
    }
  }
}
