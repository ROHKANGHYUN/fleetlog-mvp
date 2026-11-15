import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { defaultFilters } from '../apps/web/src/admin/model.mjs';

// Render the real TSX output. This does not claim browser click/layout coverage.
const vite = await createServer({ root: resolve('apps/web'), configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => vite.close());
const { AdminWorkspace, AdminDetails } = await vite.ssrLoadModule('/src/AdminPanel.tsx');
const lastSuccessAt = '2026-11-15T03:04:05.000Z';
const snapshot = (trips = [], overrides = {}) => ({ status: 'ready', trips, hasLoaded: true, lastSuccessAt, error: null, ...overrides });
function trip(tripId = 'received-trip', overrides = {}) {
  const { payload = {}, ...record } = overrides;
  return { tripId, serverVersion: 1, localRevision: 1, source: 'mock', updatedAt: '2026-11-15T03:00:00.000Z',
    payload: { vehicleId: 'received-car', driverId: 'received-driver', startedAt: '2026-11-14T14:30:00.000Z',
      endedAt: '2026-11-14T15:30:00.000Z', startOdometerM: 1000, endOdometerM: 4000,
      purpose: 'business', note: '서버가 받은 메모', quality: 'valid', ...payload }, ...record };
}
const workspace = (state, props = {}) => renderToStaticMarkup(React.createElement(AdminWorkspace, {
  snapshot: state, onRefresh() {}, ...props,
}));
const details = record => renderToStaticMarkup(React.createElement(AdminDetails, { trip: record, onClose() {} }));
const statSection = html => html.match(/<div class="admin-stats"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
const listBody = html => html.match(/<table class="trip-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';

test('first query loading and connection failure never render a successful zero-record state', () => {
  const loading = workspace(snapshot([], { status: 'loading', hasLoaded: false, lastSuccessAt: null }));
  assert.match(loading, /서버 수신 기록을 처음 조회하고 있습니다/);
  assert.match(loading, /서버 응답을 받은 뒤 기록과 집계를 표시합니다/);
  assert.doesNotMatch(loading, /아직 서버가 수신한 운행이 없습니다|필터에 맞는 기록이 없습니다/);
  assert.equal(statSection(loading), '');
  const failure = workspace(snapshot([], { status: 'error', hasLoaded: false, lastSuccessAt: null, error: '연결 거부' }));
  assert.match(failure, /role="alert"/);
  assert.match(failure, /서버 기록을 조회하지 못했습니다/);
  assert.match(failure, /조회 실패는 기록 0건을 뜻하지 않습니다/);
  assert.match(failure, /연결 거부/);
  assert.doesNotMatch(failure, /아직 서버가 수신한 운행이 없습니다/);
  assert.equal(statSection(failure), '');
});

test('received empty, filtered empty and exception-free results have distinct explanations', () => {
  const receivedEmpty = workspace(snapshot());
  assert.match(receivedEmpty, /아직 서버가 수신한 운행이 없습니다/);
  assert.doesNotMatch(receivedEmpty, /필터에 맞는 기록이 없습니다/);
  const filteredEmpty = workspace(snapshot([trip()]), { initialFilters: { ...defaultFilters(), query: '찾을 수 없는 메모' } });
  assert.match(filteredEmpty, /필터에 맞는 기록이 없습니다/);
  assert.doesNotMatch(filteredEmpty, /아직 서버가 수신한 운행이 없습니다/);
  assert.equal(listBody(filteredEmpty), '');
  const noExceptions = workspace(snapshot([trip()]), { initialView: 'exceptions' });
  assert.match(noExceptions, /이 조건에서 확인 필요한 기록이 없습니다/);
  assert.doesNotMatch(noExceptions, /아직 서버가 수신한 운행이 없습니다|필터에 맞는 기록이 없습니다/);
});

test('refresh failure keeps the old received records and last successful KST query time visible', () => {
  const html = workspace(snapshot([trip()], { status: 'error', error: '서버 응답 503' }));
  assert.match(html, /새로고침에 실패했습니다. 이전 조회값을 표시합니다/);
  assert.match(html, /마지막 성공 조회: 2026\.11\.15 12:04:05 KST/);
  assert.match(html, /서버 응답 503/);
  assert.match(listBody(html), /서버가 받은 메모/);
  assert.match(html, /필터에 해당하는 수신 운행/);
  assert.doesNotMatch(html, /새로고침을 완료했습니다/);
});

test('purpose and distance quality are separate badges and overlapping reasons remain one trip row', () => {
  const unresolved = trip('both-reasons', { payload: { purpose: null, quality: 'gap' } });
  const enteredGap = trip('entered-gap', { payload: { purpose: 'commute', quality: 'gap' } });
  const html = workspace(snapshot([unresolved, enteredGap]), { initialView: 'exceptions', initialSelectedId: unresolved.tripId });
  const rows = [...listBody(html).matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(match => match[0]);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /서버 수신/);
  assert.match(rows.find(row => row.includes('both-reasons 운행 상세')), /용도 미확정[\s\S]*거리 확인 필요 · gap/);
  assert.match(rows.find(row => row.includes('entered-gap 운행 상세')), /용도 입력됨[\s\S]*거리 확인 필요 · gap/);
  assert.match(html, /용도 미확정 \/ 거리 확인 필요 · gap/);
  assert.match(html, /사유 중복 가능/);
  assert.doesNotMatch(rows.join(''), /관리자 승인 완료|마감 완료|세무신고 완료/);
});

test('purpose summaries disclose excluded gap distances and distinguish missing totals from actual zero', () => {
  const html = workspace(snapshot([
    trip('unknown', { payload: { purpose: 'business', quality: 'gap', endOdometerM: 999000 } }),
    trip('true-zero', { payload: { purpose: 'commute', endOdometerM: 1000 } }),
    trip('valid-personal', { payload: { purpose: 'personal', endOdometerM: 6000 } }),
  ]), { initialView: 'summary' });
  const rows = [...html.matchAll(/<tr><th scope="row">([\s\S]*?)<\/tr>/g)].map(match => match[1]);
  assert.match(rows.find(row => row.startsWith('일반 업무')), /1건[\s\S]*집계 가능 거리 없음[\s\S]*1건/);
  assert.match(rows.find(row => row.startsWith('출퇴근')), /1건[\s\S]*0 km[\s\S]*0건/);
  assert.match(rows.find(row => row.startsWith('개인 용도')), /1건[\s\S]*5 km/);
  assert.match(rows.find(row => row.startsWith('미확정')), /0건[\s\S]*수신 기록 없음/);
  assert.match(html, /수신 3건 · 거리 제외 1건/);
  assert.match(html, /합산 가능 2건/);
  assert.doesNotMatch(html, /998 km/);
});

test('an open detail resolves the latest received revision by trip ID and shows all original fields separately', () => {
  const original = trip('same-trip', { payload: { purpose: null, note: '', quality: 'gap' } });
  const revised = trip('same-trip', { serverVersion: 2, localRevision: 2, updatedAt: '2026-11-15T04:05:06.000Z',
    payload: { purpose: 'personal', note: '보완된 메모', quality: 'gap' } });
  const before = workspace(snapshot([original]), { initialSelectedId: 'same-trip' });
  assert.match(before, /수신 기록 상세/);
  assert.match(before, /<dt>서버 버전<\/dt><dd>1<\/dd>/);
  const after = workspace(snapshot([original, revised]), { initialSelectedId: 'same-trip' });
  assert.equal([...listBody(after).matchAll(/<tr\b/g)].length, 1);
  assert.match(after, /<dt>서버 버전<\/dt><dd>2<\/dd>/);
  assert.match(after, /<dt>메모<\/dt><dd>보완된 메모<\/dd>/);
  assert.match(after, /<dt>용도<\/dt><dd>개인 용도<\/dd>/);
  assert.match(after, /gap · 거리 확인 필요/);
  const detail = details(revised);
  for (const text of ['거리·시각 원본', '운전자 용도 입력', '서버 최신 수신본', '운행 ID', '차량 / 이용자',
    '운행 시작', '운행 종료', '시작 누적거리', '종료 누적거리', '원본 차분', '서버 반영 시각', '서버 버전', '로컬 리비전']) {
    assert.ok(detail.includes(text), text);
  }
  assert.match(detail, /2026\.11\.14 23:30:00 KST/);
  assert.match(detail, /2026\.11\.15 00:30:00 KST/);
  assert.match(detail, /1,000 m/);
  assert.match(detail, /4,000 m/);
  assert.match(detail, /3,000 m · 참고값, 유효 거리 합계에서 제외/);
  assert.match(detail, /2026\.11\.15 13:05:06 KST/);
  assert.match(detail, /mock · 가상 차량 데이터/);
  assert.match(detail, /변경 이력 전체를 표시하지 않으며 원본 수정 기능은 없습니다/);
});

test('a selected detail disappears when its current record no longer matches the visible filter', () => {
  const html = workspace(snapshot([trip('outside-filter')]), { initialSelectedId: 'outside-filter',
    initialFilters: { ...defaultFilters(), purpose: 'personal' } });
  assert.match(html, /필터에 맞는 기록이 없습니다/);
  assert.doesNotMatch(html, /aria-label="수신 기록 상세"/);
});
