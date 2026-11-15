// Dev-only QA entry. Not imported by index.html and not included in the production bundle.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FleetController, MemoryStorage } from '../../../packages/domain/index.mjs';
import type { StoredTrip } from '../../../packages/contracts/index.mjs';
import App from '../src/App';
import '../src/styles.css';

const storage = new MemoryStorage();
let storageFails = false, networkFails = false, conflict = false;
const mockServer = new Map<string, StoredTrip>();
// Keep the administrator fixture isolated from the real local API as well.
window.fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === location.origin && url.pathname === '/api/trips') {
    if (networkFails) throw new Error('검증용 서버 조회 실패');
    return Response.json({ trips: [...mockServer.values()] });
  }
  throw new Error('검증 화면에서는 모의 관리자 조회만 허용합니다.');
};
const controller = new FleetController({
  storage: {
    getItem: key => storage.getItem(key),
    setItem: (key, value) => { if (storageFails) throw new Error('검증용 저장 공간 오류'); storage.setItem(key, value); },
    removeItem: key => storage.removeItem(key),
  },
  sendEvent: async event => {
    if (conflict) throw Object.assign(new Error('검증용 버전 충돌'), { status: 409 });
    if (networkFails) throw new Error('검증용 연결 실패');
    mockServer.set(event.tripId, { tripId: event.tripId, localRevision: event.localRevision,
      serverVersion: event.expectedServerVersion + 1, source: 'mock', payload: structuredClone(event.payload), updatedAt: new Date().toISOString() });
    return { eventId: event.eventId, ackedLocalRevision: event.localRevision, serverVersion: event.expectedServerVersion + 1 };
  },
});
const history: unknown[] = [];
function report() {
  const state = controller.getState();
  const controls = [...document.querySelectorAll<HTMLElement>('.vehicle-app button, .vehicle-app input')];
  const shown = controls.filter(node => node.getClientRects().length);
  const small = shown.filter(node => node.getBoundingClientRect().height < 56).map(node => node.textContent || node.getAttribute('aria-label') || node.tagName);
  const overflow = [...document.querySelectorAll<HTMLElement>('.vehicle-app *')].filter(node => {
    const r = node.getBoundingClientRect(), container = document.querySelector('.vehicle-app')!.getBoundingClientRect();
    return r.width > 0 && (r.right > container.right + 1 || r.left < container.left - 1);
  }).map(node => node.tagName + '.' + node.className);
  parent.postMessage({ type: 'report', value: { view: document.querySelector('.vehicle-content h2')?.textContent, viewport: `${innerWidth}×${innerHeight}`, pageWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, undersizedVehicleControls: small, overflowingVehicleElements: overflow, screen: state.screen, driving: state.driving, active: state.active, saved: state.records.length, queued: state.outbox.length, draft: state.draft, candidateEnd: state.current?.candidateEnd ?? null, latestRecord: state.records.at(-1) ?? null, actionAlert: document.querySelector('[role="alert"]')?.textContent ?? null, lastTransitions: history.slice(-8) } }, location.origin);
}
controller.subscribe(state => { history.push({ screen: state.screen, driving: state.driving, active: state.active, saved: state.records.length }); requestAnimationFrame(report); });
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data.type === 'faults') { storageFails = event.data.storage; networkFails = event.data.network; conflict = event.data.conflict; }
  requestAnimationFrame(report);
});
window.addEventListener('resize', () => requestAnimationFrame(report));
new MutationObserver(() => requestAnimationFrame(report)).observe(document.getElementById('root')!, { childList: true, subtree: true, attributes: true });
createRoot(document.getElementById('root')!).render(<App controller={controller} />);
