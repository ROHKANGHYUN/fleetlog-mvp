import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startMvpServer } from '../services/mvp/server.mjs';

const employeeId='mvp-employee-001',other='mvp-employee-002',vehicleId='mvp-vehicle-001';
async function fixture(t) {
  let clock=Date.parse('2026-11-15T01:00:00Z');
  const app=await startMvpServer({now:()=>clock});t.after(()=>app.close());
  const request=async(path,body)=>{
    const response=await fetch(app.address+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
    return {status:response.status,headers:response.headers,body:await response.json()};
  };
  const qr=await request(`/mvp-api/vehicles/${vehicleId}/qr`);
  const connection=(await request('/mvp-api/connections',{token:qr.body.token,employeeId})).body.connection;
  const command=async(type,extra={})=>{
    const result=await request('/mvp-api/commands',{commandId:randomUUID(),connectionId:connection.id,type,...extra});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
  };
  async function capture({receive=true,gap=false}={}) {
    const {trip}=await command('depart',{tripId:''});
    if(gap)await command('unknown',{tripId:trip.id,conversationId:trip.conversationId});
    const current=app.store.workflow.activeTrip(connection.id);
    await command('arrive',{tripId:trip.id,conversationId:current.conversationId});
    const {conversation}=await command('finish',{tripId:trip.id,conversationId:current.conversationId});
    await command('confirm',{conversationId:conversation.id,value:'later'});
    const upload=app.store.workflow.state().pendingUploads.at(-1);
    const event=JSON.parse(upload.body);
    const ack=receive?await request('/mvp-api/trip-events',event):null;
    if(receive)assert.equal(ack.status,200);
    return {trip:event.payload,event,ack:ack?.body};
  }
  return {app,request,connection,command,capture,setClock:value=>clock=Date.parse(value)};
}
const amendment=(extra={})=>({requestId:randomUUID(),employeeId,expectedAmendmentVersion:0,purpose:'business',destination:'가상 거래처',detailedPurpose:'가상 미팅',...extra});
function rawOrigin(store) {
  return JSON.stringify(['mvp_trips','mvp_uploads','mvp_received_trips','mvp_trip_receipts'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

test('HTTP owner amendment after disconnect keeps all original rows and first ACK, even after original-event replay',async t=>{
  const f=await fixture(t),first=await f.capture(),raw=rawOrigin(f.app.store),body=amendment();
  assert.equal((await f.request(`/mvp-api/trips/${first.trip.id}/amendments`,{...body,employeeId:other})).status,403);
  assert.equal((await f.request(`/mvp-api/connections/${f.connection.id}/disconnect`,{employeeId})).status,200);
  const result=await f.request(`/mvp-api/trips/${first.trip.id}/amendments`,body);assert.equal(result.status,200);
  assert.equal(result.body.trip.purpose,'business');assert.equal(result.body.trip.amendmentVersion,1);
  assert.equal(result.body.trip.amendmentHistory.length,1);
  assert.equal(result.body.trip.amendmentHistory[0].before.purpose,null);
  assert.equal(rawOrigin(f.app.store),raw);
  const duplicate=await f.request(`/mvp-api/trips/${first.trip.id}/amendments`,body);assert.equal(duplicate.status,200);
  assert.deepEqual(duplicate.body,result.body);
  const replay=await f.request('/mvp-api/trip-events',first.event);assert.deepEqual(replay.body,first.ack);assert.equal(replay.body.serverVersion,1);
  const state=(await f.request('/mvp-api/state')).body;
  assert.equal(state.receivedTrips.length,1);assert.equal(state.receivedTrips[0].purpose,'business');assert.equal(state.receivedTrips[0].amendmentHistory.length,1);
  assert.equal(rawOrigin(f.app.store),raw);
});

test('real concurrent HTTP corrections have one revision winner and immutable extra fields are rejected',async t=>{
  const f=await fixture(t),first=await f.capture(),path=`/mvp-api/trips/${first.trip.id}/amendments`;
  const bad=await f.request(path,amendment({distanceM:0}));assert.equal(bad.status,400);
  const outcomes=await Promise.all([f.request(path,amendment({purpose:'commute'})),f.request(path,amendment({purpose:'personal'}))]);
  assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);
  const current=(await f.request('/mvp-api/state')).body.receivedTrips[0];assert.equal(current.amendmentVersion,1);assert.equal(current.amendmentHistory.length,1);
  assert.equal(current.distanceM,23400);assert.equal(current.serverVersion,1);assert.equal(current.quality,'complete');
});

test('HTTP report creation/download use a frozen snapshot; corrections make it stale without changing old CSV',async t=>{
  const f=await fixture(t),first=await f.capture();
  const bad=await f.request('/mvp-api/monthly?month=2026-11&vehicleId=mvp-vehicle-002');assert.equal(bad.status,400);
  const create={requestId:randomUUID(),month:'2026-11'};
  const firstReport=await f.request('/mvp-api/reports',create);assert.equal(firstReport.status,200);
  const report=firstReport.body.report;assert.equal(report.data.summary.receivedCount,1);assert.equal(report.data.summary.unconfirmedCount,1);
  const csvUrl=f.app.address+`/mvp-api/reports/${report.id}/trips.csv`;
  const download=await fetch(csvUrl),bytes=Buffer.from(await download.arrayBuffer());
  assert.equal(download.status,200);assert.match(download.headers.get('Content-Type'),/^text\/csv/);
  assert.match(download.headers.get('Content-Disposition'),/attachment; filename="Fleetlog-DEMO-2026-11-v1-trips.csv"/);
  assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);assert.ok(bytes.toString('utf8').includes(first.trip.id));
  const costs=await fetch(f.app.address+`/mvp-api/reports/${report.id}/costs.csv`);assert.equal(costs.status,200);assert.match(await costs.text(),/dummy-fixture|가상/);
  const amended=await f.request(`/mvp-api/trips/${first.trip.id}/amendments`,amendment({destination:'=HYPERLINK("가상")',detailedPurpose:'가상, "미팅"\n추가 메모'}));assert.equal(amended.status,200);
  assert.equal((await f.request(`/mvp-api/reports/${report.id}`)).body.report.stale,true);
  assert.deepEqual(Buffer.from(await(await fetch(csvUrl)).arrayBuffer()),bytes);
  const cannotSubmit=await f.request('/mvp-api/submissions',{requestId:randomUUID(),reportId:report.id});assert.equal(cannotSubmit.status,409);
  const duplicate=await f.request('/mvp-api/reports',create);assert.equal(duplicate.body.report.id,report.id);assert.equal(duplicate.body.report.stale,true);
  const fresh=(await f.request('/mvp-api/reports',{requestId:randomUUID(),month:'2026-11'})).body.report;assert.equal(fresh.version,2);assert.equal(fresh.data.trips[0].purpose,'business');
  const updatedCsv=await(await fetch(f.app.address+`/mvp-api/reports/${fresh.id}/trips.csv`)).text();
  assert.ok(updatedCsv.includes("'=HYPERLINK"));assert.ok(updatedCsv.includes('""미팅""'));assert.ok(updatedCsv.includes('\n추가 메모'));
});

test('KST month HTTP summaries exclude pending and incomplete distances without treating unconfirmed as business',async t=>{
  const f=await fixture(t);
  f.setClock('2026-10-31T14:59:59.999Z');const october=await f.capture();
  f.setClock('2026-10-31T15:00:00.000Z');const november=await f.capture({gap:true});
  await f.capture({receive:false});
  const oct=(await f.request('/mvp-api/monthly?month=2026-10')).body.data,nov=(await f.request('/mvp-api/monthly?month=2026-11')).body.data;
  assert.deepEqual(oct.trips.map(x=>x.id),[october.trip.id]);assert.deepEqual(nov.trips.map(x=>x.id),[november.trip.id]);
  assert.equal(oct.summary.validDistanceM,23400);assert.equal(nov.summary.validDistanceM,null);assert.equal(nov.summary.excludedDistanceCount,1);assert.equal(nov.summary.pendingCount,1);
  assert.equal(nov.byPurpose.find(x=>x.key==='unconfirmed').count,1);assert.equal(nov.byPurpose.find(x=>x.key==='business')?.count??0,0);
  const corrected=await f.request(`/mvp-api/trips/${november.trip.id}/amendments`,amendment());assert.equal(corrected.status,200);assert.equal(corrected.body.trip.quality,'incomplete');
  const report=(await f.request('/mvp-api/reports',{requestId:randomUUID(),month:'2026-11'})).body.report;
  const response=await f.request('/mvp-api/submissions',{requestId:randomUUID(),reportId:report.id});assert.equal(response.status,409);
});

test('HTTP simulated submissions persist one result per report, with distinct failure/retry attempts and frozen receipts',async t=>{
  const f=await fixture(t),first=await f.capture();
  await f.request(`/mvp-api/trips/${first.trip.id}/amendments`,amendment());
  const report=(await f.request('/mvp-api/reports',{requestId:randomUUID(),month:'2026-11'})).body.report;
  assert.equal((await f.request('/mvp-api/simulation/submission-outcome',{outcome:'failure'})).status,200);
  const request={requestId:randomUUID(),reportId:report.id},pending=await f.request('/mvp-api/submissions',request);assert.equal(pending.status,200);assert.equal(pending.body.submission.status,'processing');
  await f.request('/mvp-api/submissions',request);assert.equal((await f.request('/mvp-api/monthly?month=2026-11')).body.submissions.length,1);
  f.setClock('2026-11-15T01:00:02Z');let result=(await f.request('/mvp-api/monthly?month=2026-11')).body.submissions[0];assert.equal(result.status,'failed');assert.equal(result.attempts.length,1);
  await f.request('/mvp-api/simulation/submission-outcome',{outcome:'success'});
  assert.equal((await f.request('/mvp-api/submissions',{requestId:randomUUID(),reportId:report.id})).body.submission.status,'processing');
  f.setClock('2026-11-15T01:00:04Z');result=(await f.request('/mvp-api/monthly?month=2026-11')).body.submissions[0];assert.equal(result.status,'completed');assert.equal(result.attempts.length,2);assert.match(result.attempts[1].receiptNumber,/^DEMO-/);
  const receipt=result.attempts[1].receiptNumber;
  await f.request('/mvp-api/submissions',{requestId:randomUUID(),reportId:report.id});assert.equal((await f.request('/mvp-api/monthly?month=2026-11')).body.submissions[0].attempts.length,2);
  await f.capture();const state=(await f.request('/mvp-api/monthly?month=2026-11')).body;
  assert.equal(state.reports[0].stale,true);assert.equal(state.submissions[0].attempts[1].receiptNumber,receipt);assert.equal(state.submissions[0].status,'completed');
  assert.equal((await f.request('/mvp-api/submissions',{requestId:randomUUID(),reportId:report.id})).status,409);
});
