import { useEffect, useRef, useState } from 'react';
import type { Purpose, ReceivedTrip, ServerState } from './workflow-types';
import { ReportingError, reportTime, reportingRequest, requestId } from './reporting-client';

const purposeLabels = { business: '일반 업무', commute: '출퇴근', personal: '개인 용도' };
const label = (purpose: Purpose | null) => purpose ? purposeLabels[purpose] : '미확정';

export function AmendmentHistory({ trip, state }: { trip: ReceivedTrip; state: ServerState }) {
  const history = trip.amendmentHistory ?? [];
  return <div className="mvp-amendment-history"><h4>용도 보완 이력</h4>
    <p className="mvp-muted">최초 수신 버전 {trip.serverVersion} · 보완 버전 {trip.amendmentVersion ?? 0}. 원본 시각·거리·품질은 변경하지 않습니다.</p>
    {history.length === 0 ? <p>보완 이력이 없습니다.</p> : <ol>{history.map(change => <li key={change.requestId}>
      <strong>보완 {change.version} · {state.employees.find(person => person.id === change.employeeId)?.name ?? change.employeeId}</strong>
      <p>{reportTime(change.changedAt)}</p><p>변경 전: {label(change.before.purpose)} · {change.before.destination || '목적지 미확정'} · {change.before.detailedPurpose || '상세 목적 미확정'}</p>
      <p>변경 후: {label(change.after.purpose)} · {change.after.destination || '목적지 미확정'} · {change.after.detailedPurpose || '상세 목적 미확정'}</p>
    </li>)}</ol>}
  </div>;
}

export function AmendmentEditor({ trip, employeeId, state, stale, onSaved }: { trip: ReceivedTrip; employeeId: string; state: ServerState; stale: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false), [review, setReview] = useState(false);
  const [purpose, setPurpose] = useState<Purpose | ''>('');
  const [destination, setDestination] = useState(trip.destination ?? ''), [detail, setDetail] = useState(trip.detailedPurpose ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [conflict, setConflict] = useState(false);
  const expectedVersion = useRef(trip.amendmentVersion ?? 0), operation = useRef<AbortController | null>(null), epoch = useRef(0), guard = useRef(false);
  const prepared = useRef<{ signature: string; body: Record<string, unknown> } | null>(null);
  const connected = state.vehicles.find(vehicle => vehicle.connection?.employeeId === employeeId);
  const parking = connected ? state.vehicleRuntime.find(runtime => runtime.vehicleId === connected.id)?.parking : undefined;
  const parkingBlocked = !!connected && parking !== 'parked';
  useEffect(() => () => { epoch.current++; operation.current?.abort(); }, []);
  useEffect(() => {
    if (parkingBlocked) { epoch.current++; operation.current?.abort(); operation.current = null;guard.current = false;setBusy(false); }
  }, [parkingBlocked]);
  function edit() {
    expectedVersion.current = trip.amendmentVersion ?? 0;prepared.current = null;
    setPurpose(trip.purpose ?? '');setDestination(trip.destination ?? '');setDetail(trip.detailedPurpose ?? '');
    setError('');setSaved(false);setConflict(false);setReview(false);setOpen(true);
  }
  async function save() {
    if (!purpose || guard.current || stale || parkingBlocked || conflict) return;
    const values = { employeeId, expectedAmendmentVersion: expectedVersion.current, purpose, destination, detailedPurpose: detail };
    const signature = JSON.stringify(values);
    if (prepared.current?.signature !== signature) prepared.current = { signature, body: { requestId: requestId(), ...values } };
    guard.current = true;setBusy(true);setError('');const generation = ++epoch.current;
    const abort = new AbortController();operation.current = abort;
    try {
      await reportingRequest(`/mvp-api/trips/${encodeURIComponent(trip.id)}/amendments`, prepared.current.body, abort.signal);
      if (generation === epoch.current) { setSaved(true);setOpen(false);onSaved(); }
    } catch (cause) {
      if (generation === epoch.current && !abort.signal.aborted) {
        setError(cause instanceof Error ? cause.message : '보완을 저장하지 못했습니다. 입력은 유지했습니다.');
        if (cause instanceof ReportingError && ['AMENDMENT_VERSION_CONFLICT', 'PURPOSE_ALREADY_CONFIRMED', 'REQUEST_CONFLICT'].includes(cause.code)) { setConflict(true);onSaved(); }
      }
    } finally { if (generation === epoch.current) { guard.current = false;setBusy(false);operation.current = null; } }
  }
  const editable = !trip.purposeConfirmed && !(trip.amendmentVersion > 0);
  if (!open) return <div className="mvp-amendment-entry">
    {saved && <p className="notice success" role="status">용도 보완을 서버에 저장했습니다.</p>}
    {editable && <><p className="mvp-muted">서버가 수신한 본인 기록의 용도를 보완합니다. 차량 연결 해제 후에도 가능합니다.</p>
      <button className="button secondary" disabled={stale || parkingBlocked} onClick={edit}>용도 보완</button>
      {parkingBlocked && <p className="notice warning">주차 확인 후 용도를 보완해 주세요.</p>}</>}
  </div>;
  return <section className="mvp-amendment-editor" aria-label="운행 용도 보완">
    <h4>{review ? '보완 내용 확인' : '운행 용도 보완'}</h4>
    <p className="mvp-muted">데모 계정의 명시적 확인입니다. 실제 인증·관리자 승인·세무신고가 아닙니다.</p>
    {parkingBlocked && <p className="notice warning" role="alert">주차 상태를 확인해야 입력할 수 있습니다. 작성 중인 내용은 유지했습니다.</p>}
    {error && <div className="notice error" role="alert"><p>{error}</p><p>입력은 유지했습니다. {conflict ? '다른 보완 또는 상태 변경을 확인한 뒤 다시 열어 주세요.' : '같은 내용으로 다시 저장할 수 있습니다.'}</p></div>}
    {review ? <dl className="mvp-facts"><dt>용도</dt><dd>{purpose ? purposeLabels[purpose] : '선택 필요'}</dd><dt>목적지</dt><dd>{destination || '미입력'}</dd><dt>상세 목적</dt><dd>{detail || '미입력'}</dd></dl>
      : <div className="mvp-edit-fields"><label className="mvp-field">운행 용도<select value={purpose} disabled={busy || parkingBlocked} onChange={event => setPurpose(event.target.value as Purpose | '')}><option value="">선택해 주세요</option>{Object.entries(purposeLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <label className="mvp-field">목적지<input value={destination} maxLength={200} disabled={busy || parkingBlocked} onChange={event => setDestination(event.target.value)} /></label>
        <label className="mvp-field">상세 목적<textarea value={detail} maxLength={200} rows={3} disabled={busy || parkingBlocked} onChange={event => setDetail(event.target.value)} /></label></div>}
    <div className="mvp-command-actions">{review ? <><button className="button primary" disabled={busy || stale || parkingBlocked || conflict} onClick={() => void save()}>{busy ? '서버 저장 중…' : '확인하고 보완 저장'}</button><button className="button secondary" disabled={busy} onClick={() => setReview(false)}>보완 내용 수정</button></>
      : <button className="button primary" disabled={!purpose || busy || stale || parkingBlocked || conflict} onClick={() => setReview(true)}>보완 내용 확인</button>}
      <button className="button secondary" disabled={busy} onClick={() => { epoch.current++;operation.current?.abort();setOpen(false);setError(''); }}>보완 닫기</button></div>
  </section>;
}
