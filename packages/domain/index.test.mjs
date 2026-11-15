import test from 'node:test';import assert from 'node:assert/strict';
import {FleetController,MemoryStorage} from './index.mjs';
const create=(options={})=>new FleetController({storage:new MemoryStorage(),...options});
function leg(c){c.start();c.setDriving(true);c.setDriving(false);c.finish();}
function confirm(c,note='거래처 방문'){c.setPurpose('business',note);c.review();c.save();}
test('recording requires explicit start and blocks driving interaction',()=>{const c=create();c.setDriving(true);assert.equal(c.getState().current,null);assert.throws(()=>c.start());c.setDriving(false);c.start();c.setDriving(true);assert.throws(()=>c.finish());assert.throws(()=>c.stop());});
test('parking alone does not close a leg and redeparture invalidates draft',()=>{const c=create();leg(c);c.setPurpose('business','초안');c.setDriving(true);const s=c.getState();assert.equal(s.draft,null);assert.equal(s.records.length,0);assert.equal(s.odometerM-s.current.startOdometerM,46800);assert.throws(()=>c.save());});
test('final purpose requires explicit review and duplicate save is blocked',()=>{const c=create();leg(c);c.setPurpose('business');assert.throws(()=>c.save());c.review();c.save();assert.throws(()=>c.save());assert.equal(c.getState().outbox.length,1);});
test('deferred purpose preserves the distance and queues an event',()=>{const c=create();leg(c);c.defer();const r=c.getState().records[0];assert.equal(r.payload.purpose,null);assert.equal(r.payload.endOdometerM-r.payload.startOdometerM,23400);assert.equal(r.ackedLocalRevision,0);});
test('next leg continues inside the active session and session stop needs restart',()=>{const c=create();leg(c);confirm(c);c.setDriving(true);c.setDriving(false);c.stop();assert.equal(c.getState().records.length,2);assert.equal(c.getState().records[1].payload.purpose,null);c.setDriving(true);assert.equal(c.getState().current,null);assert.equal(c.getState().active,false);});
test('storage failure never publishes a successful save',()=>{const storage=new MemoryStorage();const c=create({storage});leg(c);c.setPurpose('business');c.review();const before=c.getState();storage.setItem=()=>{throw new Error('quota');};assert.throws(()=>c.save(),/quota/);assert.deepEqual(c.getState(),before);});
test('reload preserves unfinished leg as a gap without silent recording',()=>{const storage=new MemoryStorage();const c=create({storage});c.start();c.setDriving(true);const restored=create({storage});const s=restored.getState();assert.equal(s.active,false);assert.equal(s.records[0].payload.quality,'gap');assert.equal(s.records[0].payload.purpose,null);assert.equal(s.outbox.length,1);});
test('invalid saved JSON is not overwritten during recovery',()=>{const storage=new MemoryStorage();storage.value='broken';assert.throws(()=>create({storage}),/손상/);assert.equal(storage.value,'broken');});
test('offline sync sends nothing and same record survives reload',async()=>{let calls=0;const storage=new MemoryStorage();const c=create({storage,sendEvent:async()=>{calls++;}});leg(c);c.defer();c.setOnline(false);await c.sync();assert.equal(calls,0);assert.equal(create({storage}).getState().records.length,1);});
test('server ACK changes only delivery; ending session remains ended',async()=>{let resolve;const c=create({sendEvent:e=>new Promise(r=>{resolve=()=>r({eventId:e.eventId,ackedLocalRevision:e.localRevision,serverVersion:1});})});leg(c);confirm(c);const promise=c.sync();c.stop();resolve();await promise;assert.equal(c.getState().active,false);assert.equal(c.getState().records[0].ackedLocalRevision,1);});
test('multiple offline revisions prepare version only after predecessor ACK',async()=>{const sent=[];const c=create({sendEvent:async e=>{sent.push(e);return {eventId:e.eventId,ackedLocalRevision:e.localRevision,serverVersion:e.expectedServerVersion+1};}});leg(c);c.defer();c.editTrip(c.getState().records[0].tripId);confirm(c);assert.equal(c.getState().outbox[1].preparedEvent,null);await c.sync();assert.deepEqual(sent.map(e=>e.expectedServerVersion),[0,1]);assert.equal(c.getState().records[0].ackedLocalRevision,2);});
test('lost response retries identical prepared envelope and event ID',async()=>{const sent=[];const c=create({sendEvent:async e=>{sent.push(e);if(sent.length===1)throw new Error('response lost');return {eventId:e.eventId,ackedLocalRevision:e.localRevision,serverVersion:1};}});leg(c);confirm(c);await c.sync();await c.sync();assert.deepEqual(sent[0],sent[1]);assert.equal(c.getState().outbox.length,0);});
test('conflict holds dependent revisions without overwriting server',async()=>{let calls=0;const c=create({sendEvent:async()=>{calls++;const e=new Error('conflict');e.status=409;throw e;}});leg(c);c.defer();c.editTrip(c.getState().records[0].tripId);confirm(c);await c.sync();assert.equal(calls,1);assert.equal(c.getState().outbox[0].status,'conflict');assert.equal(c.getState().outbox[1].preparedEvent,null);});
test('old ACK does not mark a newer local revision delivered',async()=>{let resolve;let count=0;const c=create({sendEvent:e=>{count++;if(count===1)return new Promise(r=>{resolve=()=>r({eventId:e.eventId,ackedLocalRevision:1,serverVersion:1});});throw Error('offline');}});leg(c);c.defer();const pending=c.sync();c.editTrip(c.getState().records[0].tripId);confirm(c);resolve();await pending;const r=c.getState().records[0];assert.equal(r.localRevision,2);assert.equal(r.ackedLocalRevision,1);assert.equal(r.payload.purpose,'business');});
test('wrong ACK cannot mark the record delivered',async()=>{const c=create({sendEvent:async()=>({eventId:'wrong',ackedLocalRevision:99,serverVersion:1})});leg(c);confirm(c);await c.sync();assert.equal(c.getState().records[0].ackedLocalRevision,0);assert.equal(c.getState().outbox.length,1);});
test('parallel sync calls do not dispatch duplicate network requests',async()=>{let calls=0,resolve;const c=create({sendEvent:e=>{calls++;return new Promise(r=>{resolve=()=>r({eventId:e.eventId,ackedLocalRevision:1,serverVersion:1});});}});leg(c);confirm(c);const p=c.sync();await c.sync();assert.equal(calls,1);resolve();await p;});

test('stale controller cannot overwrite newer persisted records',()=>{const storage=new MemoryStorage();const a=create({storage}),b=create({storage});leg(a);a.defer();assert.throws(()=>b.setOnline(false),/다른 창/);assert.equal(JSON.parse(storage.value).records.length,1);});
test('finish fixes the end boundary before delayed purpose confirmation',()=>{let time='2026-11-15T01:00:00.000Z';const c=create({now:()=>time});c.start();c.setDriving(true);c.setDriving(false);time='2026-11-15T01:10:00.000Z';c.finish();time='2026-11-15T01:20:00.000Z';confirm(c);assert.equal(c.getState().records[0].payload.endedAt,'2026-11-15T01:10:00.000Z');});
test('returning from review to edit preserves the original finish boundary',()=>{
  let time='2026-11-15T01:00:00.000Z';
  const c=create({now:()=>time});
  c.start();c.setDriving(true);c.setDriving(false);
  time='2026-11-15T01:10:00.000Z';c.finish();
  const candidate=c.getState().current.candidateEnd;
  c.setPurpose('business','첫 초안');c.review();
  time='2026-11-15T01:20:00.000Z';
  c.setPurpose('commute','수정한 메모');
  assert.equal(c.getState().screen,'purpose');
  assert.deepEqual(c.getState().current.candidateEnd,candidate);
  assert.equal(c.getState().records.length,0);
  c.review();time='2026-11-15T01:30:00.000Z';c.save();
  const payload=c.getState().records[0].payload;
  assert.equal(payload.endedAt,candidate.endedAt);
  assert.equal(payload.endOdometerM,candidate.endOdometerM);
  assert.equal(payload.endOdometerM-payload.startOdometerM,23400);
  assert.equal(payload.purpose,'commute');
  assert.equal(payload.note,'수정한 메모');
});
test('redeparture cancels a pending purpose correction without changing the saved record',()=>{
  const c=create();leg(c);c.defer();
  const before=c.getState();
  c.editTrip(before.records[0].tripId);
  c.setPurpose('business','저장하지 않은 보완');c.review();
  c.setDriving(true);
  const after=c.getState();
  assert.equal(after.screen,'collecting');
  assert.equal(after.driving,true);
  assert.equal(after.editingTripId,null);
  assert.equal(after.draft,null);
  assert.deepEqual(after.records,before.records);
  assert.deepEqual(after.outbox,before.outbox);
  assert.notEqual(after.current.tripId,before.records[0].tripId);
  assert.equal(after.current.candidateEnd,undefined);
  assert.throws(()=>c.save(),/주차/);
});
test('unexpected ACK version leap preserves the pending event',async()=>{const c=create({sendEvent:async e=>({eventId:e.eventId,ackedLocalRevision:e.localRevision,serverVersion:999})});leg(c);confirm(c);await c.sync();assert.equal(c.getState().outbox.length,1);assert.equal(c.getState().records[0].serverVersion,0);});

test('restart ends a gap at last stored observation rather than inventing collection during downtime',()=>{let now='2026-11-15T01:00:00.000Z';const storage=new MemoryStorage();const c=create({storage,now:()=>now});c.start();now='2026-11-15T01:05:00.000Z';c.setDriving(true);now='2026-11-15T12:00:00.000Z';const next=create({storage,now:()=>now});assert.equal(next.getState().records[0].payload.endedAt,'2026-11-15T01:05:00.000Z');});
