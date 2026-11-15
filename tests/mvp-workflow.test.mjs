import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MvpStore } from '../services/mvp/store.mjs';
import { startMvpServer } from '../services/mvp/server.mjs';
import { parseMockAnswer } from '../services/mvp/workflow.mjs';

// Latest vehicle requirements replace pre-departure dialogue/auto-arrival save.
// The same origin, receipt, rollback, attribution and idempotency protections remain.
const A='mvp-employee-001',B='mvp-employee-002',V='mvp-vehicle-001',V2='mvp-vehicle-002';
const base='http://127.0.0.1:1234';let number=0;const id=()=>`test_command_${++number}`;
function fixture(t){let now=Date.parse('2026-11-15T01:00:00.000Z');const store=new MvpStore({now:()=>now});t.after(()=>store.close());const token=store.qr(V,base).token,c=store.connect(token,A);return{store,c,token,advance:ms=>{now+=ms;}};}
const current=(s,c)=>s.state().conversations.find(v=>v.connectionId===c.id&&v.isCurrent);
const runtime=(s,v=V)=>s.state().vehicleRuntime.find(r=>r.vehicleId===v);
const pending=s=>s.state().pendingUploads.at(-1);
function command(s,c,type,extra={}){return s.workflow.command({commandId:id(),connectionId:c.id,type,...extra});}
function dialogue(s,c,type,extra={},context=current(s,c)){return command(s,c,type,{conversationId:context.id,...extra});}
function observe(s,c){const trip=command(s,c,'depart',{tripId:''}).trip;command(s,c,'arrive',{tripId:trip.id,conversationId:trip.conversationId});return s.workflow.activeTrip(c.id);}
function finishing(s,c){const trip=observe(s,c);return command(s,c,'finish',{tripId:trip.id,conversationId:trip.conversationId}).conversation;}
function promptDone(s,c){return dialogue(s,c,'simulate_prompt',{promptId:current(s,c).promptId});}
function confirm(s,c,text='판교 거래처에 계약 미팅하러 갑니다.'){promptDone(s,c);dialogue(s,c,'answer',{value:text});promptDone(s,c);return dialogue(s,c,'confirm',{value:'yes'});}
function finish(s,c,{confirmed=true}={}){finishing(s,c);return confirmed?confirm(s,c):dialogue(s,c,'confirm',{value:'later'});}
function error(action,code){assert.throws(action,e=>e.code===code);}

test('a QR connection is parked and ready but creates neither a trip nor a purpose question',t=>{
 const {store:s,c,token}=fixture(t);assert.equal(runtime(s).parking,'parked');assert.equal(runtime(s).sessionActive,true);
 for(let i=0;i<10;i++)s.state();s.connect(token,A);
 assert.equal(current(s,c),undefined);assert.equal(s.state().prompts.length,0);assert.deepEqual(s.state().activeTrips,[]);assert.deepEqual(s.state().pendingUploads,[]);
});

test('distance availability is a server mock-provider observation, never a zero fallback for invalid input',t=>{
 const {store:s,c}=fixture(t);assert.equal(runtime(s).mockOdometerM,12480000);assert.equal(runtime(s).distanceAvailable,true);
 s.db.prepare('INSERT INTO mvp_mock_odometers VALUES(?,?)').run(V,-1);assert.equal(runtime(s).distanceAvailable,false);
 error(()=>command(s,c,'depart',{tripId:''}),'ODOMETER_UNAVAILABLE');assert.equal(s.state().activeTrips.length,0);
});

test('an unavailable distance observation at parking does not fabricate the usual mock leg',t=>{
 const {store:s,c}=fixture(t),trip=command(s,c,'depart').trip;
 s.db.prepare('INSERT INTO mvp_mock_odometers VALUES(?,?)').run(V,-1);const parked=command(s,c,'arrive',{tripId:trip.id}).trip;
 assert.equal(runtime(s).parking,'parked');assert.equal(parked.lastObservedOdometerM,trip.startOdometerM);assert.equal(parked.distanceM,null);assert.equal(parked.hasGap,true);assert.equal(parked.quality,'incomplete');
 error(()=>command(s,c,'finish',{tripId:trip.id}),'NO_OBSERVED_SEGMENT');command(s,c,'stop_session',{tripId:trip.id});assert.equal(s.state().pendingUploads.length,0);
});

test('departure and parking are observations; parking alone neither ends, prompts nor queues a trip',t=>{
 const {store:s,c,advance}=fixture(t);const trip=command(s,c,'depart').trip;assert.equal(runtime(s).parking,'driving');advance(60000);
 const parked=command(s,c,'arrive',{tripId:trip.id,conversationId:trip.conversationId}).trip;
 assert.equal(runtime(s).parking,'parked');assert.equal(parked.id,trip.id);assert.equal(parked.endedAt,null);assert.equal(parked.distanceM,23400);assert.equal(parked.candidateEnd,null);
 assert.equal(s.state().pendingUploads.length,0);assert.equal(s.state().prompts.length,0);assert.equal(s.state().activeTrips.length,1);
});

test('finish freezes the candidate once and creates one purpose question only after parking',t=>{
 const {store:s,c,advance}=fixture(t);const trip=observe(s,c);advance(5000);
 const first=command(s,c,'finish',{tripId:trip.id}),candidate=first.trip.candidateEnd;
 assert.equal(first.conversation.phase,'question');assert.equal(s.state().prompts[0].text,'어디를 다녀오셨고, 어떤 목적으로 운행하셨나요?');
 advance(600000);const second=command(s,c,'finish',{tripId:trip.id});assert.deepEqual(second.trip.candidateEnd,candidate);assert.equal(second.conversation.id,first.conversation.id);assert.equal(s.state().prompts.length,1);assert.equal(s.state().pendingUploads.length,0);
});

test('finish is rejected without an observed trip, while driving, or when parking is unknown',t=>{
 const {store:s,c}=fixture(t);error(()=>command(s,c,'finish'),'NO_ACTIVE_TRIP');const trip=command(s,c,'depart').trip;
 error(()=>command(s,c,'finish',{tripId:trip.id}),'PARKING_REQUIRED');command(s,c,'unknown',{tripId:trip.id});error(()=>command(s,c,'finish',{tripId:trip.id}),'PARKING_REQUIRED');
 assert.equal(s.state().pendingUploads.length,0);assert.equal(s.state().prompts.length,0);
});

test('one prompt has one playback owner across another tab and a refreshed owner',t=>{
 const {store:s,c}=fixture(t);const promptId=finishing(s,c).promptId;
 assert.equal(s.workflow.claim({promptId,clientId:'panel_one'}).claimed,true);assert.equal(s.workflow.claim({promptId,clientId:'panel_two'}).claimed,false);assert.equal(s.workflow.claim({promptId,clientId:'panel_one'}).claimed,false);
 error(()=>s.workflow.complete({commandId:id(),promptId,clientId:'panel_two',outcome:'played'}),'STALE_PROMPT');assert.equal(current(s,c).phase,'question');
});

test('current playback completion is idempotent and only advances the purpose dialogue',t=>{
 const {store:s,c}=fixture(t);const promptId=finishing(s,c).promptId;s.workflow.claim({promptId,clientId:'panel_one'});
 const body={commandId:id(),promptId,clientId:'panel_one',outcome:'played'},result=s.workflow.complete(body);assert.deepEqual(s.workflow.complete(body),result);
 assert.equal(current(s,c).phase,'awaiting_answer');assert.equal(s.state().prompts[0].status,'played');assert.equal(s.state().pendingUploads.length,0);
});

test('failed playback preserves the observed trip as unconfirmed, never as consent',t=>{
 const {store:s,c}=fixture(t);const promptId=finishing(s,c).promptId;s.workflow.claim({promptId,clientId:'panel_one'});
 const result=s.workflow.complete({commandId:id(),promptId,clientId:'panel_one',outcome:'failed'});
 assert.equal(result.trip.purpose,null);assert.equal(result.trip.purposeConfirmed,false);assert.equal(s.state().prompts[0].status,'failed');assert.equal(pending(s).trip.id,result.trip.id);
 error(()=>s.workflow.complete({commandId:id(),promptId,clientId:'panel_one',outcome:'played'}),'STALE_CONTEXT');
});

test('fixed examples alone produce drafts without inventing destinations or mixed purposes',()=>{
 assert.deepEqual(parseMockAnswer('판교 거래처에 계약 미팅하러 갑니다.'),{destination:'판교 거래처',purpose:'business',detailedPurpose:'계약 미팅'});
 assert.deepEqual(parseMockAnswer('회사로 출근합니다.'),{destination:'회사',purpose:'commute',detailedPurpose:'출근'});assert.deepEqual(parseMockAnswer('마트에 장보러 갑니다.'),{destination:'마트',purpose:'personal',detailedPurpose:'장보기'});
 assert.equal(parseMockAnswer('잠깐 나갑니다.'),null);assert.equal(parseMockAnswer('업무와 개인 용도'),null);assert.equal(parseMockAnswer('constructor'),null);assert.equal(parseMockAnswer('__proto__'),null);
});

test('normal explicit consent automatically captures one fixed origin and prepared event after finish',t=>{
 const {store:s,c,advance}=fixture(t);finishing(s,c);const candidate=s.workflow.activeTrip(c.id).candidateEnd;advance(600000);const ended=confirm(s,c).trip;
 assert.equal(ended.employeeId,A);assert.equal(ended.connectionId,c.id);assert.equal(ended.purpose,'business');assert.equal(ended.destination,'판교 거래처');assert.equal(ended.detailedPurpose,'계약 미팅');assert.equal(ended.purposeConfirmed,true);
 assert.equal(ended.endedAt,candidate.endedAt);assert.equal(ended.endOdometerM,candidate.endOdometerM);assert.equal(ended.distanceM,23400);assert.equal(ended.quality,'complete');assert.equal(s.state().activeTrips.length,0);assert.equal(s.state().receivedTrips.length,0);
 assert.deepEqual(JSON.parse(pending(s).body).payload,ended);assert.equal(current(s,c),undefined);assert.equal(runtime(s).sessionActive,true);
});

test('yes cannot substitute for missing answer or unfinished confirmation guidance',t=>{
 const {store:s,c}=fixture(t);finishing(s,c);error(()=>dialogue(s,c,'confirm',{value:'yes'}),'DIALOGUE_STAGE');promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});
 error(()=>dialogue(s,c,'confirm',{value:'yes'}),'DIALOGUE_STAGE');assert.equal(current(s,c).confirmed,false);assert.equal(s.state().pendingUploads.length,0);
});

test('no creates a new question but preserves the same fixed candidate; old consent is rejected',t=>{
 const {store:s,c,advance}=fixture(t);finishing(s,c);const boundary=s.workflow.activeTrip(c.id).candidateEnd;promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});promptDone(s,c);
 const old=current(s,c);advance(300000);dialogue(s,c,'confirm',{value:'no'});const fresh=current(s,c);assert.notEqual(fresh.id,old.id);assert.equal(fresh.draft,null);assert.deepEqual(s.workflow.activeTrip(c.id).candidateEnd,boundary);
 error(()=>dialogue(s,c,'confirm',{value:'yes'},old),'STALE_CONTEXT');confirm(s,c);assert.equal(pending(s).trip.endedAt,boundary.endedAt);
});

test('later, silence, failure and unsupported answers automatically preserve unconfirmed observed trips',()=>{
 for(const mode of ['later','silence','failure','ambiguous']){const s=new MvpStore(),c=s.connect(s.qr(V,base).token,A);try{finishing(s,c);
 if(mode==='later')dialogue(s,c,'confirm',{value:'later'});else if(mode==='ambiguous'){promptDone(s,c);dialogue(s,c,'answer',{value:'잠깐 나갑니다.'});}else dialogue(s,c,mode);
 assert.equal(pending(s).trip.purpose,null);assert.equal(pending(s).trip.destination,null);assert.equal(pending(s).trip.purposeConfirmed,false);assert.equal(pending(s).trip.distanceM,23400);assert.equal(s.state().activeTrips.length,0);
 }finally{s.close();}}
});

test('redeparture during purpose input cancels candidate and old callbacks while preserving the same segment',t=>{
 const {store:s,c}=fixture(t);const old=finishing(s,c),before=s.workflow.activeTrip(c.id);s.workflow.claim({promptId:old.promptId,clientId:'panel_one'});
 const resumed=command(s,c,'depart',{tripId:before.id,conversationId:before.conversationId}).trip;
 assert.equal(resumed.id,before.id);assert.equal(resumed.startedAt,before.startedAt);assert.equal(resumed.startOdometerM,before.startOdometerM);assert.equal(resumed.candidateEnd,null);assert.equal(resumed.purpose,null);assert.notEqual(resumed.conversationId,before.conversationId);
 error(()=>s.workflow.complete({commandId:id(),promptId:old.promptId,clientId:'panel_one',outcome:'played'}),'STALE_CONTEXT');error(()=>dialogue(s,c,'answer',{value:'회사로 출근합니다.'},old),'STALE_CONTEXT');assert.equal(s.state().pendingUploads.length,0);
});

test('continue cancels only the candidate and draft; it is not a departure or a new trip',t=>{
 const {store:s,c}=fixture(t);finishing(s,c);promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});const before=s.workflow.activeTrip(c.id);
 const continued=command(s,c,'continue',{tripId:before.id,conversationId:before.conversationId}).trip;assert.equal(continued.id,before.id);assert.equal(continued.startedAt,before.startedAt);assert.equal(continued.lastObservedOdometerM,before.lastObservedOdometerM);assert.equal(continued.candidateEnd,null);assert.equal(current(s,c),undefined);assert.equal(runtime(s).parking,'parked');assert.equal(s.state().pendingUploads.length,0);
 const resumed=command(s,c,'depart',{tripId:continued.id,conversationId:continued.conversationId}).trip;command(s,c,'arrive',{tripId:resumed.id,conversationId:resumed.conversationId});command(s,c,'finish',{tripId:resumed.id});const ended=confirm(s,c).trip;
 assert.equal(ended.id,before.id);assert.equal(ended.distanceM,46800);assert.equal(s.state().pendingUploads.length,1);
});

test('late arrival from a previous driving leg cannot park the resumed leg',t=>{
 const {store:s,c}=fixture(t),first=observe(s,c);const resumed=command(s,c,'depart',{tripId:first.id,conversationId:first.conversationId}).trip;
 error(()=>command(s,c,'arrive',{tripId:first.id,conversationId:first.conversationId}),'STALE_CONTEXT');assert.equal(runtime(s).parking,'driving');assert.equal(s.workflow.activeTrip(c.id).lastObservedOdometerM,first.lastObservedOdometerM);
 command(s,c,'arrive',{tripId:resumed.id,conversationId:resumed.conversationId});assert.equal(s.workflow.activeTrip(c.id).distanceM,46800);
});

test('unknown parking blocks finishing and its quality gap survives later parking and purpose confirmation',t=>{
 const {store:s,c}=fixture(t),trip=command(s,c,'depart').trip;command(s,c,'unknown',{tripId:trip.id});error(()=>command(s,c,'finish',{tripId:trip.id}),'PARKING_REQUIRED');
 command(s,c,'arrive',{tripId:trip.id,conversationId:s.workflow.activeTrip(c.id).conversationId});command(s,c,'finish',{tripId:trip.id});const ended=confirm(s,c).trip;assert.equal(ended.quality,'incomplete');assert.equal(ended.hasGap,true);assert.equal(ended.purpose,'business');
});

test('stopping a session preserves only the last observed boundary and keeps the employee connection',t=>{
 const {store:s,c,advance}=fixture(t),trip=observe(s,c);advance(900000);const result=command(s,c,'stop_session',{tripId:trip.id,conversationId:trip.conversationId});
 assert.equal(result.trip.endedAt,trip.lastObservedAt);assert.equal(result.trip.endOdometerM,trip.lastObservedOdometerM);assert.equal(result.trip.purpose,null);assert.equal(runtime(s).sessionActive,false);assert.equal(s.state().vehicles[0].connection.id,c.id);
 error(()=>command(s,c,'depart',{tripId:''}),'SESSION_STOPPED');s.state();assert.equal(runtime(s).sessionActive,false);command(s,c,'start_session',{tripId:''});assert.equal(runtime(s).sessionActive,true);assert.equal(s.state().activeTrips.length,0);
});

test('session stop with no trip or no observed movement creates no empty event',t=>{
 const {store:s,c}=fixture(t);command(s,c,'stop_session',{tripId:''});assert.equal(s.state().pendingUploads.length,0);command(s,c,'start_session',{tripId:''});
 const trip=command(s,c,'depart',{tripId:''}).trip;command(s,c,'park',{tripId:trip.id,conversationId:trip.conversationId});command(s,c,'stop_session',{tripId:trip.id,conversationId:trip.conversationId});
 assert.equal(s.state().activeTrips.length,0);assert.equal(s.state().pendingUploads.length,0);assert.equal(runtime(s).sessionActive,false);
});

test('a stale empty-snapshot stop cannot end a newly observed trip',t=>{
 const {store:s,c}=fixture(t);const trip=observe(s,c);error(()=>command(s,c,'stop_session',{tripId:'',conversationId:''}),'STALE_TRIP');assert.equal(s.state().activeTrips[0].id,trip.id);assert.equal(s.state().pendingUploads.length,0);
});

test('prototype names cannot be interpreted as confirmation commands',t=>{
 const {store:s,c}=fixture(t);finishing(s,c);promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});promptDone(s,c);const before=current(s,c);
 error(()=>dialogue(s,c,'confirm',{value:'constructor'}),'INVALID_CONFIRMATION');assert.deepEqual(current(s,c),before);
});

test('same command ID cannot change body and exact replay never adds a new trip',t=>{
 const {store:s,c}=fixture(t),body={commandId:id(),connectionId:c.id,type:'depart',tripId:''};const first=s.workflow.command(body);assert.deepEqual(s.workflow.command(body),first);
 error(()=>s.workflow.command({...body,type:'stop_session'}),'COMMAND_CONFLICT');assert.equal(s.state().activeTrips.length,1);
});

test('repeated departures, parking, finish, answers and exact consent make one queued trip',t=>{
 const {store:s,c}=fixture(t);const trip=command(s,c,'depart').trip;assert.equal(command(s,c,'depart').trip.id,trip.id);
 command(s,c,'arrive',{tripId:trip.id,conversationId:trip.conversationId});command(s,c,'arrive',{tripId:trip.id,conversationId:trip.conversationId});assert.equal(s.workflow.activeTrip(c.id).distanceM,23400);
 command(s,c,'finish',{tripId:trip.id});command(s,c,'finish',{tripId:trip.id});promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});dialogue(s,c,'answer',{value:'회사로 출근합니다.'});assert.equal(s.state().prompts.length,2);promptDone(s,c);
 const body={commandId:id(),connectionId:c.id,conversationId:current(s,c).id,type:'confirm',value:'yes'};const result=s.workflow.command(body);assert.deepEqual(s.workflow.command(body),result);
 assert.equal(command(s,c,'finish',{tripId:trip.id}).trip.id,trip.id);assert.equal(s.state().pendingUploads.length,1);assert.equal(s.state().activeTrips.length,0);assert.equal(current(s,c),undefined);
});

test('next trip uses the last meter but never copies the previously confirmed purpose',t=>{
 const {store:s,c}=fixture(t),first=finish(s,c).trip,next=command(s,c,'depart',{tripId:''}).trip;assert.notEqual(next.id,first.id);assert.equal(next.startOdometerM,first.endOdometerM);assert.equal(next.purpose,null);assert.equal(next.purposeConfirmed,false);assert.equal(s.state().prompts.length,2);
});

test('late finished-trip arrival or stop does not change a later active trip',t=>{
 const {store:s,c}=fixture(t),first=finish(s,c).trip,next=command(s,c,'depart',{tripId:''}).trip;
 assert.equal(command(s,c,'arrive',{tripId:first.id,conversationId:first.conversationId}).trip.id,first.id);command(s,c,'stop_session',{tripId:first.id,conversationId:first.conversationId});
 assert.equal(s.state().activeTrips[0].id,next.id);assert.equal(runtime(s).parking,'driving');assert.equal(runtime(s).sessionActive,true);
});

test('unfinished parked or driving trip blocks employee handover',t=>{
 const {store:s,c,token}=fixture(t);const trip=command(s,c,'depart').trip;error(()=>s.disconnect(c.id,A),'TRIP_IN_PROGRESS');command(s,c,'arrive',{tripId:trip.id});error(()=>s.disconnect(c.id,A),'TRIP_IN_PROGRESS');error(()=>s.connect(token,B),'TOKEN_USED');assert.equal(s.state().activeTrips[0].employeeId,A);
});

test('old speech after observed-session stop and employee replacement cannot change a new dialogue',t=>{
 const {store:s,c}=fixture(t),old=finishing(s,c);s.workflow.claim({promptId:old.promptId,clientId:'panel_one'});command(s,c,'stop_session',{tripId:s.workflow.activeTrip(c.id).id});s.disconnect(c.id,A);
 const other=s.connect(s.qr(V,base).token,B);finishing(s,other);const fresh=current(s,other);error(()=>dialogue(s,c,'answer',{value:'회사로 출근합니다.'},old),'STALE_CONTEXT');error(()=>s.workflow.complete({commandId:id(),promptId:old.promptId,clientId:'panel_one',outcome:'played'}),'STALE_CONTEXT');assert.equal(current(s,other).id,fresh.id);assert.equal(current(s,other).employeeId,B);
});

test('an ended queued trip uploads with its original employee after handover',t=>{
 const {store:s,c}=fixture(t),ended=finish(s,c).trip,event=JSON.parse(pending(s).body);s.disconnect(c.id,A);const other=s.connect(s.qr(V,base).token,B);command(s,other,'depart');const ack=s.workflow.receive(event);assert.equal(ack.tripId,ended.id);assert.equal(s.state().receivedTrips[0].employeeId,A);assert.equal(s.state().activeTrips[0].employeeId,B);
});

test('upload block holds exact body and receipt retry remains idempotent after recovery',t=>{
 const {store:s,c}=fixture(t);s.workflow.setUploadMode(V,true);finish(s,c);const body=pending(s).body,event=JSON.parse(body);
 for(let i=0;i<5;i++){try{s.workflow.receive(event);}catch(e){assert.equal(e.status,503);}}assert.equal(pending(s).status,'paused');assert.equal(pending(s).body,body);assert.equal(s.state().receivedTrips.length,0);assert.equal(s.qr(V,base).status,'connected');
 s.workflow.setUploadMode(V,false);assert.equal(pending(s).attempts,0);const ack=s.workflow.receive(event);assert.deepEqual(s.workflow.receive(event),ack);assert.equal(s.state().receivedTrips.length,1);assert.equal(pending(s).body,body);
});

test('changed prepared source is a held conflict and never overwrites driver or origin',t=>{
 const {store:s,c}=fixture(t),ended=finish(s,c).trip,original=pending(s).body,event=JSON.parse(original);event.payload.employeeId=B;
 error(()=>s.workflow.receive(event),'TRIP_EVENT_CONFLICT');assert.equal(pending(s).status,'conflict');assert.equal(pending(s).body,original);assert.deepEqual(pending(s).trip,ended);s.workflow.setUploadMode(V,false);assert.equal(pending(s).status,'conflict');assert.equal(s.state().receivedTrips.length,0);
});

test('finalization and queue insert roll back together when storage fails, preserving candidate and draft',t=>{
 const {store:s,c}=fixture(t);finishing(s,c);promptDone(s,c);dialogue(s,c,'answer',{value:'회사로 출근합니다.'});promptDone(s,c);const trip=s.workflow.activeTrip(c.id),conversation=current(s,c);
 s.db.exec("CREATE TRIGGER fail_queue BEFORE INSERT ON mvp_uploads BEGIN SELECT RAISE(ABORT,'simulated queue full');END;");
 assert.throws(()=>dialogue(s,c,'confirm',{value:'yes'}),/queue full/);assert.deepEqual(s.workflow.activeTrip(c.id),trip);assert.deepEqual(current(s,c),conversation);assert.equal(s.state().pendingUploads.length,0);
 s.db.exec('DROP TRIGGER fail_queue');dialogue(s,c,'confirm',{value:'yes'});assert.equal(s.state().pendingUploads.length,1);
});

test('received trip and receipt are one commit and the identical retry completes once',t=>{
 const {store:s,c}=fixture(t);finish(s,c);const event=JSON.parse(pending(s).body);s.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON mvp_trip_receipts BEGIN SELECT RAISE(ABORT,'simulated receipt full');END;");
 assert.throws(()=>s.workflow.receive(event),/receipt full/);assert.equal(s.state().receivedTrips.length,0);assert.equal(pending(s).status,'queued');assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_trip_receipts').get().n,0);
 s.db.exec('DROP TRIGGER fail_receipt');const ack=s.workflow.receive(event);assert.deepEqual(s.workflow.receive(event),ack);assert.equal(s.state().receivedTrips.length,1);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_trip_receipts').get().n,1);
});

test('database reopen retains stopped session, queue, demo ID and exact prepared body',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chagok-mvp-workflow-'));t.after(()=>rm(root,{recursive:true,force:true}));const filename=join(root,'mvp.sqlite');
 const s=new MvpStore({filename}),c=s.connect(s.qr(V,base).token,A);finish(s,c);command(s,c,'stop_session',{tripId:''});const before=s.state(),body=pending(s).body;s.close();
 const reopened=new MvpStore({filename});t.after(()=>reopened.close());assert.equal(reopened.state().demoId,before.demoId);assert.equal(runtime(reopened).sessionActive,false);assert.equal(pending(reopened).body,body);reopened.workflow.connected(c);assert.equal(runtime(reopened).sessionActive,false);reopened.workflow.receive(JSON.parse(body));assert.equal(reopened.state().receivedTrips.length,1);
});

test('foreign conversation or missing connection cannot operate a trip',t=>{
 const {store:s,c}=fixture(t),other=s.connect(s.qr(V2,base).token,B);finishing(s,other);
 error(()=>command(s,c,'depart',{conversationId:current(s,other).id}),'STALE_CONTEXT');error(()=>command(s,{id:'missing'},'depart'),'STALE_CONTEXT');assert.equal(s.state().activeTrips.length,1);
});

test('backwards observed time remains an incomplete record after purpose confirmation',t=>{
 const {store:s,c,advance}=fixture(t),trip=command(s,c,'depart').trip;advance(-1000);command(s,c,'arrive',{tripId:trip.id});command(s,c,'finish',{tripId:trip.id});confirm(s,c);s.workflow.receive(JSON.parse(pending(s).body));assert.equal(s.state().receivedTrips[0].quality,'incomplete');assert.equal(s.state().receivedTrips[0].source,'mock');
});

test('real HTTP observation, finish/defer, blocked upload and discarded ACK replay preserve one receipt',async t=>{
 const app=await startMvpServer();t.after(()=>app.close());const s=app.store,c=s.connect(s.qr(V,app.address).token,A);
 const request=async(path,body)=>fetch(`${app.address}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const departure={commandId:id(),connectionId:c.id,type:'depart',tripId:''},results=await Promise.all([request('/mvp-api/commands',departure),request('/mvp-api/commands',departure)]);assert.ok(results.every(r=>r.status===200));const trip=(await results[0].json()).trip;
 await request('/mvp-api/commands',{commandId:id(),connectionId:c.id,type:'arrive',tripId:trip.id,conversationId:trip.conversationId});assert.equal(s.state().pendingUploads.length,0);
 const finished=await request('/mvp-api/commands',{commandId:id(),connectionId:c.id,type:'finish',tripId:trip.id});assert.equal(finished.status,200);await request('/mvp-api/commands',{commandId:id(),connectionId:c.id,conversationId:current(s,c).id,type:'confirm',value:'later'});
 const event=JSON.parse(pending(s).body);await request(`/mvp-api/vehicles/${V}/upload-mode`,{blocked:true});assert.equal((await request('/mvp-api/trip-events',event)).status,503);assert.equal(s.state().receivedTrips.length,0);await request(`/mvp-api/vehicles/${V}/upload-mode`,{blocked:false});
 assert.equal((await request('/mvp-api/trip-events',event)).status,200);const replay=await request('/mvp-api/trip-events',event);assert.deepEqual(await replay.json(),{eventId:event.eventId,tripId:trip.id,serverVersion:1});assert.equal(s.state().receivedTrips.length,1);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_trip_receipts').get().n,1);
 assert.equal((await request('/mvp-api/commands',{...departure,unexpected:true})).status,400);assert.equal((await request(`/mvp-api/vehicles/${V}/upload-mode`,{blocked:'yes'})).status,400);
});
