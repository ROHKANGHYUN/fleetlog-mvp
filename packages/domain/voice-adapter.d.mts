/** In-memory application port; these names do not claim a Pleos SDK API. */
export interface VoiceContext { sessionId: string; tripId: string; }
export type VoiceEvent = VoiceContext & (
  | { type: 'prompt-complete' }
  | { type: 'interim' | 'final'; text: string }
  | { type: 'ended' }
  | { type: 'error'; code: 'failed' | 'unavailable' }
);
export type VoiceEmit = (event: VoiceEvent) => void;
export interface VoiceAdapter {
  startPrompt(context: VoiceContext, emit: VoiceEmit): void;
  stopPrompt(context: VoiceContext): void;
  startRecognition(context: VoiceContext, emit: VoiceEmit): void;
  finishRecognition(context: VoiceContext): void;
  cancelRecognition(context: VoiceContext): void;
}
