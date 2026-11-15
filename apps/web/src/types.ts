import { PURPOSE_LABELS, type TripPayload } from '../../../packages/contracts/index.mjs';
export type { Purpose, TripPayload, StoredTrip } from '../../../packages/contracts/index.mjs';

// Presentation labels only; persisted purpose values and the shared wire contract stay unchanged.
export const purposeLabels = { ...PURPOSE_LABELS, personal: '개인 용도' };

export function distanceKm(payload: Pick<TripPayload, 'quality' | 'startOdometerM' | 'endOdometerM'>): number | null {
  if (payload.quality !== 'valid' || payload.endOdometerM === null ||
    !Number.isFinite(payload.startOdometerM) || !Number.isFinite(payload.endOdometerM) ||
    payload.endOdometerM < payload.startOdometerM) return null;
  return (payload.endOdometerM - payload.startOdometerM) / 1000;
}

export function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '시간 확인 필요' :
    new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
