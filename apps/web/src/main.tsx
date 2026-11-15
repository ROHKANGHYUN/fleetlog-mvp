import { createRoot } from 'react-dom/client';
import { FleetController } from '../../../packages/domain/index.mjs';
import App from './App';
import MvpApp from './mvp/MvpApp';
import './styles.css';

const element = document.getElementById('root');
if (!element) throw new Error('앱 루트 요소를 찾지 못했습니다.');
const root = createRoot(element);

function StartupNotice({ title, detail, retry = true }: { title: string; detail: string; retry?: boolean }) {
  return <main className="startup-error"><p className="eyebrow">Fleetlog · 웹 MOCK</p><h1>{title}</h1><div className="notice neutral" role="status">{detail}</div><p>기존 로컬 기록을 자동으로 지우거나 덮어쓰지 않습니다.</p>{retry && <button className="button secondary" onClick={() => window.location.reload()}>다시 불러오기</button>}</main>;
}

if (window.location.pathname === '/mvp' || window.location.pathname.startsWith('/mvp/')) {
  // MVP connection views use only their separate server; no recording controller or writer lock.
  root.render(<MvpApp />);
} else {
root.render(<StartupNotice title="기록 저장소를 준비하고 있습니다" detail="다른 탭에서 사용 중인지 확인합니다." retry={false} />);

if (!navigator.locks?.request) {
  root.render(<StartupNotice title="지원 브라우저로 열어 주세요" detail="안전한 단일 탭 저장을 위해 Web Locks 지원이 필요합니다. 최신 Chrome에서 localhost 주소로 접속해 주세요. 이 브라우저에서는 기록을 시작하지 않습니다." />);
} else {
  void navigator.locks.request('fleetlog-writer-v1', { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) {
      root.render(<StartupNotice title="다른 탭에서 Fleetlog를 사용 중입니다" detail="동시에 기록을 변경하지 않도록 이 탭을 잠갔습니다. 먼저 열었던 탭을 닫은 뒤 다시 불러와 주세요." />);
      return;
    }
    try {
      const controller = new FleetController();
      root.render(<App controller={controller} />);
    } catch (cause) {
      root.render(<StartupNotice title="저장한 데이터를 확인해 주세요" detail={`${cause instanceof Error ? cause.message : '브라우저 저장소를 열지 못했습니다.'} 저장소 접근 설정을 확인하고, 손상된 데이터는 백업한 뒤 복구해 주세요.`} />);
      return;
    }
    // Keep the writer lock for this document's lifetime. Closing/reloading the tab
    // releases it in the browser; no second controller can write concurrently.
    await new Promise<void>(() => {});
  }).catch(cause => {
    root.render(<StartupNotice title="기록 저장소를 열지 못했습니다" detail={cause instanceof Error ? cause.message : '단일 탭 잠금을 확보하지 못해 기록을 시작하지 않았습니다.'} />);
  });
}
}
