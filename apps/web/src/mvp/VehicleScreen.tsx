import { useEffect, useRef, useState } from 'react';
import { qrSvg } from './qr.mjs';
import type { Qr, ServerState } from './workflow-types';
import './vehicle.css';

function CarIcon() {
  return <svg className="vehicle-car-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M8 19 12 10a4 4 0 0 1 4-2h17a4 4 0 0 1 4 3l4 10v14H7V23l1-4Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/><path d="M9 21h30" stroke="currentColor" strokeWidth="4"/><circle cx="15" cy="35" r="6" fill="currentColor"/><circle cx="34" cy="35" r="6" fill="currentColor"/></svg>;
}
function Mark({ clock = false }: { clock?: boolean }) {
  return clock ? <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="15" stroke="currentColor" strokeWidth="3.5"/><path d="M20 10v11l7 5" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"/></svg>
    : <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="m9 20 7 7 16-17" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
const shortTime = (value: string) => new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value));
const identifier = () => globalThis.crypto?.randomUUID?.() ?? `car-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const validity = (qr?: Qr) => qr?.validForMs && qr.validForMs !== 600000
  ? `${Math.ceil(qr.validForMs / 1000)}초간 유효 · 한 번만 사용` : '10분간 유효 · 한 번만 사용';

export function VehicleScreen({ state, vehicleId, qr, error, onRefresh }:
  { state?: ServerState; vehicleId: string; qr?: Qr; error: string; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const guard = useRef(false);
  const vehicle = state?.vehicles.find(item => item.id === vehicleId);
  const connection = vehicle?.connection ?? qr?.connection;
  const runtime = state?.vehicleRuntime?.find(item => item.vehicleId === vehicleId);
  const parking = error ? 'unknown' : runtime?.parking ?? 'unknown';
  const parked = parking === 'parked';
  const trip = state?.activeTrips.find(item => item.vehicleId === vehicleId);
  const employee = state?.employees.find(item => item.id === connection?.employeeId);
  const conversation = state?.conversations.find(item => item.connectionId === connection?.id && item.isCurrent);
  const candidate = trip?.candidateEnd;
  const observedOdometer = candidate?.endOdometerM ?? trip?.lastObservedOdometerM ?? trip?.endOdometerM;
  const hasObservation = !!trip && typeof observedOdometer === 'number' && observedOdometer > trip.startOdometerM;
  const distanceValid = hasObservation && trip?.quality === 'complete' && !trip.hasGap;
  const distance = distanceValid ? ((observedOdometer! - trip!.startOdometerM) / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : null;
  const pending = state?.pendingUploads.filter(item => item.vehicleId === vehicleId && item.status !== 'received').length ?? 0;
  const session = runtime?.sessionActive ?? false;
  const dialogue = !!candidate && !!conversation;
  useEffect(() => { setMessage(''); }, [vehicleId, connection?.id, conversation?.id]);

  async function command(type: string) {
    if (guard.current || !connection || !parked) return;
    guard.current = true;setBusy(true);setMessage('');
    try {
      const response = await fetch('/mvp-api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: identifier(), connectionId: connection.id, type,
          tripId: trip?.id ?? '', conversationId: trip?.conversationId ?? '' }) });
      if (!response.ok) throw new Error('상태를 확인해 주세요. 자세한 안내는 시연 패널에서 확인할 수 있습니다.');
      onRefresh();
    } catch { setMessage('처리하지 못했습니다. 시연 패널에서 상태를 확인해 주세요.');onRefresh(); }
    finally { guard.current = false;setBusy(false); }
  }
  function check() { setMessage('서버에서 연결 상태를 다시 확인합니다.');onRefresh(); }

  if (parking === 'driving') return <main className="mvp-car-screen vehicle-screen vehicle-driving" data-connected={!!connection} data-driving="true" aria-label="Fleetlog 차량 화면" />;

  let title = '이번 운행을 마칠까요';
  let description = '마치면 운행 용도를 한 번 묻습니다.';
  if (!session) { title = '기록이 중지되어 있습니다';description = '다시 기록하려면 주차 중에 시작해 주세요.'; }
  else if (!trip) { title = '출발을 기다리고 있습니다';description = '아직 시작한 운행이 없습니다.'; }
  else if (dialogue) {
    title = conversation?.phase === 'awaiting_confirmation' ? '운행 용도를 확인해 주세요' : '운행 용도를 확인하고 있습니다';
    description = ['question', 'confirmation'].includes(conversation?.phase ?? '') ? '음성 안내를 진행하고 있습니다.' : '운행 목적을 확인한 뒤 자동으로 저장합니다.';
  }
  const activeFooter = !trip ? session ? '수집 대기' : '수집 중지' : distanceValid ? '거리 수집 정상' : '거리 확인 필요';

  return <main className="mvp-car-screen vehicle-screen" data-connected={!!connection} data-driving="false" data-parking={parking} aria-label="Fleetlog 차량 화면">
    <header className="vehicle-screen-header"><div className="vehicle-brand"><CarIcon /><strong>Fleetlog 운행기록</strong><small>MVP · 모의 차량</small></div>
      <div className={`vehicle-parking-badge ${parked ? '' : 'unknown'}`}>{parked && <Mark />}<span>{parked ? '주차 확인됨' : '주차 상태 확인 필요'}</span></div>
    </header>
    {!parked ? <section className="vehicle-unknown"><h1>차량 상태를 확인하고 있습니다</h1><p>주차가 확인되면 연결과 운행 화면을 표시합니다.</p><p>자세한 상태는 시연 패널에서 확인해 주세요.</p></section>
      : !connection ? <section className="vehicle-connection-layout">
        <div className="vehicle-connection-copy"><div><h1>회사와 이 차량을 연결해 주세요</h1><p className="vehicle-introduction">휴대폰으로 QR을 찍고 회사 계정으로 승인하면 연결됩니다.</p>
          <ul className="vehicle-readiness"><li className="good"><Mark /><span>네트워크 연결됨</span></li><li className={runtime?.distanceAvailable ? 'good' : 'waiting'}><Mark clock={!runtime?.distanceAvailable} /><span>{runtime?.distanceAvailable ? '주행거리 사용 가능' : '주행거리 확인 필요'} <small>· 모의 값</small></span></li><li className="waiting"><Mark clock /><span>회사 연결을 기다리는 중</span></li></ul>
          {message && <p className="vehicle-inline-message" role="status">{message}</p>}
        </div><div className="vehicle-connection-actions"><button className="vehicle-button primary" onClick={check}>연결 완료</button><button className="vehicle-button secondary" onClick={check}>다시 확인</button></div></div>
        <div className="vehicle-qr-card">{qr?.status === 'available' && qr.url ? <><div className="mvp-qr" role="img" aria-label="운전자 연결 QR" data-qr-url={qr.url} dangerouslySetInnerHTML={{ __html: qrSvg(qr.url) }} />
          <p>QR이 안 되면 연결 코드 입력</p><strong className="vehicle-connection-code">{qr.code || '코드 확인 중'}</strong><p className="vehicle-qr-validity">{validity(qr)}</p></>
          : <p role="status">서버에서 QR을 확인하고 있습니다.</p>}</div>
      </section> : <section className="vehicle-trip-layout">
        <div className="vehicle-trip-card"><div><p className="vehicle-section-label">이번 구간</p><div className={`vehicle-distance ${trip && !distanceValid ? 'unavailable' : ''}`}>
          <strong>{trip ? distance ?? '확인 필요' : '—'}</strong>{(!trip || distance !== null) && <span>km</span>}</div>
          <p className="vehicle-driver-name">{employee?.name || '운전자 확인 중'}</p>
          <p className="vehicle-trip-origin">{trip ? `${shortTime(trip.startedAt)} 출발 · 계기판 거리 기준` : '아직 출발하지 않았습니다'}</p>
          <p className="vehicle-mock-distance">모의 누적거리 기준{vehicle && ` · ${vehicle.name}`}</p>
        </div><ul className="vehicle-collection-state"><li className={distanceValid ? 'good' : 'muted'}>{distanceValid ? <Mark /> : <Mark clock />}<span>{activeFooter}</span></li>
          <li className={pending > 0 ? 'waiting' : 'muted'}><Mark clock /><span>회사 전송 대기 {pending}건</span></li></ul></div>
        <div className="vehicle-trip-actions"><div><h1>{title}</h1><p className="vehicle-introduction">{description}</p>
          {message && <p className="vehicle-inline-message" role="status">{message}</p>}</div>
          <div className="vehicle-trip-buttons">{!session ? <button className="vehicle-button primary" disabled={busy} onClick={() => void command('start_session')}>기록 시작</button>
            : <button className="vehicle-button primary" disabled={busy || !hasObservation || dialogue} onClick={() => void command('finish')}>운행 마치기</button>}
            <button className="vehicle-button secondary" disabled={busy || !trip || !session} onClick={() => void command('continue')}>계속 운행</button>
            <button className="vehicle-stop-button" disabled={busy || !session} onClick={() => void command('stop_session')}>기록 종료</button>
          </div></div>
      </section>}
  </main>;
}
