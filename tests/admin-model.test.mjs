import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFilters, distanceMeters, exceptionReasons, formatKst, selectTrips } from '../apps/web/src/admin/model.mjs';

function trip(id, { startedAt = '2026-11-14T15:00:00.000Z', endedAt = '2026-11-14T15:30:00.000Z', purpose = 'business', quality = 'valid', start = 1000, end = 4000, vehicle = 'car-a', driver = 'driver-a', note = '', version = 1, revision = version } = {}) {
  return { tripId:id, serverVersion:version, localRevision:revision, source:'mock', updatedAt:'2026-11-15T02:00:00.000Z',
    payload:{ vehicleId:vehicle,driverId:driver,startedAt,endedAt,startOdometerM:start,endOdometerM:end,purpose,note,quality } };
}
const withFilters = (trips, filters, options) => selectTrips(trips, { ...defaultFilters(), ...filters }, options);

test('Korean calendar day includes both UTC boundaries and leaves a cross-midnight trip intact', () => {
  const before = trip('before', { startedAt:'2026-11-14T14:59:59.999Z' });
  const atStart = trip('start');
  const crossing = trip('cross', { startedAt:'2026-11-15T14:59:59.999Z',endedAt:'2026-11-15T16:00:00.000Z',end:9000 });
  const after = trip('after', { startedAt:'2026-11-15T15:00:00.000Z' });
  const result = withFilters([before, atStart, crossing, after], { from:'2026-11-15',to:'2026-11-15' });
  assert.deepEqual(result.filtered.map(t => t.tripId), ['cross','start']);
  assert.equal(result.summary.validDistanceM, 11000);
  assert.equal(result.filtered[0].payload.endedAt, crossing.payload.endedAt);
  assert.equal(formatKst(atStart.payload.startedAt),'2026.11.15 00:00:00 KST');
  assert.equal(formatKst(crossing.payload.endedAt),'2026.11.16 01:00:00 KST');
});

test('invalid calendar days and reversed intervals are explicit filter errors rather than an accidental valid period', () => {
  for (const filters of [{from:'2026-02-30'}, {to:'2026-2-01'}, {from:'2026-11-16',to:'2026-11-15'}]) {
    const result = withFilters([trip('a')], filters);
    assert.ok(result.filterError);
    assert.equal(result.rows.length,0);
    assert.equal(result.filtered.length,0);
    assert.equal(result.allLatest.length,1);
  }
});

test('all filters have one shared scope for table, exceptions and purpose summary while selectors use actual received records', () => {
  const data = [
    trip('match',{purpose:null,quality:'gap',vehicle:'car-b',driver:'driver-b',note:'Seoul 미팅'}),
    trip('wrong-driver',{purpose:null,quality:'gap',vehicle:'car-b',driver:'driver-c',note:'Seoul 미팅'}),
    trip('wrong-purpose',{quality:'gap',vehicle:'car-b',driver:'driver-b',note:'Seoul 미팅'}),
    trip('wrong-distance',{purpose:null,vehicle:'car-b',driver:'driver-b',note:'Seoul 미팅'}),
    trip('wrong-query',{purpose:null,quality:'gap',vehicle:'car-b',driver:'driver-b',note:'다른 메모'}),
  ];
  const result = withFilters(data,{unconfirmed:'yes',distance:'needs',vehicleId:'car-b',driverId:'driver-b',query:'seOul'});
  assert.deepEqual(result.rows.map(t=>t.tripId),['match']);
  assert.deepEqual(result.exceptions.map(t=>t.tripId),['match']);
  assert.equal(result.summary.receivedCount,1);
  assert.equal(result.summary.groups.find(g=>g.key==='unconfirmed').count,1);
  assert.equal(result.summary.groups.find(g=>g.key==='business').count,0);
  assert.deepEqual(result.options.driverIds,['driver-b','driver-c']);
  const reset=selectTrips(data,defaultFilters());
  assert.equal(reset.total,5);
  assert.equal(withFilters(data,{purpose:'business'}).total,1);
  assert.equal(withFilters(data,{unconfirmed:'no'}).total,1);
  assert.equal(withFilters(data,{distance:'valid'}).total,1);
  assert.equal(withFilters(data,{query:'CAR-B'}).total,5);
});

test('one trip with two review reasons appears once while reason counts may overlap and gap never becomes valid with a purpose', () => {
  const both=trip('both',{purpose:null,quality:'gap'}), purposeOnly=trip('purpose',{purpose:null}), gapOnly=trip('gap',{quality:'gap'});
  const result=selectTrips([both,purposeOnly,gapOnly],defaultFilters(),{view:'exceptions'});
  assert.equal(result.rows.length,3);
  assert.equal(result.summary.needsReviewCount,3);
  assert.equal(result.summary.unconfirmedCount,2);
  assert.equal(result.summary.invalidDistanceCount,2);
  assert.deepEqual(exceptionReasons(both),['용도 미확정','거리 확인 필요 · gap']);
  assert.deepEqual(exceptionReasons(gapOnly),['거리 확인 필요 · gap']);
  assert.equal(result.summary.validDistanceM,3000);
  assert.equal(result.summary.excludedDistanceCount,2);
});

test('distance totals distinguish no records, all excluded records and an actual zero distance', () => {
  assert.equal(selectTrips([]).summary.validDistanceM,null);
  const excluded=selectTrips([trip('gap',{quality:'gap'}),trip('reverse',{end:500})]);
  assert.equal(excluded.summary.validDistanceM,null);
  assert.equal(excluded.summary.receivedCount,2);
  assert.equal(excluded.summary.excludedDistanceCount,2);
  const zero=selectTrips([trip('zero',{end:1000})]);
  assert.equal(zero.summary.validDistanceM,0);
  assert.equal(zero.summary.validDistanceCount,1);
  assert.equal(zero.summary.groups.find(g=>g.key==='business').validDistanceM,0);
  assert.equal(zero.summary.groups.find(g=>g.key==='commute').validDistanceM,null);
  for (const payload of [{quality:'gap',startOdometerM:0,endOdometerM:1000},{quality:'valid',startOdometerM:-1,endOdometerM:10},{quality:'valid',startOdometerM:0,endOdometerM:null},{quality:'valid',startOdometerM:0,endOdometerM:NaN}]) assert.equal(distanceMeters(payload),null);
});

test('only the latest received revision counts even when older revisions arrive later in the response', () => {
  const old=trip('same',{purpose:null,quality:'gap',version:1});
  const latest=trip('same',{purpose:'personal',quality:'gap',version:2,note:'보완 메모'});
  const data=[latest,trip('other',{purpose:'commute'}),old];
  const result=selectTrips(data);
  assert.equal(result.summary.receivedCount,2);
  assert.equal(result.summary.unconfirmedCount,0);
  assert.equal(result.summary.needsReviewCount,1);
  assert.equal(result.summary.groups.find(g=>g.key==='personal').count,1);
  assert.equal(result.allLatest.find(t=>t.tripId==='same').serverVersion,2);
  assert.equal(result.allLatest.find(t=>t.tripId==='same').payload.note,'보완 메모');
  assert.equal(data[2],old);
});

test('stable start-time sorting and clamped pagination do not change filter summaries', () => {
  const records=Array.from({length:23},(_,i)=>trip(String(i).padStart(2,'0'),{startedAt:i<3?'2026-11-14T15:00:00.000Z':`2026-11-15T${String(i).padStart(2,'0')}:00:00.000Z`}));
  const first=selectTrips(records,defaultFilters(),{page:1,pageSize:10});
  const last=selectTrips(records,defaultFilters(),{page:99,pageSize:10});
  assert.equal(first.pages,3);assert.equal(first.rows.length,10);
  assert.equal(last.page,3);assert.equal(last.rows.length,3);
  assert.deepEqual(first.summary,last.summary);
  assert.deepEqual(selectTrips(records,defaultFilters(),{sort:'oldest',pageSize:3}).rows.map(t=>t.tripId),['00','01','02']);
  const narrowed=withFilters(records,{query:'no-match'},{page:3});
  assert.equal(narrowed.page,1);assert.equal(narrowed.pages,1);assert.equal(narrowed.total,0);
});
