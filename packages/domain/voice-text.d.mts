import type { Purpose } from '../contracts/index.mjs';
export interface ParsedVoiceText {
  transcript: string;
  purpose: Purpose | null;
  note: string;
  reason: 'matched' | 'missing' | 'ambiguous' | 'empty' | 'too-long';
}
export function parseVoiceText(text: string): ParsedVoiceText;
