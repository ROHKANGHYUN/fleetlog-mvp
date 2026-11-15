import type { VoiceAdapter } from '../../../../packages/domain/voice-adapter.mjs';
export type { VoiceContext, VoiceEvent, VoiceEmit, VoiceAdapter } from '../../../../packages/domain/voice-adapter.mjs';
export type MockVoiceMode = 'ok' | 'failed' | 'empty' | 'timeout' | 'unavailable';
export interface MockVoiceAdapter extends VoiceAdapter {
  configure(options: { mode?: MockVoiceMode; text?: string }): void;
  preview(): void;
  complete(): void;
  dispose(): void;
}
export function createMockVoiceAdapter(options?: {
  schedule?: (callback: () => void, delay: number) => unknown;
  unschedule?: (handle: any) => void;
  promptDelayMs?: number;
}): MockVoiceAdapter;
