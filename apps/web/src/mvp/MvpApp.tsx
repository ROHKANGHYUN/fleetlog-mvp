import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RuntimeControl } from './RuntimeControl';
import { VehicleScreen } from './VehicleScreen';
import { AmendmentEditor, AmendmentHistory } from './AmendmentEditor';
import { MonthEndControl, MonthlyReports } from './MonthlyReports';
import { koreanDate } from './reporting-client';
import type { Connection, Conversation, PendingUpload, Purpose, Qr, ReceivedTrip, ServerState, Trip, Vehicle } from './workflow-types';
import './mvp.css';

type Lookup = { vehicle: Vehicle; status: 'available' | 'connected'; expiresAt: string; connection?: Connection };
type Bundle = { state: ServerState; qr?: Qr; lookup?: Lookup; lookupError?: string };
const EMPLOYEE_KEY = 'chagok.mvp.demoEmployeeId';
const POLL_MS = 1000;

class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => { throw new RequestError('서버 응답을 확인하지 못했습니다.', response.status); });
  if (!response.ok) throw new RequestError(result?.error?.message ?? '요청을 처리하지 못했습니다.', response.status);
  return result;
}

/** Single in-flight poll, cancelled on refresh/unmount; an old response cannot replace a new cycle. */
function useServer(load: (signal: AbortSignal) => Promise<Bundle>) {
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ data: Bundle | null; error: string; lastSuccess: string }>({ data: null, error: '', lastSuccess: '' });
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function poll() {
      try {
        const data = await load(abort.signal);
        if (alive) setSnapshot({ data, error: '', lastSuccess: new Date().toISOString() });
      } catch (error) {
        if (alive && !abort.signal.aborted) setSnapshot(previous => ({ ...previous,
          error: error instanceof Error ? error.message : '서버 연결을 확인해 주세요.' }));
      } finally { if (alive) timer = setTimeout(() => void poll(), POLL_MS); }
    }
    void poll();
    return () => { alive = false; abort.abort(); clearTimeout(timer); };
  }, [load, version]);
  return { ...snapshot, refresh: () => setVersion(previous => previous + 1) };
}

const timeLabel = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Seoul' }).format(new Date(value)) : '확인 필요';
const localOnlyUrl = (value: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
const activeForEmployee = (state: ServerState, employeeId: string) => state.vehicles.find(vehicle => vehicle.connection?.employeeId === employeeId);
// Demo account preference follows a newly opened QR tab; connection state is never stored here.
function storedEmployee() { try { return localStorage.getItem(EMPLOYEE_KEY) ?? ''; } catch { return ''; } }

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mvp-shell"><header className="mvp-header">
    <a className="brand" href="/mvp/control"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Fleetlog</span></a>
    <span className="badge neutral">MVP · 가상 데이터</span>
  </header><main className="mvp-main"><div className="mvp-heading"><p className="eyebrow">차량 연결과 모의 운행</p><h1>{title}</h1></div>{children}</main>
    <footer className="mvp-footer">가상 운행·모의 발화 시연입니다. 음성 합성은 지원 브라우저의 시연 패널에서 요청합니다. 실제 인증·음성인식·Pleos SDK는 연결하지 않았습니다.</footer></div>;
}

function QueryStatus({ error, loaded, lastSuccess }: { error: string; loaded: boolean; lastSuccess: string }) {
  if (error) return <div className="notice error mvp-query-error" role="alert"><strong>서버 상태를 조회하지 못했습니다</strong>
    <p>{error}</p><p>{loaded ? '이전 조회값을 표시합니다. 현재 연결 여부는 확인 중입니다.' : '미연결 상태로 판단하지 않습니다.'}</p>
    {lastSuccess && <small>마지막 성공 조회: {timeLabel(lastSuccess)}</small>}</div>;
  if (!loaded) return <p className="notice neutral" role="status">서버의 연결 상태를 확인하고 있습니다.</p>;
  return <p className="mvp-update" role="status">서버 상태 자동 갱신 · 마지막 확인 {timeLabel(lastSuccess)}</p>;
}

export default function MvpApp() {
  const path = window.location.pathname.replace(/\/$/, '');
  const kind = path === '/mvp/car' ? 'car' : path === '/mvp/driver' ? 'driver' : path === '/mvp/admin' ? 'admin' : path === '/mvp/control' || path === '/mvp' ? 'control' : 'unknown';
  const params = new URLSearchParams(window.location.search);
  const vehicleId = params.get('vehicleId') ?? 'mvp-vehicle-001';
  const token = params.get('token') ?? '';
  const code = params.get('code') ?? '';
  const load = useCallback(async (signal: AbortSignal): Promise<Bundle> => {
    const state = await request<ServerState>('/mvp-api/state', signal);
    if (kind === 'car' || kind === 'control') {
      const qr = await request<Qr>(`/mvp-api/vehicles/${encodeURIComponent(vehicleId)}/qr`, signal);
      return { state, qr };
    }
    if (kind === 'driver' && (token || code)) {
      const path = token ? `/mvp-api/qr/${encodeURIComponent(token)}` : `/mvp-api/codes/${encodeURIComponent(code)}`;
      try { return { state, lookup: await request<Lookup>(path, signal) }; }
      catch (error) {
        if (error instanceof RequestError && error.status < 500) return { state, lookupError: error.message };
        throw error;
      }
    }
    return { state };
  }, [kind, vehicleId, token, code]);
  const query = useServer(load);
  const state = query.data?.state;
  const qr = query.data?.qr;
  if (kind === 'car') return <VehicleScreen state={state} vehicleId={vehicleId} qr={qr} error={query.error} onRefresh={query.refresh} />;
  if (kind === 'unknown') return <Shell title="화면을 찾지 못했습니다"><a className="button secondary" href="/mvp/control">시연 패널로 이동</a></Shell>;
  return <Shell title={kind === 'driver' ? '운전자 모바일웹' : kind === 'admin' ? 'Fleetlog 비즈 · 연결 현황' : 'MVP 시연 패널'}>
    <QueryStatus error={query.error} loaded={!!state} lastSuccess={query.lastSuccess} />
    {state && (kind === 'driver' ? <Driver state={state} lookup={query.data?.lookup} lookupError={query.data?.lookupError} token={token} code={code} stale={!!query.error} refresh={query.refresh} />
      : kind === 'admin' ? <Admin state={state} stale={!!query.error} /> : <Control state={state} vehicleId={vehicleId} qr={qr} stale={!!query.error} refresh={query.refresh} />)}
  </Shell>;
}

function Driver({ state, lookup, lookupError, token, code, stale, refresh }: { state: ServerState; lookup?: Lookup; lookupError?: string; token: string; code: string; stale: boolean; refresh: () => void }) {
  const [employeeId, setEmployeeId] = useState(storedEmployee);
  const [codeInput, setCodeInput] = useState(code);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const epoch = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const employee = state.employees.find(person => person.id === employeeId);
  const vehicle = employee ? activeForEmployee(state, employee.id) : undefined;
  const connection = vehicle?.connection;
  const activeTrip = (state.activeTrips ?? []).find(trip => trip.employeeId === employee?.id);
  useEffect(() => () => { epoch.current++; operation.current?.abort(); }, []);
  function choose(id: string) {
    epoch.current++; operation.current?.abort(); operation.current = null;
    setEmployeeId(id); setBusy(false); setActionError('');
    try { localStorage.setItem(EMPLOYEE_KEY, id); } catch { /* Optional demo preference only; connections are always read from the server. */ }
  }
  async function act(path: string, body: unknown) {
    if (busy) return;
    const current = ++epoch.current;
    operation.current?.abort(); const abort = new AbortController(); operation.current = abort;
    setBusy(true); setActionError('');
    try { await request(path, abort.signal, body); if (epoch.current === current) refresh(); }
    catch (error) { if (epoch.current === current && !abort.signal.aborted) { setActionError(error instanceof Error ? error.message : '요청 결과를 확인하지 못했습니다.'); refresh(); } }
    finally { if (epoch.current === current) setBusy(false); }
  }
  const targetUsed = lookup?.status === 'connected';
  return <div className="mvp-driver">
    <section className="mvp-card"><h2>데모 계정 선택</h2><p>가상 직원으로 화면 연결을 체험합니다. 실제 로그인이 아닙니다.</p>
      <label className="mvp-field">데모 계정 선택<select value={employee?.id ?? ''} onChange={event => choose(event.target.value)}>
        <option value="">가상 직원을 선택해 주세요</option>{state.employees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select></label>
      {employee && <dl className="mvp-facts"><dt>직원</dt><dd>{employee.name}</dd><dt>회사</dt><dd>{state.company.name}</dd><dt>부서</dt><dd>{employee.department}</dd><dt>직책</dt><dd>{employee.title}</dd></dl>}
    </section>
    <section className="mvp-card" aria-label="연결 코드 입력"><h2>연결 코드로 차량 확인</h2><p>QR을 열기 어렵다면 차량 화면의 코드를 입력해 주세요.</p>
      <form className="mvp-code-form" onSubmit={event => { event.preventDefault();const entered = codeInput.trim().toUpperCase().replace(/\s/g, '');if (entered) window.location.href = `/mvp/driver?code=${encodeURIComponent(entered)}`; }}>
        <label className="mvp-field">연결 코드<input value={codeInput} onChange={event => setCodeInput(event.target.value)} placeholder="차량 화면의 코드" autoCapitalize="characters" autoComplete="off" maxLength={20} /></label>
        <button className="button secondary" disabled={stale || !codeInput.trim()} type="submit">코드 확인</button>
      </form></section>
    {actionError && <div className="notice error" role="alert"><strong>요청을 완료하지 못했습니다</strong><p>{actionError}</p><p>서버의 연결 상태를 다시 확인합니다. 기록을 임의로 덮어쓰지 않습니다.</p></div>}
    {employee && connection && vehicle ? <section className="mvp-card mvp-current-connection" aria-label="현재 차량 연결" data-connection-id={connection.id}>
      <span className="badge success">{stale ? '이전 조회의 연결 정보' : '서버 연결 확인'}</span><h2>{vehicle.name}</h2><p>{vehicle.plate}</p>
      <dl className="mvp-facts"><dt>직원</dt><dd>{employee.name}</dd><dt>연결 시각</dt><dd>{timeLabel(connection.connectedAt)}</dd></dl>
      {activeTrip && <p className="notice warning" role="status">아직 마치지 않은 운행이 있습니다. 주차 후 차량 화면에서 ‘운행 마치기’ 또는 ‘기록 종료’를 진행해 주세요.</p>}
      <button className="button secondary" disabled={busy || stale || !!activeTrip} onClick={() => void act(`/mvp-api/connections/${encodeURIComponent(connection.id)}/disconnect`, { employeeId: employee.id })}>{busy ? '서버 처리 중…' : '연결 해제'}</button>
    </section> : <section className="mvp-card" aria-label="차량 연결 확인"><h2>QR 차량 확인</h2>
      {!token && !code ? <p>차량 화면의 QR을 휴대폰 기본 카메라로 열거나 연결 코드를 입력해 주세요.</p>
        : lookupError ? <div className="notice warning" role="alert"><strong>QR·연결 코드를 사용할 수 없습니다</strong><p>{lookupError}</p><p>차량 화면의 새 QR 또는 연결 코드를 확인해 주세요.</p></div>
        : lookup ? <><h3>{lookup.vehicle.name}</h3><p>{lookup.vehicle.plate}</p><p>{state.company.name} 소속 · 가상 차량</p>
          {targetUsed ? <div className="notice warning" role="alert">이미 사용 중인 차량입니다. 기존 연결을 덮어쓰지 않습니다.</div>
            : <><p>이 차량이 맞는지 확인한 뒤 연결해 주세요.</p><p className="mvp-muted">QR 만료: {timeLabel(lookup.expiresAt)}</p>
              {!employee && <p className="mvp-muted">위에서 데모 계정을 선택하면 이 차량의 연결을 이어갑니다.</p>}
              <button className="button primary" disabled={!employee || busy || stale} onClick={() => employee && void act('/mvp-api/connections', { ...(token ? { token } : { code }), employeeId: employee.id })}>{busy ? '서버 처리 중…' : '이 차량에 연결'}</button></>}
        </> : <p>QR의 서버 상태를 확인하고 있습니다.</p>}
    </section>}
    {employee && <EmployeeTrips key={employee.id} state={state} employeeId={employee.id} stale={stale} refresh={refresh} />}
  </div>;
}

const purposeLabels: Record<Purpose, string> = { business: '일반 업무', commute: '출퇴근', personal: '개인 용도' };
const purposeLabel = (purpose: Purpose | null) => purpose ? purposeLabels[purpose] : '용도 미확정';
function validDistance(trip: Trip) {
  return trip.quality === 'complete' && !trip.hasGap && trip.distanceM !== null && Number.isFinite(trip.distanceM) && trip.distanceM >= 0;
}
function tripDistance(trip: Trip, active = false) {
  if (active && trip.hasGap) return '거리 확인 필요';
  if (validDistance(trip)) return `${(trip.distanceM! / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 3 })} km${active ? ' · 관측값' : ''}`;
  return active && trip.distanceM === null ? '거리 관측 대기' : '거리 확인 필요';
}
const uploadProblem = (upload: PendingUpload) => ['paused', 'blocked', 'conflict'].includes(upload.status) || !!upload.lastError;
function uploadLabel(upload: PendingUpload) {
  if (upload.status === 'conflict') return '전송 충돌 · 확인 필요';
  if (upload.status === 'blocked') return '전송 보류 · 확인 필요';
  if (upload.status === 'paused') return '재시도 중지 · 확인 필요';
  return upload.lastError ? '전송 대기 · 일시 오류' : '전송 대기';
}

function TripCard({ trip, state, delivery, upload, stale, showEmployee = false, children }:
  { trip: Trip; state: ServerState; delivery: 'active' | 'pending' | 'received'; upload?: PendingUpload; stale: boolean; showEmployee?: boolean; children?: ReactNode }) {
  const person = state.employees.find(employee => employee.id === trip.employeeId);
  const vehicle = state.vehicles.find(item => item.id === trip.vehicleId);
  const active = delivery === 'active';
  return <article className="mvp-card mvp-trip-card" id={`mvp-trip-${trip.id}`} data-trip-id={trip.id} data-employee-id={trip.employeeId} data-delivery={delivery}>
    <div className="mvp-trip-badges"><span className={`badge ${delivery === 'received' ? 'success' : 'warning'}`}>
      {stale ? '이전 조회값' : active ? '수집 구간 · 미완료' : delivery === 'received' ? '서버 수신 완료' : upload ? uploadLabel(upload) : '전송 대기'}</span>
      {!trip.purposeConfirmed && <span className="badge warning">용도 미확정 · 확인 필요</span>}
      {!active && !validDistance(trip) && <span className="badge warning">불완전 기록 · 거리 확인 필요</span>}
      <span className="badge neutral">모의 운행</span></div>
    <h3>{trip.destination || '목적지 미확정'}</h3>
    <p>{purposeLabel(trip.purpose)} · {trip.detailedPurpose || '상세 목적 미확정'}</p>
    <dl className="mvp-facts">
      {showEmployee && <><dt>직원</dt><dd>{person?.name ?? '직원 확인 필요'} · {person?.department ?? '부서 확인 필요'}</dd></>}
      <dt>차량</dt><dd>{vehicle?.name ?? trip.vehicleId} · {vehicle?.plate ?? '차량번호 확인 필요'}</dd>
      <dt>출발</dt><dd>{timeLabel(trip.startedAt)}</dd><dt>종료</dt><dd>{active ? '운행 마치기 전' : timeLabel(trip.endedAt)}</dd>
      <dt>운행 거리</dt><dd>{tripDistance(trip, active)}</dd>
    </dl>
    {upload?.lastError && <p className="mvp-muted">{upload.lastError}</p>}
    {delivery === 'received' && <details className="mvp-trip-detail"><summary>운행 상세</summary><dl className="mvp-facts">
      <dt>운행 ID</dt><dd>{trip.id}</dd><dt>원래 직원</dt><dd>{person?.name ?? trip.employeeId} · {person?.department ?? '부서 확인 필요'}</dd>
      <dt>회사·연결 ID</dt><dd>{trip.companyId} · {trip.connectionId}</dd><dt>시작 누적거리</dt><dd>{trip.startOdometerM.toLocaleString('ko-KR')} m · 모의 값</dd>
      <dt>종료 누적거리</dt><dd>{trip.endOdometerM === null ? '확인 필요' : `${trip.endOdometerM.toLocaleString('ko-KR')} m · 모의 값`}</dd><dt>거리 품질</dt><dd>{validDistance(trip) ? '유효한 모의 관측' : '불완전 · 거리 확인 필요'}</dd>
      <dt>서버 반영</dt><dd>{timeLabel((trip as ReceivedTrip).receivedAt)} · 최초 수신 버전 {(trip as ReceivedTrip).serverVersion}</dd>
    </dl><AmendmentHistory trip={trip as ReceivedTrip} state={state} /></details>}
    {children}
  </article>;
}

function EmployeeTrips({ state, employeeId, stale, refresh }: { state: ServerState; employeeId: string; stale: boolean; refresh: () => void }) {
  const active = (state.activeTrips ?? []).filter(trip => trip.employeeId === employeeId);
  const pending = (state.pendingUploads ?? []).filter(upload => upload.status !== 'received' && upload.trip.employeeId === employeeId);
  const received = (state.receivedTrips ?? []).filter(trip => trip.employeeId === employeeId);
  return <section className="mvp-section mvp-trip-section" aria-label="직원 운행 내역"><h2>내 모의 운행</h2>
    <p className="mvp-muted">선택한 데모 직원의 기록입니다. 다른 직원의 기록은 표시하지 않습니다.</p>
    {active.length + pending.length + received.length === 0 ? <div className="mvp-card"><p>아직 이 직원의 모의 운행이 없습니다.</p></div>
      : <div className="mvp-trip-list">{active.map(trip => <TripCard key={trip.id} trip={trip} state={state} delivery="active" stale={stale} />)}
        {pending.map(upload => <TripCard key={upload.tripId} trip={upload.trip} state={state} delivery="pending" upload={upload} stale={stale} />)}
        {received.map(trip => <TripCard key={trip.id} trip={trip} state={state} delivery="received" stale={stale}><AmendmentEditor key={`${employeeId}/${trip.id}`} trip={trip} employeeId={employeeId} state={state} stale={stale} onSaved={refresh} /></TripCard>)}</div>}
    <p className="mvp-muted">미확정 수신 기록은 원래 직원이 용도만 보완할 수 있습니다. 원본 시각·거리·품질과 최초 수신 ACK는 보존합니다.</p>
  </section>;
}

function Admin({ state, stale }: { state: ServerState; stale: boolean }) {
  const [from, setFrom] = useState(''), [through, setThrough] = useState(''), [employeeFilter, setEmployeeFilter] = useState(''), [vehicleFilter, setVehicleFilter] = useState(''), [purposeFilter, setPurposeFilter] = useState('');
  const allReceived = state.receivedTrips ?? [];
  const received = allReceived.filter(trip => {
    const day = koreanDate(trip.startedAt);
    return (!from || day >= from) && (!through || day <= through) && (!employeeFilter || trip.employeeId === employeeFilter) && (!vehicleFilter || trip.vehicleId === vehicleFilter)
      && (!purposeFilter || (purposeFilter === 'unconfirmed' ? !trip.purposeConfirmed : trip.purposeConfirmed && trip.purpose === purposeFilter));
  }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.id.localeCompare(b.id));
  const active = state.activeTrips ?? [];
  const review = received.filter(trip => !trip.purposeConfirmed || !validDistance(trip));
  const pending = (state.pendingUploads ?? []).filter(upload => upload.status !== 'received');
  const valid = received.filter(validDistance), distance = valid.reduce((sum, trip) => sum + trip.distanceM!, 0);
  return <div className="mvp-admin"><section className="mvp-card"><p className="eyebrow">가상 회사</p><h2>{state.company.name}</h2><p>가상 직원 {state.employees.length}명 · 가상 차량 {state.vehicles.length}대</p><p>모의 운행의 진행·전송 대기·실제 서버 수신을 구분합니다. 실제 운전자 인증은 아닙니다.</p></section>
    <section className="mvp-section"><h2>차량별 연결 현황</h2><div className="mvp-vehicle-grid">{state.vehicles.map(vehicle => {
      const employee = state.employees.find(person => person.id === vehicle.connection?.employeeId);
      return <article className="mvp-card mvp-vehicle-card" key={vehicle.id} data-vehicle-id={vehicle.id}><span className={`badge ${stale ? 'warning' : vehicle.connection ? 'success' : 'neutral'}`}>{stale ? '현재 상태 확인 중' : vehicle.connection ? '연결 중' : '미연결'}</span>
        <h3>{vehicle.name}</h3><p>{vehicle.plate}</p><p className="mvp-muted">{state.company.name}</p>
        {vehicle.connection ? <dl className="mvp-facts"><dt>직원</dt><dd>{employee?.name ?? '직원 확인 필요'}</dd><dt>연결 시각</dt><dd>{timeLabel(vehicle.connection.connectedAt)}</dd></dl> : <p>{stale ? '이전 조회에는 연결이 없었습니다.' : '연결된 직원이 없습니다.'}</p>}
      </article>;
    })}</div></section>
    <section className="mvp-section mvp-card" aria-label="수신 운행 필터"><h2>운행 내역 필터</h2><p className="mvp-muted">운행 시작 시각의 한국 날짜 기준 · 최신 수신본 · 시작 시각 내림차순. 요약과 수신 확인 필요 목록에 같은 필터를 적용합니다.</p>
      <div className="mvp-received-filters"><label className="mvp-field">기간 시작일<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="mvp-field">기간 종료일<input type="date" value={through} min={from || undefined} onChange={event => setThrough(event.target.value)} /></label>
        <label className="mvp-field">직원 필터<select value={employeeFilter} onChange={event => setEmployeeFilter(event.target.value)}><option value="">전체 직원</option>{state.employees.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <label className="mvp-field">차량 필터<select value={vehicleFilter} onChange={event => setVehicleFilter(event.target.value)}><option value="">전체 차량</option>{state.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></label>
        <label className="mvp-field">용도 필터<select value={purposeFilter} onChange={event => setPurposeFilter(event.target.value)}><option value="">전체 용도</option>{Object.entries(purposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="unconfirmed">용도 미확정</option></select></label></div>
      <button className="button secondary" onClick={() => { setFrom('');setThrough('');setEmployeeFilter('');setVehicleFilter('');setPurposeFilter(''); }}>운행 필터 초기화</button>
    </section>
    <section className="mvp-section" aria-label="수신 운행 요약"><h2>수신 운행 요약</h2><div className="mvp-stats">
      <div><span>서버 수신 운행</span><strong>{received.length}건</strong></div>
      <div><span>유효 거리 합계</span><strong>{received.length === 0 ? '수신 기록 없음' : valid.length === 0 ? '합산 가능한 거리 없음' : `${(distance / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 3 })} km`}</strong><small>거리 제외 {received.length - valid.length}건</small></div>
      <div><span>용도 확인 필요</span><strong>{received.filter(trip => !trip.purposeConfirmed).length}건</strong></div>
    </div><p className="mvp-muted">현재 목록 필터에 해당하는 수신본만 합산합니다. 세무 적격성·기간 마감 결과가 아닙니다.</p></section>
    <section className="mvp-section" aria-label="수신 확인 필요"><h2>확인 필요 · 수신 운행</h2><p className="mvp-muted">운행 단위 {review.length}건 · 용도 미확정 {received.filter(trip => !trip.purposeConfirmed).length}건 · 거리 불완전 {received.filter(trip => !validDistance(trip)).length}건. 사유별 건수는 겹칠 수 있습니다.</p>
      {review.length ? <div className="mvp-vehicle-grid">{review.map(trip => <article className="mvp-card" key={trip.id} data-review-trip-id={trip.id}><h3>{state.employees.find(person => person.id === trip.employeeId)?.name ?? trip.employeeId} · {state.vehicles.find(vehicle => vehicle.id === trip.vehicleId)?.name ?? trip.vehicleId}</h3><p>{timeLabel(trip.startedAt)} · {tripDistance(trip)}</p><div className="mvp-trip-badges">{!trip.purposeConfirmed && <span className="badge warning">용도 미확정</span>}{!validDistance(trip) && <span className="badge warning">거리 불완전</span>}</div><a className="button secondary" href={`#mvp-trip-${trip.id}`}>수신 운행 상세로 이동</a></article>)}</div> : <div className="mvp-card"><p>{stale ? '이전 조회에는 수신 확인 대상이 없었습니다.' : '현재 필터의 수신 확인 대상이 없습니다.'}</p></div>}
      <p className="mvp-muted">보완 요청 발송 기능은 없습니다. 원래 운전자가 모바일웹에서 보완합니다.</p>
    </section>
    <section className="mvp-section mvp-trip-section" aria-label="진행 중 운행"><h2>진행 중 모의 운행</h2>
      {active.length ? <div className="mvp-vehicle-grid">{active.map(trip => <TripCard key={trip.id} trip={trip} state={state} delivery="active" stale={stale} showEmployee />)}</div> : <div className="mvp-card"><p>진행 중인 모의 운행이 없습니다.</p></div>}
    </section>
    <section className="mvp-section mvp-trip-section" aria-label="전송 대기 및 확인 필요"><h2>전송 대기 및 확인 필요</h2>
      <p className="mvp-muted">회사 전체의 알려진 미전송 현황입니다. 위 수신 목록 필터 및 수신 집계와 분리합니다.</p>
      {pending.length ? <><p className="mvp-muted">전송 대기 {pending.length}건 · 전송 문제 {pending.filter(uploadProblem).length}건. 아직 수신 운행 목록에 포함하지 않습니다.</p>
        <div className="mvp-vehicle-grid">{pending.map(upload => <TripCard key={upload.eventId} trip={upload.trip} state={state} delivery="pending" upload={upload} stale={stale} showEmployee />)}</div></>
        : <div className="mvp-card"><p>전송 대기 중인 기록이 없습니다.</p></div>}
    </section>
    <section className="mvp-section mvp-trip-section" aria-label="서버 수신 운행 목록"><h2>서버 수신 운행 목록</h2>
      {received.length ? <div className="mvp-vehicle-grid">{received.map(trip => <TripCard key={trip.id} trip={trip} state={state} delivery="received" stale={stale} showEmployee />)}</div>
        : <div className="mvp-card"><p>{allReceived.length === 0 ? '아직 서버가 수신한 MVP 운행이 없습니다.' : '필터에 맞는 수신 운행이 없습니다.'}</p></div>}
    </section>
    <MonthlyReports state={state} stale={stale} />
    <section className="mvp-section"><h2>데모 직원</h2><div className="mvp-vehicle-grid">{state.employees.map(employee => <article className="mvp-card" key={employee.id}><h3>{employee.name}</h3><p>{state.company.name}</p><p>{employee.department} · {employee.title}</p><small className="mvp-muted">직원 ID {employee.id} · 가상 인물</small></article>)}</div></section>
  </div>;
}

const conversationLabels: Record<Conversation['phase'], string> = {
  question: '질문 안내', awaiting_answer: '모의 답변 대기', confirmation: '재확인 안내', awaiting_confirmation: '모의 동의 대기',
  confirmed: '초안 확인 완료', deferred: '목적 미확정으로 보관', cancelled: '대화 종료', driving: '모의 주행 중 · 대화 중단', completed: '운행 저장 완료',
};
const answerExamples = {
  business: { label: '업무 방문', text: '판교 거래처에 계약 미팅하러 갑니다.' },
  commute: { label: '출퇴근', text: '회사로 출근합니다.' },
  personal: { label: '개인 용도', text: '마트에 장보러 갑니다.' },
  ambiguous: { label: '모호한 목적', text: '잠깐 나갑니다.' },
};
const commandId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `mvp-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function Control({ state, vehicleId, qr, stale, refresh }: { state: ServerState; vehicleId: string; qr?: Qr; stale: boolean; refresh: () => void }) {
  const vehicle = state.vehicles.find(item => item.id === vehicleId);
  const employee = state.employees.find(person => person.id === vehicle?.connection?.employeeId);
  const connection = vehicle?.connection;
  const conversation = (state.conversations ?? []).find(item => item.connectionId === connection?.id && item.isCurrent);
  const prompt = (state.prompts ?? []).find(item => item.id === conversation?.promptId);
  const trip = (state.activeTrips ?? []).find(item => item.vehicleId === vehicleId);
  const pending = (state.pendingUploads ?? []).filter(upload => upload.vehicleId === vehicleId && upload.status !== 'received');
  const received = (state.receivedTrips ?? []).filter(item => item.vehicleId === vehicleId);
  const blocked = (state.uploadBlockedVehicles ?? []).includes(vehicleId);
  const runtime = state.vehicleRuntime?.find(item => item.vehicleId === vehicleId);
  const [answer, setAnswer] = useState<keyof typeof answerExamples>('business');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const busyGuard = useRef(false);
  useEffect(() => {
    epoch.current++;operation.current?.abort();operation.current = null;busyGuard.current = false;
    setBusy(false);setActionError('');
    return () => { epoch.current++;operation.current?.abort(); };
  }, [vehicleId, connection?.id, conversation?.id]);
  async function act(path: string, body: unknown) {
    if (busyGuard.current || stale) return;
    busyGuard.current = true;setBusy(true);setActionError('');
    const generation = ++epoch.current, abort = new AbortController();operation.current = abort;
    try { await request(path, abort.signal, body);if (generation === epoch.current) refresh(); }
    catch (error) { if (generation === epoch.current && !abort.signal.aborted) { setActionError(error instanceof Error ? error.message : '모의 요청을 완료하지 못했습니다.');refresh(); } }
    finally { if (generation === epoch.current) { busyGuard.current = false;setBusy(false);operation.current = null; } }
  }
  function command(type: string, extra: Record<string, string> = {}) {
    if (!connection) return;
    const control = ['depart', 'arrive', 'finish', 'continue', 'stop_session', 'start_session', 'unknown', 'park'].includes(type);
    void act('/mvp-api/commands', { commandId: commandId(), connectionId: connection.id,
      ...(control ? { tripId: trip?.id ?? '', conversationId: trip?.conversationId ?? '' } : conversation ? { conversationId: conversation.id } : {}), type, ...extra });
  }
  const unavailable = stale || busy || !connection;
  const dialogueUnavailable = unavailable || !conversation;
  const canAnswer = conversation?.phase === 'awaiting_answer';
  const canConfirm = conversation?.phase === 'awaiting_confirmation';
  const canSilence = !!conversation && !['driving', 'confirmed', 'cancelled', 'completed'].includes(conversation.phase);
  const seconds = qr?.expiresAt ? Math.max(0, Math.ceil((Date.parse(qr.expiresAt) - Date.parse(state.serverTime)) / 1000)) : null;
  return <div className="mvp-control"><section className="mvp-card"><h2>시연할 차량</h2>
    <label className="mvp-field">시연 차량<select value={vehicleId} onChange={event => { window.location.href = `/mvp/control?vehicleId=${encodeURIComponent(event.target.value)}`; }}>{state.vehicles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.plate}</option>)}</select></label>
    <div className="mvp-links"><a className="button primary" target="_blank" rel="noreferrer" href={`/mvp/car?vehicleId=${encodeURIComponent(vehicleId)}`}>차량 화면 열기</a>
      <a className="button secondary" target="_blank" rel="noreferrer" href="/mvp/driver">운전자 모바일웹 열기</a><a className="button secondary" target="_blank" rel="noreferrer" href="/mvp/admin">관리자 화면 열기</a></div>
    <p>화면은 같은 서버 상태를 자동 조회합니다. 차량 화면에는 시연용 제어를 넣지 않습니다.</p></section>
    <section className="mvp-card" aria-label="현재 QR 시연 정보"><h2>현재 QR</h2>
      {stale ? <p>서버 조회 실패로 QR 링크를 숨겼습니다. 자동 재조회를 기다려 주세요.</p>
        : vehicle?.connection ? <><span className="badge success">연결 중</span><p>{vehicle.name} · {employee?.name}</p><p>연결 시각 {timeLabel(vehicle.connection.connectedAt)}</p><p>차량 화면은 주차 중 표시되고 주행 중 비워집니다. 운행을 마친 뒤 모바일웹에서 연결을 해제할 수 있습니다.</p></>
        : qr?.url ? <><span className="badge neutral">{seconds === 0 ? '만료 · 새 QR 확인 중' : `유효 · 약 ${seconds}초 남음`}</span><p>QR 만료: {qr.expiresAt && timeLabel(qr.expiresAt)}</p>
          <a className="mvp-token-link" aria-label="현재 QR 연결 링크" target="_blank" rel="noreferrer" href={qr.url}>{qr.url}</a>
          <a className="button secondary" target="_blank" rel="noreferrer" href={`/mvp/driver?token=${encodeURIComponent(qr.token ?? '')}`}>이 PC에서 QR 연결 재현</a>
          {qr.code && <><p className="mvp-connection-code">연결 코드 <strong>{qr.code}</strong></p><a className="button secondary" target="_blank" rel="noreferrer" href={`/mvp/driver?code=${encodeURIComponent(qr.code)}`}>이 PC에서 연결 코드 재현</a></>}
          <p className="mvp-muted">{qr.validForMs === 600000 ? '10분간 유효' : `${Math.ceil((qr.validForMs ?? 600000) / 1000)}초간 유효`} · QR과 코드는 한 번만 함께 사용합니다.</p>
          <p className="mvp-muted">{localOnlyUrl(qr.url) ? '이 QR은 PC 로컬 시연용입니다. 실제 휴대폰은 별도 접속 주소와 네트워크 설정이 필요합니다.' : '설정된 외부 접속 주소를 사용합니다. 실제 휴대폰의 네트워크 연결과 QR 스캔은 별도로 확인해야 합니다.'}</p></> : <p>QR을 확인하고 있습니다.</p>}
    </section>
    <section className="mvp-card mvp-control-wide" aria-label="모의 대화 제어"><h2>모의 대화 제어</h2>
      <p>실제 음성인식이 아닙니다. 정해진 예시 발화와 동의를 서버에 전달합니다.</p>
      <p><strong>{employee ? `${vehicle?.name} · ${employee.name}` : '먼저 QR로 데모 직원을 연결해 주세요.'}</strong></p>
      {conversation ? <><span className="badge neutral">{conversationLabels[conversation.phase]}</span>
        {prompt && <p className="mvp-dialogue-line">{prompt.text}</p>}
        {conversation.transcript && <p className="mvp-muted">전달한 모의 발화: {conversation.transcript}</p>}
        {conversation.draft && <dl className="mvp-facts"><dt>목적지 초안</dt><dd>{conversation.draft.destination || '미확정'}</dd>
          <dt>용도 초안</dt><dd>{purposeLabel(conversation.draft.purpose)}</dd><dt>상세 목적</dt><dd>{conversation.draft.detailedPurpose || '미확정'}</dd></dl>}
        <p className="mvp-muted">모의 동의 또는 미확정 보관 후 종료 후보의 원본으로 자동 저장합니다. 재출발하면 초안과 종료 후보를 취소합니다.</p></>
        : <p>모의 주행·도착 후 차량 화면의 ‘운행 마치기’를 누르면 목적을 묻습니다.</p>}
      <label className="mvp-field">모의 답변 예시<select value={answer} onChange={event => setAnswer(event.target.value as keyof typeof answerExamples)} disabled={busy}>
        {Object.entries(answerExamples).map(([id, example]) => <option key={id} value={id}>{example.label}</option>)}
      </select></label>
      <p className="mvp-muted">{answerExamples[answer].text}</p>
      <div className="mvp-command-actions"><button className="button primary" disabled={dialogueUnavailable || !canAnswer} onClick={() => command('answer', { value: answerExamples[answer].text })}>모의 발화 전달</button>
        <button className="button secondary" disabled={dialogueUnavailable || !canSilence} onClick={() => command('silence')}>모의 무응답</button>
        <button className="button secondary" disabled={dialogueUnavailable || !canConfirm} onClick={() => command('confirm', { value: 'yes' })}>모의 네</button>
        <button className="button secondary" disabled={dialogueUnavailable || !canConfirm} onClick={() => command('confirm', { value: 'no' })}>모의 아니요</button>
        <button className="button secondary" disabled={dialogueUnavailable || !canSilence} onClick={() => command('confirm', { value: 'later' })}>모의 나중에</button>
        <button className="button secondary" disabled={dialogueUnavailable || !canSilence} onClick={() => command('failure')}>모의 실패</button></div>
      {actionError && <div className="notice error" role="alert"><strong>모의 요청을 완료하지 못했습니다</strong><p>{actionError}</p><p>서버 상태를 다시 확인합니다. 다른 연결이나 운행으로 적용하지 않습니다.</p></div>}
      {conversation && <details className="mvp-diagnostics"><summary>현재 대화 진단</summary><p>연결 ID {connection?.id}</p><p>대화 ID {conversation.id}</p><p>안내 ID {conversation.promptId || '없음'}</p></details>}
    </section>
    <div className="mvp-control-wide"><RuntimeControl state={state} vehicleId={vehicleId} stale={stale} onRefresh={refresh} /></div>
    <section className="mvp-card mvp-control-wide" aria-label="모의 운행 제어"><h2>모의 운행과 자동 전달</h2>
      <p>시연 버튼이 차량 신호를 대신합니다. QR 연결만으로 운행을 시작하지 않습니다.</p>
      <p className="mvp-muted">{runtime?.parking === 'driving' ? '모의 주행 중' : runtime?.parking === 'parked' ? '모의 주차 확인' : '주차 상태 불명확'} · {runtime?.sessionActive ? '기록 세션 켜짐' : '기록 세션 중지'} · 전송 대기 {pending.length}건 · 서버 수신 {received.length}건</p>
      <div className="mvp-command-actions"><button className="button primary" disabled={unavailable || !runtime?.sessionActive || runtime.parking === 'driving'} onClick={() => command('depart', trip ? { tripId: trip.id } : {})}>모의 출발</button>
        <button className="button secondary" disabled={unavailable || !trip || runtime?.parking === 'parked'} onClick={() => trip && command('arrive', { tripId: trip.id })}>모의 도착</button>
        <button className="button secondary" disabled={unavailable || runtime?.parking === 'unknown'} onClick={() => command('unknown', trip ? { tripId: trip.id } : {})}>모의 상태 불명확</button>
        <button className="button secondary" disabled={unavailable || runtime?.parking !== 'unknown'} onClick={() => command('park')}>모의 주차 확인</button>
        <button className="button secondary" disabled={busy || stale} aria-pressed={blocked} onClick={() => void act(`/mvp-api/vehicles/${encodeURIComponent(vehicleId)}/upload-mode`, { blocked: !blocked })}>{blocked ? '운행 업로드 복구' : '운행 업로드 차단'}</button></div>
      <p className="mvp-muted">{blocked ? '운행 업로드만 차단했습니다. QR·상태 조회·모의 제어는 계속 동작합니다.' : '모의 도착은 주차 전환입니다. 차량의 운행 마치기·용도 확인 또는 미확정 보관 후 자동 전송합니다.'}</p>
      {trip && <TripCard trip={trip} state={state} delivery="active" stale={stale} showEmployee />}
      {pending.map(upload => <TripCard key={upload.eventId} trip={upload.trip} state={state} delivery="pending" upload={upload} stale={stale} showEmployee />)}
    </section>
    <MonthEndControl state={state} stale={stale} />
  </div>;
}
