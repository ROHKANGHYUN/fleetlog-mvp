import type { StoredTrip } from '../../../../packages/contracts/index.mjs';

export interface AdminQueryState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  trips: StoredTrip[];
  hasLoaded: boolean;
  lastSuccessAt: string | null;
  error: string | null;
}
export class AdminQuery {
  constructor(options?: { fetchTrips?: (signal: AbortSignal) => Promise<StoredTrip[]>; now?: () => string });
  getState(): AdminQueryState;
  subscribe(listener: (state: AdminQueryState) => void): () => void;
  load(): Promise<void>;
  cancel(): void;
}
