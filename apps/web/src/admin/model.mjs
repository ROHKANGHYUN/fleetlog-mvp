const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURPOSES = [
  ['business', '일반 업무'], ['commute', '출퇴근'], ['personal', '개인 용도'], ['unconfirmed', '미확정'],
];

export function defaultFilters() {
  return { from: '', to: '', purpose: 'all', unconfirmed: 'all', distance: 'all', vehicleId: '', driverId: '', query: '' };
}

export function distanceMeters(payload) {
  if (payload.quality !== 'valid' || !Number.isFinite(payload.startOdometerM) || !Number.isFinite(payload.endOdometerM) ||
    payload.startOdometerM < 0 || payload.endOdometerM < payload.startOdometerM) return null;
  return payload.endOdometerM - payload.startOdometerM;
}

export function exceptionReasons(trip) {
  const reasons = [];
  if (trip.payload.purpose === null) reasons.push('용도 미확정');
  if (distanceMeters(trip.payload) === null) reasons.push(trip.payload.quality === 'gap' ? '거리 확인 필요 · gap' : '거리 확인 필요');
  return reasons;
}

/** KST display is independent of the browser/system time zone. */
export function formatKst(value) {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return '시간 확인 필요';
  const date = new Date(instant + KST_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} KST`;
}

function koreanDayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const instant = Date.parse(`${value}T00:00:00+09:00`);
  // Date.parse may normalize dates such as February 30. Reject those explicitly.
  if (!Number.isFinite(instant) || new Date(instant + KST_OFFSET_MS).toISOString().slice(0, 10) !== value) return NaN;
  return instant;
}

function dateRange(filters) {
  const from = filters.from ? koreanDayStart(filters.from) : -Infinity;
  const to = filters.to ? koreanDayStart(filters.to) : Infinity;
  if (Number.isNaN(from) || Number.isNaN(to)) return { error: '올바른 한국 날짜를 입력해 주세요.' };
  if (from > to) return { error: '시작일이 종료일보다 늦습니다.' };
  return { from, until: to === Infinity ? Infinity : to + DAY_MS, error: null };
}

function latestTrips(trips) {
  const latest = new Map();
  for (const trip of trips) {
    const previous = latest.get(trip.tripId);
    if (!previous || trip.serverVersion > previous.serverVersion ||
      (trip.serverVersion === previous.serverVersion && trip.localRevision > previous.localRevision) ||
      (trip.serverVersion === previous.serverVersion && trip.localRevision === previous.localRevision && trip.updatedAt > previous.updatedAt)) {
      latest.set(trip.tripId, trip);
    }
  }
  return [...latest.values()];
}

function summarize(records) {
  const distances = records.map(trip => distanceMeters(trip.payload)).filter(value => value !== null);
  return {
    receivedCount: records.length,
    needsReviewCount: records.filter(trip => exceptionReasons(trip).length > 0).length,
    unconfirmedCount: records.filter(trip => trip.payload.purpose === null).length,
    invalidDistanceCount: records.length - distances.length,
    validDistanceM: distances.length ? distances.reduce((sum, value) => sum + value, 0) : null,
    validDistanceCount: distances.length,
    excludedDistanceCount: records.length - distances.length,
    groups: PURPOSES.map(([key, label]) => {
      const group = records.filter(trip => (trip.payload.purpose ?? 'unconfirmed') === key);
      const valid = group.map(trip => distanceMeters(trip.payload)).filter(value => value !== null);
      return { key, label, count: group.length, validDistanceM: valid.length ? valid.reduce((sum, value) => sum + value, 0) : null,
        validDistanceCount: valid.length, excludedDistanceCount: group.length - valid.length };
    }),
  };
}

export function selectTrips(trips, filters = defaultFilters(), { view = 'records', sort = 'newest', page = 1, pageSize = 10 } = {}) {
  filters = { ...defaultFilters(), ...filters };
  const allLatest = latestTrips(trips).sort((a, b) => {
    const aTime = Date.parse(a.payload.startedAt), bTime = Date.parse(b.payload.startedAt);
    if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
    if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
    const timeDifference = sort === 'oldest' ? aTime - bTime : bTime - aTime;
    return (Number.isFinite(timeDifference) ? timeDifference : 0) || (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0);
  });
  const options = {
    vehicleIds: [...new Set(allLatest.map(trip => trip.payload.vehicleId))].sort(),
    driverIds: [...new Set(allLatest.map(trip => trip.payload.driverId))].sort(),
  };
  const range = dateRange(filters);
  const query = filters.query.trim().toLocaleLowerCase('ko-KR');
  const filtered = range.error ? [] : allLatest.filter(trip => {
    const payload = trip.payload;
    const startedAt = Date.parse(payload.startedAt);
    if ((filters.from || filters.to) && (!Number.isFinite(startedAt) || startedAt < range.from || startedAt >= range.until)) return false;
    if (filters.purpose !== 'all' && payload.purpose !== filters.purpose) return false;
    if (filters.unconfirmed === 'yes' && payload.purpose !== null) return false;
    if (filters.unconfirmed === 'no' && payload.purpose === null) return false;
    const validDistance = distanceMeters(payload) !== null;
    if (filters.distance === 'valid' && !validDistance) return false;
    if (filters.distance === 'needs' && validDistance) return false;
    if (filters.vehicleId && payload.vehicleId !== filters.vehicleId) return false;
    if (filters.driverId && payload.driverId !== filters.driverId) return false;
    return !query || [payload.vehicleId, payload.driverId, payload.note].some(value => value.toLocaleLowerCase('ko-KR').includes(query));
  });
  const exceptions = filtered.filter(trip => exceptionReasons(trip).length > 0);
  const visible = view === 'exceptions' ? exceptions : filtered;
  const size = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : 10;
  const pages = Math.max(1, Math.ceil(visible.length / size));
  const currentPage = Math.min(pages, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  return { allLatest, filtered, exceptions, rows: visible.slice((currentPage - 1) * size, currentPage * size),
    page: currentPage, pages, total: visible.length, summary: summarize(filtered), options, filterError: range.error };
}
