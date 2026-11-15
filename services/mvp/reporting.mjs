import { createHash, randomUUID } from 'node:crypto';
import { MvpError } from './store.mjs';

const COMPANY_ID = 'mvp-company-001';
const PURPOSES = ['business', 'commute', 'personal'];
const fail = (status, code, message) => { throw new MvpError(status, code, message); };
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const purposeFields = trip => ({ purpose: trip.purpose ?? null, destination: trip.destination ?? null, detailedPurpose: trip.detailedPurpose ?? null, purposeConfirmed: !!trip.purposeConfirmed });

// Explicitly dated fixtures. Selecting another month never copies these costs.
export const MVP_COST_FIXTURES = Object.freeze([
  { id: 'demo-cost-202611-fuel-1', companyId: COMPANY_ID, vehicleId: 'mvp-vehicle-001', occurredOn: '2026-11-02', category: 'fuel', amountKRW: 68000, source: 'dummy-fixture', description: '가상 차량 비용 · 실제 결제 아님' },
  { id: 'demo-cost-202611-parking-1', companyId: COMPANY_ID, vehicleId: 'mvp-vehicle-001', occurredOn: '2026-11-04', category: 'parking', amountKRW: 8000, source: 'dummy-fixture', description: '가상 차량 비용 · 실제 결제 아님' },
  { id: 'demo-cost-202611-toll-2', companyId: COMPANY_ID, vehicleId: 'mvp-vehicle-002', occurredOn: '2026-11-06', category: 'toll', amountKRW: 4200, source: 'dummy-fixture', description: '가상 차량 비용 · 실제 결제 아님' },
  { id: 'demo-cost-202610-fuel-2', companyId: COMPANY_ID, vehicleId: 'mvp-vehicle-002', occurredOn: '2026-10-20', category: 'fuel', amountKRW: 55000, source: 'dummy-fixture', description: '가상 차량 비용 · 실제 결제 아님' },
].map(Object.freeze));

export function koreanMonth(value) {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant + 9 * 60 * 60 * 1000).toISOString().slice(0, 7) : null;
}
export function validDistance(trip) {
  return trip.quality === 'complete' && !trip.hasGap && Number.isFinite(trip.distanceM) && trip.distanceM >= 0;
}
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Quoting CSV is insufficient against spreadsheet formulas after whitespace.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const csvRows = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
const requireMonth = month => {
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) fail(400, 'INVALID_MONTH', '월은 YYYY-MM 형식으로 선택해 주세요.');
  return month;
};
const requireRequestId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) fail(400, 'INVALID_REQUEST_ID', '요청 식별자를 확인해 주세요.');
};
const exactKeys = (body, keys) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) fail(400, 'INVALID_REQUEST', '요청 항목을 확인해 주세요.');
};

/** MVP-only amendments, monthly snapshots and local submission simulation.
 * Received originals, prepared upload strings and transport receipts stay immutable.
 */
export class MvpReporting {
  constructor(store) {
    this.store = store;this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mvp_amendments(trip_id TEXT NOT NULL,version INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,body_json TEXT NOT NULL,PRIMARY KEY(trip_id,version));
      CREATE TABLE IF NOT EXISTS mvp_reporting_requests(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,canonical_body TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_costs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,occurred_on TEXT NOT NULL,body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_reports(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,month TEXT NOT NULL,version INTEGER NOT NULL,body_json TEXT NOT NULL,UNIQUE(company_id,month,version));
      CREATE TABLE IF NOT EXISTS mvp_submissions(id TEXT PRIMARY KEY,report_id TEXT NOT NULL UNIQUE REFERENCES mvp_reports(id),body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_reporting_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO mvp_reporting_settings VALUES('submissionOutcome','success');
    `);
    const insert = this.db.prepare('INSERT OR IGNORE INTO mvp_costs VALUES(?,?,?,?,?)');
    for (const cost of MVP_COST_FIXTURES) insert.run(cost.id,cost.companyId,cost.vehicleId,cost.occurredOn,JSON.stringify(cost));
  }
  now() { return this.store.now(); }
  iso() { return new Date(this.now()).toISOString(); }
  rawTrips() { return this.db.prepare('SELECT body_json FROM mvp_received_trips ORDER BY rowid').all().map(row => JSON.parse(row.body_json)); }
  history(id) { return this.db.prepare('SELECT body_json FROM mvp_amendments WHERE trip_id=? ORDER BY version').all(id).map(row => JSON.parse(row.body_json)); }
  enrichTrips(rawReceived) {
    return rawReceived.map(original => {
      const amendmentHistory = this.history(original.id),latest = amendmentHistory.at(-1);
      return { ...clone(original), ...(latest?.after ?? {}), amendmentVersion: latest?.version ?? 0, amendmentHistory, originalPurpose: purposeFields(original) };
    });
  }
  replay(requestId,kind,body) {
    const previous = this.db.prepare('SELECT * FROM mvp_reporting_requests WHERE request_id=?').get(requestId);
    if (!previous) return null;
    if (previous.kind !== kind || previous.canonical_body !== canonical(body)) fail(409,'REQUEST_CONFLICT','같은 요청 ID의 내용을 변경할 수 없습니다. 이전 결과를 확인해 주세요.');
    return JSON.parse(previous.result_json);
  }
  remember(requestId,kind,body,result) {
    this.db.prepare('INSERT INTO mvp_reporting_requests VALUES(?,?,?,?)').run(requestId,kind,canonical(body),JSON.stringify(result));
    return result;
  }
  amend(tripId,body) {
    exactKeys(body,['requestId','employeeId','expectedAmendmentVersion','purpose','destination','detailedPurpose']);requireRequestId(body.requestId);
    if(typeof tripId!=='string'||!tripId||tripId.length>100)fail(400,'INVALID_TRIP','운행 ID를 확인해 주세요.');
    if (typeof body.employeeId !== 'string' || !body.employeeId || !Number.isSafeInteger(body.expectedAmendmentVersion) || body.expectedAmendmentVersion < 0 || !PURPOSES.includes(body.purpose)
      || ['destination','detailedPurpose'].some(key => typeof body[key] !== 'string' || body[key].length > 200 || body[key].includes('\0'))) fail(400,'INVALID_AMENDMENT','용도와 200자 이내 목적지·상세 목적을 확인해 주세요.');
    const input = { tripId,...body };
    return this.store.transaction(() => {
      const replayed = this.replay(body.requestId,'amendment',input);if (replayed) return replayed;
      const row = this.db.prepare('SELECT body_json FROM mvp_received_trips WHERE trip_id=?').get(tripId);
      if (!row) fail(404,'RECEIVED_TRIP_NOT_FOUND','서버가 수신한 운행만 보완할 수 있습니다.');
      const original = JSON.parse(row.body_json),employee = this.db.prepare('SELECT * FROM mvp_employees WHERE id=?').get(body.employeeId);
      if (!employee || original.employeeId !== body.employeeId || employee.company_id !== original.companyId || original.companyId !== COMPANY_ID) fail(403,'TRIP_OWNER_MISMATCH','원래 운행 직원만 자신의 기록을 보완할 수 있습니다.');
      const current = this.enrichTrips([original])[0];
      if (current.amendmentVersion !== body.expectedAmendmentVersion) fail(409,'AMENDMENT_VERSION_CONFLICT','다른 요청으로 이미 보완됐습니다. 최신 기록을 다시 확인해 주세요.');
      if (original.purposeConfirmed || current.purposeConfirmed) fail(409,'PURPOSE_ALREADY_CONFIRMED','이번 MVP에서는 서버 수신된 미확정 운행만 보완할 수 있습니다.');
      const active = this.db.prepare("SELECT vehicle_id FROM mvp_connections WHERE employee_id=? AND status='active'").get(body.employeeId);
      if (active && this.store.workflow.runtime(active.vehicle_id).parking !== 'parked') fail(409,'PARKING_REQUIRED','현재 연결 차량의 주차가 확인된 뒤 보완해 주세요.');
      const amendment = { requestId:body.requestId,tripId,version:current.amendmentVersion+1,employeeId:body.employeeId,changedAt:this.iso(),before:purposeFields(current),
        after:{purpose:body.purpose,destination:body.destination.trim()||null,detailedPurpose:body.detailedPurpose.trim()||null,purposeConfirmed:true} };
      this.db.prepare('INSERT INTO mvp_amendments VALUES(?,?,?,?)').run(tripId,amendment.version,body.requestId,JSON.stringify(amendment));
      return this.remember(body.requestId,'amendment',input,{trip:this.enrichTrips([original])[0],amendment});
    });
  }
  company() { return { ...this.db.prepare('SELECT id,name FROM mvp_companies WHERE id=?').get(COMPANY_ID) }; }
  employees() { return this.db.prepare('SELECT id,name,company_id AS companyId,department,title FROM mvp_employees WHERE company_id=? ORDER BY id').all(COMPANY_ID).map(row=>({...row})); }
  vehicles() { return this.db.prepare('SELECT id,name,plate,company_id AS companyId FROM mvp_vehicles WHERE company_id=? ORDER BY id').all(COMPANY_ID).map(row=>({...row})); }
  groups(keys,trips,keyOf) {
    return keys.map(key => {
      const matching = trips.filter(trip => keyOf(trip) === key),valid = matching.filter(validDistance);
      return { key,count:matching.length,validDistanceM:valid.length ? valid.reduce((sum,trip)=>sum+trip.distanceM,0) : null,excludedDistanceCount:matching.length-valid.length };
    });
  }
  data(month) {
    requireMonth(month);
    const trips = this.enrichTrips(this.rawTrips()).filter(trip=>trip.companyId===COMPANY_ID && koreanMonth(trip.startedAt)===month).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||a.id.localeCompare(b.id));
    const costs = this.db.prepare('SELECT body_json FROM mvp_costs WHERE company_id=? AND substr(occurred_on,1,7)=? ORDER BY occurred_on,id').all(COMPANY_ID,month).map(row=>JSON.parse(row.body_json))
      .filter(cost => this.db.prepare('SELECT company_id FROM mvp_vehicles WHERE id=?').get(cost.vehicleId)?.company_id===COMPANY_ID);
    const pending = this.db.prepare("SELECT * FROM mvp_uploads WHERE status!='received' ORDER BY event_id").all().map(row=>({row,trip:JSON.parse(row.body).payload}))
      .filter(({trip})=>trip.companyId===COMPANY_ID && koreanMonth(trip.startedAt)===month)
      .map(({row,trip})=>({eventId:row.event_id,tripId:row.trip_id,vehicleId:row.vehicle_id,employeeId:trip.employeeId,startedAt:trip.startedAt,status:row.status,lastError:row.last_error}));
    const valid = trips.filter(validDistance),unconfirmed = trips.filter(trip=>!trip.purposeConfirmed || !PURPOSES.includes(trip.purpose));
    const summary = { receivedCount:trips.length,validDistanceM:valid.length ? valid.reduce((sum,trip)=>sum+trip.distanceM,0) : null,excludedDistanceCount:trips.length-valid.length,
      unconfirmedCount:unconfirmed.length,incompleteCount:trips.length-valid.length,pendingCount:pending.length,costTotalKRW:costs.reduce((sum,cost)=>sum+cost.amountKRW,0) };
    const issues = [];
    if (!trips.length) issues.push({code:'NO_RECEIVED_TRIPS',message:'이 월에 서버가 수신한 운행이 없습니다.'});
    if (unconfirmed.length) issues.push({code:'UNCONFIRMED_PURPOSE',message:`용도 미확정 운행 ${unconfirmed.length}건을 보완해 주세요.`});
    if (summary.incompleteCount) issues.push({code:'INCOMPLETE_DISTANCE',message:`거리 확인이 필요한 운행 ${summary.incompleteCount}건이 있습니다.`});
    if (pending.length) issues.push({code:'PENDING_UPLOADS',message:`이 월에 알려진 미전송 운행 ${pending.length}건이 있습니다.`});
    const employees=this.employees(),vehicles=this.vehicles();
    return {month,company:this.company(),scope:{timeZone:'Asia/Seoul',basis:'startedAt',allVehicles:true},trips,costs,pending,summary,
      byEmployee:this.groups(employees.map(row=>row.id),trips,trip=>trip.employeeId),byVehicle:this.groups(vehicles.map(row=>row.id),trips,trip=>trip.vehicleId),
      byPurpose:this.groups([...PURPOSES,'unconfirmed'],trips,trip=>trip.purposeConfirmed && PURPOSES.includes(trip.purpose)?trip.purpose:'unconfirmed'),issues,employees,vehicles};
  }
  fingerprint(data) { return hash({company:data.company,employees:data.employees,vehicles:data.vehicles,trips:data.trips,costs:data.costs,pending:data.pending}); }
  reportValue(row,currentData) {
    const saved = JSON.parse(row.body_json),current = currentData ?? this.data(saved.month),stale = saved.fingerprint !== this.fingerprint(current);
    const reasons = [...current.issues,...(stale?[{code:'STALE_SNAPSHOT',message:'생성 후 대상 데이터가 바뀌었습니다. 새 자료 버전을 생성해 주세요.'}]:[])];
    return { ...saved,stale,readiness:{canSubmit:reasons.length===0,reasons} };
  }
  report(id) {
    this.settle();const row=this.db.prepare('SELECT * FROM mvp_reports WHERE id=? AND company_id=?').get(id,COMPANY_ID);
    if(!row)fail(404,'REPORT_NOT_FOUND','월별 자료를 찾을 수 없습니다.');
    return this.reportValue(row);
  }
  createReport(body) {
    exactKeys(body,['requestId','month']);requireRequestId(body.requestId);requireMonth(body.month);
    return this.store.transaction(()=>{
      const replayed=this.replay(body.requestId,'report',body);
      if(replayed){const row=this.db.prepare('SELECT * FROM mvp_reports WHERE id=? AND company_id=?').get(replayed.report.id,COMPANY_ID);return{report:this.reportValue(row)};}
      const data=this.data(body.month),version=(this.db.prepare('SELECT MAX(version) version FROM mvp_reports WHERE company_id=? AND month=?').get(COMPANY_ID,body.month).version??0)+1;
      const report={id:randomUUID(),companyId:COMPANY_ID,month:body.month,version,createdAt:this.iso(),fingerprint:this.fingerprint(data),data};
      this.db.prepare('INSERT INTO mvp_reports VALUES(?,?,?,?,?)').run(report.id,COMPANY_ID,body.month,version,JSON.stringify(report));
      return this.remember(body.requestId,'report',body,{report:{...report,stale:false,readiness:{canSubmit:data.issues.length===0,reasons:data.issues}}});
    });
  }
  outcome() { return this.db.prepare("SELECT value FROM mvp_reporting_settings WHERE key='submissionOutcome'").get().value; }
  setSimulationMode(body) {
    exactKeys(body,['outcome']);if(!['success','failure'].includes(body.outcome))fail(400,'INVALID_OUTCOME','모의 성공 또는 실패를 선택해 주세요.');
    return this.store.transaction(()=>{this.db.prepare("UPDATE mvp_reporting_settings SET value=? WHERE key='submissionOutcome'").run(body.outcome);return{outcome:body.outcome};});
  }
  settle() {
    const ids=this.db.prepare('SELECT id,body_json FROM mvp_submissions').all().filter(row=>JSON.parse(row.body_json).status==='processing').map(row=>row.id);
    if(!ids.length)return;
    this.store.transaction(()=>{
      for(const id of ids){
        const value=JSON.parse(this.db.prepare('SELECT body_json FROM mvp_submissions WHERE id=?').get(id).body_json),attempt=value.attempts.at(-1);
        if(value.status!=='processing'||Date.parse(attempt.readyAt)>this.now())continue;
        const status=attempt.outcome==='success'?'completed':'failed';
        const finished={...attempt,status,completedAt:this.iso(),receiptNumber:status==='completed'?`DEMO-${value.month.replace('-','')}-V${value.reportVersion}-${attempt.id.replace(/-/g,'').slice(0,8).toUpperCase()}`:null,
          error:status==='failed'?'모의 접수 실패를 재현했습니다. 실제 신고는 수행하지 않았습니다.':null};
        value.status=status;value.attempts=[...value.attempts.slice(0,-1),finished];
        this.db.prepare('UPDATE mvp_submissions SET body_json=? WHERE id=?').run(JSON.stringify(value),id);
      }
    });
  }
  submit(body) {
    exactKeys(body,['requestId','reportId']);requireRequestId(body.requestId);if(typeof body.reportId!=='string'||!body.reportId||body.reportId.length>100)fail(400,'INVALID_REPORT','자료를 선택해 주세요.');
    this.settle();
    return this.store.transaction(()=>{
      const replayed=this.replay(body.requestId,'submission',body);if(replayed)return replayed;
      const row=this.db.prepare('SELECT * FROM mvp_reports WHERE id=? AND company_id=?').get(body.reportId,COMPANY_ID);
      if(!row)fail(404,'REPORT_NOT_FOUND','월별 자료를 찾을 수 없습니다.');
      const report=this.reportValue(row);
      if(!report.readiness.canSubmit)fail(409,'SUBMISSION_NOT_READY',report.readiness.reasons.map(issue=>issue.message).join(' '));
      const existing=this.db.prepare('SELECT body_json FROM mvp_submissions WHERE report_id=?').get(body.reportId),old=existing&&JSON.parse(existing.body_json);
      if(old&&['processing','completed'].includes(old.status))return this.remember(body.requestId,'submission',body,{submission:old});
      const requestedAt=this.iso(),attempt={id:randomUUID(),number:(old?.attempts.length??0)+1,requestId:body.requestId,requestedAt,readyAt:new Date(this.now()+1000).toISOString(),completedAt:null,outcome:this.outcome(),receiptNumber:null,error:null,status:'processing'};
      const submission={id:old?.id??randomUUID(),reportId:body.reportId,month:report.month,reportVersion:report.version,status:'processing',attempts:[...(old?.attempts??[]),attempt]};
      this.db.prepare('INSERT INTO mvp_submissions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json').run(submission.id,body.reportId,JSON.stringify(submission));
      return this.remember(body.requestId,'submission',body,{submission});
    });
  }
  monthly(month) {
    requireMonth(month);this.settle();const data=this.data(month);
    const reports=this.db.prepare('SELECT * FROM mvp_reports WHERE company_id=? AND month=? ORDER BY version DESC').all(COMPANY_ID,month).map(row=>this.reportValue(row,data));
    const submissions=this.db.prepare('SELECT body_json FROM mvp_submissions ORDER BY rowid').all().map(row=>JSON.parse(row.body_json)).filter(row=>row.month===month);
    return {data,reports,submissions,simulationOutcome:this.outcome()};
  }
  csv(id,kind) {
    if(!['trips','costs'].includes(kind))fail(400,'INVALID_CSV','운행 또는 가상 비용 CSV를 선택해 주세요.');
    const report=this.report(id),data=report.data,prefix=[data.company.name,data.month,report.version,report.id,'가상 데이터 · 실제 신고 아님'];
    const person=id=>data.employees?.find(row=>row.id===id),vehicle=id=>data.vehicles?.find(row=>row.id===id);
    const rows=kind==='trips'?
      [['회사','대상 월(한국 시작일)','자료 버전','자료 ID','구분','운행 ID','보완 버전','직원 ID','직원','부서','차량 ID','차량','가상 차량번호','출발(UTC)','종료(UTC)','용도','목적지','상세 목적','거리 품질','유효 거리(m)','거리 확인 필요','출처'],
        ...data.trips.map(trip=>[...prefix,trip.id,trip.amendmentVersion,trip.employeeId,person(trip.employeeId)?.name,person(trip.employeeId)?.department,trip.vehicleId,vehicle(trip.vehicleId)?.name,vehicle(trip.vehicleId)?.plate,trip.startedAt,trip.endedAt,trip.purposeConfirmed?trip.purpose:'unconfirmed',trip.destination,trip.detailedPurpose,trip.quality,validDistance(trip)?trip.distanceM:null,validDistance(trip)?'아니요':'예',trip.source])]:
      [['회사','대상 월(한국 시작일)','자료 버전','자료 ID','구분','비용 ID','발생일','차량 ID','차량','항목','금액(KRW)','가상 출처','설명'],
        ...data.costs.map(cost=>[...prefix,cost.id,cost.occurredOn,cost.vehicleId,vehicle(cost.vehicleId)?.name,cost.category,cost.amountKRW,cost.source,cost.description])];
    return {body:csvRows(rows),filename:`Fleetlog-DEMO-${report.month}-v${report.version}-${kind}.csv`};
  }
  state() { return { simulationOutcome:this.outcome() }; }
}
