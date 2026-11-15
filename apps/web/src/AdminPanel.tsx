import { useEffect, useMemo, useState } from 'react';
import { purposeLabels, type StoredTrip } from './types';
import { AdminQuery, type AdminQueryState } from './admin/query.mjs';
import { defaultFilters, selectTrips, distanceMeters, exceptionReasons, formatKst, type AdminFilters } from './admin/model.mjs';
import './admin.css';

type AdminView = 'records' | 'exceptions' | 'summary';
const km = (meters: number | null) => meters === null ? '집계 가능 거리 없음' : `${(meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 3 })} km`;
const raw = (value: number | null | undefined) => Number.isFinite(value) ? `${value!.toLocaleString('ko-KR')} m` : '확인 필요';

export function AdminPanel({ refreshKey }: { refreshKey: number }) {
  const query = useMemo(() => new AdminQuery(), []);
  const [snapshot, setSnapshot] = useState(() => query.getState());
  useEffect(() => {
    const unsubscribe = query.subscribe(setSnapshot);
    void query.load();
    return () => { unsubscribe(); query.cancel(); };
  }, [query, refreshKey]);
  return <AdminWorkspace snapshot={snapshot} onRefresh={() => void query.load()} />;
}

/** Presentational workspace also used by isolated server-rendered regression fixtures. */
export function AdminWorkspace({ snapshot, onRefresh, initialView = 'records', initialFilters = defaultFilters(), initialSelectedId = null }:
  { snapshot: AdminQueryState; onRefresh: () => void; initialView?: AdminView; initialFilters?: AdminFilters; initialSelectedId?: string | null }) {
  const [view, setView] = useState<AdminView>(initialView);
  const [filters, setFilters] = useState(initialFilters);
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const model = selectTrips(snapshot.trips, filters, { view: view === 'exceptions' ? 'exceptions' : 'records', sort, page, pageSize: 10 });
  const selected = model.rows.find(trip => trip.tripId === selectedId) ?? null;
  const { summary } = model;
  useEffect(() => {
    if (page !== model.page) setPage(model.page);
    if (selectedId && !model.rows.some(trip => trip.tripId === selectedId)) setSelectedId(null);
  }, [page, model.page, model.rows, selectedId]);
  function changeFilter<K extends keyof AdminFilters>(key: K, value: AdminFilters[K]) {
    setFilters(previous => ({ ...previous, [key]: value })); setPage(1); setSelectedId(null);
  }
  function switchView(next: AdminView) { setView(next); setPage(1); setSelectedId(null); }
  const ready = snapshot.hasLoaded && !model.filterError;
  const queryMessage = snapshot.status === 'loading'
    ? snapshot.hasLoaded ? '새로고침 중입니다. 이전 조회값을 표시합니다.' : '서버 수신 기록을 처음 조회하고 있습니다.'
    : snapshot.status === 'error' ? snapshot.hasLoaded ? '새로고침에 실패했습니다. 이전 조회값을 표시합니다.' : '서버 기록을 조회하지 못했습니다.'
    : snapshot.hasLoaded ? '새로고침을 완료했습니다.' : '서버 기록 조회를 준비합니다.';

  return <section className="admin-panel" aria-label="Fleetlog 비즈 관리자 웹">
    <div className="section-heading"><div><p className="eyebrow">Fleetlog 비즈 · 관리자</p><h1>회사 운행 기록</h1><p className="subtle">서버가 실제 수신한 최신 운행 기록입니다. 현재 출처는 mock입니다.</p></div>
      <button className="button secondary" onClick={onRefresh}>{snapshot.status === 'loading' ? '다시 새로고침' : '서버 기록 새로고침'}</button></div>
    <div className={`notice ${snapshot.status === 'error' ? 'error' : 'neutral'} admin-query-status`} role={snapshot.status === 'error' ? 'alert' : 'status'} aria-live="polite">
      <strong>{queryMessage}</strong>{snapshot.error && <span>{snapshot.error}</span>}
      <span>{snapshot.lastSuccessAt ? `마지막 성공 조회: ${formatKst(snapshot.lastSuccessAt)}` : '성공한 조회가 아직 없습니다.'}</span>
    </div>
    <form className="admin-filters" aria-label="운행 기록 필터" onSubmit={event => event.preventDefault()}>
      <label>시작일 · 한국 날짜<input type="date" value={filters.from} onChange={event => changeFilter('from', event.target.value)} /></label>
      <label>종료일 · 한국 날짜<input type="date" value={filters.to} onChange={event => changeFilter('to', event.target.value)} /></label>
      <label>운행 용도<select value={filters.purpose} onChange={event => changeFilter('purpose', event.target.value as AdminFilters['purpose'])}><option value="all">모든 용도</option><option value="business">일반 업무</option><option value="commute">출퇴근</option><option value="personal">개인 용도</option></select></label>
      <label>용도 입력 상태<select value={filters.unconfirmed} onChange={event => changeFilter('unconfirmed', event.target.value as AdminFilters['unconfirmed'])}><option value="all">전체</option><option value="yes">미확정</option><option value="no">입력됨</option></select></label>
      <label>거리 품질<select value={filters.distance} onChange={event => changeFilter('distance', event.target.value as AdminFilters['distance'])}><option value="all">전체</option><option value="needs">거리 확인 필요</option><option value="valid">유효 거리</option></select></label>
      <label>차량<select value={filters.vehicleId} onChange={event => changeFilter('vehicleId', event.target.value)}><option value="">모든 수신 차량</option>{model.options.vehicleIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>이용자<select value={filters.driverId} onChange={event => changeFilter('driverId', event.target.value)}><option value="">모든 수신 이용자</option>{model.options.driverIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>차량·이용자·메모 검색<input type="search" value={filters.query} placeholder="수신 기록에서 검색" onChange={event => changeFilter('query', event.target.value)} /></label>
      <div className="admin-filter-actions"><button className="button secondary" type="button" onClick={() => { setFilters(defaultFilters()); setPage(1); setSelectedId(null); }}>필터 초기화</button>
        <p className="admin-scope-note">운행 시작 시각 기준 · 한국 표준시(KST). 종료일을 포함하며, 자정을 넘는 운행도 나누지 않습니다. 모든 조건을 함께 적용합니다.</p></div>
    </form>
    {model.filterError && <div className="notice error" role="alert"><strong>기간을 확인해 주세요</strong><span>{model.filterError}</span></div>}
    {ready && <div className="admin-stats" aria-label="현재 필터 범위 요약">
      <div><span>필터에 해당하는 수신 운행</span><strong>{summary.receivedCount}<small>건</small></strong></div>
      <div><span>확인 필요 · 운행 단위</span><strong>{summary.needsReviewCount}<small>건</small></strong><small>용도 {summary.unconfirmedCount}건 / 거리 {summary.invalidDistanceCount}건 · 사유 중복 가능</small></div>
      <div><span>유효 거리 합계</span><strong>{km(summary.validDistanceM)}</strong><small>거리 제외 {summary.excludedDistanceCount}건 · 합산 가능 {summary.validDistanceCount}건</small></div>
    </div>}
    <div className="admin-content" aria-busy={snapshot.status === 'loading'}>
      <div className="admin-toolbar"><nav className="subtabs" aria-label="관리자 보기">{([['records', '전체 기록'], ['exceptions', '확인 필요'], ['summary', '용도별 요약']] as const).map(([id, label]) => <button key={id} className={view === id ? 'selected' : ''} aria-pressed={view === id} onClick={() => switchView(id)}>{label}{id === 'exceptions' && ready && <span className="count">{summary.needsReviewCount}</span>}</button>)}</nav>
        <span className="refresh-time">목록·확인 필요·요약에 같은 필터 적용</span></div>
      {!snapshot.hasLoaded ? <div className="empty"><h2>{snapshot.status === 'error' ? '서버 연결을 확인해 주세요' : '서버 기록을 불러오는 중입니다'}</h2><p>{snapshot.status === 'error' ? '조회 실패는 기록 0건을 뜻하지 않습니다. 서버 연결 후 다시 조회하세요.' : '서버 응답을 받은 뒤 기록과 집계를 표시합니다.'}</p></div>
        : model.filterError ? <div className="empty"><p>기간을 수정하면 목록과 요약을 표시합니다.</p></div>
        : model.allLatest.length === 0 ? <div className="empty"><h2>아직 서버가 수신한 운행이 없습니다</h2><p>차량에서 로컬 저장 후 실제 서버 전송을 완료한 기록만 표시합니다.</p></div>
        : model.filtered.length === 0 ? <div className="empty"><h2>필터에 맞는 기록이 없습니다</h2><p>기간과 조건을 조정하거나 필터를 초기화하세요.</p></div>
        : view === 'summary' ? <AdminSummary summary={summary} />
        : model.total === 0 ? <div className="empty"><h2>이 조건에서 확인 필요한 기록이 없습니다</h2><p>용도 입력과 거리 품질을 각각 기준으로 확인했습니다.</p></div>
        : <><div className="admin-list-heading"><p>{view === 'exceptions' ? '확인 필요 운행' : '수신 운행'} {model.total}건 · 한 화면 10건</p>
          <label>운행 시작 시각 정렬<select value={sort} onChange={event => { setSort(event.target.value as typeof sort); setPage(1); setSelectedId(null); }}><option value="newest">최근 시작순</option><option value="oldest">오래된 시작순</option></select></label></div>
          {view === 'exceptions' && <p className="admin-scope-note">같은 운행에 용도·거리 사유가 겹쳐도 한 건으로 표시합니다. 용도 보완으로 gap이 해소되지는 않습니다.</p>}
          <AdminRecords rows={model.rows} onSelect={setSelectedId} selectedId={selected?.tripId ?? null} />
          <nav className="admin-pagination" aria-label="운행 목록 페이지"><button className="button secondary" disabled={model.page <= 1} onClick={() => { setPage(model.page - 1); setSelectedId(null); }}>이전</button><span>{model.page} / {model.pages} 페이지</span><button className="button secondary" disabled={model.page >= model.pages} onClick={() => { setPage(model.page + 1); setSelectedId(null); }}>다음</button></nav>
          {selected && <AdminDetails trip={selected} onClose={() => setSelectedId(null)} />}
        </>}
    </div>
    <p className="admin-footnote">필터 범위의 서버 수신본 집계입니다. 기간 전체 누락 여부·세무 적격성을 검증하지 않습니다. 관리자 승인·기간 마감·세무신고·보완 요청 발송 기능은 제공하지 않습니다.</p>
  </section>;
}

export function AdminRecords({ rows, onSelect, selectedId }: { rows: StoredTrip[]; onSelect: (id: string) => void; selectedId: string | null }) {
  return <div className="trip-table-wrap admin-records"><table className="trip-table"><caption className="sr-only">서버가 수신한 최신 운행 목록</caption><thead><tr><th scope="col">시작 / 종료 · KST</th><th scope="col">차량 / 이용자</th><th scope="col">운전자 용도 / 메모</th><th scope="col">운행 거리</th><th scope="col">상태</th><th scope="col">상세</th></tr></thead><tbody>{rows.map(trip => {
    const meters = distanceMeters(trip.payload);
    return <tr key={trip.tripId} aria-selected={selectedId === trip.tripId}><td data-label="시작 / 종료"><strong>{formatKst(trip.payload.startedAt)}</strong><small>{formatKst(trip.payload.endedAt)}</small></td><td data-label="차량 / 이용자">{trip.payload.vehicleId}<small>{trip.payload.driverId}</small></td><td data-label="용도 / 메모">{trip.payload.purpose ? purposeLabels[trip.payload.purpose] : '미확정'}<small>{trip.payload.note || '메모 없음'}</small></td><td data-label="거리" className="number">{meters === null ? '거리 확인 필요' : km(meters)}</td><td data-label="상태"><div className="admin-reasons"><span className="badge neutral">서버 수신</span><span className={`badge ${trip.payload.purpose ? 'success' : 'warning'}`}>{trip.payload.purpose ? '용도 입력됨' : '용도 미확정'}</span><span className={`badge ${meters === null ? 'warning' : 'success'}`}>{meters === null ? `거리 확인 필요 · ${trip.payload.quality}` : '유효 거리'}</span></div></td><td data-label="상세"><button className="text-button" aria-expanded={selectedId === trip.tripId} aria-label={`${trip.tripId} 운행 상세`} onClick={() => onSelect(trip.tripId)}>상세 보기</button></td></tr>;
  })}</tbody></table></div>;
}

export function AdminDetails({ trip, onClose }: { trip: StoredTrip; onClose: () => void }) {
  const meters = distanceMeters(trip.payload);
  const difference = Number.isFinite(trip.payload.startOdometerM) && Number.isFinite(trip.payload.endOdometerM) ? trip.payload.endOdometerM - trip.payload.startOdometerM : null;
  return <section className="record-details" aria-label="수신 기록 상세"><div className="detail-heading"><h2>수신 기록 상세</h2><button className="text-button" onClick={onClose}>닫기</button></div>
    <h3 className="admin-detail-section">거리·시각 원본</h3><dl><dt>운행 ID</dt><dd>{trip.tripId}</dd><dt>차량 / 이용자</dt><dd>{trip.payload.vehicleId} / {trip.payload.driverId}</dd><dt>운행 시작</dt><dd>{formatKst(trip.payload.startedAt)}</dd><dt>운행 종료</dt><dd>{formatKst(trip.payload.endedAt)}</dd><dt>시작 누적거리</dt><dd>{raw(trip.payload.startOdometerM)}</dd><dt>종료 누적거리</dt><dd>{raw(trip.payload.endOdometerM)}</dd><dt>원본 차분</dt><dd>{difference === null ? '확인 필요' : raw(difference)}{meters === null && ' · 참고값, 유효 거리 합계에서 제외'}</dd><dt>거리 품질</dt><dd>{trip.payload.quality} · {meters === null ? '거리 확인 필요' : '유효 거리'}</dd></dl>
    <h3 className="admin-detail-section">운전자 용도 입력</h3><dl><dt>용도</dt><dd>{trip.payload.purpose ? purposeLabels[trip.payload.purpose] : '미확정'}</dd><dt>메모</dt><dd>{trip.payload.note || '없음'}</dd><dt>확인 필요 사유</dt><dd>{exceptionReasons(trip).join(' / ') || '해당 없음'}</dd></dl>
    <h3 className="admin-detail-section">서버 최신 수신본</h3><dl><dt>서버 반영 시각</dt><dd>{formatKst(trip.updatedAt)}</dd><dt>서버 버전</dt><dd>{trip.serverVersion}</dd><dt>로컬 리비전</dt><dd>{trip.localRevision}</dd><dt>출처</dt><dd>{trip.source === 'mock' ? 'mock · 가상 차량 데이터' : trip.source}</dd></dl>
    <p className="admin-scope-note">현재 API는 최신 수신본만 제공합니다. 변경 이력 전체를 표시하지 않으며 원본 수정 기능은 없습니다.</p>
  </section>;
}

export function AdminSummary({ summary }: { summary: ReturnType<typeof selectTrips>['summary'] }) {
  return <><div className="trip-table-wrap"><table className="admin-summary-table"><caption>현재 필터 범위 · 용도별 수신본 집계</caption><thead><tr><th scope="col">운전자 용도</th><th scope="col">수신 운행</th><th scope="col">유효 거리 합계</th><th scope="col">거리 제외</th></tr></thead><tbody>{summary.groups.map(group => <tr key={group.key}><th scope="row">{group.label}</th><td>{group.count}건</td><td>{group.count === 0 ? '수신 기록 없음' : km(group.validDistanceM)}</td><td>{group.excludedDistanceCount}건</td></tr>)}</tbody></table></div>
    <div className="notice neutral"><strong>수신 {summary.receivedCount}건 · 거리 제외 {summary.excludedDistanceCount}건</strong><span>거리 확인이 필요한 기록은 0km로 바꾸지 않고 합계에서 제외합니다. 용도가 미확정이어도 거리 품질이 유효하면 해당 용도 그룹의 합계에 포함합니다.</span></div></>;
}
