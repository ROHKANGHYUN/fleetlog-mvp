import { useEffect, useRef, useState } from 'react';
import type { MonthlyData, MonthlyGroup, MonthlyReport, MonthlyResponse, ReceivedTrip, ServerState, Submission } from './workflow-types';
import { koreanMonth, reportTime, reportingRequest, requestId, useReportingQuery } from './reporting-client';

const purposeLabels: Record<string, string> = { business: '일반 업무', commute: '출퇴근', personal: '개인 용도', unconfirmed: '용도 미확정' };
const costLabels = { fuel: '가상 유류비', parking: '가상 주차비', toll: '가상 통행료' };
const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const distance = (meters: number | null) => meters === null ? '합산 가능한 거리 없음' : `${(meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 3 })} km`;
const tripDistance = (trip: ReceivedTrip) => trip.quality === 'complete' && !trip.hasGap && trip.distanceM !== null ? distance(trip.distanceM) : '거리 확인 필요';

function Summary({ data }: { data: MonthlyData }) {
  const summary = data.summary;
  return <div className="mvp-monthly-summary" aria-label="월별 수신 집계">
    <div><span>서버 수신 건수</span><strong>{summary.receivedCount}건</strong></div>
    <div><span>유효 거리</span><strong>{summary.receivedCount === 0 ? '수신 기록 없음' : distance(summary.validDistanceM)}</strong><small>거리 제외 {summary.excludedDistanceCount}건</small></div>
    <div><span>용도 미확정</span><strong>{summary.unconfirmedCount}건</strong></div>
    <div><span>거리 불완전</span><strong>{summary.incompleteCount}건</strong></div>
    <div><span>알려진 미전송</span><strong>{summary.pendingCount}건</strong></div>
    <div><span>가상 비용 합계</span><strong>{won(summary.costTotalKRW)}</strong><small>운행 거리와 별도 집계</small></div>
  </div>;
}

function Groups({ title, groups, label }: { title: string; groups: MonthlyGroup[]; label: (key: string) => string }) {
  return <section className="mvp-group-summary"><h4>{title}</h4>{groups.length === 0 ? <p>수신 기록이 없습니다.</p> : <ul>{groups.map(group => <li key={group.key}><strong>{label(group.key)}</strong><span>{group.count}건 · {distance(group.validDistanceM)}</span><small>거리 제외 {group.excludedDistanceCount}건</small></li>)}</ul>}</section>;
}

function CostList({ data }: { data: MonthlyData }) {
  return <div className="mvp-cost-list"><h4>가상 차량 비용</h4><p className="mvp-muted">고정 날짜의 fixture입니다. 실제 결제·비용 영수증·카드 연동이 아니며 다른 월로 복제하지 않습니다.</p>
    {data.costs.length === 0 ? <p>이 월의 가상 비용이 없습니다.</p> : <ul>{data.costs.map(cost => <li key={cost.id}><strong>{costLabels[cost.category]} · {won(cost.amountKRW)}</strong><p>{cost.occurredOn} · {data.vehicles?.find(vehicle => vehicle.id === cost.vehicleId)?.name ?? cost.vehicleId}</p><p>{cost.description}</p><small>가상 출처: {cost.source} · 비용 ID {cost.id}</small></li>)}</ul>}
  </div>;
}

function SubmissionResult({ submission }: { submission: Submission }) {
  const statuses = { processing: '모의 접수 중', completed: '모의 접수 완료', failed: '모의 실패' };
  return <section className="mvp-submission" aria-label="모의 접수 결과" data-submission-id={submission.id} data-submission-status={submission.status}>
    <h4>{statuses[submission.status]}</h4><p>{submission.month} · 자료 버전 {submission.reportVersion} · 시도 {submission.attempts.length}회</p>
    <p className="mvp-muted">세무처리 시뮬레이션 · 실제 신고 아님</p>
    <ol>{submission.attempts.map(attempt => <li key={attempt.id}><strong>시도 {attempt.number} · {statuses[attempt.status]}</strong><p>요청 {reportTime(attempt.requestedAt)}</p>
      {attempt.completedAt && <p>모의 처리 {reportTime(attempt.completedAt)}</p>}{attempt.receiptNumber && <p className="mvp-demo-receipt">모의 접수번호 <strong>{attempt.receiptNumber}</strong></p>}
      {attempt.error && <p className="notice error">{attempt.error}</p>}</li>)}</ol>
  </section>;
}

function Snapshot({ report, submission, unavailable, onSubmit, busy }: { report: MonthlyReport; submission?: Submission; unavailable: boolean; onSubmit: () => void; busy: boolean }) {
  const data = report.data;
  const delivered = submission?.status === 'completed' || submission?.status === 'processing';
  return <article className="mvp-card mvp-snapshot" aria-label="선택한 월별 자료" data-report-id={report.id} data-report-version={report.version}>
    <div className="mvp-trip-badges"><span className="badge neutral">가상 데이터 · 고정 스냅샷</span><span className={`badge ${report.stale ? 'warning' : 'success'}`}>{report.stale ? '갱신 필요' : '현재 수신본 기준'}</span></div>
    <h3>{report.month} 자료 버전 {report.version}</h3><p>{data.company.name} · 전체 차량 · 생성 {reportTime(report.createdAt)}</p>
    <p className="mvp-muted">이 자료에 포함된 운행·보완 버전·비용은 생성 당시 값입니다. 새 기록이 생겨도 이 내용을 덮어쓰지 않습니다.</p>
    <Summary data={data} />
    <details className="mvp-report-details"><summary>자료에 포함된 운행 {data.trips.length}건</summary>
      {data.trips.length === 0 ? <p>포함된 수신 운행이 없습니다.</p> : <ul>{data.trips.map(trip => <li key={trip.id}><strong>{data.employees?.find(employee => employee.id === trip.employeeId)?.name ?? trip.employeeId} · {data.vehicles?.find(vehicle => vehicle.id === trip.vehicleId)?.name ?? trip.vehicleId}</strong><p>{reportTime(trip.startedAt)} → {reportTime(trip.endedAt)}</p><p>{trip.purposeConfirmed && trip.purpose ? purposeLabels[trip.purpose] : '용도 미확정'} · {trip.destination || '목적지 미확정'} · {trip.detailedPurpose || '상세 목적 미확정'}</p><p>{tripDistance(trip)} · 보완 버전 {trip.amendmentVersion ?? 0}</p><small>운행 ID {trip.id}</small></li>)}</ul>}
    </details>
    <details className="mvp-report-details"><summary>자료에 포함된 가상 비용 {data.costs.length}건</summary><CostList data={data} /></details>
    <div className="mvp-command-actions mvp-downloads">{unavailable ? <p>조회가 복구되면 스냅샷 다운로드를 사용할 수 있습니다.</p> : <><a className="button secondary" href={`/mvp-api/reports/${encodeURIComponent(report.id)}/trips.csv`} download>운행 내역 CSV</a><a className="button secondary" href={`/mvp-api/reports/${encodeURIComponent(report.id)}/costs.csv`} download>가상 차량 비용 CSV</a></>}</div>
    <section className="mvp-simulation-box" aria-label="모의 제출 준비 상태"><h4>세무처리 시뮬레이션 · 실제 신고 아님</h4>
      {report.readiness.reasons.length ? <><p>다음 조건을 확인해야 모의 제출할 수 있습니다.</p><ul>{report.readiness.reasons.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul></> : <p>현재 MVP 내부 준비 조건을 충족했습니다. 법적 세무 적격성 판단이 아닙니다.</p>}
      <button className="button primary" disabled={unavailable || busy || !report.readiness.canSubmit || delivered} onClick={onSubmit}>{busy ? '서버 요청 중…' : submission?.status === 'failed' ? '모의 제출 재시도' : '모의 제출'}</button>
    </section>
    {submission && <SubmissionResult submission={submission} />}
  </article>;
}

export function MonthlyReports({ state, stale }: { state: ServerState; stale: boolean }) {
  const [month, setMonth] = useState(() => koreanMonth(state.serverTime));
  const query = useReportingQuery<MonthlyResponse>(`/mvp-api/monthly?month=${encodeURIComponent(month)}`);
  const [selectedId, setSelectedId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const epoch = useRef(0), operation = useRef<AbortController | null>(null), guard = useRef(false);
  const createPrepared = useRef<{ month: string; requestId: string } | null>(null), submitPrepared = useRef<{ reportId: string; requestId: string } | null>(null);
  useEffect(() => () => { epoch.current++;operation.current?.abort(); }, []);
  function chooseMonth(value: string) {
    epoch.current++;operation.current?.abort();operation.current = null;guard.current = false;
    setMonth(value);setSelectedId('');setBusy(false);setError('');setNotice('');createPrepared.current = null;submitPrepared.current = null;
  }
  const current = query.data;
  const reports = [...(current?.reports ?? [])].sort((a, b) => b.version - a.version);
  const selected = reports.find(report => report.id === selectedId) ?? (selectedId ? undefined : reports[0]);
  const submission = current?.submissions.find(value => value.reportId === selected?.id);
  const unavailable = stale || !!query.error || !current;
  async function act(type: 'create' | 'submit') {
    if (guard.current || unavailable || type === 'submit' && !selected) return;
    guard.current = true;setBusy(true);setError('');setNotice('');const generation = ++epoch.current;
    const abort = new AbortController();operation.current = abort;
    try {
      if (type === 'create') {
        if (createPrepared.current?.month !== month) createPrepared.current = { month, requestId: requestId() };
        const result = await reportingRequest<{ report: MonthlyReport }>('/mvp-api/reports', createPrepared.current, abort.signal);
        if (generation === epoch.current) { setSelectedId(result.report.id);setNotice(`자료 버전 ${result.report.version}을 서버에 생성했습니다.`);createPrepared.current = null;query.refresh(); }
      } else {
        if (submitPrepared.current?.reportId !== selected!.id) submitPrepared.current = { reportId: selected!.id, requestId: requestId() };
        await reportingRequest('/mvp-api/submissions', submitPrepared.current, abort.signal);
        if (generation === epoch.current) { setNotice('모의 제출 요청을 서버에 저장했습니다. 접수 결과를 자동 조회합니다.');submitPrepared.current = null;query.refresh(); }
      }
    } catch (cause) {
      if (generation === epoch.current && !abort.signal.aborted) { setError(cause instanceof Error ? cause.message : '처리하지 못했습니다.');query.refresh(); }
    } finally { if (generation === epoch.current) { guard.current = false;setBusy(false);operation.current = null; } }
  }
  return <section className="mvp-section mvp-monthly" aria-label="월별 자료·모의 세무처리"><h2>월별 자료·모의 세무처리</h2>
    <p className="notice neutral">세무처리 시뮬레이션 · 실제 신고 아님</p>
    <label className="mvp-field mvp-month-field">집계 월<input type="month" value={month} onChange={event => chooseMonth(event.target.value)} /></label>
    <p className="mvp-muted">회사 전체 · 선택 월 · 전체 차량입니다. 운행 시작 시각의 한국 날짜(Asia/Seoul)를 기준으로 하며 위 운행 목록의 필터와 독립적입니다.</p>
    {query.error && <div className="notice error" role="alert"><strong>월별 자료를 조회하지 못했습니다</strong><p>{query.error}</p><p>{current ? '이전 조회값을 유지합니다.' : '기록 0건으로 판단하지 않습니다.'} 마지막 성공 {reportTime(query.lastSuccess)}</p></div>}
    {!current && !query.error && <p role="status">선택한 월의 수신 자료를 조회하고 있습니다.</p>}
    {error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
    {current && <><Summary data={current.data} />
      <div className="mvp-monthly-groups"><Groups title="직원별" groups={current.data.byEmployee} label={key => current.data.employees?.find(person => person.id === key)?.name ?? key} /><Groups title="차량별" groups={current.data.byVehicle} label={key => current.data.vehicles?.find(vehicle => vehicle.id === key)?.name ?? key} /><Groups title="용도별" groups={current.data.byPurpose} label={key => purposeLabels[key] ?? key} /></div>
      <CostList data={current.data} />
      <p className="mvp-muted">알려진 미전송 {current.data.pending.length}건은 수신 집계에 포함하지 않습니다. 운행 수신 ACK는 위 가상 비용의 영수증이 아닙니다.</p>
      <button className="button primary" disabled={unavailable || busy} onClick={() => void act('create')}>월별 자료 생성</button>
      <label className="mvp-field mvp-report-picker">자료 버전<select value={selected?.id ?? ''} disabled={reports.length === 0 || busy} onChange={event => { setSelectedId(event.target.value);setError('');setNotice('');submitPrepared.current = null; }}>{reports.length === 0 && <option value="">생성한 자료 없음</option>}{reports.map(report => <option key={report.id} value={report.id}>{report.month} · 버전 {report.version}{report.stale ? ' · 갱신 필요' : ''}</option>)}</select></label>
      {selected ? <Snapshot report={selected} submission={submission} unavailable={unavailable} busy={busy} onSubmit={() => void act('submit')} /> : <div className="mvp-card"><p>{selectedId ? '생성한 자료를 다시 조회하고 있습니다.' : '아직 생성한 월별 자료가 없습니다. 빈 월도 초안으로 생성·다운로드할 수 있습니다.'}</p></div>}
    </>}
  </section>;
}

export function MonthEndControl({ state, stale }: { state: ServerState; stale: boolean }) {
  const [month, setMonth] = useState(() => koreanMonth(state.serverTime));
  const query = useReportingQuery<MonthlyResponse>(`/mvp-api/monthly?month=${encodeURIComponent(month)}`);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const guard = useRef(false), epoch = useRef(0), operation = useRef<AbortController | null>(null), prepared = useRef<{ month: string; requestId: string } | null>(null);
  useEffect(() => () => { epoch.current++;operation.current?.abort(); }, []);
  const unavailable = stale || !!query.error || !query.data;
  const failure = query.data?.simulationOutcome === 'failure';
  async function act(type: 'report' | 'outcome') {
    if (guard.current || unavailable) return;
    guard.current = true;setBusy(true);setError('');setNotice('');const generation = ++epoch.current;
    const abort = new AbortController();operation.current = abort;
    try {
      if (type === 'report') {
        if (prepared.current?.month !== month) prepared.current = { month, requestId: requestId() };
        const result = await reportingRequest<{ report: MonthlyReport }>('/mvp-api/reports', prepared.current, abort.signal);
        if (generation === epoch.current) { setNotice(`${month} 자료 버전 ${result.report.version}을 생성했습니다. 관리자에서 같은 스냅샷을 확인하세요.`);prepared.current = null; }
      } else {
        await reportingRequest('/mvp-api/simulation/submission-outcome', { outcome: failure ? 'success' : 'failure' }, abort.signal);
        if (generation === epoch.current) setNotice(failure ? '이후 모의 제출은 성공 결과를 사용합니다.' : '이후 모의 제출은 실패 결과를 사용합니다. 진행 중인 요청은 바꾸지 않습니다.');
      }
      if (generation === epoch.current) query.refresh();
    } catch (cause) { if (generation === epoch.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : '시연 조작을 처리하지 못했습니다.'); }
    finally { if (generation === epoch.current) { guard.current = false;setBusy(false);operation.current = null; } }
  }
  return <section className="mvp-card mvp-control-wide" aria-label="월말 처리 시연 제어"><h2>월말 처리 재현</h2><p>자동 주기 처리를 재현하는 개발용 버튼입니다. 실제 예약 작업·세무신고·외부 전송이 아닙니다.</p>
    <label className="mvp-field mvp-month-field">월말 재현 월<input type="month" value={month} disabled={busy} onChange={event => { epoch.current++;operation.current?.abort();setMonth(event.target.value);prepared.current = null;setError('');setNotice(''); }} /></label>
    <div className="mvp-command-actions"><button className="button primary" disabled={unavailable || busy} onClick={() => void act('report')}>월말 처리 재현</button><button className="button secondary" disabled={unavailable || busy} aria-pressed={failure} onClick={() => void act('outcome')}>{failure ? '모의 제출 성공으로 복구' : '모의 제출 실패 재현'}</button></div>
    <p className="mvp-muted">현재 모의 제출 결과: {query.data ? failure ? '모의 실패' : '모의 성공' : '확인 중'}. 관리자와 같은 자료 생성 API를 사용합니다.</p>
    {(query.error || error) && <p className="notice error" role="alert">{error || query.error}</p>}{notice && <p className="notice success" role="status">{notice}</p>}
    <a className="button secondary" href="/mvp/admin" target="_blank" rel="noreferrer">월별 자료 관리자 열기</a>
  </section>;
}
