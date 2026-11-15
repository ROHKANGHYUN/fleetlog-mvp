import { canonicalJson, validateTripEvent } from '../contracts/index.mjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const require = condition => { if (!condition) throw Error('invalid local state'); };
const payloadEvent = (tripId, payload, revision = 1) => ({ schemaVersion: 1, eventType: 'TRIP_UPSERT',
  tripId, eventId: tripId, localRevision: revision, expectedServerVersion: 0, source: 'mock', payload });
const rawFields = ['vehicleId', 'driverId', 'startedAt', 'endedAt', 'startOdometerM', 'endOdometerM', 'quality'];

/** Validate schema v1 without repairing, dropping or rewriting any saved value. */
export function validateSavedState(s) {
  require(object(s) && s.schemaVersion === 1 && Array.isArray(s.records) && Array.isArray(s.outbox) && object(s.receipts));
  require(['active', 'driving', 'online'].every(key => typeof s[key] === 'boolean'));
  require(['ready', 'collecting', 'purpose', 'review', 'saved', 'pending'].includes(s.screen) && integer(s.odometerM));
  require(s.lastError === null || typeof s.lastError === 'string');
  const records = new Map();
  for (const r of s.records) {
    require(object(r) && uuid(r.tripId) && !records.has(r.tripId) && integer(r.localRevision, 1) &&
      integer(r.ackedLocalRevision) && r.ackedLocalRevision <= r.localRevision && integer(r.serverVersion));
    validateTripEvent(payloadEvent(r.tripId, r.payload, r.localRevision));
    require((r.serverVersion === 0) === (r.ackedLocalRevision === 0));
    records.set(r.tripId, r);
  }
  for (const [eventId, ack] of Object.entries(s.receipts)) {
    require(uuid(eventId) && object(ack) && ack.eventId === eventId && integer(ack.ackedLocalRevision, 1) && integer(ack.serverVersion, 1));
  }
  const events = new Map();
  const revisions = new Set();
  for (const e of s.outbox) {
    const r = records.get(e?.tripId);
    require(object(e) && r && uuid(e.eventId) && !events.has(e.eventId) && !s.receipts[e.eventId] &&
      integer(e.localRevision, 1) && e.localRevision > r.ackedLocalRevision && e.localRevision <= r.localRevision &&
      integer(e.baseServerVersion) && integer(e.attempts) && ['queued', 'conflict', 'blocked'].includes(e.status));
    const revisionKey = `${e.tripId}:${e.localRevision}`;
    require(!revisions.has(revisionKey)); revisions.add(revisionKey);
    validateTripEvent({ ...payloadEvent(e.tripId, e.payload, e.localRevision), eventId: e.eventId });
    require(rawFields.every(key => e.payload[key] === r.payload[key]));
    require(e.localRevision !== r.localRevision || canonicalJson(e.payload) === canonicalJson(r.payload));
    require(e.lastError === undefined || typeof e.lastError === 'string');
    require(e.failureKind === undefined || ['transient', 'ack', 'blocked', 'conflict'].includes(e.failureKind));
    if (e.predecessorEventId !== null) {
      const previous = events.get(e.predecessorEventId), ack = s.receipts[e.predecessorEventId];
      require((previous && previous.tripId === e.tripId && previous.localRevision < e.localRevision) ||
        (ack && ack.ackedLocalRevision < e.localRevision));
    }
    if (e.preparedEvent !== null) {
      const prepared = validateTripEvent(e.preparedEvent);
      require(prepared.eventId === e.eventId && prepared.tripId === e.tripId && prepared.localRevision === e.localRevision &&
        canonicalJson(prepared.payload) === canonicalJson(e.payload));
      const expected = e.predecessorEventId ? s.receipts[e.predecessorEventId]?.serverVersion : e.baseServerVersion;
      require(expected !== undefined && prepared.expectedServerVersion === expected);
    }
    events.set(e.eventId, e);
  }
  for (const r of records.values()) {
    const pending = [...events.values()].filter(e => e.tripId === r.tripId);
    require(r.ackedLocalRevision === r.localRevision || pending.some(e => e.localRevision === r.localRevision));
  }
  if (s.current !== null) {
    const c = s.current;
    require(object(c) && uuid(c.tripId) && !records.has(c.tripId) && s.active && timestamp(c.startedAt) &&
      integer(c.startOdometerM) && c.startOdometerM <= s.odometerM && ['valid', 'gap'].includes(c.quality));
    require(c.lastObservedAt === undefined || (timestamp(c.lastObservedAt) && c.lastObservedAt >= c.startedAt));
    require(c.candidateEnd === undefined || (object(c.candidateEnd) && timestamp(c.candidateEnd.endedAt) &&
      c.candidateEnd.endedAt >= c.startedAt && integer(c.candidateEnd.endOdometerM) &&
      c.candidateEnd.endOdometerM >= c.startOdometerM && c.candidateEnd.endOdometerM <= s.odometerM));
  }
  require(s.editingTripId === null || records.has(s.editingTripId));
  require(s.lastSavedTripId === null || records.has(s.lastSavedTripId));
  if (s.draft !== null) {
    require(object(s.draft) && [null, 'business', 'commute', 'personal'].includes(s.draft.purpose) &&
      typeof s.draft.note === 'string' && s.draft.note.length <= 120 && ['purpose', 'review'].includes(s.screen));
    require(!s.driving && (s.editingTripId !== null || s.current?.candidateEnd));
    require(s.screen !== 'review' || s.draft.purpose !== null);
  } else require(!['purpose', 'review'].includes(s.screen) && s.editingTripId === null);
  return s;
}
