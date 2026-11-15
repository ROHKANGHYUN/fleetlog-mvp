import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startServer } from '../services/api/src/server.mjs';

async function unusedPort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

// Every test owns a fresh SQLite directory, a fresh HTTP listener and the default
// Playwright fresh browser context. Existing ports, processes and data are unused.
export const test = base.extend({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'chagok-e2e-'));
    let running;
    try {
      running = await startServer({ port: await unusedPort(), filename: join(directory, 'test.sqlite') });
      await use(running);
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
export { expect };
export const readLocal = page => page.evaluate(() => JSON.parse(localStorage.getItem('fleetlog.mock.v1')));
export async function received(page, app) {
  const response = await page.request.get(`${app.address}/api/trips`, { headers: { 'X-FleetLog-Dev': 'local-only' } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).trips;
}
export const car = page => page.locator('.vehicle-app');
export const dev = page => page.getByRole('complementary', { name: '개발용 제어' });
export async function beginLeg(page, { start = true } = {}) {
  if (start) await car(page).getByRole('button', { name: '운행 기록 시작', exact: true }).click();
  await dev(page).getByRole('button', { name: '주행', exact: true }).click();
  await expect(car(page).getByRole('heading', { name: '운전에 집중해 주세요' })).toBeVisible();
  await dev(page).getByRole('button', { name: '주차', exact: true }).click();
  await car(page).getByRole('button', { name: '운행 마치기', exact: true }).click();
}
export async function manualSave(page, purpose = '일반 업무', note = 'E2E 수동 입력') {
  await car(page).getByRole('button', { name: purpose, exact: true }).click();
  await car(page).getByPlaceholder('예: 거래처 미팅', { exact: true }).fill(note);
  await car(page).getByRole('button', { name: '요약 확인', exact: true }).click();
  await car(page).getByRole('button', { name: '확인하고 저장', exact: true }).click();
  await expect(car(page).getByRole('heading', { name: '이 기기에 저장했습니다' })).toBeVisible();
}
export async function send(page) {
  await page.getByRole('region', { name: '로컬 저장과 서버 전송' }).getByRole('button', { name: /서버.*전송/ }).click();
  await expect.poll(async () => (await readLocal(page)).outbox.length).toBe(0);
}
export async function openAdmin(page) {
  await page.getByRole('button', { name: 'Fleetlog 비즈', exact: true }).click();
  await expect(page.getByText('새로고침을 완료했습니다.', { exact: true })).toBeVisible();
}
