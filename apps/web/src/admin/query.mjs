const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.length > 0;
const version = value => Number.isSafeInteger(value) && value >= 1;
const odometer = value => Number.isSafeInteger(value) && value >= 0;

// A malformed response is a query error, never an empty server dataset.
function validateTrips(values) {
  if (!Array.isArray(values)) throw new Error('서버의 기록 목록 형식을 확인해 주세요.');
  for (const trip of values) {
    const p = trip?.payload;
    if (!object(trip) || !text(trip.tripId) || !version(trip.serverVersion) || !version(trip.localRevision) ||
      trip.source !== 'mock' || !timestamp(trip.updatedAt) || !object(p) ||
      !text(p.vehicleId) || !text(p.driverId) || !timestamp(p.startedAt) || !timestamp(p.endedAt) ||
      !odometer(p.startOdometerM) || !odometer(p.endOdometerM) ||
      !['business', 'commute', 'personal', null].includes(p.purpose) || typeof p.note !== 'string' ||
      !['valid', 'gap'].includes(p.quality)) {
      throw new Error('서버 수신 기록의 필수 항목이나 데이터 형식을 확인해 주세요.');
    }
  }
  return values;
}

async function fetchServerTrips(signal) {
  const response = await fetch('/api/trips', {
    headers: { 'X-FleetLog-Dev': 'local-only' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  });
  if (!response.ok) throw new Error(`서버 응답 ${response.status}`);
  const body = await response.json();
  if (!object(body)) throw new Error('서버의 기록 목록 형식을 확인해 주세요.');
  return validateTrips(body.trips);
}

/** Server-only read model. It never reads vehicle localStorage or writes trips. */
export class AdminQuery {
  #fetchTrips; #now; #state; #generation = 0; #request = null; #listeners = new Set();
  constructor({ fetchTrips = fetchServerTrips, now = () => new Date().toISOString() } = {}) {
    this.#fetchTrips = fetchTrips;
    this.#now = now;
    this.#state = { status: 'idle', trips: [], hasLoaded: false, lastSuccessAt: null, error: null };
  }
  getState() { return structuredClone(this.#state); }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.getState());
  }
  async load() {
    const generation = ++this.#generation;
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.#set({ status: 'loading', error: null });
    try {
      const trips = validateTrips(await this.#fetchTrips(request.signal));
      if (generation !== this.#generation) return;
      this.#set({ status: 'ready', trips: structuredClone(trips), hasLoaded: true, lastSuccessAt: this.#now(), error: null });
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.#set({ status: 'error', error: cause instanceof Error ? cause.message : '서버에 연결할 수 없습니다.' });
    } finally {
      if (generation === this.#generation) this.#request = null;
    }
  }
  cancel() {
    ++this.#generation;
    this.#request?.abort();
    this.#request = null;
    if (this.#state.status === 'loading') this.#set({ status: this.#state.hasLoaded ? 'ready' : 'idle', error: null });
  }
}
