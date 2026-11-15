import { test, expect, readLocal, received, car, dev, beginLeg, manualSave, send, openAdmin } from './fixtures.mjs';

// All UI tests use production assets and real HTTP/SQLite; failure injection is
// restricted to this test's browser routes or this test's SQLite connection.
test('normal voice draft saves only after confirmation and reaches admin list/detail', async ({ page, app }) => {
  await page.goto(app.address);
  await beginLeg(page);
  await expect(car(page).getByText('음성 입력을 취소했습니다. 직접 입력할 수 있습니다.', { exact: true })).toHaveCount(0);
  const boundary = (await readLocal(page)).current.candidateEnd;
  await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
  await expect(car(page).getByText('질문 안내 중', { exact: true })).toBeVisible();
  await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
  await dev(page).getByRole('button', { name: '중간 결과 전달', exact: true }).click();
  await expect(car(page).getByText('중간 결과 · 저장되지 않습니다', { exact: true })).toBeVisible();
  expect((await readLocal(page)).records).toHaveLength(0);
  await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).click();
  await expect(car(page).getByText('음성 초안입니다. 확인·수정 후 저장해 주세요.', { exact: true })).toBeVisible();
  await expect(car(page).getByPlaceholder('예: 거래처 미팅', { exact: true })).toHaveValue('거래처 미팅');
  expect((await readLocal(page)).records).toHaveLength(0);
  await car(page).getByRole('button', { name: '요약 확인', exact: true }).click();
  await car(page).getByRole('button', { name: '수정', exact: true }).click();
  await car(page).getByPlaceholder('예: 거래처 미팅', { exact: true }).fill('E2E 음성 확인·수정');
  await car(page).getByRole('button', { name: '요약 확인', exact: true }).click();
  await car(page).getByRole('button', { name: '확인하고 저장', exact: true }).click();
  await expect(car(page).getByText('전송 대기', { exact: true })).toBeVisible();
  let local = await readLocal(page);
  expect(local.records).toHaveLength(1);
  expect(local.records[0].payload.endedAt).toBe(boundary.endedAt);
  expect(await received(page, app)).toHaveLength(0);
  await send(page);
  const serverTrips = await received(page, app);
  expect(serverTrips).toHaveLength(1);
  expect(serverTrips[0].payload.note).toBe('E2E 음성 확인·수정');
  await openAdmin(page);
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: `${serverTrips[0].tripId} 운행 상세`, exact: true }).click();
  await expect(page.getByRole('region', { name: '수신 기록 상세' })).toContainText('E2E 음성 확인·수정');
  await expect(page.getByRole('region', { name: '수신 기록 상세' })).toContainText('서버 버전1');
});

test('unconfirmed reception and purpose correction stay one trip at the latest revision', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await car(page).getByRole('button', { name: '미확정으로 보관', exact: true }).click();
  await send(page);
  const before = (await received(page, app))[0];
  await openAdmin(page);
  await page.getByRole('button', { name: /^확인 필요/ }).click();
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await expect(page.locator('.admin-records tbody')).toContainText('용도 미확정');
  await page.getByRole('button', { name: '차량 화면', exact: true }).click();
  await car(page).getByRole('button', { name: '미확정 기록 1건', exact: true }).click();
  await car(page).getByRole('button', { name: '용도 확인', exact: true }).click();
  await manualSave(page, '개인 용도', 'E2E 보완된 내용');
  await send(page);
  const after = await received(page, app);
  expect(after).toHaveLength(1);expect(after[0].tripId).toBe(before.tripId);
  expect(after[0].serverVersion).toBe(2);expect(after[0].localRevision).toBe(2);
  expect(after[0].payload.startedAt).toBe(before.payload.startedAt);
  expect(after[0].payload.endedAt).toBe(before.payload.endedAt);
  await openAdmin(page);
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await expect(page.locator('.admin-records tbody')).toContainText('E2E 보완된 내용');
  await page.getByRole('button', { name: `${before.tripId} 운행 상세`, exact: true }).click();
  await expect(page.getByRole('region', { name: '수신 기록 상세' })).toContainText('서버 버전2');
  await page.getByRole('button', { name: /^확인 필요/ }).click();
  await expect(page.getByRole('heading', { name: '이 조건에서 확인 필요한 기록이 없습니다' })).toBeVisible();
});

test('offline saved trip and prepared queue survive reload without resuming collection', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await dev(page).getByRole('button', { name: '오프라인', exact: true }).click();
  await manualSave(page, '출퇴근', 'E2E 오프라인 복구');
  const before = await readLocal(page);
  expect(before.outbox).toHaveLength(1);expect(await received(page, app)).toHaveLength(0);
  await page.reload();
  await expect(car(page).getByRole('button', { name: '운행 기록 시작', exact: true })).toBeVisible();
  const after = await readLocal(page);
  expect(after.active).toBe(false);expect(after.records).toEqual(before.records);expect(after.outbox).toEqual(before.outbox);
  await openAdmin(page);
  await expect(page.getByRole('heading', { name: '아직 서버가 수신한 운행이 없습니다' })).toBeVisible();
  await page.getByRole('button', { name: '차량 화면', exact: true }).click();
  await dev(page).getByRole('button', { name: '온라인', exact: true }).click();await send(page);
  await openAdmin(page);await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
});

test('cancel/redeparture prevent queued speech processing and do not create records', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
  await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
  await dev(page).getByRole('button', { name: '중간 결과 전달', exact: true }).click();
  await car(page).getByRole('button', { name: '음성 입력 취소', exact: true }).click();
  await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeDisabled();
  // A browser task already holding a stale control cannot apply a disabled result.
  await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).evaluate(node => node.click());
  expect((await readLocal(page)).draft).toEqual({ purpose: null, note: '' });
  await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
  await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
  await dev(page).getByRole('button', { name: '주행', exact: true }).click();
  await expect(car(page).getByRole('heading', { name: '운전에 집중해 주세요' })).toBeVisible();
  expect((await readLocal(page)).draft).toBeNull();
  expect((await readLocal(page)).current.candidateEnd).toBeUndefined();
  expect((await readLocal(page)).records).toHaveLength(0);
  await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).evaluate(node => node.click());
  expect((await readLocal(page)).records).toHaveLength(0);expect(await received(page, app)).toHaveLength(0);
});

test('failed, empty and unavailable mock speech all leave manual or deferred input available', async ({ page, app }) => {
  await page.goto(app.address);
  for (const [index, mode, message, defer] of [
    [0, 'failed', '음성을 인식하지 못했습니다', false],
    [1, 'empty', '인식된 문장이 없습니다', true],
    [2, 'unavailable', '음성을 사용할 수 없습니다', false],
  ]) {
    await beginLeg(page, { start: index === 0 });
    await dev(page).getByRole('combobox', { name: '모의 음성 결과', exact: true }).selectOption(mode);
    await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
    if (mode !== 'unavailable') {
      await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
      await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).click();
    }
    await expect(car(page).getByText(message, { exact: true })).toBeVisible();
    await expect(car(page).getByRole('button', { name: '음성 다시 입력', exact: true })).toBeVisible();
    expect((await readLocal(page)).records).toHaveLength(index);
    if (defer) await car(page).getByRole('button', { name: '미확정으로 보관', exact: true }).click();
    else await manualSave(page, '일반 업무', `E2E ${mode} 직접 입력`);
    expect((await readLocal(page)).records).toHaveLength(index + 1);
  }
  const stored = await readLocal(page);
  expect(stored.records.map(record => record.payload.purpose)).toEqual(['business', null, 'business']);
  expect(stored.outbox).toHaveLength(3);
  expect(await received(page, app)).toHaveLength(0);
});

test('a final speech result queued for processing is discarded when input is cancelled', async ({ page, app }) => {
  await page.clock.install({ time: new Date('2026-11-15T01:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-11-15T01:00:01.000Z'));
  await page.goto(app.address);await beginLeg(page);
  await car(page).getByRole('button', { name: '음성으로 입력', exact: true }).click();
  await page.clock.runFor(900);
  await expect(dev(page).getByRole('button', { name: '최종 결과 전달', exact: true })).toBeEnabled();
  await dev(page).getByRole('button', { name: '최종 결과 전달', exact: true }).click();
  await expect(car(page).getByRole('heading', { name: '결과를 정리하고 있습니다', exact: true })).toBeVisible();
  await car(page).getByRole('button', { name: '음성 입력 취소', exact: true }).click();
  await page.clock.runFor(1);
  expect((await readLocal(page)).draft).toEqual({ purpose: null, note: '' });
  expect((await readLocal(page)).records).toHaveLength(0);
  expect((await readLocal(page)).outbox).toHaveLength(0);
  expect(await received(page, app)).toHaveLength(0);
});

test('quota failure during trip save keeps review and draft until a successful single retry', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);
  await car(page).getByRole('button', { name: '일반 업무', exact: true }).click();
  await car(page).getByPlaceholder('예: 거래처 미팅', { exact: true }).fill('E2E 저장 실패 복구');
  await car(page).getByRole('button', { name: '요약 확인', exact: true }).click();
  const before = await readLocal(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.__failTripSave = true;
    Storage.prototype.setItem = function(key, value) {
      if (window.__failTripSave && key === 'fleetlog.mock.v1') {
        const previous = JSON.parse(this.getItem(key));
        const next = JSON.parse(value);
        if (next.records.length > previous.records.length) throw new DOMException('E2E 저장 공간 부족', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await car(page).getByRole('button', { name: '확인하고 저장', exact: true }).click();
  await expect(car(page).getByText('이 기기에 저장하지 못했습니다', { exact: true })).toBeVisible();
  await expect(car(page).getByRole('heading', { name: '이 내용으로 남길까요?', exact: true })).toBeVisible();
  await expect(car(page).getByRole('heading', { name: '이 기기에 저장했습니다', exact: true })).toHaveCount(0);
  expect(await readLocal(page)).toEqual(before);expect(await received(page, app)).toHaveLength(0);
  await page.evaluate(() => { window.__failTripSave = false; });
  await car(page).getByRole('button', { name: '확인하고 저장', exact: true }).click();
  await expect(car(page).getByRole('heading', { name: '이 기기에 저장했습니다', exact: true })).toBeVisible();
  expect((await readLocal(page)).records).toHaveLength(1);expect((await readLocal(page)).outbox).toHaveLength(1);
  await send(page);expect(await received(page, app)).toHaveLength(1);
});

test('temporary server failure retries the identical prepared event without duplicate reception', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);await manualSave(page);
  const bodies = [];
  let fail = true;
  await page.route('**/api/trip-events', async route => {
    bodies.push(route.request().postData());
    if (fail) { fail = false;await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: 'E2E 일시적 오류' } }) }); }
    else await route.continue();
  });
  await page.getByRole('region', { name: '로컬 저장과 서버 전송' }).getByRole('button', { name: '서버로 전송', exact: true }).click();
  await expect(car(page).getByText(/전송 실패/, { exact: false })).toBeVisible();
  expect(await received(page, app)).toHaveLength(0);
  const failed = await readLocal(page);expect(failed.outbox).toHaveLength(1);
  await send(page);
  expect(bodies).toHaveLength(2);expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0]).eventId).toBe(failed.outbox[0].eventId);
  expect(await received(page, app)).toHaveLength(1);
  expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM event_receipts').get().count).toBe(1);
  await expect(car(page).getByText('서버 수신 완료', { exact: true })).toBeVisible();
});

test('administrator refresh error retains rows/details and date/purpose filters agree with summary', async ({ page, app }) => {
  await page.goto(app.address);await beginLeg(page);await manualSave(page, '개인 용도', 'E2E 관리자 확인');await send(page);await openAdmin(page);
  const record = (await received(page, app))[0];
  const day = new Date(Date.parse(record.payload.startedAt) + 9 * 3600000).toISOString().slice(0,10);
  await page.getByLabel('시작일 · 한국 날짜', { exact: true }).fill(day);
  await page.getByLabel('종료일 · 한국 날짜', { exact: true }).fill(day);
  await page.getByRole('combobox', { name: '운행 용도', exact: true }).selectOption('personal');
  await expect(page.locator('.admin-records tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: `${record.tripId} 운행 상세`, exact: true }).click();
  await page.route('**/api/trips', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: '서버 기록 새로고침', exact: true }).click();
  await expect(page.getByText('새로고침에 실패했습니다. 이전 조회값을 표시합니다.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '수신 기록 상세' })).toContainText('E2E 관리자 확인');
  await expect(page.locator('.admin-query-status')).toContainText('마지막 성공 조회:');
  await page.getByRole('button', { name: '용도별 요약', exact: true }).click();
  await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: '개인 용도' })).toContainText('1건');
  await expect(page.locator('.admin-summary-table tbody tr').filter({ hasText: '일반 업무' })).toContainText('수신 기록 없음');
});

for (const [width, height] of [[1280,720],[960,540],[640,720]]) {
  test(`viewport ${width}x${height} keeps vehicle actions and admin filters/list/detail within page width`, async ({ page, app }, testInfo) => {
    await page.setViewportSize({ width, height });await page.goto(app.address);
    async function layout(name) {
      // The writer lock is acquired asynchronously before the vehicle app mounts.
      await expect(page.locator('.vehicle-app, .admin-panel')).toBeVisible();
      const geometry = await page.evaluate(() => {
        const area = document.querySelector('.vehicle-app') || document.querySelector('.admin-panel');
        const bounds = area.getBoundingClientRect();
        const controls = [...area.querySelectorAll('button,input,select')].filter(node => node.getClientRects().length);
        const outside = [...area.querySelectorAll('*')].filter(node => {
          if (node.matches('.sr-only,thead') || node.closest('thead')) return false;
          const r=node.getBoundingClientRect();return r.width>0 && (r.left<bounds.left-1 || r.right>bounds.right+1);
        }).map(node => `${node.tagName}.${node.className}`);
        return { horizontalOverflow: document.documentElement.scrollWidth > innerWidth, outside,
          shortControls: controls.filter(node=>node.getBoundingClientRect().height<56).map(node=>node.textContent || node.getAttribute('aria-label') || node.tagName) };
      });
      expect(geometry.horizontalOverflow, `${name} page overflow`).toBe(false);
      expect(geometry.outside, `${name} area overflow`).toEqual([]);
      expect(geometry.shortControls, `${name} short controls`).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}x${height}.png`), fullPage: true });
    }
    await layout('ready');await beginLeg(page);await layout('purpose');await manualSave(page);await layout('saved');await send(page);await openAdmin(page);
    const record=(await received(page,app))[0];await page.getByRole('button',{name:`${record.tripId} 운행 상세`,exact:true}).click();await layout('admin-detail');
  });
}

test('a second tab cannot acquire the writer lock while the first tab records', async ({ page, context, app }) => {
  await page.goto(app.address);await car(page).getByRole('button',{name:'운행 기록 시작',exact:true}).click();
  const other=await context.newPage();await other.goto(app.address);
  await expect(other.getByRole('heading',{name:'다른 탭에서 Fleetlog를 사용 중입니다'})).toBeVisible();
  await expect(other.getByRole('button',{name:'운행 기록 시작',exact:true})).toHaveCount(0);
  expect((await readLocal(other)).records).toHaveLength(0);
  await other.close();await page.bringToFront();
  await expect(car(page).getByRole('button',{name:'운행 마치기',exact:true})).toBeDisabled();
});
