import { useEffect, useState, type ReactNode } from 'react';
import type { FleetController, FleetState } from '../../../packages/domain/index.mjs';
import { useVoiceInput } from './voice/useVoiceInput';
import type { MockVoiceMode } from './voice/mock-adapter.mjs';
import { AdminPanel } from './AdminPanel';
import { deliveryStatus } from './delivery.mjs';
import { dateLabel, distanceKm, purposeLabels, type Purpose } from './types';

type ActionError = { title: string; detail: string } | null;

export default function App({ controller }: { controller: FleetController }) {
  const [state, setState] = useState<FleetState>(() => controller.getState());
  // These are view controls only. Recording, drafts and delivery live in the controller.
  const [tab, setTab] = useState<'car' | 'admin'>('car');
  const [narrow, setNarrow] = useState(false);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState<ActionError>(null);
  const [voiceMode, setVoiceMode] = useState<MockVoiceMode>('ok');
  const [voiceText, setVoiceText] = useState('일반 업무, 거래처 미팅');
  const [stopDialog, setStopDialog] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { voice, flow, adapter } = useVoiceInput(controller, tab === 'car' && !stopDialog);
  const cancelVoice = () => flow.cancel();

  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => {
    if (state.driving || tab !== 'car') setStopDialog(false);
  }, [state.driving, tab]);

  async function perform(action: () => unknown | Promise<unknown>, failureTitle = '처리하지 못했습니다', success = '') {
    setActionError(null);
    setMessage('');
    try {
      await action();
      if (success) setMessage(success);
      return true;
    } catch (cause) {
      setActionError({ title: failureTitle, detail: cause instanceof Error ? cause.message : '다시 시도해 주세요.' });
      return false;
    }
  }

  function startVoice() {
    adapter.configure({ mode: voiceMode, text: voiceText });
    flow.start();
  }

  function changeTab(next: 'car' | 'admin') {
    cancelVoice();
    setTab(next);
    setActionError(null);
    setMessage('');
    window.scrollTo(0, 0);
  }

  async function sync() {
    if (!await perform(() => controller.sync(), '전송 상태를 저장하지 못했습니다')) return;
    const latest = controller.getState();
    // sync() can resolve while preserving failed/conflicting events. Only ACK state is success.
    if (latest.outbox.some(event => event.status === 'conflict')) setMessage('버전 충돌이 남아 있습니다. 해당 기록의 전송을 멈췄습니다.');
    else if (latest.outbox.some(event => event.status === 'blocked')) setMessage('원인 확인이 필요한 전송 오류가 있습니다. 해당 기록과 후속 변경을 보존하고 전송을 보류했습니다.');
    else if (latest.outbox.some(event => event.lastError)) setMessage('전송하지 못한 기록이 있습니다. 기록은 이 기기에 보관됩니다.');
    else if (latest.outbox.length) setMessage('전송 대기 기록이 남아 있습니다. 연결 상태를 확인해 주세요.');
    else setMessage('저장된 기록의 서버 수신을 모두 확인했습니다.');
    setRefreshKey(key => key + 1);
  }

  const editing = state.records.find(record => record.tripId === state.editingTripId);
  const saved = state.records.find(record => record.tripId === state.lastSavedTripId);
  const pending = state.records.filter(record => record.payload.purpose === null);
  const draft = state.draft;
  const currentDistance = editing ? distanceKm(editing.payload) : state.current ? distanceKm({
    quality: state.current.quality,
    startOdometerM: state.current.startOdometerM,
    endOdometerM: state.current.candidateEnd?.endOdometerM ?? state.odometerM,
  }) : 0;
  const hasUnfinished = !!state.current && state.odometerM > state.current.startOdometerM;
  const statuses = state.records.map(record => deliveryStatus(state, record));
  const conflicts = statuses.filter(status => status.kind === 'conflict').length;
  const blocked = statuses.filter(status => status.kind === 'blocked').length;
  const failures = statuses.filter(status => status.kind === 'failed').length;
  const undelivered = state.records.filter(record => record.ackedLocalRevision < record.localRevision).length;
  const canSync = state.outbox.some(event => event.status === 'queued' &&
    (!event.predecessorEventId || state.receipts[event.predecessorEventId]));
  const heading = (overline: string, title: string, description?: string) => <div className="screen-heading">
    <p className="car-eyebrow">{overline}</p><h2>{title}</h2>
    {description && <p className="car-description">{description}</p>}
  </div>;
  const actions = (...buttons: ReactNode[]) => <div className="car-actions">{buttons}</div>;
  const action = (label: string, handler: () => unknown, primary = false, disabled = false, failureTitle?: string) =>
    <button key={label} className={`car-button ${primary ? 'primary' : ''}`} disabled={disabled}
      onClick={() => void perform(handler, failureTitle)}>{label}</button>;
  const metric = <div className="drive-metric">
    <div><span>이번 운행 거리</span><strong>{currentDistance === null ? '거리 확인 필요' : currentDistance.toFixed(1)}{currentDistance !== null && <small>km</small>}</strong></div>
    <div className="metric-context"><span>모의 차량 데이터</span><span>{state.driving ? '주행 중' : '주차 중'}</span></div>
  </div>;
  const sessionEnd = <button className="car-text-button" onClick={() => { cancelVoice(); setActionError(null); setStopDialog(true); }}>기록 세션 종료</button>;

  function carContent() {
    if (state.driving) return <>
      {heading(state.active ? '주행 중 · 기록 수집 중' : '주행 중 · 수집 중지', '운전에 집중해 주세요',
        state.active ? '운행을 기록하고 있습니다.' : '기록이 시작되지 않았습니다. 주차 후 시작해 주세요.')}
      {state.active && metric}
      <p className="car-footnote">주행 중에는 용도·메모·음성 입력과 기록 종료를 할 수 없습니다.</p>
    </>;

    if (stopDialog) return <>
      {heading('수집 세션 종료', '기록 수집을 종료할까요?', '‘운행 마치기’는 한 운행만, ‘세션 종료’는 수집 전체를 끝냅니다.')}
      <div className="car-notice">
        <strong>{hasUnfinished ? '미완료 운행은 미확정으로 보관합니다.' : '저장한 운행은 그대로 보관합니다.'}</strong>
        <p>다음 수집은 ‘운행 기록 시작’을 눌러야 시작됩니다.</p>
      </div>
      {actions(action('기록 세션 종료하기', () => { controller.stop(); setStopDialog(false); }, true, false, '기록 세션을 종료하지 못했습니다'),
        action('계속 기록하기', () => setStopDialog(false)))}
    </>;

    if (state.screen === 'ready') return <>
      {heading('시작 전 · 수집 중지', '출발 전에, 기록을 시작하세요', '말 한마디로, 운행 기록은 Fleetlog.')}
      <div className="identity-grid">
        <div className="identity-item"><span>이용자 · 모의 정보</span><strong>샘플 이용자</strong></div>
        <div className="identity-item"><span>차량 · 모의 정보</span><strong>샘플 법인차량</strong></div>
      </div>
      {actions(action('운행 기록 시작', () => controller.start(), true), action(`미확정 기록 ${pending.length}건`, () => controller.showPending()))}
      <p className="car-footnote">직접 시작하기 전에는 운행을 수집하지 않습니다.</p>
    </>;

    if (state.screen === 'collecting') return <>
      {heading('주차 중 · 수집 세션 유지', hasUnfinished ? '이번 운행을 마칠까요?' : '출발할 준비가 됐습니다',
        hasUnfinished ? '잠깐 주차했다면 그대로 이어서 운행하세요.' : '출발하면 새 운행을 기록합니다.')}
      {metric}
      {actions(action('운행 마치기', () => controller.finish(), true, !hasUnfinished),
        action(`미확정 기록 ${pending.length}건`, () => controller.showPending()))}
      {sessionEnd}
    </>;

    if (state.screen === 'purpose') {
      if (['prompting', 'listening', 'processing'].includes(voice.phase)) return <>
        {heading('모의 음성 입력', voice.phase === 'prompting' ? '어떤 용도로 운행하셨나요?' : voice.phase === 'processing' ? '결과를 정리하고 있습니다' : '말씀을 기다리고 있습니다', '실제 마이크나 음성인식은 사용하지 않습니다.')}
        <div className={`voice-stage ${voice.phase}`} aria-live="polite">
          <div className="voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <strong>{voice.phase === 'prompting' ? '질문 안내 중' : voice.phase === 'processing' ? '최종 결과 처리 중' : '개발용 제어에서 모의 결과를 전달하세요'}</strong>
          {voice.interim && <div className="voice-transcript"><span>중간 결과 · 저장되지 않습니다</span><p>{voice.interim}</p></div>}
          <span>최종 결과도 사용자 확인 전에는 저장하지 않습니다.</span>
        </div>
        {actions(action('음성 입력 취소', cancelVoice))}
      </>;
      const voiceErrors = { failed: '음성을 인식하지 못했습니다', empty: '인식된 문장이 없습니다', timeout: '음성 입력 시간이 초과됐습니다', unavailable: '음성을 사용할 수 없습니다', 'draft-failed': '음성 초안을 반영하지 못했습니다' };
      return <>
        {heading(state.editingTripId ? '미확정 기록 보완' : '운행 용도', '어떤 운행이었나요?', '용도를 선택하고 요약을 확인해 주세요.')}
        {voice.phase === 'error' && <div className="car-notice warning" role="status"><strong>{voiceErrors[voice.error ?? 'failed']}</strong><p>직접 입력하거나 다시 시도하세요. 미확정 보관도 가능합니다.</p></div>}
        {voice.phase === 'draft' && <div className="voice-transcript" role="status"><span>인식한 문장 · 모의 결과</span><p>{voice.transcript}</p>
          <strong>{voice.reason === 'matched' ? '음성 초안입니다. 확인·수정 후 저장해 주세요.' : voice.reason === 'too-long' ? '메모가 너무 깁니다. 아래에 120자 이내로 입력해 주세요.' : '용도를 하나로 확인할 수 없습니다. 직접 선택해 주세요.'}</strong></div>}
        {voice.cancelReason === 'user' && <p className="inline-status" role="status">음성 입력을 취소했습니다. 직접 입력할 수 있습니다.</p>}
        <div className="purpose-options" role="group" aria-label="운행 용도">
          {(Object.keys(purposeLabels) as Purpose[]).map(purpose => <button key={purpose}
            className={draft?.purpose === purpose ? 'selected' : ''} aria-pressed={draft?.purpose === purpose}
            onClick={() => void perform(() => controller.setPurpose(purpose, draft?.note ?? ''))}>{purposeLabels[purpose]}</button>)}
        </div>
        <label className="car-field">운행 메모 <span>선택 · 최대 120자</span>
          <input value={draft?.note ?? ''} maxLength={120} placeholder="예: 거래처 미팅"
            onChange={event => void perform(() => controller.setPurpose(draft?.purpose ?? null, event.target.value))} />
        </label>
        {actions(action('요약 확인', () => { cancelVoice(); controller.review(); }, true, !draft?.purpose),
          action(voice.phase === 'error' ? '음성 다시 입력' : '음성으로 입력', startVoice))}
        <div className="car-secondary-actions">
          <button onClick={() => void perform(() => { cancelVoice(); controller.defer(); }, '미확정 기록을 저장하지 못했습니다')}>미확정으로 보관</button>
          <button onClick={() => void perform(() => { cancelVoice(); controller.continueDriving(); })}>{state.editingTripId ? '목록으로 돌아가기' : '계속 운행'}</button>
        </div>
      </>;
    }

    if (state.screen === 'review') return <>
      {heading('저장 전 확인', '이 내용으로 남길까요?', '확인하면 이 기기에 저장합니다.')}
      <dl className="review-card">
        <dt>운행 거리</dt><dd>{currentDistance === null ? '거리 확인 필요' : `${currentDistance.toFixed(1)} km`}</dd>
        <dt>용도</dt><dd>{draft?.purpose ? purposeLabels[draft.purpose] : '미확정'}</dd>
        <dt>메모</dt><dd>{draft?.note || '없음'}</dd>
      </dl>
      {actions(action('확인하고 저장', () => { cancelVoice(); controller.save(); }, true, false, '이 기기에 저장하지 못했습니다'),
        action('수정', () => { controller.setPurpose(draft?.purpose ?? null, draft?.note ?? ''); }))}
      <p className="car-footnote">서버 전송은 로컬 저장 후 별도로 진행합니다.</p>
    </>;

    if (state.screen === 'saved') {
      const delivery = saved ? deliveryStatus(state, saved) : null;
      return <>
        {heading('로컬 저장 완료', '이 기기에 저장했습니다', state.active ? '수집 세션은 유지됩니다. 출발하면 다음 운행을 기록합니다.' : '수집은 중지되어 있습니다. 다음 수집은 직접 시작해 주세요.')}
        <div className="saved-card"><span className="saved-check" aria-hidden="true">✓</span><div>
          <strong>{saved?.payload.purpose ? purposeLabels[saved.payload.purpose] : '용도 미확정'}</strong>
          <span>{saved && distanceKm(saved.payload) !== null ? `${distanceKm(saved.payload)?.toFixed(1)} km` : '거리 확인 필요'}</span>
        </div></div>
        {delivery && <div className="delivery-detail" role="status"><span className={`record-status ${delivery.tone}`}>{delivery.label}</span><p>{delivery.detail}</p></div>}
        {actions(action('확인', () => controller.home(), true), action(`미확정 기록 ${pending.length}건`, () => controller.showPending()))}
        {state.active && sessionEnd}
      </>;
    }

    if (state.screen === 'pending') return <>
      {heading('나중에 보완', '미확정 운행 기록', '주차 중에 운행 용도를 확인해 주세요.')}
      {hasUnfinished && <div className="car-notice warning"><strong>현재 운행을 먼저 마쳐 주세요</strong><p>아래 기록은 보관되어 있습니다. 운행을 마친 뒤 보완할 수 있습니다.</p></div>}
      {pending.length ? <div className="pending-list">{pending.map(record => {
        const delivery = deliveryStatus(state, record);
        const blocked = delivery.kind === 'conflict' || delivery.kind === 'blocked';
        const km = distanceKm(record.payload);
        return <div className="pending-row" key={record.tripId}>
          <div className="pending-meta"><strong>{dateLabel(record.payload.startedAt)}</strong>
            <span>{km === null ? '거리 확인 필요' : `${km.toFixed(1)} km`}</span>
            <span className={`record-status ${delivery.tone}`}>{delivery.label}</span>
            {blocked && <p className="pending-reason">{delivery.kind === 'conflict' ? '서버 버전 충돌로 보완을 멈췄습니다.' : '전송 오류로 보완을 멈췄습니다.'} 개발 담당자의 확인이 필요합니다.</p>}
          </div>
          <button className="car-button" disabled={hasUnfinished || blocked}
            onClick={() => void perform(() => { controller.editTrip(record.tripId); })}>용도 확인</button>
        </div>;
      })}</div> : <div className="empty car-empty"><span className="saved-check" aria-hidden="true">✓</span><h3>미확정 기록이 없습니다</h3><p>나중에 보관한 운행은 이곳에서 보완하세요.</p></div>}
      {actions(action(hasUnfinished ? '현재 운행으로 돌아가기' : '돌아가기', () => controller.home(), pending.length === 0 || hasUnfinished))}
    </>;
    return <>{heading('기록 상태', '상태를 확인해 주세요')}{actions(action('처음으로', () => controller.home(), true))}</>;
  }

  const errorNotice = actionError ? <div className="notice error car-alert" role="alert">
    <strong>{actionError.title}</strong><span>{actionError.detail}</span>
    {state.screen === 'review' && <span>아직 저장되지 않았습니다. 입력 내용을 확인한 뒤 다시 시도해 주세요.</span>}
  </div> : state.lastError ? <div className="notice warning car-alert" role="status"><strong>기록 상태를 확인해 주세요</strong><span>{state.lastError}</span></div> : null;

  return <div className="app-shell">
    <header className="app-header">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); changeTab('car'); }} aria-label="Fleetlog 차량 화면">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span className="brand-copy">Fleetlog</span>
      </a>
      <span className="development-label">공모전 프로토타입 <span className="badge neutral">MOCK</span></span>
    </header>
    <div className="workspace-nav"><nav aria-label="작업 공간">
      <button className={tab === 'car' ? 'active' : ''} aria-pressed={tab === 'car'} onClick={() => changeTab('car')}>차량 화면</button>
      <button className={tab === 'admin' ? 'active' : ''} aria-pressed={tab === 'admin'} onClick={() => changeTab('admin')}>Fleetlog 비즈</button>
    </nav><span className={`connection ${state.online ? 'online' : ''}`}><i aria-hidden="true" />{state.online ? '온라인 모의' : '오프라인 모의'}</span></div>
    <main className="workspace">
      {tab === 'car' ? <>
        <div className="prototype-intro"><div><h1>말 한마디로, 운행 기록은 Fleetlog.</h1><p className="subtle">차량 화면을 미리 경험하는 웹 시뮬레이터</p></div><span className="badge neutral">가상 데이터 · 실차 미연결</span></div>
        <div className="prototype-layout">
          <div className="vehicle-stage">
            <div className={`vehicle-preview ${narrow ? 'narrow' : ''}`}>
              <section className="vehicle-app" aria-label="차량 앱 영역">
                <header className="vehicle-header"><strong>Fleetlog</strong><div className="vehicle-status"><span className={`status-indicator ${state.active ? 'active' : ''}`} aria-hidden="true" /><span>{state.active ? '수집 세션 켜짐' : '수집 중지'}</span><span className="badge neutral">MOCK</span></div></header>
                <div className="vehicle-content">{errorNotice}{carContent()}</div>
              </section>
            </div>
            <section className="sync-panel" aria-label="로컬 저장과 서버 전송">
              <div><p className="eyebrow">기록 전달</p><h2>로컬 저장과 서버 수신은 별도입니다</h2>
                <p className="sync-counts">저장 {state.records.length}건 · 미전송 {undelivered}건{failures > 0 && ` · 전송 실패 ${failures}건`}{conflicts > 0 && ` · 버전 충돌 ${conflicts}건`}{blocked > 0 && ` · 오류 보류 ${blocked}건`}</p>
              </div>
              <button className="button secondary" disabled={!state.online || state.syncing || !canSync} onClick={() => void sync()}>{state.syncing ? '수신 확인 중…' : failures > 0 ? '서버 전송 다시 시도' : '서버로 전송'}</button>
              {!state.online && undelivered > 0 && <p className="sync-feedback">오프라인 모의 상태입니다. 온라인으로 전환한 뒤 전송해 주세요.</p>}
              {conflicts > 0 && <p className="sync-warning" role="status">버전 충돌 기록은 자동으로 덮어쓰지 않습니다. 해당 기록과 후속 변경의 전송을 멈췄습니다.</p>}
              {blocked > 0 && <p className="sync-warning" role="status">요청 형식·권한·응답 오류의 원인 확인이 필요합니다. 해당 기록은 반복 전송하지 않고 보존합니다.</p>}
              {state.syncError && <p className="sync-feedback error" role="alert">{state.syncError}</p>}
              {message && <p className="sync-feedback" role="status" aria-live="polite">{message}</p>}
            </section>
          </div>
          <aside className="simulator" aria-label="개발용 제어">
            <div className="dev-heading"><span className="eyebrow">시뮬레이터</span><h2>개발용 제어</h2><p>차량 앱 밖의 테스트 도구입니다.</p></div>
            <div className="simulator-controls">
              <fieldset><legend>차량 상태</legend><div className="segmented">
                <button aria-pressed={!state.driving} className={!state.driving ? 'selected' : ''} onClick={() => void perform(() => { cancelVoice(); controller.setDriving(false); })}>주차</button>
                <button aria-pressed={state.driving} className={state.driving ? 'selected' : ''} onClick={() => void perform(() => { cancelVoice(); setStopDialog(false); controller.setDriving(true); })}>주행</button>
              </div></fieldset>
              <fieldset><legend>통신 상태</legend><div className="segmented">
                <button className={state.online ? 'selected' : ''} aria-pressed={state.online} onClick={() => void perform(() => controller.setOnline(true))}>온라인</button>
                <button className={!state.online ? 'selected' : ''} aria-pressed={!state.online} onClick={() => void perform(() => controller.setOnline(false))}>오프라인</button>
              </div></fieldset>
              <fieldset><legend>앱 창</legend><div className="segmented">
                <button className={!narrow ? 'selected' : ''} aria-pressed={!narrow} onClick={() => setNarrow(false)}>넓게</button>
                <button className={narrow ? 'selected' : ''} aria-pressed={narrow} onClick={() => setNarrow(true)}>좁게</button>
              </div></fieldset>
              <label className="select-label">모의 음성 결과<select value={voiceMode} onChange={event => setVoiceMode(event.target.value as MockVoiceMode)}>
                <option value="ok">정상 결과</option><option value="failed">인식 실패</option><option value="empty">결과 없음</option><option value="timeout">시간 초과</option><option value="unavailable">사용 불가</option>
              </select></label>
              <label className="select-label">모의 인식 문장<input value={voiceText} onChange={event => setVoiceText(event.target.value)} /></label>
              <div className="voice-dev-actions"><button className="button secondary" disabled={voice.phase !== 'listening'} onClick={() => adapter.preview()}>중간 결과 전달</button>
                <button className="button secondary" disabled={voice.phase !== 'listening'} onClick={() => adapter.complete()}>최종 결과 전달</button></div>
            </div>
            <p className="simulation-caption">처음부터 시연하려면 새 시연 서버와 새 시크릿 창을 여세요. 기존 저장 기록은 지우지 않습니다.</p>
            <p className="simulation-caption">주행 전환 시 모의 거리 23.4km가 추가됩니다. 음성은 모의 결과이며 마이크를 사용하지 않습니다.</p>
          </aside>
        </div>
      </> : <><AdminPanel refreshKey={refreshKey} />{errorNotice}</>}
    </main>
    <footer className="app-footer"><span>Fleetlog · 웹 MOCK 프로토타입</span><span>Android 차량 앱과 별도 클라이언트 · 실제 SDK / 인증 / 세무신고 미연결</span></footer>
  </div>;
}
