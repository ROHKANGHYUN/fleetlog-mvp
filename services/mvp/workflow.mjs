import { randomUUID } from 'node:crypto';
import { MvpError } from './store.mjs';

const QUESTION = '어디를 다녀오셨고, 어떤 목적으로 운행하셨나요?';
const fail = (status, code, message) => { throw new MvpError(status, code, message); };
const parse = value => JSON.parse(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const json = value => JSON.stringify(value);
const labels = { business: '업무', commute: '출퇴근', personal: '개인 용도' };
const MOCK_INITIAL_ODOMETER_M = 12480000;
function objectParticle(text) {
  const last=text.charCodeAt(text.length-1);
  return last>=0xac00 && last<=0xd7a3 && (last-0xac00)%28===0?'를':'을';
}
export function parseMockAnswer(text) {
  const value = String(text).trim().replace(/[.!?。]$/, '');
  const examples = {
    '판교 거래처에 계약 미팅하러 갑니다': ['판교 거래처', 'business', '계약 미팅'],
    '업무 방문': [null, 'business', '업무 방문'],
    '회사로 출근합니다': ['회사', 'commute', '출근'],
    '집으로 퇴근합니다': ['집', 'commute', '퇴근'],
    '출퇴근': [null, 'commute', '출퇴근'],
    '마트에 장보러 갑니다': ['마트', 'personal', '장보기'],
    '개인 용도': [null, 'personal', '개인 용도'],
  };
  const found = Object.hasOwn(examples,value) ? examples[value] : null;
  return found ? { destination: found[0], purpose: found[1], detailedPurpose: found[2] } : null;
}

/** Authoritative simulator capture/queue, distinct from the received-trip tables. */
export class MvpWorkflow {
  constructor(store) {
    this.store = store;this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mvp_workflow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_conversations(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,phase TEXT NOT NULL,body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_prompts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,connection_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,status TEXT NOT NULL,body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_trips(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,vehicle_id TEXT NOT NULL,status TEXT NOT NULL,body_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS mvp_one_active_trip ON mvp_trips(vehicle_id) WHERE status='active';
      CREATE TABLE IF NOT EXISTS mvp_uploads(event_id TEXT PRIMARY KEY,trip_id TEXT NOT NULL UNIQUE,vehicle_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,next_attempt_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mvp_received_trips(trip_id TEXT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,body_json TEXT NOT NULL,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_trip_receipts(event_id TEXT PRIMARY KEY,canonical_body TEXT NOT NULL,ack_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_commands(id TEXT PRIMARY KEY,canonical_body TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_upload_modes(vehicle_id TEXT PRIMARY KEY,blocked INTEGER NOT NULL CHECK(blocked IN(0,1)));
      CREATE TABLE IF NOT EXISTS mvp_mock_odometers(vehicle_id TEXT PRIMARY KEY,meters INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_vehicle_runtime(vehicle_id TEXT PRIMARY KEY,body_json TEXT NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO mvp_workflow_meta VALUES('demoId',?)").run(randomUUID());
    for (const row of this.db.prepare('SELECT id FROM mvp_vehicles').all()) {
      this.db.prepare('INSERT OR IGNORE INTO mvp_vehicle_runtime VALUES(?,?)').run(row.id,json({vehicleId:row.id,connectionId:null,parking:'parked',sessionActive:false}));
    }
  }
  now() { return this.store.now(); }
  iso() { return new Date(this.now()).toISOString(); }
  body(table, id) { const row = this.db.prepare(`SELECT body_json FROM ${table} WHERE id=?`).get(id);return row ? parse(row.body_json) : null; }
  conversation(id) { return this.body('mvp_conversations', id); }
  prompt(id) { return this.body('mvp_prompts', id); }
  trip(id) { return this.body('mvp_trips', id); }
  currentConversation(connectionId) {
    const row = this.db.prepare("SELECT body_json FROM mvp_conversations WHERE connection_id=? AND phase NOT IN ('cancelled','completed') ORDER BY rowid DESC LIMIT 1").get(connectionId);
    return row ? parse(row.body_json) : null;
  }
  saveConversation(value) { this.db.prepare('UPDATE mvp_conversations SET phase=?,body_json=? WHERE id=?').run(value.phase,json(value),value.id);return value; }
  savePrompt(value) { this.db.prepare('UPDATE mvp_prompts SET status=?,body_json=? WHERE id=?').run(value.status,json(value),value.id);return value; }
  newPrompt(conversation, kind, text) {
    const prompt = { id: randomUUID(), conversationId: conversation.id, connectionId: conversation.connectionId,
      vehicleId: conversation.vehicleId, kind, text, status: 'pending', claimedBy: null };
    this.db.prepare('INSERT INTO mvp_prompts VALUES(?,?,?,?,?,?)').run(prompt.id,prompt.conversationId,prompt.connectionId,prompt.vehicleId,prompt.status,json(prompt));
    conversation.promptId = prompt.id;return prompt;
  }
  connected(connection) {
    const previous=this.runtime(connection.vehicleId);
    // Replayed QR acknowledgement and database reopen must not restart a stopped session.
    if (previous.connectionId===connection.id) return previous;
    return this.saveRuntime({...previous,connectionId:connection.id,sessionActive:true});
  }
  runtime(vehicleId) {
    const row=this.db.prepare('SELECT body_json FROM mvp_vehicle_runtime WHERE vehicle_id=?').get(vehicleId);
    const value=row?parse(row.body_json):{vehicleId,connectionId:null,parking:'unknown',sessionActive:false};
    const mockOdometerM=this.db.prepare('SELECT meters FROM mvp_mock_odometers WHERE vehicle_id=?').get(vehicleId)?.meters??MOCK_INITIAL_ODOMETER_M;
    return {...value,mockOdometerM,distanceAvailable:Number.isSafeInteger(mockOdometerM)&&mockOdometerM>=0};
  }
  saveRuntime(value) {
    const {vehicleId,connectionId,parking,sessionActive}=value;
    this.db.prepare('INSERT INTO mvp_vehicle_runtime VALUES(?,?) ON CONFLICT(vehicle_id) DO UPDATE SET body_json=excluded.body_json').run(vehicleId,json({vehicleId,connectionId,parking,sessionActive}));return this.runtime(vehicleId);
  }
  newConversation(connection,trip) {
    const value = { id:trip.conversationId,tripId:trip.id,connectionId:connection.id,vehicleId:connection.vehicle_id,employeeId:connection.employee_id,
      phase:'question',draft:null,transcript:'',confirmed:false,promptId:null,createdAt:this.iso() };
    this.newPrompt(value,'question',QUESTION);
    this.db.prepare('INSERT INTO mvp_conversations VALUES(?,?,?,?,?)').run(value.id,value.connectionId,value.vehicleId,value.phase,json(value));
    return value;
  }
  activeTrip(connectionId) {
    const row=this.db.prepare("SELECT body_json FROM mvp_trips WHERE connection_id=? AND status='active'").get(connectionId);
    return row ? parse(row.body_json) : null;
  }
  beforeDisconnect(connectionId) {
    if (this.activeTrip(connectionId)) fail(409,'TRIP_IN_PROGRESS','미완료 운행이 있습니다. 주차 후 운행 마치기 또는 기록 종료를 먼저 진행해 주세요.');
  }
  cancelPrompt(conversation) {
    const prompt=this.prompt(conversation.promptId);
    if (prompt && ['pending','claimed'].includes(prompt.status)) this.savePrompt({...prompt,status:'cancelled'});
  }
  disconnected(connectionId) {
    for (const row of this.db.prepare("SELECT body_json FROM mvp_conversations WHERE connection_id=? AND phase NOT IN ('cancelled','completed')").all(connectionId)) {
      const value=parse(row.body_json);this.cancelPrompt(value);
      this.saveConversation({...value,phase:'cancelled',draft:null,confirmed:false});
    }
    const row=this.db.prepare('SELECT vehicle_id FROM mvp_connections WHERE id=?').get(connectionId);
    if(row){const runtime=this.runtime(row.vehicle_id);if(runtime.connectionId===connectionId)this.saveRuntime({...runtime,connectionId:null,sessionActive:false});}
  }
  requireContext(connectionId, conversationId) {
    const connection=this.db.prepare("SELECT * FROM mvp_connections WHERE id=? AND status='active'").get(connectionId);
    const conversation=this.conversation(conversationId);
    const trip=this.activeTrip(connectionId),runtime=connection&&this.runtime(connection.vehicle_id);
    if (!connection || !conversation || conversation.connectionId!==connectionId || this.currentConversation(connectionId)?.id!==conversationId || !trip?.candidateEnd || runtime.parking!=='parked') fail(409,'STALE_CONTEXT','이전 연결 또는 대화의 요청입니다. 현재 시연 상태를 확인해 주세요.');
    return { connection,conversation };
  }
  requireConnection(id) {
    const connection=this.db.prepare("SELECT * FROM mvp_connections WHERE id=? AND status='active'").get(id);
    if(!connection)fail(409,'STALE_CONTEXT','현재 연결된 운전자의 요청이 아닙니다.');
    const runtime=this.runtime(connection.vehicle_id);
    if(runtime.connectionId!==id)fail(409,'STALE_CONTEXT','차량 연결 상태가 변경됐습니다.');
    return {connection,runtime};
  }
  requireParked(runtime) { if(runtime.parking!=='parked')fail(409,'PARKING_REQUIRED','주차가 확인된 상태에서만 처리할 수 있습니다.'); }
  saveTrip(trip,status='active') { this.db.prepare('UPDATE mvp_trips SET status=?,body_json=? WHERE id=?').run(status,json(trip),trip.id);return trip; }
  cancelDialogue(connectionId) {
    const conversation=this.currentConversation(connectionId);
    if(conversation){this.cancelPrompt(conversation);this.saveConversation({...conversation,phase:'cancelled',draft:null,confirmed:false});}
  }
  finalize(trip,{draft=null,reason='deferred',boundary=trip.candidateEnd}={}) {
    if(!boundary || boundary.endOdometerM<=trip.startOdometerM)fail(409,'NO_OBSERVED_SEGMENT','보관할 관측 구간이 없습니다.');
    const ended={...trip,endedAt:boundary.endedAt,endOdometerM:boundary.endOdometerM,distanceM:boundary.endOdometerM-trip.startOdometerM,
      destination:draft?.destination??null,purpose:draft?.purpose??null,detailedPurpose:draft?.detailedPurpose??null,purposeConfirmed:!!draft,
      quality:trip.hasGap||Date.parse(boundary.endedAt)<Date.parse(trip.startedAt)?'incomplete':'complete',legInProgress:false,candidateEnd:{...boundary}};
    this.saveTrip(ended,'ended');
    const eventId=randomUUID(),event={schemaVersion:1,eventId,tripId:trip.id,source:'mock',payload:ended};
    this.db.prepare("INSERT INTO mvp_uploads VALUES(?,?,?,?,'queued',0,NULL,0)").run(eventId,trip.id,trip.vehicleId,json(event));
    const conversation=this.currentConversation(trip.connectionId);
    if(conversation){this.cancelPrompt(conversation);this.saveConversation({...conversation,phase:'completed',confirmed:!!draft,completionReason:reason});}
    return {trip:ended,eventId,...(conversation?{conversation:this.conversation(conversation.id)}:{})};
  }
  control(command) {
    const {connection,runtime}=this.requireConnection(command.connectionId);
    const active=this.activeTrip(connection.id);
    if(Object.hasOwn(command,'tripId') && (active?.id??'')!==command.tripId){
      const old=this.trip(command.tripId);
      if(['arrive','finish','stop_session'].includes(command.type)&&old?.endedAt&&old.connectionId===connection.id)return {trip:old,runtime};
      fail(409,'STALE_TRIP','현재 운행에 대한 요청이 아닙니다.');
    }
    if(command.conversationId && command.conversationId!==active?.conversationId)fail(409,'STALE_CONTEXT','이전 대화의 제어 요청입니다.');
    if(command.type==='unknown'){
      this.cancelDialogue(connection.id);
      if(active)this.saveTrip({...active,hasGap:true,quality:'incomplete',candidateEnd:null,conversationId:randomUUID(),purpose:null,destination:null,detailedPurpose:null,purposeConfirmed:false});
      return {runtime:this.saveRuntime({...runtime,parking:'unknown'})};
    }
    if(command.type==='park'){
      if(active?.legInProgress)this.saveTrip({...active,hasGap:true,quality:'incomplete',legInProgress:false});
      return {runtime:this.saveRuntime({...runtime,parking:'parked'})};
    }
    if(command.type==='start_session'){
      this.requireParked(runtime);return {runtime:this.saveRuntime({...runtime,sessionActive:true})};
    }
    if(command.type==='stop_session'){
      this.requireParked(runtime);let result={};
      if(active){
        if(active.lastObservedOdometerM>active.startOdometerM)result=this.finalize(active,{reason:'session-ended',boundary:{endedAt:active.lastObservedAt,endOdometerM:active.lastObservedOdometerM}});
        else {this.cancelDialogue(connection.id);this.saveTrip({...active,candidateEnd:null},'discarded');}
      }
      return {...result,runtime:this.saveRuntime({...runtime,sessionActive:false})};
    }
    if(!runtime.sessionActive)fail(409,'SESSION_STOPPED','기록 수집이 중지됐습니다. 주차 상태에서 기록 시작을 눌러 주세요.');
    if(command.type==='depart'){
      if(!runtime.distanceAvailable)fail(409,'ODOMETER_UNAVAILABLE','모의 누적거리 상태를 확인할 수 없습니다. 0으로 대체하지 않습니다.');
      if(active){
        if(runtime.parking==='driving')return {trip:active,runtime};
        this.cancelDialogue(connection.id);
        const trip=this.saveTrip({...active,conversationId:randomUUID(),candidateEnd:null,purpose:null,destination:null,detailedPurpose:null,purposeConfirmed:false,legInProgress:true});
        return {trip,runtime:this.saveRuntime({...runtime,parking:'driving'})};
      }
      const meters=runtime.mockOdometerM;
      const id=randomUUID(),startedAt=this.iso(),trip={id,tripId:id,connectionId:connection.id,companyId:connection.company_id,employeeId:connection.employee_id,vehicleId:connection.vehicle_id,
        conversationId:randomUUID(),startedAt,endedAt:null,startOdometerM:meters,endOdometerM:null,distanceM:null,lastObservedAt:startedAt,lastObservedOdometerM:meters,candidateEnd:null,
        destination:null,purpose:null,detailedPurpose:null,purposeConfirmed:false,quality:'incomplete',hasGap:runtime.parking==='unknown',legInProgress:true,source:'mock'};
      this.db.prepare("INSERT INTO mvp_trips VALUES(?,?,?,'active',?)").run(id,connection.id,connection.vehicle_id,json(trip));
      return {trip,runtime:this.saveRuntime({...runtime,parking:'driving'})};
    }
    if(command.type==='arrive'){
      if(!active || !command.tripId)fail(409,'STALE_TRIP','현재 운행 ID의 주차 요청이 필요합니다.');
      if(!active.legInProgress)return {trip:active,runtime};
      if(!runtime.distanceAvailable){
        const trip=this.saveTrip({...active,hasGap:true,quality:'incomplete',legInProgress:false,candidateEnd:null});
        return {trip,runtime:this.saveRuntime({...runtime,parking:'parked'})};
      }
      const observedAt=this.iso(),observedOdo=active.lastObservedOdometerM+23400,hasGap=active.hasGap||Date.parse(observedAt)<Date.parse(active.startedAt);
      const trip=this.saveTrip({...active,lastObservedAt:observedAt,lastObservedOdometerM:observedOdo,endOdometerM:observedOdo,distanceM:observedOdo-active.startOdometerM,
        quality:hasGap?'incomplete':'complete',hasGap,legInProgress:false,candidateEnd:null});
      this.db.prepare('INSERT INTO mvp_mock_odometers VALUES(?,?) ON CONFLICT(vehicle_id) DO UPDATE SET meters=excluded.meters').run(trip.vehicleId,observedOdo);
      return {trip,runtime:this.saveRuntime({...runtime,parking:'parked'})};
    }
    this.requireParked(runtime);
    if(!active)fail(409,'NO_ACTIVE_TRIP','진행 중인 운행이 없습니다.');
    if(command.type==='continue'){
      this.cancelDialogue(connection.id);
      return {trip:this.saveTrip({...active,candidateEnd:null,conversationId:randomUUID(),purpose:null,destination:null,detailedPurpose:null,purposeConfirmed:false}),runtime};
    }
    if(command.type==='finish'){
      if(active.lastObservedOdometerM<=active.startOdometerM)fail(409,'NO_OBSERVED_SEGMENT','마칠 수 있는 관측 구간이 없습니다.');
      if(active.candidateEnd)return {trip:active,conversation:this.currentConversation(connection.id),runtime};
      const trip=this.saveTrip({...active,candidateEnd:{endedAt:this.iso(),endOdometerM:active.lastObservedOdometerM}});
      return {trip,conversation:this.newConversation(connection,trip),runtime};
    }
    fail(400,'INVALID_COMMAND','지원하지 않는 시연 제어입니다.');
  }
  once(command, action) {
    if (typeof command.commandId!=='string' || !/^[A-Za-z0-9_-]{8,100}$/.test(command.commandId)) fail(400,'INVALID_COMMAND','명령 ID를 확인해 주세요.');
    const body=canonical(command),old=this.db.prepare('SELECT * FROM mvp_commands WHERE id=?').get(command.commandId);
    if (old) { if (old.canonical_body!==body) fail(409,'COMMAND_CONFLICT','같은 명령 ID의 내용을 변경할 수 없습니다.');return parse(old.result_json); }
    const result=action();
    this.db.prepare('INSERT INTO mvp_commands VALUES(?,?,?)').run(command.commandId,body,json(result));
    return result;
  }
  command(command) {
    return this.store.transaction(()=>this.once(command,()=> {
      if(['depart','arrive','finish','continue','stop_session','start_session','unknown','park'].includes(command.type))return this.control(command);
      const {connection,conversation}=this.requireContext(command.connectionId,command.conversationId);
      if (command.type==='simulate_prompt') {
        const prompt=this.prompt(command.promptId);
        if (!prompt || prompt.id!==conversation.promptId || prompt.conversationId!==conversation.id || ['cancelled'].includes(prompt.status) || ['driving','deferred','confirmed'].includes(conversation.phase)) fail(409,'STALE_PROMPT','현재 안내에 대한 요청이 아닙니다.');
        if (['played','simulated'].includes(prompt.status)) return {conversation};
        this.savePrompt({...prompt,status:'simulated'});
        return {conversation:this.saveConversation({...conversation,phase:prompt.kind==='question'?'awaiting_answer':'awaiting_confirmation'})};
      }
      if (command.type==='answer') {
        if (typeof command.value!=='string' || command.value.length>200) fail(400,'INVALID_ANSWER','모의 답변은200자 이내 문장이어야 합니다.');
        if (conversation.phase!=='awaiting_answer') {
          if (conversation.transcript===command.value && ['confirmation','awaiting_confirmation','deferred'].includes(conversation.phase)) return {conversation};
          fail(409,'DIALOGUE_STAGE','질문 안내 완료 후 모의 답변을 전달해 주세요.');
        }
        const draft=parseMockAnswer(command.value);
        const next={...conversation,transcript:command.value,draft,confirmed:false,phase:draft?'confirmation':'deferred'};
        if (draft) this.newPrompt(next,'confirmation',`${draft.destination ? draft.destination+' 방문' : '목적지 미확인'}, ${draft.detailedPurpose}${objectParticle(draft.detailedPurpose)} 위한 ${labels[draft.purpose]} 운행으로 기록할까요?`);
        this.saveConversation(next);
        return draft?{conversation:next}:this.finalize(this.activeTrip(connection.id),{reason:'unsupported-answer'});
      }
      if (command.type==='confirm') {
        const choices={yes:'yes',no:'no',later:'later','네':'yes','아니요':'no','나중에':'later'};
        const decision=Object.hasOwn(choices,command.value)?choices[command.value]:null;
        if (!decision) fail(400,'INVALID_CONFIRMATION','모의 확인·거절·보류 중 하나를 선택해 주세요.');
        if (decision==='later') {
          if (['driving','cancelled','confirmed'].includes(conversation.phase)) fail(409,'DIALOGUE_STAGE','이미 확정되었거나 운행 중인 대화에는 보류를 전달할 수 없습니다.');
          return this.finalize(this.activeTrip(connection.id),{reason:'later'});
        }
        if (conversation.phase!=='awaiting_confirmation' || !conversation.draft) fail(409,'DIALOGUE_STAGE','확인 안내가 완료된 초안에만 동의할 수 있습니다.');
        if (decision==='yes') return this.finalize(this.activeTrip(connection.id),{draft:conversation.draft,reason:'confirmed'});
        this.cancelPrompt(conversation);this.saveConversation({...conversation,phase:'cancelled',draft:null,confirmed:false});
        const trip=this.saveTrip({...this.activeTrip(connection.id),conversationId:randomUUID()});
        return {conversation:this.newConversation(connection,trip),trip};
      }
      if (command.type==='silence' || command.type==='failure') {
        if (['driving','confirmed','cancelled'].includes(conversation.phase)) fail(409,'DIALOGUE_STAGE','현재 단계에서는 무응답을 전달할 수 없습니다.');
        return this.finalize(this.activeTrip(connection.id),{reason:command.type});
      }
      fail(400,'INVALID_COMMAND','지원하지 않는 시연 명령입니다.');
    }));
  }
  claim({promptId,clientId}) {
    return this.store.transaction(()=> {
      const prompt=this.prompt(promptId);
      if (!prompt) fail(404,'PROMPT_NOT_FOUND','음성 안내를 찾을 수 없습니다.');
      const {conversation}=this.requireContext(prompt.connectionId,prompt.conversationId);
      if (conversation.promptId!==prompt.id || !['question','confirmation'].includes(conversation.phase) || prompt.status!=='pending') return {claimed:false,prompt};
      const claimed=this.savePrompt({...prompt,status:'claimed',claimedBy:clientId});return {claimed:true,prompt:claimed};
    });
  }
  complete(command) {
    return this.store.transaction(()=>this.once(command,()=> {
      const prompt=this.prompt(command.promptId);
      if (!prompt) fail(404,'PROMPT_NOT_FOUND','음성 안내를 찾을 수 없습니다.');
      const {conversation}=this.requireContext(prompt.connectionId,prompt.conversationId);
      if (prompt.claimedBy!==command.clientId || prompt.status!=='claimed' || conversation.promptId!==prompt.id || !['question','confirmation'].includes(conversation.phase)) fail(409,'STALE_PROMPT','취소되었거나 이미 처리한 음성 결과입니다.');
      if (!['played','failed'].includes(command.outcome)) fail(400,'INVALID_SPEECH_OUTCOME','음성 결과를 확인해 주세요.');
      this.savePrompt({...prompt,status:command.outcome});
      return command.outcome==='played'?{conversation:this.saveConversation({...conversation,phase:prompt.kind==='question'?'awaiting_answer':'awaiting_confirmation'})}:this.finalize(this.activeTrip(conversation.connectionId),{reason:'speech-failed'});
    }));
  }
  setUploadMode(vehicleId,blocked) {
    return this.store.transaction(()=> {
      this.store.requireVehicle(vehicleId);
      if (typeof blocked!=='boolean') fail(400,'INVALID_UPLOAD_MODE','업로드 차단 상태를 확인해 주세요.');
      this.db.prepare('INSERT INTO mvp_upload_modes VALUES(?,?) ON CONFLICT(vehicle_id) DO UPDATE SET blocked=excluded.blocked').run(vehicleId,blocked?1:0);
      if (!blocked) this.db.prepare("UPDATE mvp_uploads SET status='queued',attempts=0,last_error=NULL,next_attempt_at=0 WHERE vehicle_id=? AND status IN ('queued','paused')").run(vehicleId);
      return {vehicleId,blocked};
    });
  }
  failedUpload(row,status,message) {
    const attempts=row.attempts+1;
    this.db.prepare('UPDATE mvp_uploads SET status=?,attempts=?,last_error=?,next_attempt_at=? WHERE event_id=? AND status!=\'received\'')
      .run(status==='queued' && attempts>=5?'paused':status,attempts,message,this.now()+1500,row.event_id);
  }
  receive(event) {
    const eventId=event?.eventId;
    const row=typeof eventId==='string'?this.db.prepare('SELECT * FROM mvp_uploads WHERE event_id=?').get(eventId):null;
    if (!row) fail(400,'UNKNOWN_TRIP_EVENT','서버에 확인된 종료 운행의 이벤트만 수신할 수 있습니다.');
    const prepared=canonical(parse(row.body)),incoming=canonical(event);
    if (incoming!==prepared) {
      if (row.status!=='received') this.failedUpload(row,'conflict','준비된 운행 원본과 요청 내용이 다릅니다.');
      fail(409,'TRIP_EVENT_CONFLICT','같은 이벤트의 원본·직원·차량을 변경할 수 없습니다.');
    }
    const receipt=this.db.prepare('SELECT * FROM mvp_trip_receipts WHERE event_id=?').get(eventId);
    if (receipt) return parse(receipt.ack_json);
    if (['blocked','conflict','paused'].includes(row.status)) fail(409,'UPLOAD_HELD','확인이 필요한 전송을 보류했습니다. 원본 이벤트는 보존했습니다.');
    if (this.db.prepare('SELECT blocked FROM mvp_upload_modes WHERE vehicle_id=?').get(row.vehicle_id)?.blocked) {
      this.failedUpload(row,'queued','운행 업로드 차단 모의 상태입니다.');
      fail(503,'UPLOAD_BLOCKED','운행 업로드만 차단했습니다. 종료 기록은 전송 대기로 보관됩니다.');
    }
    try {
      return this.store.transaction(()=> {
        // Receipt and received trip are a single commit. Current connection may have changed.
        const existing=this.db.prepare('SELECT ack_json FROM mvp_trip_receipts WHERE event_id=?').get(eventId);
        if (existing) return parse(existing.ack_json);
        const original=this.trip(row.trip_id),connection=this.db.prepare('SELECT * FROM mvp_connections WHERE id=?').get(original?.connectionId);
        if (!original?.endedAt || !connection || connection.employee_id!==original.employeeId || connection.vehicle_id!==original.vehicleId || canonical(original)!==canonical(event.payload)) fail(409,'TRIP_ORIGIN_CONFLICT','원래 운행과 연결 정보를 확인할 수 없습니다.');
        const ack={eventId,tripId:row.trip_id,serverVersion:1},receivedAt=this.iso();
        this.db.prepare('INSERT INTO mvp_received_trips VALUES(?,?,?,?)').run(row.trip_id,eventId,json({...original,eventId,receivedAt,serverVersion:1}),receivedAt);
        this.db.prepare('INSERT INTO mvp_trip_receipts VALUES(?,?,?)').run(eventId,incoming,json(ack));
        this.db.prepare("UPDATE mvp_uploads SET status='received',last_error=NULL,next_attempt_at=0 WHERE event_id=?").run(eventId);
        return ack;
      });
    } catch (error) {
      if (error instanceof MvpError) this.failedUpload(row,error.status===409?'conflict':'blocked',error.message);
      else this.failedUpload(row,'queued','수신 저장에 실패했습니다. 종료 기록을 보존하고 재시도합니다.');
      throw error;
    }
  }
  state() {
    const rows=table=>this.db.prepare(`SELECT body_json FROM ${table} ORDER BY rowid`).all().map(row=>parse(row.body_json));
    return {
      demoId:this.db.prepare("SELECT value FROM mvp_workflow_meta WHERE key='demoId'").get().value,
      conversations:rows('mvp_conversations').map(value=>({...value,isCurrent:this.currentConversation(value.connectionId)?.id===value.id})),prompts:rows('mvp_prompts'),
      activeTrips:this.db.prepare("SELECT body_json FROM mvp_trips WHERE status='active' ORDER BY rowid").all().map(row=>parse(row.body_json)),
      pendingUploads:this.db.prepare('SELECT * FROM mvp_uploads ORDER BY rowid').all().map(row=>({eventId:row.event_id,tripId:row.trip_id,vehicleId:row.vehicle_id,body:row.body,status:row.status,attempts:row.attempts,lastError:row.last_error,nextAttemptAt:row.next_attempt_at,trip:parse(row.body).payload})),
      receivedTrips:rows('mvp_received_trips'),
      vehicleRuntime:this.db.prepare('SELECT vehicle_id FROM mvp_vehicle_runtime ORDER BY vehicle_id').all().map(row=>this.runtime(row.vehicle_id)),
      uploadBlockedVehicles:this.db.prepare('SELECT vehicle_id FROM mvp_upload_modes WHERE blocked=1').all().map(row=>row.vehicle_id),
    };
  }
}
