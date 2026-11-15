export const DEMO_VEHICLE_ID = 'demo-car-001';
export const DEMO_DRIVER_ID = 'demo-driver-001';
export const PURPOSES = Object.freeze(['business', 'commute', 'personal']);
export const PURPOSE_LABELS = Object.freeze({business:'일반 업무', commute:'출퇴근', personal:'사적 이용'});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
function exactKeys(obj, keys, label){if(!plain(obj)||Object.keys(obj).some(k=>!keys.includes(k))||keys.some(k=>!(k in obj)))throw new Error(`${label}: 필드 구성이 올바르지 않습니다`);}
function iso(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
export function validateTripEvent(e){
  exactKeys(e,['schemaVersion','eventType','eventId','tripId','localRevision','expectedServerVersion','source','payload'],'event');
  if(e.schemaVersion!==1||e.eventType!=='TRIP_UPSERT'||e.source!=='mock')throw new Error('이 starter는 schemaVersion 1 mock 이벤트만 받습니다');
  if(!uuid.test(e.eventId)||!uuid.test(e.tripId))throw new Error('eventId와 tripId는 UUID여야 합니다');
  if(!integer(e.localRevision,1)||!integer(e.expectedServerVersion))throw new Error('버전은 유효한 정수여야 합니다');
  const p=e.payload;exactKeys(p,['vehicleId','driverId','startedAt','endedAt','startOdometerM','endOdometerM','purpose','note','quality'],'payload');
  if(p.vehicleId!==DEMO_VEHICLE_ID||p.driverId!==DEMO_DRIVER_ID)throw new Error('데모 회사의 등록된 차량과 운전자만 허용합니다');
  if(!iso(p.startedAt)||!iso(p.endedAt)||Date.parse(p.endedAt)<Date.parse(p.startedAt))throw new Error('운행 시작과 종료 시각을 확인하세요');
  if(!integer(p.startOdometerM)||!integer(p.endOdometerM)||p.endOdometerM<p.startOdometerM)throw new Error('거리 값은 역행하지 않는 정수 m여야 합니다');
  if(p.purpose!==null&&!PURPOSES.includes(p.purpose))throw new Error('운행 목적을 확인하세요');
  if(typeof p.note!=='string'||p.note.length>120)throw new Error('메모는 120자 이하여야 합니다');
  if(!['valid','gap'].includes(p.quality))throw new Error('거리 품질을 확인하세요');
  return e;
}
export function canonicalJson(value){
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(plain(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
