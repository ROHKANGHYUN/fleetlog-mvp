import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMvpServer } from '../services/mvp/server.mjs';

// Real Chrome + isolated SQLite/HTTP. Server time is controlled; no real tax,
// card, microphone, remote service or device data is involved.
const test = base.extend({ app: async ({}, use) => {
  const directory = await mkdtemp(join(tmpdir(), 'fleetlog-mvp-reporting-'));
  let now = Date.parse('2026-11-15T09:00:00+09:00'), app;
  try {
    app = await startMvpServer({ port: 0, filename: join(directory, 'mvp.sqlite'), staticDir: resolve('apps/web/dist'), now: () => now });
    await use({ ...app, advance: milliseconds => { now += milliseconds; }, setClock: value => { now = Date.parse(value); } });
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
} });

const A = 'mvp-employee-001', B = 'mvp-employee-002', V = 'mvp-vehicle-001', V2 = 'mvp-vehicle-002';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const employeeSelect = page => page.getByRole('combobox', { name: '데모 계정 선택', exact: true });
const history = page => page.getByRole('region', { name: '직원 운행 내역', exact: true });
const received = page => page.getByRole('region', { name: '서버 수신 운행 목록', exact: true });
const monthRegion = page => page.getByRole('region', { name: '월별 자료·모의 세무처리', exact: true });
const editor = page => page.getByRole('region', { name: '운행 용도 보완', exact: true });
async function json(response) { expect(response.ok(), `HTTP ${response.status()}: ${await response.text()}`).toBeTruthy(); return response.json(); }
const state = (request, app) => request.get(app.address + '/mvp-api/state').then(json);
const monthly = (request, app, month = '2026-11') => request.get(`${app.address}/mvp-api/monthly?month=${month}`).then(json);
const post = (request, app, path, data) => request.post(app.address + path, { data, headers: { 'Content-Type': 'application/json' } });
const command = (request, app, connectionId, type, extra = {}) => post(request, app, '/mvp-api/commands', { commandId: randomUUID(), connectionId, type, ...extra }).then(json);
const amendBody = (extra = {}) => ({ requestId: randomUUID(), employeeId: A, expectedAmendmentVersion: 0, purpose: 'business', destination: '가상 거래처', detailedPurpose: '가상 업무 미팅', ...extra });
async function amendment(request, app, tripId, body = amendBody()) { return post(request, app, `/mvp-api/trips/${tripId}/amendments`, body); }
async function createReport(request, app, month = '2026-11') { return (await json(await post(request, app, '/mvp-api/reports', { requestId: randomUUID(), month }))).report; }
async function ensureConnection(request, app, employeeId = A, vehicleId = V) {
  const current = (await state(request, app)).vehicles.find(item => item.id === vehicleId).connection;
  if (current) { expect(current.employeeId).toBe(employeeId); return current; }
  const qr = await json(await request.get(`${app.address}/mvp-api/vehicles/${vehicleId}/qr`));
  return (await json(await post(request, app, '/mvp-api/connections', { token: qr.token, employeeId }))).connection;
}
async function observedTrip(request, app, { employeeId = A, vehicleId = V, deliver = true, gap = false } = {}) {
  const connection = await ensureConnection(request, app, employeeId, vehicleId);
  const departure = await command(request, app, connection.id, 'depart', { tripId: '' });
  app.advance(1000);
  await command(request, app, connection.id, 'arrive', { tripId: departure.trip.id, conversationId: departure.trip.conversationId });
  if (gap) { await command(request, app, connection.id, 'unknown'); await command(request, app, connection.id, 'park'); }
  const finish = await command(request, app, connection.id, 'finish');
  await command(request, app, connection.id, 'confirm', { conversationId: finish.conversation.id, value: 'later' });
  const queued = (await state(request, app)).pendingUploads.find(upload => upload.tripId === departure.trip.id);
  const ack = deliver ? await json(await post(request, app, '/mvp-api/trip-events', queued.body)) : null;
  return { connection, trip: queued.trip, queued, ack };
}
function disableSpeech() {
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined });
}
async function roles({ browser, context, page, app }) {
  await page.addInitScript(disableSpeech);
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage(), car = await context.newPage(), admin = await context.newPage();
  await Promise.all([page.goto(app.address + '/mvp/control'), car.goto(app.address + '/mvp/car'), admin.goto(app.address + '/mvp/admin')]);
  return { control: page, phone, car, admin, async close() { await phoneContext.close(); await car.close(); await admin.close(); await page.close(); } };
}
async function connectByQr(views, request, app, testInfo) {
  const qr = await json(await request.get(`${app.address}/mvp-api/vehicles/${V}/qr`));
  const diagnostics = [];
  views.phone.on('response', async response => {
    if (new URL(response.url()).pathname === '/mvp-api/connections') { const sent = response.request().postDataJSON(); diagnostics.push({ status: response.status(), request: { employeeId: sent.employeeId, credentialType: sent.token ? 'token' : 'code' }, response: await response.text().catch(() => 'unavailable') }); }
  });
  await views.phone.goto(qr.url);
  await employeeSelect(views.phone).selectOption(A);
  await expect(employeeSelect(views.phone)).toHaveValue(A);
  try {
    const response = views.phone.waitForResponse(item => item.request().method() === 'POST' && new URL(item.url()).pathname === '/mvp-api/connections');
    await button(views.phone, '이 차량에 연결').click();
    await json(await response);
    await expect.poll(async () => (await state(request, app)).vehicles[0].connection?.employeeId).toBe(A);
  } finally {
    await testInfo.attach('QR connection diagnostic', { body: JSON.stringify({ selectedEmployee: await employeeSelect(views.phone).inputValue(), responses: diagnostics, connections: (await state(request, app)).connections }), contentType: 'application/json' });
  }
}
async function beginEditor(phone, tripId, { purpose = 'business', destination = '가상 거래처', detailedPurpose = '가상 업무 미팅' } = {}) {
  await history(phone).locator(`[data-trip-id="${tripId}"]`).getByRole('button', { name: '용도 보완', exact: true }).click();
  await editor(phone).getByRole('combobox', { name: '운행 용도', exact: true }).selectOption(purpose);
  await editor(phone).getByRole('textbox', { name: '목적지', exact: true }).fill(destination);
  await editor(phone).getByRole('textbox', { name: '상세 목적', exact: true }).fill(detailedPurpose);
  await button(editor(phone), '보완 내용 확인').click();
}
async function downloadText(page, link) {
  const downloading = page.waitForEvent('download'); await link.click(); const download = await downloading;
  const stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return { filename: download.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
}
// Independent RFC4180 reader, including escaped quotes and embedded line breaks.
function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, ''), rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') { if (quoted && source[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && source[index + 1] === '\n') index++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
async function assertNoHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const outside = await page.locator('button,input,select,textarea').evaluateAll(nodes => nodes.filter(node => { const r = node.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map(node => node.getAttribute('aria-label') || node.textContent));
  expect(outside).toEqual([]);
}

test('MVP complete QR-to-unconfirmed-to-mobile-amendment-to-monthly-download-and-simulated-reception flow', async ({ browser, context, page, request, app }, testInfo) => {
  const views = await roles({ browser, context, page, app });
  try {
    await connectByQr(views, request, app, testInfo);
    await expect(button(views.car, '운행 마치기')).toBeDisabled();
    await button(views.control, '모의 출발').click();
    await expect(views.car.locator('.mvp-car-screen > *')).toHaveCount(0);
    await button(views.control, '모의 도착').click();
    await expect(button(views.car, '운행 마치기')).toBeEnabled();
    expect((await state(request, app)).receivedTrips).toHaveLength(0);
    await button(views.car, '운행 마치기').click();
    await expect(button(views.control, '모의 나중에')).toBeEnabled(); await button(views.control, '모의 나중에').click();
    await expect.poll(async () => (await state(request, app)).receivedTrips.length).toBe(1);
    const first = (await state(request, app)).receivedTrips[0]; expect(first.purpose).toBeNull();
    // A disconnected original driver still owns their received record.
    await button(views.phone, '연결 해제').click(); await expect.poll(async () => (await state(request, app)).vehicles[0].connection).toBeNull();
    const destination = '가상 거래처, "본사"', detailedPurpose = '@SUM(1,2)\n가상 메모';
    await beginEditor(views.phone, first.id, { destination, detailedPurpose });
    const saving = views.phone.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/mvp-api/trips/${first.id}/amendments`));
    await button(editor(views.phone), '확인하고 보완 저장').click(); await json(await saving);
    await expect.poll(async () => (await state(request, app)).receivedTrips[0].amendmentVersion).toBe(1);
    const amended = (await state(request, app)).receivedTrips[0];
    for (const field of ['id', 'tripId', 'companyId', 'employeeId', 'vehicleId', 'connectionId', 'startedAt', 'endedAt', 'startOdometerM', 'endOdometerM', 'distanceM', 'quality', 'serverVersion']) expect(amended[field]).toBe(first[field]);
    expect(amended.purpose).toBe('business'); expect(amended.destination).toBe(destination); expect(amended.detailedPurpose).toBe(detailedPurpose); expect(amended.originalPurpose.purpose).toBeNull();
    await expect(received(views.admin).locator(`[data-trip-id="${first.id}"]`)).toContainText('일반 업무');
    await expect(received(views.admin).locator(`[data-trip-id="${first.id}"]`)).toContainText('가상 거래처');
    await assertNoHorizontalOverflow(views.phone);
    const region = monthRegion(views.admin); await region.getByLabel('집계 월', { exact: true }).fill('2026-11');
    const generation = views.admin.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/mvp-api/reports');
    await button(region, '월별 자료 생성').click(); const report = (await json(await generation)).report;
    expect(report.data.trips).toHaveLength(1); expect(report.data.trips[0].amendmentVersion).toBe(1); expect(report.data.summary.receivedCount).toBe(1);
    expect(report.data.summary.costTotalKRW).toBeGreaterThan(0); expect(report.readiness.canSubmit).toBe(true);
    const tripsFile = await downloadText(views.admin, region.getByRole('link', { name: '운행 내역 CSV', exact: true }));
    const costsFile = await downloadText(views.admin, region.getByRole('link', { name: '가상 차량 비용 CSV', exact: true }));
    expect(tripsFile.filename).toContain('DEMO-2026-11-v1'); expect(costsFile.filename).toContain('DEMO-2026-11-v1');
    const tripRows = parseCsv(tripsFile.text), costRows = parseCsv(costsFile.text);
    expect(tripRows).toHaveLength(report.data.trips.length + 1); expect(costRows).toHaveLength(report.data.costs.length + 1);
    expect(tripRows[1]).toContain(first.id); expect(tripRows[1]).toContain(destination); expect(tripRows[1]).toContain("'" + detailedPurpose);
    for (const cost of report.data.costs) expect(costRows.slice(1).some(row => row.includes(cost.id) && row.includes(String(cost.amountKRW)))).toBe(true);
    const submit = views.admin.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/mvp-api/submissions');
    await button(region, '모의 제출').click(); const submission = (await json(await submit)).submission; expect(submission.status).toBe('processing');
    await expect(region).toContainText('모의 접수 중'); app.advance(2000);
    await expect.poll(async () => (await monthly(request, app)).submissions[0].status).toBe('completed');
    await expect(region).toContainText('모의 접수 완료'); await expect(region).toContainText('DEMO-');
    await views.admin.reload(); await expect(monthRegion(views.admin)).toContainText('모의 접수 완료');
    const completed = (await monthly(request, app)).submissions[0]; expect(completed.id).toBe(submission.id); expect(completed.attempts).toHaveLength(1); expect(completed.attempts[0].receiptNumber).toMatch(/^DEMO-/);
    await mkdir('test-results/mvp-step3/screenshots', { recursive: true });
    await monthRegion(views.admin).scrollIntoViewIfNeeded(); await views.admin.screenshot({ path: 'test-results/mvp-step3/screenshots/monthly-received.png' });
    await testInfo.attach('frozen-report-and-reception', { body: JSON.stringify({ reportId: report.id, version: report.version, tripId: first.id, receivedCount: report.data.summary.receivedCount, costTotalKRW: report.data.summary.costTotalKRW, submission: completed }), contentType: 'application/json' });
  } finally { await views.close(); }
});

test('MVP amendment HTTP rejects another employee, serializes concurrent corrections, and preserves original upload/ACK on replay', async ({ request, app }) => {
  const original = await observedTrip(request, app), tripId = original.trip.id;
  const raw = app.store.db.prepare('SELECT body_json FROM mvp_received_trips WHERE trip_id=?').get(tripId).body_json;
  const receipt = app.store.db.prepare('SELECT * FROM mvp_trip_receipts WHERE event_id=?').get(original.queued.eventId);
  expect((await amendment(request, app, tripId, amendBody({ employeeId: B }))).status()).toBe(403);
  const save = amendBody(), alternate = amendBody({ purpose: 'personal', destination: '가상 마트' });
  const competing = await Promise.all([amendment(request, app, tripId, save), amendment(request, app, tripId, alternate)]);
  expect(competing.map(response => response.status()).sort()).toEqual([200, 409]);
  const accepted = competing[0].ok() ? save : alternate, winner = await json(competing.find(response => response.ok()));
  const retry = await json(await amendment(request, app, tripId, accepted)); expect(retry.amendment.version).toBe(1);
  const replay = await json(await post(request, app, '/mvp-api/trip-events', original.queued.body)); expect(replay).toEqual(original.ack);
  const current = (await state(request, app)).receivedTrips[0]; expect(current.purpose).toBe(accepted.purpose); expect(current.amendmentHistory).toHaveLength(1); expect(current.serverVersion).toBe(1);
  expect(winner.amendment.before.purpose).toBeNull(); expect(winner.amendment.after.purpose).toBe(accepted.purpose);
  expect(app.store.db.prepare('SELECT body_json FROM mvp_received_trips WHERE trip_id=?').get(tripId).body_json).toBe(raw);
  expect(app.store.db.prepare('SELECT * FROM mvp_trip_receipts WHERE event_id=?').get(original.queued.eventId)).toEqual(receipt);
  expect(app.store.db.prepare('SELECT body FROM mvp_uploads WHERE event_id=?').get(original.queued.eventId).body).toBe(original.queued.body);
  expect((await monthly(request, app)).data.summary.receivedCount).toBe(1);
});

test('MVP monthly scope uses Korean start month, excludes gap and unreceived distance, and never clones fixed costs into another month', async ({ request, app }) => {
  app.setClock('2026-10-31T14:59:59.999Z'); const october = await observedTrip(request, app);
  app.setClock('2026-10-31T15:00:00.000Z'); const november = await observedTrip(request, app);
  const gap = await observedTrip(request, app, { employeeId: B, vehicleId: V2, gap: true });
  await json(await amendment(request, app, november.trip.id)); await json(await amendment(request, app, gap.trip.id, amendBody({ employeeId: B, purpose: 'commute' })));
  const pending = await observedTrip(request, app, { deliver: false });
  const month = (await monthly(request, app)).data;
  expect(month.scope).toEqual({ timeZone: 'Asia/Seoul', basis: 'startedAt', allVehicles: true });
  expect(month.trips.map(trip => trip.id).sort()).toEqual([november.trip.id, gap.trip.id].sort());
  expect(month.trips.some(trip => trip.id === pending.trip.id)).toBe(false);
  expect(month.summary.receivedCount).toBe(2); expect(month.summary.validDistanceM).toBe(23400); expect(month.summary.excludedDistanceCount).toBe(1); expect(month.summary.incompleteCount).toBe(1); expect(month.summary.pendingCount).toBe(1);
  expect(month.byPurpose.find(group => group.key === 'commute').validDistanceM).toBeNull();
  const blockedReport = await createReport(request, app); expect(blockedReport.readiness.reasons.map(reason => reason.code)).toContain('INCOMPLETE_DISTANCE'); expect(blockedReport.readiness.reasons.map(reason => reason.code)).toContain('PENDING_UPLOADS');
  expect(month.costs.every(cost => cost.occurredOn.startsWith('2026-11') && cost.source === 'dummy-fixture')).toBe(true);
  const octoberData = (await monthly(request, app, '2026-10')).data; expect(octoberData.trips.map(trip => trip.id)).toEqual([october.trip.id]);
  expect(octoberData.costs.every(cost => cost.occurredOn.startsWith('2026-10'))).toBe(true);
  const empty = (await monthly(request, app, '2026-12')).data; expect(empty.trips).toHaveLength(0); expect(empty.costs).toHaveLength(0); expect(empty.summary.validDistanceM).toBeNull(); expect(empty.summary.costTotalKRW).toBe(0);
});

test('MVP frozen snapshots retain rows and versions while latest amendments and pending uploads block stale or incomplete submissions', async ({ request, app }) => {
  const empty = await createReport(request, app, '2026-12'); expect(empty.readiness.canSubmit).toBe(false); expect(empty.readiness.reasons.some(reason => reason.code === 'NO_RECEIVED_TRIPS')).toBe(true);
  expect((await post(request, app, '/mvp-api/submissions', { requestId: randomUUID(), reportId: empty.id })).status()).toBe(409);
  const original = await observedTrip(request, app), first = await createReport(request, app); expect(first.data.summary.unconfirmedCount).toBe(1);
  expect((await post(request, app, '/mvp-api/submissions', { requestId: randomUUID(), reportId: first.id })).status()).toBe(409);
  await json(await amendment(request, app, original.trip.id));
  const stale = (await json(await request.get(`${app.address}/mvp-api/reports/${first.id}`))).report;
  expect(stale.stale).toBe(true); expect(stale.readiness.reasons.some(reason => reason.code === 'STALE_SNAPSHOT')).toBe(true); expect(stale.data).toEqual(first.data);
  const fresh = await createReport(request, app); expect(fresh.version).toBe(first.version + 1); expect(fresh.readiness.canSubmit).toBe(true);
  const awaiting = await observedTrip(request, app, { deliver: false });
  expect((await post(request, app, '/mvp-api/submissions', { requestId: randomUUID(), reportId: fresh.id })).status()).toBe(409);
  const held = await createReport(request, app); expect(held.readiness.reasons.some(reason => reason.code === 'PENDING_UPLOADS')).toBe(true); expect(held.data.summary.receivedCount).toBe(1);
  await json(await post(request, app, '/mvp-api/trip-events', awaiting.queued.body)); await json(await amendment(request, app, awaiting.trip.id));
  const ready = await createReport(request, app); expect(ready.readiness.canSubmit).toBe(true); expect(ready.data.summary.receivedCount).toBe(2);
  const repeatedBody = { requestId: randomUUID(), month: '2026-11' };
  const generated = await json(await post(request, app, '/mvp-api/reports', repeatedBody)); const repeated = await json(await post(request, app, '/mvp-api/reports', repeatedBody)); expect(repeated.report.id).toBe(generated.report.id);
});

test('MVP persisted simulated failure, duplicate submission, retry, and reload preserve one reception with separate attempts', async ({ page, request, app }) => {
  const original = await observedTrip(request, app); await json(await amendment(request, app, original.trip.id));
  const report = await createReport(request, app);
  await page.goto(app.address + '/mvp/control'); await button(page, '모의 제출 실패 재현').click();
  const firstRequest = { requestId: randomUUID(), reportId: report.id };
  const started = (await json(await post(request, app, '/mvp-api/submissions', firstRequest))).submission;
  expect(started.status).toBe('processing');
  const duplicate = (await json(await post(request, app, '/mvp-api/submissions', { requestId: randomUUID(), reportId: report.id }))).submission; expect(duplicate.id).toBe(started.id); expect(duplicate.attempts).toHaveLength(1);
  app.advance(2000); const failed = (await monthly(request, app)).submissions[0]; expect(failed.status).toBe('failed'); expect(failed.attempts[0].receiptNumber).toBeNull();
  await page.goto(app.address + '/mvp/admin'); await expect(monthRegion(page)).toContainText(/모의 (접수 )?실패/); await page.reload(); await expect(monthRegion(page)).toContainText(/모의 (접수 )?실패/);
  await json(await post(request, app, '/mvp-api/simulation/submission-outcome', { outcome: 'success' }));
  const retryBody = { requestId: randomUUID(), reportId: report.id }, retried = (await json(await post(request, app, '/mvp-api/submissions', retryBody))).submission;
  expect(retried.id).toBe(started.id); expect(retried.attempts).toHaveLength(2); expect(retried.attempts[0].status).toBe('failed');
  expect((await json(await post(request, app, '/mvp-api/submissions', retryBody))).submission.attempts).toHaveLength(2);
  app.advance(2000); const completed = (await monthly(request, app)).submissions[0]; expect(completed.status).toBe('completed'); expect(completed.attempts[1].receiptNumber).toMatch(/^DEMO-/);
  const receipt = completed.attempts[1].receiptNumber; await observedTrip(request, app);
  const changed = await monthly(request, app); expect(changed.submissions).toHaveLength(1); expect(changed.submissions[0].attempts[1].receiptNumber).toBe(receipt); expect(changed.reports.find(item => item.id === report.id).stale).toBe(true);
});

test('MVP mobile save failure retains the prepared request and inputs; employee switching ignores an old successful response', async ({ browser, request, app }) => {
  const original = await observedTrip(request, app), phoneContext = await browser.newContext({ viewport: { width: 360, height: 720 } }), phone = await phoneContext.newPage();
  try {
    await phone.goto(app.address + '/mvp/driver'); await employeeSelect(phone).selectOption(A);
    const details = { destination: '실패 후 보존할 가상 목적지', detailedPurpose: '실패 후 보존할 가상 목적' };
    await beginEditor(phone, original.trip.id, details); await assertNoHorizontalOverflow(phone);
    const attempts = [];
    await phone.route('**/mvp-api/trips/*/amendments', route => { attempts.push(route.request().postDataJSON()); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'MVP_FAILED', message: '가상 저장 실패' } }) }); });
    await button(editor(phone), '확인하고 보완 저장').click(); await expect(editor(phone)).toContainText('가상 저장 실패'); await expect(editor(phone)).toContainText(details.destination); expect((await state(request, app)).receivedTrips[0].amendmentVersion).toBe(0);
    await phone.unroute('**/mvp-api/trips/*/amendments');
    let release, committed; const gate = new Promise(resolve => { release = resolve; }), committedPromise = new Promise(resolve => { committed = resolve; });
    await phone.route('**/mvp-api/trips/*/amendments', async route => {
      attempts.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.ok()).toBe(true); committed(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    await button(editor(phone), '확인하고 보완 저장').click(); await committedPromise;
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    await employeeSelect(phone).selectOption(B); await expect(employeeSelect(phone)).toHaveValue(B); release();
    await expect(editor(phone)).toHaveCount(0); await expect(history(phone).locator(`[data-trip-id="${original.trip.id}"]`)).toHaveCount(0);
    await assertNoHorizontalOverflow(phone); const current = (await state(request, app)).receivedTrips[0]; expect(current.employeeId).toBe(A); expect(current.amendmentHistory).toHaveLength(1);
  } finally { await phoneContext.close(); }
});

test('MVP received-list filters do not change company monthly scope and stale monthly responses or query failures cannot invent empty data', async ({ page, request, app }) => {
  const first = await observedTrip(request, app), second = await observedTrip(request, app, { employeeId: B, vehicleId: V2 });
  await json(await amendment(request, app, first.trip.id));
  await json(await amendment(request, app, second.trip.id, amendBody({ employeeId: B, purpose: 'commute' })));
  await page.goto(app.address + '/mvp/admin');
  await expect(received(page).locator('[data-delivery="received"]')).toHaveCount(2);
  const region = monthRegion(page), summary = region.locator('.mvp-monthly-summary').first();
  await expect(summary.locator('strong').first()).toHaveText('2건');
  await page.getByRole('combobox', { name: '직원 필터', exact: true }).selectOption(A);
  await page.getByRole('combobox', { name: '차량 필터', exact: true }).selectOption(V);
  await page.getByRole('combobox', { name: '용도 필터', exact: true }).selectOption('business');
  await expect(received(page).locator('[data-delivery="received"]')).toHaveCount(1);
  await expect(summary.locator('strong').first()).toHaveText('2건');
  const generated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/mvp-api/reports');
  await button(region, '월별 자료 생성').click();
  expect((await json(await generated)).report.data.summary.receivedCount).toBe(2);
  await page.getByLabel('기간 시작일', { exact: true }).fill('2026-11-16');
  await expect(received(page).locator('[data-delivery="received"]')).toHaveCount(0);
  await expect(summary.locator('strong').first()).toHaveText('2건');
  await button(page, '운행 필터 초기화').click(); await expect(received(page).locator('[data-delivery="received"]')).toHaveCount(2);
  await page.route('**/mvp-api/monthly?month=*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: '가상 월별 조회 실패' } }) }));
  await expect(region.getByRole('alert')).toContainText('가상 월별 조회 실패');
  await expect(region).toContainText('이전 조회값을 유지합니다'); await expect(summary.locator('strong').first()).toHaveText('2건');
  await expect(button(region, '월별 자료 생성')).toBeDisabled();
  await page.unroute('**/mvp-api/monthly?month=*'); await expect(region.getByRole('alert')).toHaveCount(0);
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), held = new Promise(resolve => { arrived = resolve; });
  await page.route('**/mvp-api/monthly?month=2026-10', async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await region.getByLabel('집계 월', { exact: true }).fill('2026-10'); await held;
  await region.getByLabel('집계 월', { exact: true }).fill('2026-11');
  await expect(summary.locator('strong').first()).toHaveText('2건'); release();
  await expect(region.getByLabel('집계 월', { exact: true })).toHaveValue('2026-11');
  await expect(summary.locator('strong').first()).toHaveText('2건');
});
