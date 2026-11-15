import { test as base, expect } from '@playwright/test';
import { startDemo } from '../scripts/demo.mjs';
import { car, dev, beginLeg, manualSave, send, openAdmin, received, readLocal } from './fixtures.mjs';

// Exercise the actual demo launcher, with a fresh browser context and empty
// temporary SQLite per test. Android/Pleos services are not part of this fixture.
const test = base.extend({
  app: async ({}, use) => {
    const app = await startDemo();
    try { await use(app); } finally { await app.close(); }
  },
});

test('WEB MOCK demo: confirmed local recording reaches the administrator only after actual transmission', async ({ page, app }) => {
  await page.goto(app.address);
  expect(await received(page, app)).toHaveLength(0);
  await beginLeg(page);await manualSave(page, '일반 업무', '시연 1 · 정상 수신');
  await expect(car(page).getByText('전송 대기', { exact:true })).toBeVisible();
  expect(await received(page, app)).toHaveLength(0);
  await send(page);
  const trips=await received(page, app);expect(trips).toHaveLength(1);
  expect(trips[0].source).toBe('mock');expect(trips[0].serverVersion).toBe(1);
  await openAdmin(page);
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:`${trips[0].tripId} 운행 상세`,exact:true}).click();
  await expect(page.getByRole('region',{name:'수신 기록 상세'})).toContainText('시연 1 · 정상 수신');
  await expect(page.getByRole('region',{name:'수신 기록 상세'})).toContainText('mock · 가상 차량 데이터');
});

test('WEB MOCK demo: an unconfirmed trip is corrected as one latest received trip', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await car(page).getByRole('button',{name:'미확정으로 보관',exact:true}).click();await send(page);
  const first=(await received(page,app))[0];expect(first.payload.purpose).toBeNull();
  await openAdmin(page);await page.getByRole('button',{name:/^확인 필요/}).click();
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await expect(page.locator('.admin-records tbody')).toContainText('용도 미확정');
  await page.getByRole('button',{name:'차량 화면',exact:true}).click();
  await car(page).getByRole('button',{name:'미확정 기록 1건',exact:true}).click();
  await car(page).getByRole('button',{name:'용도 확인',exact:true}).click();
  await manualSave(page,'출퇴근','시연 2 · 기존 운행 보완');await send(page);
  const latest=await received(page,app);expect(latest).toHaveLength(1);
  expect(latest[0].tripId).toBe(first.tripId);expect(latest[0].serverVersion).toBe(2);
  expect(latest[0].payload.startedAt).toBe(first.payload.startedAt);
  expect(latest[0].payload.endedAt).toBe(first.payload.endedAt);
  expect(latest[0].payload.endOdometerM).toBe(first.payload.endOdometerM);
  await openAdmin(page);await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:`${first.tripId} 운행 상세`,exact:true}).click();
  await expect(page.getByRole('region',{name:'수신 기록 상세'})).toContainText('시연 2 · 기존 운행 보완');
  await expect(page.getByRole('region',{name:'수신 기록 상세'})).toContainText('서버 버전2');
});

test('WEB MOCK demo: offline storage survives reload and appears remotely after explicit online delivery', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await dev(page).getByRole('button',{name:'오프라인',exact:true}).click();
  await manualSave(page,'개인 용도','시연 3 · 오프라인 복구');
  const stored=await readLocal(page);expect(stored.outbox).toHaveLength(1);
  expect(await received(page,app)).toHaveLength(0);
  await page.reload();
  await expect(car(page).getByRole('button',{name:'운행 기록 시작',exact:true})).toBeVisible();
  const reopened=await readLocal(page);
  expect(reopened.active).toBe(false);expect(reopened.records).toEqual(stored.records);expect(reopened.outbox).toEqual(stored.outbox);
  await openAdmin(page);
  await expect(page.getByRole('heading',{name:'아직 서버가 수신한 운행이 없습니다'})).toBeVisible();
  await page.getByRole('button',{name:'차량 화면',exact:true}).click();
  await dev(page).getByRole('button',{name:'온라인',exact:true}).click();await send(page);
  expect(await received(page,app)).toHaveLength(1);
  await openAdmin(page);await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await expect(page.locator('.admin-records tbody')).toContainText('시연 3 · 오프라인 복구');
});
