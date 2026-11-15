import { test as base, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemo } from '../scripts/demo.mjs';
import { car, dev, beginLeg, manualSave, send, openAdmin, received, readLocal } from './fixtures.mjs';

// Each rehearsal is the complete three-scene script, starting with a new demo
// server/SQLite and Playwright browser context. No development origin is opened.
const test = base.extend({
  app: async ({}, use) => {
    const app = await startDemo();
    try { await use(app); } finally { await app.close(); }
  },
});

const vehicleTab = page => page.getByRole('button', { name: '차량 화면', exact: true });
const syncButton = page => page.getByRole('region', { name: '로컬 저장과 서버 전송' })
  .getByRole('button', { name: /서버.*전송/ });
const details = page => page.getByRole('region', { name: '수신 기록 상세' });
const summary = page => page.locator('.admin-stats');

function readReceipts(directory) {
  const db = new DatabaseSync(join(directory, 'demo.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT event_id, ack_json FROM event_receipts ORDER BY event_id').all(); }
  finally { db.close(); }
}

for (const run of [1, 2]) {
  test(`complete isolated WEB MOCK rehearsal ${run}: three scenes and preserved-record recovery`, async ({ page, app }, testInfo) => {
    test.setTimeout(90000);
    // Controlled mock prompt/processing time; no external speech or long waits.
    await page.clock.install({ time: new Date('2026-11-15T01:00:00.000Z') });
    await page.clock.pauseAt(new Date('2026-11-15T01:00:01.000Z'));
    await page.goto(app.address);
    await expect(car(page).getByRole('button', { name: '운행 기록 시작', exact: true })).toBeVisible();
    expect(await received(page, app)).toEqual([]);
    // An untouched fresh context has no persisted snapshot until its first
    // mutation; that is distinct from reusing any previous stored records.
    expect(await readLocal(page)).toBeNull();

    // Scene 1: spoken words remain an editable draft until explicit review/save.
    await beginLeg(page);
    const boundary = (await readLocal(page)).current.candidateEnd;
    await dev(page).getByRole('textbox', { name: '모의 인식 문장', exact: true }).fill('일반 업무, 가상 거래처 미팅');
    await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
    await expect(car(page).getByText('질문 안내 중', { exact: true })).toBeVisible();
    await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeDisabled();
    await page.clock.runFor(900);
    await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
    await dev(page).getByRole('button', { name: '중간 결과 전달', exact: true }).click();
    await expect(car(page).getByText('중간 결과 · 저장되지 않습니다', { exact: true })).toBeVisible();
    expect((await readLocal(page)).records).toHaveLength(0);
    await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).click();
    await page.clock.runFor(1);
    await expect(car(page).getByText('음성 초안입니다. 확인·수정 후 저장해 주세요.', { exact: true })).toBeVisible();
    await expect(car(page).getByPlaceholder('예: 거래처 미팅', { exact: true })).toHaveValue('가상 거래처 미팅');
    expect((await readLocal(page)).records).toHaveLength(0);
    if (run === 1) {
      await mkdir('test-results/step7', { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: 'test-results/step7/voice-draft.png' });
    }
    const normalNote = '가상 시연 1 · 거래처 미팅';
    await car(page).getByPlaceholder('예: 거래처 미팅', { exact: true }).fill(normalNote);
    await car(page).getByRole('button', { name: '요약 확인', exact: true }).click();
    await car(page).getByRole('button', { name: '확인하고 저장', exact: true }).click();
    await expect(car(page).getByRole('heading', { name: '이 기기에 저장했습니다' })).toBeVisible();
    await expect(car(page).getByText('전송 대기', { exact: true })).toBeVisible();
    const localNormal = (await readLocal(page)).records[0];
    expect(localNormal.payload.endedAt).toBe(boundary.endedAt);
    expect(await received(page, app)).toHaveLength(0);
    await openAdmin(page);
    await expect(page.getByRole('heading', { name: '아직 서버가 수신한 운행이 없습니다' })).toBeVisible();
    await vehicleTab(page).click();

    // Rehearsal 1 deliberately fails one request, retaining the record and exact
    // prepared event. Rehearsal 2 runs the same script without that injection.
    const requestBodies = [];
    let injectFailure = run === 1;
    await page.route('**/api/trip-events', async route => {
      requestBodies.push(route.request().postData());
      if (injectFailure) {
        injectFailure = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: '가상 시연 일시 오류' } }) });
      } else await route.continue();
    });
    if (run === 1) {
      await syncButton(page).click();
      await expect(car(page).getByText(/전송 실패/)).toBeVisible();
      const failed = await readLocal(page);
      expect(failed.records).toHaveLength(1);
      expect(failed.records[0].payload).toEqual(localNormal.payload);
      expect(failed.outbox).toHaveLength(1);
      expect(await received(page, app)).toHaveLength(0);
      await send(page);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toBe(requestBodies[0]);
      expect(JSON.parse(requestBodies[0]).eventId).toBe(failed.outbox[0].eventId);
    } else await send(page);
    await expect(car(page).getByText('서버 수신 완료', { exact: true })).toBeVisible();
    const normal = (await received(page, app))[0];
    expect(normal.tripId).toBe(localNormal.tripId);
    expect(normal.source).toBe('mock');
    await openAdmin(page);
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: `${normal.tripId} 운행 상세`, exact: true }).click();
    await expect(details(page)).toContainText(normalNote);
    await expect(details(page)).toContainText('mock · 가상 차량 데이터');
    await details(page).scrollIntoViewIfNeeded();
    const navigationBounds = await page.locator('.workspace-nav').boundingBox();
    expect(navigationBounds.y).toBeGreaterThanOrEqual(0);
    expect(navigationBounds.y + navigationBounds.height).toBeLessThanOrEqual(720);

    // Scene 2: the uncertain trip is received, then corrected as revision 2.
    await vehicleTab(page).click();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    const returnedHeading = await car(page).getByRole('heading', { name: '이 기기에 저장했습니다', exact: true }).boundingBox();
    expect(returnedHeading.y).toBeGreaterThanOrEqual(0);
    expect(returnedHeading.y + returnedHeading.height).toBeLessThanOrEqual(720);
    await beginLeg(page, { start: false });
    await car(page).getByRole('button', { name: '미확정으로 보관', exact: true }).click();
    await send(page);
    const deferred = (await received(page, app)).find(trip => trip.tripId !== normal.tripId);
    expect(deferred.payload.purpose).toBeNull();
    await openAdmin(page);
    await page.getByRole('button', { name: /^확인 필요/ }).click();
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
    await expect(page.locator('.admin-records tbody')).toContainText('용도 미확정');
    await expect(summary(page)).toContainText('2건');
    await expect(summary(page)).toContainText('46.8 km');
    await vehicleTab(page).click();
    await car(page).getByRole('button', { name: '미확정 기록 1건', exact: true }).click();
    await car(page).getByRole('button', { name: '용도 확인', exact: true }).click();
    const correctedNote = '가상 시연 2 · 출퇴근 보완';
    await manualSave(page, '출퇴근', correctedNote);
    // A new local revision does not pretend to replace the last remote receipt.
    expect((await received(page, app)).find(trip => trip.tripId === deferred.tripId).payload.purpose).toBeNull();
    await send(page);
    const latest = await received(page, app);
    expect(latest).toHaveLength(2);
    const corrected = latest.find(trip => trip.tripId === deferred.tripId);
    expect(corrected.serverVersion).toBe(2);
    expect(corrected.localRevision).toBe(2);
    expect(corrected.payload).toEqual({ ...deferred.payload, purpose: 'commute', note: correctedNote });
    await openAdmin(page);
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: `${deferred.tripId} 운행 상세`, exact: true }).click();
    await expect(details(page)).toContainText(correctedNote);
    await expect(details(page)).toContainText('서버 버전2');
    await page.getByRole('button', { name: /^확인 필요/ }).click();
    await expect(page.getByRole('heading', { name: '이 조건에서 확인 필요한 기록이 없습니다' })).toBeVisible();

    // Scene 3: an offline record survives reopening and arrives only after send.
    await vehicleTab(page).click();
    await beginLeg(page, { start: false });
    await dev(page).getByRole('button', { name: '오프라인', exact: true }).click();
    await manualSave(page, '개인 용도', '가상 시연 3 · 오프라인 복구');
    await expect(car(page).getByText('오프라인 · 전송 대기', { exact: true })).toBeVisible();
    const offline = await readLocal(page);
    expect(offline.records).toHaveLength(3);
    expect(offline.outbox).toHaveLength(1);
    expect(await received(page, app)).toHaveLength(2);
    await page.reload();
    await expect(car(page).getByRole('button', { name: '운행 기록 시작', exact: true })).toBeVisible();
    const reopened = await readLocal(page);
    expect(reopened.active).toBe(false);
    expect(reopened.records).toEqual(offline.records);
    expect(reopened.outbox).toEqual(offline.outbox);
    await openAdmin(page);
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(2);
    await vehicleTab(page).click();
    await dev(page).getByRole('button', { name: '온라인', exact: true }).click();
    await send(page);
    const final = await received(page, app);
    expect(final).toHaveLength(3);
    expect(new Set(final.map(trip => trip.tripId)).size).toBe(3);
    expect(final.reduce((sum, trip) => sum + trip.payload.endOdometerM - trip.payload.startOdometerM, 0)).toBe(70200);
    const receipts = readReceipts(app.directory);
    expect(receipts).toHaveLength(4);

    // Re-send an already received exact event to the actual API. Its receipt is
    // reused; no new trip or receipt is made by the duplicate request.
    const duplicate = await page.request.post(`${app.address}/api/trip-events`, {
      headers: { 'Content-Type': 'application/json', 'X-FleetLog-Dev': 'local-only' },
      data: requestBodies.at(-1),
    });
    expect(duplicate.ok()).toBeTruthy();
    expect(await received(page, app)).toEqual(final);
    expect(readReceipts(app.directory)).toEqual(receipts);

    await openAdmin(page);
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(3);
    await expect(summary(page)).toContainText('3건');
    await expect(summary(page)).toContainText('70.2 km');
    const day = new Date(Date.parse(corrected.payload.startedAt) + 9 * 3600000).toISOString().slice(0, 10);
    await page.getByLabel('시작일 · 한국 날짜', { exact: true }).fill(day);
    await page.getByLabel('종료일 · 한국 날짜', { exact: true }).fill(day);
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(3);
    await expect(summary(page)).toContainText('70.2 km');
    await page.getByRole('combobox', { name: '운행 용도', exact: true }).selectOption('commute');
    await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
    await expect(page.locator('.admin-records tbody')).toContainText(correctedNote);
    await expect(summary(page)).toContainText('23.4 km');
    await page.getByRole('button', { name: `${deferred.tripId} 운행 상세`, exact: true }).click();
    await expect(details(page)).toContainText('서버 버전2');
    await page.getByRole('button', { name: '용도별 요약', exact: true }).click();
    await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: '출퇴근' })).toContainText('1건');
    await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: '출퇴근' })).toContainText('23.4 km');
    await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: '일반 업무' })).toContainText('수신 기록 없음');
    await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
    for (const purpose of ['일반 업무', '출퇴근', '개인 용도']) {
      await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: purpose })).toContainText('1건');
      await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: purpose })).toContainText('23.4 km');
    }
    await expect(summary(page)).toContainText('70.2 km');

    if (run === 1) {
      await page.locator('.admin-summary-table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/step7/received-summary.png' });
    }

    await testInfo.attach(`rehearsal-${run}-result.json`, {
      contentType: 'application/json',
      body: JSON.stringify({ run, source: 'WEB_MOCK', address: app.address,
        initialTrips: 0, finalTrips: final.length, finalReceipts: receipts.length,
        validDistanceM: 70200, correctedTripId: corrected.tripId,
        correctedServerVersion: corrected.serverVersion,
        transientFailureRecovered: run === 1, duplicateReceiptPreserved: true,
        trips: final.map(({ tripId, serverVersion, localRevision, source, payload }) => ({ tripId, serverVersion, localRevision, source, payload })),
      }, null, 2),
    });
  });
}
