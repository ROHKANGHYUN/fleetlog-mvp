import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MvpStore } from '../services/mvp/store.mjs';
import { koreanMonth } from '../services/mvp/reporting.mjs';

const A='mvp-employee-001',B='mvp-employee-002',V='mvp-vehicle-001',V2='mvp-vehicle-002';
function fixture(t,{filename=':memory:',initial='2026-11-15T01:00:00Z'}={}){
 let time=Date.parse(initial);const s=new MvpStore({filename,now:()=>time});t.after(()=>{try{s.close();}catch{}});
 const connect=(vehicle=V,employee=A)=>s.connect(s.qr(vehicle,'http://127.0.0.1:4321').token,employee);
 const c=connect(),command=(type,extra={},connection=c)=>s.workflow.command({commandId:randomUUID(),connectionId:connection.id,type,...extra});
 function capture({confirmed=false,gap=false,receive=true}={}){
  const trip=command('depart').trip;time+=1000;
  if(gap)command('unknown',{tripId:trip.id,conversationId:trip.conversationId});
  const active=s.workflow.activeTrip(c.id);command('arrive',{tripId:trip.id,conversationId:active.conversationId});
  const {conversation}=command('finish',{tripId:trip.id,conversationId:active.conversationId});
  const context=()=>s.workflow.currentConversation(c.id);
  if(confirmed){command('simulate_prompt',{conversationId:conversation.id,promptId:context().promptId});command('answer',{conversationId:conversation.id,value:'업무 방문'});command('simulate_prompt',{conversationId:conversation.id,promptId:context().promptId});command('confirm',{conversationId:conversation.id,value:'yes'});}
  else command('confirm',{conversationId:conversation.id,value:'later'});
  const upload=s.workflow.state().pendingUploads.at(-1),event=JSON.parse(upload.body),ack=receive?s.workflow.receive(event):null;
  return{trip:event.payload,event,ack,body:upload.body};
 }
 return{s,r:s.reporting,c,connect,command,capture,set:value=>time=Date.parse(value),advance:ms=>time+=ms};
}
const amendBody=(extra={})=>({requestId:randomUUID(),employeeId:A,expectedAmendmentVersion:0,purpose:'business',destination:'가상 거래처',detailedPurpose:'가상 미팅',...extra});
const reportBody=(month='2026-11')=>({requestId:randomUUID(),month});
const submitBody=report=>({requestId:randomUUID(),reportId:report.id});
const rejects=(action,code)=>assert.throws(action,error=>error.code===code);
function originals(s){return JSON.stringify(['mvp_trips','mvp_uploads','mvp_received_trips','mvp_trip_receipts'].map(table=>s.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));}
function parseCsv(input){
 // Independent small RFC4180 reader: escaped quotes and embedded CR/LF stay cells.
 const rows=[];let row=[],value='',quoted=false;
 for(let i=input.charCodeAt(0)===0xfeff?1:0;i<input.length;i++){
  const ch=input[i];
  if(ch==='"'){if(quoted&&input[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
  else if(ch===','&&!quoted){row.push(value);value='';}
  else if(ch==='\r'&&!quoted&&input[i+1]==='\n'){row.push(value);rows.push(row);row=[];value='';i++;}
  else value+=ch;
 }
 assert.equal(quoted,false);return rows;
}

test('latest purposes overlay received originals without mutating transport data or first ACK',t=>{
 const {s,r,capture}=fixture(t),first=capture(),before=originals(s),body=amendBody();
 const result=r.amend(first.trip.id,body),current=s.state().receivedTrips[0];
 assert.equal(current.purpose,'business');assert.equal(current.amendmentVersion,1);assert.equal(current.serverVersion,1);
 for(const key of ['id','connectionId','companyId','employeeId','vehicleId','startedAt','endedAt','startOdometerM','endOdometerM','distanceM','quality','source'])assert.equal(current[key],first.trip[key]);
 assert.equal(current.originalPurpose.purpose,null);assert.equal(current.amendmentHistory[0].before.purpose,null);assert.equal(result.amendment.after.purposeConfirmed,true);
 assert.deepEqual(s.workflow.receive(first.event),first.ack);assert.equal(originals(s),before);assert.equal(s.state().receivedTrips[0].purpose,'business');
});

test('same correction retry makes one history while altered IDs and stale concurrent versions conflict',t=>{
 const {s,r,capture}=fixture(t),first=capture(),body=amendBody(),saved=r.amend(first.trip.id,body);
 assert.deepEqual(r.amend(first.trip.id,body),saved);
 rejects(()=>r.amend(first.trip.id,{...body,destination:'다른 내용'}),'REQUEST_CONFLICT');
 rejects(()=>r.amend(first.trip.id,amendBody({purpose:'personal'})),'AMENDMENT_VERSION_CONFLICT');
 rejects(()=>r.amend(first.trip.id,amendBody({expectedAmendmentVersion:1})),'PURPOSE_ALREADY_CONFIRMED');
 assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_amendments').get().n,1);
});

test('amendment ownership follows original employee after disconnect even while the replacement driver is driving',t=>{
 const {s,r,c,capture,connect,command}=fixture(t),first=capture();s.disconnect(c.id,A);const replacement=connect(V,B);command('depart',{},replacement);
 rejects(()=>r.amend(first.trip.id,amendBody({employeeId:B})),'TRIP_OWNER_MISMATCH');
 assert.equal(r.amend(first.trip.id,amendBody()).trip.employeeId,A);
 assert.equal(s.workflow.runtime(V).parking,'driving');assert.equal(s.activeForVehicle(V).employeeId,B);
});

test('currently connected owner cannot edit while driving or unknown; exact committed retry remains idempotent',t=>{
 const {r,capture,command}=fixture(t),first=capture();const active=command('depart').trip,body=amendBody();
 rejects(()=>r.amend(first.trip.id,body),'PARKING_REQUIRED');
 command('unknown',{tripId:active.id,conversationId:active.conversationId});rejects(()=>r.amend(first.trip.id,body),'PARKING_REQUIRED');
 command('park');const result=r.amend(first.trip.id,body);command('depart');assert.deepEqual(r.amend(first.trip.id,body),result);
});

test('unreceived, originally confirmed, foreign and malformed corrections cannot modify records',t=>{
 const {s,r,capture}=fixture(t),pending=capture({receive:false}),confirmed=capture({confirmed:true});
 rejects(()=>r.amend(pending.trip.id,amendBody()),'RECEIVED_TRIP_NOT_FOUND');
 rejects(()=>r.amend(confirmed.trip.id,amendBody()),'PURPOSE_ALREADY_CONFIRMED');
 const unconfirmed=capture(),before=originals(s);
 for(const extra of [{purpose:'constructor'},{expectedAmendmentVersion:0.5},{expectedAmendmentVersion:-1},{destination:'a'.repeat(201)},{detailedPurpose:null},{distanceM:0}])rejects(()=>r.amend(unconfirmed.trip.id,amendBody(extra)),Object.hasOwn(extra,'distanceM')?'INVALID_REQUEST':'INVALID_AMENDMENT');
 assert.equal(originals(s),before);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_amendments').get().n,0);
});

test('storage failure rolls back correction and idempotency receipt together and same input can retry',t=>{
 const {s,r,capture}=fixture(t),first=capture(),before=originals(s),body=amendBody();
 s.db.exec("CREATE TRIGGER fail_amendment_request BEFORE INSERT ON mvp_reporting_requests BEGIN SELECT RAISE(ABORT,'simulated quota');END;");
 assert.throws(()=>r.amend(first.trip.id,body),/simulated quota/);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_amendments').get().n,0);assert.equal(r.enrichTrips(s.workflow.state().receivedTrips)[0].purpose,null);assert.equal(originals(s),before);
 s.db.exec('DROP TRIGGER fail_amendment_request');assert.equal(r.amend(first.trip.id,body).trip.amendmentVersion,1);
});

test('Korean month boundary uses start time and keeps a midnight-crossing trip whole',t=>{
 const {r,capture,set}=fixture(t);set('2026-10-31T14:59:59.999Z');const crossing=capture();set('2026-10-31T15:00:00.000Z');const november=capture();
 const oct=r.monthly('2026-10').data,nov=r.monthly('2026-11').data;
 assert.deepEqual(oct.trips.map(x=>x.id),[crossing.trip.id]);assert.equal(oct.summary.validDistanceM,23400);assert.deepEqual(nov.trips.map(x=>x.id),[november.trip.id]);
 assert.equal(koreanMonth(crossing.trip.endedAt),'2026-11');assert.equal(crossing.trip.distanceM,23400);
});

test('pending and gap records remain distinct from received valid distance and business purpose',t=>{
 const {r,capture}=fixture(t),valid=capture(),gap=capture({gap:true}),queued=capture({receive:false});
 let data=r.monthly('2026-11').data;
 assert.equal(data.summary.receivedCount,2);assert.equal(data.summary.pendingCount,1);assert.equal(data.summary.validDistanceM,23400);assert.equal(data.summary.excludedDistanceCount,1);assert.equal(data.byPurpose.find(x=>x.key==='business').count,0);assert.equal(data.byPurpose.find(x=>x.key==='unconfirmed').count,2);
 assert.deepEqual(new Set(data.trips.map(x=>x.id)),new Set([valid.trip.id,gap.trip.id]));assert.equal(data.pending[0].tripId,queued.trip.id);
 r.amend(gap.trip.id,amendBody());data=r.monthly('2026-11').data;assert.equal(data.trips.find(x=>x.id===gap.trip.id).quality,'incomplete');assert.equal(data.summary.excludedDistanceCount,1);assert.equal(data.summary.validDistanceM,23400);
});

test('empty received data differs from a valid zero distance and no-valid-distance data',t=>{
 const {s,r,capture}=fixture(t);assert.equal(r.monthly('2026-11').data.summary.validDistanceM,null);
 const first=capture(),original=s.workflow.state().receivedTrips[0];
 s.db.prepare('UPDATE mvp_received_trips SET body_json=? WHERE trip_id=?').run(JSON.stringify({...original,distanceM:0,endOdometerM:original.startOdometerM}),first.trip.id);
 assert.equal(r.monthly('2026-11').data.summary.validDistanceM,0);assert.equal(r.monthly('2026-11').data.summary.receivedCount,1);
 s.db.prepare('UPDATE mvp_received_trips SET body_json=? WHERE trip_id=?').run(JSON.stringify({...original,quality:'incomplete'}),first.trip.id);assert.equal(r.monthly('2026-11').data.summary.validDistanceM,null);
});

test('fixed dummy costs stay in their own month and vehicle without duplication from repeated month selection',t=>{
 const {s,r}=fixture(t),nov=r.monthly('2026-11').data,oct=r.monthly('2026-10').data,dec=r.monthly('2026-12').data;
 assert.equal(nov.costs.length,3);assert.equal(nov.summary.costTotalKRW,80200);assert.equal(oct.costs.length,1);assert.equal(oct.summary.costTotalKRW,55000);assert.equal(dec.costs.length,0);assert.equal(dec.summary.costTotalKRW,0);
 assert.equal(new Set(nov.costs.map(x=>x.vehicleId)).size,2);assert.ok(nov.costs.every(x=>x.source==='dummy-fixture'&&x.occurredOn.startsWith('2026-11')));
 r.monthly('2026-11');r.monthly('2026-10');assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_costs').get().n,4);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_trip_receipts').get().n,0);
});

test('report requests are idempotent and new versions preserve earlier snapshot data',t=>{
 const {r,capture}=fixture(t);capture();const body=reportBody(),first=r.createReport(body).report;
 assert.equal(r.createReport(body).report.id,first.id);rejects(()=>r.createReport({...body,month:'2026-10'}),'REQUEST_CONFLICT');
 const before=JSON.stringify(first.data);capture();const current=r.report(first.id);assert.equal(current.stale,true);assert.equal(JSON.stringify(current.data),before);
 const duplicate=r.createReport(body).report;assert.equal(duplicate.id,first.id);assert.equal(duplicate.stale,true);assert.equal(duplicate.readiness.canSubmit,false);assert.equal(JSON.stringify(duplicate.data),before);
 const second=r.createReport(reportBody()).report;assert.equal(second.version,2);assert.equal(second.data.summary.receivedCount,2);assert.equal(r.report(first.id).data.summary.receivedCount,1);
});

test('purpose amendments, pending delivery and captured labels mark snapshots stale without rewriting old exports',t=>{
 const {s,r,capture}=fixture(t),first=capture(),report=r.createReport(reportBody()).report,exported=r.csv(report.id,'trips').body;
 r.amend(first.trip.id,amendBody());assert.equal(r.report(report.id).stale,true);assert.equal(r.csv(report.id,'trips').body,exported);
 const second=r.createReport(reportBody()).report;s.db.prepare('UPDATE mvp_employees SET name=? WHERE id=?').run('가상 새 표시명',A);assert.equal(r.report(second.id).stale,true);assert.ok(r.csv(second.id,'trips').body.includes('가상 김차곡'));
 const third=r.createReport(reportBody()).report;capture({receive:false});assert.equal(r.report(third.id).stale,true);
});

test('snapshot creation failure keeps report version and request history consistent',t=>{
 const {s,r,capture}=fixture(t);capture();const body=reportBody();
 s.db.exec("CREATE TRIGGER fail_report_request BEFORE INSERT ON mvp_reporting_requests BEGIN SELECT RAISE(ABORT,'simulated report storage full');END;");assert.throws(()=>r.createReport(body),/storage full/);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_reports').get().n,0);
 s.db.exec('DROP TRIGGER fail_report_request');assert.equal(r.createReport(body).report.version,1);
});

test('CSV uses one immutable snapshot and safely round-trips Korean punctuation, quotes, newlines and formula text',t=>{
 const {r,capture}=fixture(t),first=capture();r.amend(first.trip.id,amendBody({destination:'=HYPERLINK("가상")',detailedPurpose:'가상, "거래처"\n다음 줄'}));
 const report=r.createReport(reportBody()).report,csv=r.csv(report.id,'trips');assert.match(csv.filename,/^Fleetlog-DEMO-2026-11-v1-trips.csv$/);assert.equal(csv.body.charCodeAt(0),0xfeff);
 const rows=parseCsv(csv.body);assert.equal(rows.length,2);assert.ok(rows[1].includes("'=HYPERLINK(\"가상\")"));assert.ok(rows[1].includes('가상, "거래처"\n다음 줄'));assert.ok(rows[1].includes(first.trip.id));assert.ok(rows[1].includes('가상 데이터 · 실제 신고 아님'));
 const costRows=parseCsv(r.csv(report.id,'costs').body),amount=costRows[0].indexOf('금액(KRW)');assert.equal(costRows.length-1,report.data.costs.length);assert.equal(costRows.slice(1).reduce((sum,row)=>sum+Number(row[amount]),0),report.data.summary.costTotalKRW);
});

test('CSV prefixes leading whitespace or control formulas instead of executing user input as formulas',t=>{
 const {r,capture}=fixture(t);
 for(const input of ['+1','-1','@SUM(A1)','\t=1','\n +1']){
  const {trip}=capture();r.amend(trip.id,amendBody({destination:input}));
 }
 const report=r.createReport(reportBody()).report,rows=parseCsv(r.csv(report.id,'trips').body),col=rows[0].indexOf('목적지');assert.ok(rows.slice(1).every(row=>row[col].startsWith("'")));
});

test('simulated submission checks every preparation condition and never creates an external receipt',t=>{
 for(const setup of ['empty','unconfirmed','incomplete','pending','stale']){
  const f=fixture(t);let report;
  if(setup==='empty')report=f.r.createReport(reportBody()).report;
  else {const first=f.capture({confirmed:setup!=='unconfirmed',gap:setup==='incomplete'});if(setup==='pending')f.capture({receive:false});report=f.r.createReport(reportBody()).report;if(setup==='stale')f.capture();assert.ok(first.trip.id);}
  assert.equal(f.r.report(report.id).readiness.canSubmit,false);rejects(()=>f.r.submit(submitBody(report)),'SUBMISSION_NOT_READY');assert.equal(f.s.db.prepare('SELECT count(*) n FROM mvp_submissions').get().n,0);
 }
});

test('submission duplicates keep one attempt, failure retry is a new attempt, and historic completion stays fixed',t=>{
 const {s,r,capture,advance}=fixture(t);capture({confirmed:true});const report=r.createReport(reportBody()).report;
 r.setSimulationMode({outcome:'failure'});const firstBody=submitBody(report),started=r.submit(firstBody).submission;
 assert.equal(started.status,'processing');assert.equal(started.attempts[0].receiptNumber,null);assert.deepEqual(r.submit(firstBody).submission,started);r.submit(submitBody(report));assert.equal(r.monthly('2026-11').submissions[0].attempts.length,1);
 advance(1000);const failed=r.monthly('2026-11').submissions[0];assert.equal(failed.status,'failed');assert.equal(failed.attempts[0].receiptNumber,null);r.setSimulationMode({outcome:'success'});
 const retry=r.submit(submitBody(report)).submission;assert.equal(retry.id,started.id);assert.equal(retry.attempts.length,2);assert.equal(retry.attempts[0].status,'failed');assert.notEqual(retry.attempts[0].id,retry.attempts[1].id);
 advance(1000);const completed=r.monthly('2026-11').submissions[0];assert.equal(completed.status,'completed');assert.match(completed.attempts[1].receiptNumber,/^DEMO-/);const history=JSON.stringify(completed);
 capture();assert.equal(r.report(report.id).stale,true);assert.equal(JSON.stringify(r.monthly('2026-11').submissions[0]),history);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_submissions').get().n,1);
});

test('submission outcome is captured at request time and result transition is durable after reopen',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'fleetlog-mvp-reporting-'));t.after(()=>rm(directory,{recursive:true,force:true}));const filename=join(directory,'mvp.sqlite');
 const {s,r,capture,advance}=fixture(t,{filename});capture({confirmed:true});const report=r.createReport(reportBody()).report;r.setSimulationMode({outcome:'failure'});const started=r.submit(submitBody(report)).submission;r.setSimulationMode({outcome:'success'});s.close();
 const reopened=new MvpStore({filename,now:()=>Date.parse('2026-11-15T01:00:05Z')});t.after(()=>reopened.close());let result=reopened.reporting.monthly('2026-11').submissions[0];assert.equal(result.id,started.id);assert.equal(result.status,'failed');assert.equal(result.attempts[0].outcome,'failure');
 const before=JSON.stringify(result);assert.equal(JSON.stringify(reopened.reporting.monthly('2026-11').submissions[0]),before);assert.equal(reopened.reporting.monthly('2026-11').reports[0].data.trips.length,1);advance(1);
});

test('failed submission storage does not leave an attempt or consume its retry request',t=>{
 const {s,r,capture}=fixture(t);capture({confirmed:true});const report=r.createReport(reportBody()).report,body=submitBody(report);
 s.db.exec("CREATE TRIGGER fail_submission_request BEFORE INSERT ON mvp_reporting_requests BEGIN SELECT RAISE(ABORT,'simulated submission full');END;");assert.throws(()=>r.submit(body),/submission full/);assert.equal(s.db.prepare('SELECT count(*) n FROM mvp_submissions').get().n,0);
 s.db.exec('DROP TRIGGER fail_submission_request');assert.equal(r.submit(body).submission.attempts.length,1);
});

test('monthly/report/simulation inputs reject malformed types and extra fields without hidden alternate scopes',t=>{
 const {r}=fixture(t);
 for(const month of ['2026-00','2026-13','2026-1','2026-11?employee=A',null])rejects(()=>r.monthly(month),'INVALID_MONTH');
 rejects(()=>r.createReport({...reportBody(),vehicleId:V}),'INVALID_REQUEST');rejects(()=>r.setSimulationMode({outcome:'success',employeeId:A}),'INVALID_REQUEST');rejects(()=>r.setSimulationMode({outcome:'maybe'}),'INVALID_OUTCOME');rejects(()=>r.report('missing'),'REPORT_NOT_FOUND');
});


test('fresh submit requests recheck stale readiness while exact retries preserve the committed request result',t=>{
 const {r,capture,advance}=fixture(t);capture({confirmed:true});const report=r.createReport(reportBody()).report,body=submitBody(report),initial=r.submit(body);advance(1000);const completed=r.monthly('2026-11').submissions[0];assert.equal(completed.status,'completed');
 capture();assert.equal(r.report(report.id).stale,true);rejects(()=>r.submit(submitBody(report)),'SUBMISSION_NOT_READY');assert.deepEqual(r.submit(body),initial);assert.deepEqual(r.monthly('2026-11').submissions[0],completed);
});
