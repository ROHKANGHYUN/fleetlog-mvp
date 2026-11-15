import {DEMO_VEHICLE_ID, DEMO_DRIVER_ID, PURPOSES, validateTripEvent} from '../contracts/index.mjs';
import { validateSavedState } from './persistence.mjs';
const clone=v=>structuredClone(v);
const initial=()=>({schemaVersion:1,active:false,driving:false,screen:'ready',odometerM:12480000,current:null,editingTripId:null,draft:null,records:[],outbox:[],receipts:{},lastSavedTripId:null,lastError:null,online:true});
export class MemoryStorage {value=null;getItem(){return this.value;}setItem(_key,value){this.value=value;}removeItem(){this.value=null;}}
async function defaultSend(event){
  const r=await fetch('/api/trip-events',{method:'POST',headers:{'Content-Type':'application/json','X-FleetLog-Dev':'local-only'},body:JSON.stringify(event),signal:AbortSignal.timeout(10000)});
  let body;
  try { body=await r.json(); }
  catch { if(r.ok)throw Object.assign(new Error('서버 응답이 올바른 JSON이 아닙니다. 원인 확인이 필요합니다.'),{code:'INVALID_RESPONSE'}); }
  if(!r.ok)throw Object.assign(new Error(body?.error?.message??body?.message??`HTTP ${r.status}`),{status:r.status});
  return body;
}
export class FleetController {
  #state;#listeners=new Set();#storage;#key;#now;#id;#send;#busy=false;#persistedRaw=null;#inFlightEventId=null;#syncError=null;
  constructor({storage=globalThis.localStorage,key='fleetlog.mock.v1',now=()=>new Date().toISOString(),id=()=>crypto.randomUUID(),sendEvent=defaultSend}={}){
    this.#storage=storage??new MemoryStorage();this.#key=key;this.#now=now;this.#id=id;this.#send=sendEvent;
    let restored;const raw=this.#storage.getItem(key);
    if(raw){try{restored=validateSavedState(JSON.parse(raw));}catch{throw new Error('로컬 데이터 형식이 손상되었습니다. 기존 데이터를 보존한 뒤 개발 도구에서 복구하세요.');}}
    this.#state=restored??initial();this.#persistedRaw=raw;
    // Reload never resumes capture silently. A non-empty interrupted leg is preserved as a gap.
    if(restored&&(restored.active||restored.driving||restored.editingTripId||restored.draft)){
      this.#commit(s=>{if(s.current&&s.odometerM>s.current.startOdometerM){s.current.quality='gap';s.current.candidateEnd={endedAt:s.current.candidateEnd?.endedAt??s.current.lastObservedAt??s.current.startedAt,endOdometerM:s.odometerM};this.#close(s,false);}s.active=false;s.driving=false;s.current=null;s.editingTripId=null;s.draft=null;s.screen='ready';s.lastError='앱이 다시 열려 기록을 중단했습니다. 보관된 기록을 확인하고 직접 시작하세요.';});
    }
  }
  getState(){return {...clone(this.#state),syncing:this.#busy,inFlightEventId:this.#inFlightEventId,syncError:this.#syncError};}
  subscribe(fn){this.#listeners.add(fn);return()=>this.#listeners.delete(fn);}
  #emit(){for(const fn of this.#listeners)fn(this.getState());}
  #commit(fn){if(this.#storage.getItem(this.#key)!==this.#persistedRaw)throw new Error('다른 창에서 데이터가 변경되었습니다. 현재 창을 닫고 다시 여세요.');const next=clone(this.#state);fn(next);const raw=JSON.stringify(next);this.#storage.setItem(this.#key,raw);this.#persistedRaw=raw;this.#state=next;this.#emit();}
  #parked(s){if(s.driving)throw new Error('주차 후 입력할 수 있습니다.');}
  #newTrip(s){s.current={tripId:this.#id(),startedAt:this.#now(),lastObservedAt:this.#now(),startOdometerM:s.odometerM,quality:'valid'};}
  start(){this.#commit(s=>{this.#parked(s);if(s.active)throw new Error('이미 기록 중입니다.');s.active=true;this.#newTrip(s);s.screen='collecting';s.lastError=null;});}
  setDriving(value){this.#commit(s=>{if(s.driving===value)return;s.driving=value;s.editingTripId=null;s.draft=null;if(value&&s.active){if(!s.current)this.#newTrip(s);delete s.current.candidateEnd;s.odometerM+=23400;s.current.lastObservedAt=this.#now();}s.screen=s.active?'collecting':'ready';});}
  finish(){this.#commit(s=>{this.#parked(s);if(!s.active||!s.current||s.odometerM<=s.current.startOdometerM)throw new Error('수집된 운행이 없습니다.');s.current.candidateEnd={endedAt:this.#now(),endOdometerM:s.odometerM};s.editingTripId=null;s.draft={purpose:null,note:''};s.screen='purpose';});}
  continueDriving(){this.#commit(s=>{this.#parked(s);s.screen=s.editingTripId?'pending':s.active?'collecting':'ready';s.editingTripId=null;s.draft=null;if(s.current)delete s.current.candidateEnd;});}
  setPurpose(purpose,note=''){this.#commit(s=>{this.#parked(s);if(!s.draft||!['purpose','review'].includes(s.screen))throw new Error('입력 중인 운행이 없습니다.');if(purpose!==null&&!PURPOSES.includes(purpose))throw new Error('지원하지 않는 용도입니다.');if(typeof note!=='string'||note.length>120)throw new Error('메모는 120자까지 입력하세요.');s.draft={purpose,note};s.screen='purpose';});}
  review(){this.#commit(s=>{this.#parked(s);if(!s.draft?.purpose)throw new Error('운행 용도를 선택하세요.');s.screen='review';});}
  #close(s,confirmed){
    const existing=s.editingTripId?s.records.find(r=>r.tripId===s.editingTripId):null;
    if(!existing&&!s.current)throw new Error('대상 운행이 없습니다.');
    if(!existing&&s.odometerM<=s.current.startOdometerM)throw new Error('수집된 운행이 없습니다.');
    const tripId=existing?.tripId??s.current.tripId;
    const payload=existing?clone(existing.payload):{vehicleId:DEMO_VEHICLE_ID,driverId:DEMO_DRIVER_ID,startedAt:s.current.startedAt,endedAt:s.current.candidateEnd?.endedAt??this.#now(),startOdometerM:s.current.startOdometerM,endOdometerM:s.current.candidateEnd?.endOdometerM??s.odometerM,purpose:null,note:'',quality:s.current.quality};
    payload.purpose=confirmed?s.draft?.purpose:null;payload.note=confirmed?s.draft?.note??'':'';
    if(confirmed&&!payload.purpose)throw new Error('확인할 용도가 없습니다.');
    const localRevision=(existing?.localRevision??0)+1;
    const eventId=this.#id();const predecessor=[...s.outbox].reverse().find(e=>e.tripId===tripId);
    const record={tripId,localRevision,ackedLocalRevision:existing?.ackedLocalRevision??0,serverVersion:existing?.serverVersion??0,payload};
    const event={eventId,tripId,localRevision,baseServerVersion:record.serverVersion,predecessorEventId:predecessor?.eventId??null,payload:clone(payload),preparedEvent:null,status:'queued',attempts:0};
    validateTripEvent({schemaVersion:1,eventType:'TRIP_UPSERT',eventId,tripId,localRevision,expectedServerVersion:record.serverVersion,source:'mock',payload});
    if(existing)s.records[s.records.indexOf(existing)]=record;else s.records.push(record);
    s.outbox.push(event);if(!existing)s.current=null;s.editingTripId=null;s.draft=null;s.lastSavedTripId=tripId;s.screen='saved';s.lastError=null;
  }
  save(){this.#commit(s=>{this.#parked(s);if(s.screen!=='review')throw new Error('요약을 확인한 뒤 저장하세요.');this.#close(s,true);});}
  defer(){this.#commit(s=>{this.#parked(s);if(!s.draft)throw new Error('입력 중인 운행이 없습니다.');this.#close(s,false);});}
  stop(){this.#commit(s=>{this.#parked(s);if(!s.active)throw new Error('기록이 시작되지 않았습니다.');s.editingTripId=null;s.draft=null;if(s.current&&s.odometerM>s.current.startOdometerM)this.#close(s,false);s.active=false;s.current=null;s.screen='ready';});}
  editTrip(id){this.#commit(s=>{this.#parked(s);if(s.current&&s.odometerM>s.current.startOdometerM)throw new Error('현재 운행을 먼저 마쳐 주세요.');const r=s.records.find(x=>x.tripId===id);if(!r)throw new Error('운행이 없습니다.');if(s.outbox.some(e=>e.tripId===id&&['conflict','blocked'].includes(e.status)))throw new Error('충돌 또는 전송 오류의 원인을 먼저 확인해야 합니다.');s.editingTripId=id;s.draft={purpose:r.payload.purpose,note:r.payload.note};s.screen='purpose';});}
  showPending(){this.#commit(s=>{this.#parked(s);s.screen='pending';s.editingTripId=null;s.draft=null;});}
  home(){this.continueDriving();}
  setOnline(value){this.#commit(s=>{s.online=value;});}
  resetLocal(){if(this.#busy)throw new Error('전송 중에는 초기화할 수 없습니다.');this.#commit(s=>{this.#parked(s);Object.assign(s,initial());});}
  async sync(){
    if(this.#busy||!this.#state.online)return;
    this.#busy=true;this.#syncError=null;this.#emit();
    try{
      const attempted=new Set();
      while(this.#state.online){
        const item=this.#state.outbox.find(e=>e.status==='queued'&&!attempted.has(e.eventId)&&(!e.predecessorEventId||this.#state.receipts[e.predecessorEventId]));
        if(!item)break;attempted.add(item.eventId);
        // Persist the exact envelope BEFORE dispatch. A storage failure sends nothing.
        this.#commit(s=>{const e=s.outbox.find(x=>x.eventId===item.eventId);if(!e.preparedEvent){const expected=e.predecessorEventId?s.receipts[e.predecessorEventId].serverVersion:e.baseServerVersion;e.preparedEvent={schemaVersion:1,eventType:'TRIP_UPSERT',eventId:e.eventId,tripId:e.tripId,localRevision:e.localRevision,expectedServerVersion:expected,source:'mock',payload:clone(e.payload)};}e.attempts++;});
        const prepared=clone(this.#state.outbox.find(e=>e.eventId===item.eventId).preparedEvent);
        this.#inFlightEventId=item.eventId;this.#emit();
        let ack;
        try{
          ack=await this.#send(prepared);
          if(!ack||ack.eventId!==prepared.eventId||ack.ackedLocalRevision!==prepared.localRevision||!Number.isSafeInteger(ack.serverVersion)||ack.serverVersion!==prepared.expectedServerVersion+1)
            throw Object.assign(new Error('서버 응답의 이벤트와 버전이 맞지 않습니다. 확인 후 동일 이벤트로 재시도하세요.'),{code:'INVALID_ACK'});
        }catch(err){
          this.#inFlightEventId=null;
          const status=err?.status;
          const kind=status===409?'conflict':err?.code==='INVALID_RESPONSE'||(status>=400&&status<500&&![408,429].includes(status))?'blocked':err?.code==='INVALID_ACK'?'ack':'transient';
          this.#commit(s=>{const e=s.outbox.find(x=>x.eventId===item.eventId);if(!e)return;e.lastError=String(err?.message??err);e.failureKind=kind;if(kind==='conflict'||kind==='blocked')e.status=kind;s.lastError=e.lastError;});
          continue; // Other trips can proceed; dependents require the actual receipt.
        }
        // ACK validation is not delivery completion until this commit succeeds.
        // Keep storage failures OUTSIDE the transport catch: no fake receipt/error overwrite.
        this.#commit(s=>{s.receipts[ack.eventId]=ack;s.outbox=s.outbox.filter(e=>e.eventId!==ack.eventId);const r=s.records.find(x=>x.tripId===item.tripId);r.ackedLocalRevision=Math.max(r.ackedLocalRevision,ack.ackedLocalRevision);r.serverVersion=Math.max(r.serverVersion,ack.serverVersion);s.lastError=null;});
        this.#inFlightEventId=null;this.#emit();
      }
    }catch(error){
      this.#syncError='전송 상태를 이 기기에 저장하지 못했습니다. 기록과 전송 대기열을 보존했습니다. 저장 공간과 다른 탭의 변경을 확인한 뒤 다시 시도하세요.';
      throw error;
    }finally{this.#inFlightEventId=null;this.#busy=false;this.#emit();}
  }
}
