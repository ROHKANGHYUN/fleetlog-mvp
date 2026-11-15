import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';

// Load the real TSX without a browser, server listener or additional test dependencies.
const vite = await createServer({ root: resolve('apps/web'), configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
after(() => vite.close());
const { default: App } = await vite.ssrLoadModule('/src/App.tsx');
const car = controller => renderToStaticMarkup(React.createElement(App, { controller }))
  .match(/<section class="vehicle-app"[^>]*>([\s\S]*?)<\/section>/)[1];
const create = options => new FleetController({ storage: new MemoryStorage(), ...options });
function finish(c) { c.start();c.setDriving(true);c.setDriving(false);c.finish(); }
function save(c) { c.setPurpose('business','메모');c.review();c.save(); }

test('rendering follows real controller states and removes all vehicle controls while driving', () => {
  const c=create();assert.match(car(c),/시작 전 · 수집 중지/);
  c.setDriving(true);assert.match(car(c),/기록이 시작되지 않았습니다/);assert.doesNotMatch(car(c),/<(?:button|input|select)\b/);
  c.setDriving(false);c.start();c.setDriving(true);
  assert.match(car(c),/기록 수집 중/);assert.doesNotMatch(car(c),/<(?:button|input|select)\b/);
  c.setDriving(false);assert.match(car(c),/운행 마치기/);
  c.finish();assert.match(car(c),/개인 용도/);assert.match(car(c),/요약 확인/);
  c.setPurpose('business');c.review();assert.match(car(c),/확인하고 저장/);
});

test('a rejected save stays on review and never renders the saved screen', () => {
  const storage=new MemoryStorage(),c=create({storage});finish(c);c.setPurpose('business');c.review();
  storage.setItem=()=>{throw Error('quota');};
  assert.throws(()=>c.save(),/quota/);
  assert.match(car(c),/이 내용으로 남길까요/);assert.doesNotMatch(car(c),/이 기기에 저장했습니다/);
});

test('saved rendering distinguishes failed send from received ACK', async () => {
  let fails=true;
  const c=create({sendEvent:async e=>{if(fails)throw Error('offline');return {eventId:e.eventId,ackedLocalRevision:e.localRevision,serverVersion:e.expectedServerVersion+1};}});
  finish(c);save(c);await c.sync();
  assert.match(car(c),/이 기기에 저장했습니다/);assert.match(car(c),/전송 실패/);assert.doesNotMatch(car(c),/서버 수신 완료/);
  fails=false;await c.sync();assert.match(car(c),/서버 수신 완료/);
});

test('pending rendering distinguishes empty list, current leg blocker and version conflict', async () => {
  const c=create({sendEvent:async()=>{throw Object.assign(Error('conflict'),{status:409});}});
  c.showPending();assert.match(car(c),/미확정 기록이 없습니다/);c.home();
  finish(c);c.defer();c.setDriving(true);c.setDriving(false);c.showPending();
  assert.match(car(c),/현재 운행을 먼저 마쳐/);assert.doesNotMatch(car(c),/서버 버전 충돌로 보완/);
  c.stop();await c.sync();c.showPending();
  assert.match(car(c),/서버 버전 충돌로 보완/);assert.doesNotMatch(car(c),/현재 운행을 먼저 마쳐/);
  assert.match(car(c),/class="car-button" disabled=""/);
});

test('demo restart guidance preserves existing unsent records and exposes no destructive reset control', () => {
  const c=create();finish(c);c.defer();
  const before=c.getState();
  const html=renderToStaticMarkup(React.createElement(App,{controller:c}));
  assert.match(html,/새 시연 서버와 새 시크릿 창을 여세요/);
  assert.match(html,/기존 저장 기록은 지우지 않습니다/);
  assert.doesNotMatch(html,/<button\b[^>]*>[^<]*(?:로컬 초기화|로컬 데이터 지우기)/);
  assert.deepEqual(c.getState().records,before.records);
  assert.deepEqual(c.getState().outbox,before.outbox);
  assert.equal(c.getState().records.length,1);
  assert.equal(c.getState().outbox.length,1);
});

test('gap renders as distance unknown after purpose correction', () => {
  const storage=new MemoryStorage(),c=create({storage});c.start();c.setDriving(true);
  const restored=create({storage});restored.showPending();assert.match(car(restored),/거리 확인 필요/);
  restored.editTrip(restored.getState().records[0].tripId);save(restored);
  assert.match(car(restored),/거리 확인 필요/);assert.doesNotMatch(car(restored),/0\.0 km/);
});
