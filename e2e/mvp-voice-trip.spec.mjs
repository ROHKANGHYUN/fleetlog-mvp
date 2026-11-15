import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMvpServer } from '../services/mvp/server.mjs';

// Real local HTTP/SQLite and fresh browser contexts. Fake TTS observes browser
// API calls/callbacks only; these tests never claim that sound was heard.
const test = base.extend({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'chagok-mvp-voice-e2e-'));
    let running;
    try {
      running = await startMvpServer({ port: 0, filename: join(directory, 'mvp.sqlite'), staticDir: resolve('apps/web/dist') });
      await use(running);
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

const QUESTION = '어디를 다녀오셨고, 어떤 목적으로 운행하셨나요?';
const employeeSelect = page => page.getByRole('combobox', { name: '데모 계정 선택', exact: true });
const history = page => page.getByRole('region', { name: '직원 운행 내역', exact: true });
const receivedList = page => page.getByRole('region', { name: '서버 수신 운행 목록', exact: true });
async function snapshot(request, app) {
  const response = await request.get(`${app.address}/mvp-api/state`);
  expect(response.ok()).toBeTruthy();return response.json();
}
async function blankCar(page) {
  await expect.poll(() => page.locator('.mvp-car-screen').textContent()).toBe('');
  await expect(page.locator('.mvp-car-screen > *')).toHaveCount(0);
  await expect(page.locator('button,input,select,form,[role="dialog"]')).toHaveCount(0);
}

function installSpeechSpy() {
  const countsKey = '__chagokE2eTtsCalls';
  class Utterance {
    constructor(text = '') { this.text = text;this.lang = '';this.onstart = null;this.onend = null;this.onerror = null; }
    addEventListener(type, listener) { this[`on${type}`] = listener; }
    removeEventListener(type, listener) { if (this[`on${type}`] === listener) this[`on${type}`] = null; }
  }
  const trace = { utterances: [], texts: [], autoEnd: true, cancelCount: 0 };
  Object.defineProperty(window, '__tts', { value: trace, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ lang: 'ko-KR', name: 'E2E API-only voice', default: true, localService: true }],
    speak(utterance) {
      trace.utterances.push(utterance);trace.texts.push(utterance.text);
      const prior = JSON.parse(sessionStorage.getItem(countsKey) || '[]');prior.push(utterance.text);
      sessionStorage.setItem(countsKey, JSON.stringify(prior));
      utterance.onstart?.({ type: 'start' });
      if (trace.autoEnd) queueMicrotask(() => utterance.onend?.({ type: 'end' }));
    },
    // Deliberately do not suppress stored callbacks. A hostile late onend can
    // still be invoked by a test, exercising the production cancellation guard.
    cancel() { trace.cancelCount++; }, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
  } });
}
function disableSpeech() {
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
}

async function openRoles({ browser, context, page, app }, speech = 'unavailable') {
  await page.addInitScript(speech === 'spy' ? installSpeechSpy : disableSpeech);
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneContext.newPage(), car = await context.newPage(), admin = await context.newPage();
  await Promise.all([page.goto(`${app.address}/mvp/control`), car.goto(`${app.address}/mvp/car`), admin.goto(`${app.address}/mvp/admin`)]);
  await expect(page.getByRole('combobox', { name: '시연 차량', exact: true })).toBeVisible();
  return { control: page, phone, car, admin, async close() { await phoneContext.close();await car.close();await admin.close();await page.close(); } };
}
async function connect(roles, request, app, index = 0) {
  const initial = await snapshot(request, app), employee = initial.employees[index], vehicle = initial.vehicles[0];
  const issued = await (await request.get(`${app.address}/mvp-api/vehicles/${vehicle.id}/qr`)).json();
  await roles.phone.goto(issued.url);await employeeSelect(roles.phone).selectOption(employee.id);
  await expect(employeeSelect(roles.phone)).toHaveValue(employee.id);
  const connectionResponse=roles.phone.waitForResponse(response=>new URL(response.url()).pathname==='/mvp-api/connections'&&response.request().method()==='POST');
  await roles.phone.getByRole('button', { name: '이 차량에 연결', exact: true }).click();
  const response=await connectionResponse;
  expect(response.ok(),`mobile connection response ${response.status()}: ${await response.text()}`).toBeTruthy();
  await expect.poll(async () => (await snapshot(request, app)).vehicles[0].connection?.employeeId).toBe(employee.id);
  await parkedCar(roles.car);
  const connection = (await snapshot(request, app)).vehicles[0].connection;
  expect((await snapshot(request, app)).prompts.filter(prompt => prompt.connectionId === connection.id)).toHaveLength(0);
  return { employee, vehicle, connection };
}
async function parkedCar(page) {
  await expect(page.locator('.mvp-car-screen').getByText('주차 확인됨', { exact: true })).toBeVisible();
  await expect(page.locator('.mvp-car-screen').getByRole('button', { name: '운행 마치기', exact: true })).toBeVisible();
  await expect(page.locator('.mvp-car-screen').locator('input,select,form,[role="dialog"]')).toHaveCount(0);
}
async function simulatePrompt(control) {
  const button = control.getByRole('button', { name: '안내 완료 모의', exact: true });
  await expect(button).toBeEnabled();await button.click();
}
async function answerAndConfirm(control) {
  await simulatePrompt(control);
  await control.getByRole('button', { name: '모의 발화 전달', exact: true }).click();
  await simulatePrompt(control);
  await control.getByRole('button', { name: '모의 네', exact: true }).click();
}
async function startAndPark(roles, request, app) {
  await roles.control.getByRole('button', { name: '모의 출발', exact: true }).click();
  await blankCar(roles.car);
  await expect(roles.control.getByRole('button', { name: '모의 도착', exact: true })).toBeEnabled();
  await roles.control.getByRole('button', { name: '모의 도착', exact: true }).click();
  await parkedCar(roles.car);
  await expect(roles.car.getByRole('button', { name: '운행 마치기', exact: true })).toBeEnabled();
  const result = await snapshot(request, app);
  expect(result.activeTrips).toHaveLength(1);
  expect(result.activeTrips[0].endedAt).toBeNull();
  expect(result.activeTrips[0].candidateEnd).toBeNull();
  return result.activeTrips[0];
}
async function finish(roles) {
  await roles.car.getByRole('button', { name: '운행 마치기', exact: true }).click();
}

test('MVP asks purpose only after parked finish, auto-uploads the confirmed fixed boundary, and ignores duplicate commands', async ({ browser, context, page, request, app }) => {
  test.setTimeout(60000);
  const roles = await openRoles({ browser, context, page, app }, 'spy');
  try {
    const commandBodies = [], uploads = [];
    for (const client of [roles.control, roles.car]) client.on('request', req => {
      if (new URL(req.url()).pathname === '/mvp-api/commands') commandBodies.push(req.postDataJSON());
      if (new URL(req.url()).pathname === '/mvp-api/trip-events') uploads.push(req.postData());
    });
    await roles.control.getByRole('button', { name: '시연 음성 준비', exact: true }).click();
    const actor = await connect(roles, request, app);
    expect(await roles.control.evaluate(question => window.__tts.texts.filter(text => text === question).length, QUESTION)).toBe(0);
    const observed = await startAndPark(roles, request, app);
    expect((await snapshot(request, app)).receivedTrips).toHaveLength(0);
    expect((await snapshot(request, app)).pendingUploads).toHaveLength(0);
    expect(await roles.control.evaluate(question => window.__tts.texts.filter(text => text === question).length, QUESTION)).toBe(0);
    await finish(roles);
    await expect(roles.control.getByRole('button', { name: '모의 발화 전달', exact: true })).toBeEnabled();
    const boundary = (await snapshot(request, app)).activeTrips[0].candidateEnd;
    await expect.poll(() => roles.control.evaluate(question => window.__tts.texts.filter(text => text === question).length, QUESTION)).toBe(1);
    await roles.control.reload();
    expect(await roles.control.evaluate(question => JSON.parse(sessionStorage.getItem('__chagokE2eTtsCalls') || '[]').filter(text => text === question).length, QUESTION)).toBe(1);
    await roles.control.getByRole('button', { name: '시연 음성 준비', exact: true }).click();
    await roles.control.getByRole('button', { name: '모의 발화 전달', exact: true }).click();
    await expect(roles.control.getByRole('button', { name: '모의 네', exact: true })).toBeEnabled();
    await roles.control.getByRole('button', { name: '모의 네', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(1);
    const result = await snapshot(request, app), trip = result.receivedTrips[0];
    expect(trip.id).toBe(observed.id);expect(trip.startedAt).toBe(observed.startedAt);expect(trip.endedAt).toBe(boundary.endedAt);
    expect(trip.endOdometerM).toBe(boundary.endOdometerM);
    expect(trip.employeeId).toBe(actor.employee.id);expect(trip.connectionId).toBe(actor.connection.id);
    expect(trip.companyId).toBe(actor.connection.companyId);expect(trip.vehicleId).toBe(actor.vehicle.id);
    expect(trip.source).toBe('mock');expect(trip.purpose).toBe('business');expect(trip.destination).toBe('판교 거래처');
    expect(trip.detailedPurpose).toBe('계약 미팅');expect(trip.purposeConfirmed).toBe(true);expect(trip.distanceM).toBe(23400);
    await expect(history(roles.phone).locator(`[data-trip-id="${trip.id}"]`)).toContainText('서버 수신');
    await expect(receivedList(roles.admin).locator(`[data-trip-id="${trip.id}"]`)).toContainText(actor.employee.name);
    await parkedCar(roles.car);
    expect(uploads.length).toBeGreaterThan(0);
    const repeated = await request.post(`${app.address}/mvp-api/trip-events`, { headers: { 'Content-Type': 'application/json' }, data: uploads[0] });
    expect(repeated.ok()).toBeTruthy();expect((await repeated.json()).tripId).toBe(trip.id);
    for (const body of commandBodies.filter(body => ['answer','confirm','depart','arrive','finish'].includes(body.type))) {
      expect((await request.post(`${app.address}/mvp-api/commands`, { data: body })).ok()).toBeTruthy();
    }
    expect((await snapshot(request, app)).receivedTrips).toHaveLength(1);
    expect((await snapshot(request, app)).activeTrips).toHaveLength(0);
  } finally { await roles.close(); }
});

test('MVP re-departure during purpose dialogue keeps the original segment, cancels the draft, and blocks handover', async ({ browser, context, page, request, app }) => {
  const roles = await openRoles({ browser, context, page, app });
  try {
    const actor = await connect(roles, request, app), original = await startAndPark(roles, request, app);
    await finish(roles);await simulatePrompt(roles.control);
    await roles.control.getByRole('button', { name: '모의 발화 전달', exact: true }).click();
    const oldConversation=(await snapshot(request,app)).conversations.find(item=>item.isCurrent);
    await roles.control.getByRole('button', { name: '모의 출발', exact: true }).click();
    await blankCar(roles.car);
    const lateAnswer=await request.post(`${app.address}/mvp-api/commands`,{data:{commandId:randomUUID(),connectionId:actor.connection.id,conversationId:oldConversation.id,type:'answer',value:'판교 거래처에 업무 미팅하러 갑니다.'}});
    expect(lateAnswer.status()).toBe(409);
    const moving = (await snapshot(request, app)).activeTrips[0];
    expect(moving.id).toBe(original.id);expect(moving.startedAt).toBe(original.startedAt);expect(moving.startOdometerM).toBe(original.startOdometerM);
    expect(moving.candidateEnd).toBeNull();expect(moving.purpose).toBeNull();expect(moving.purposeConfirmed).toBe(false);
    await expect(roles.phone.getByRole('button', { name: '연결 해제', exact: true })).toBeDisabled();
    const rejectedHandover = await request.post(`${app.address}/mvp-api/connections/${actor.connection.id}/disconnect`, { data: { employeeId: actor.employee.id } });
    expect(rejectedHandover.status()).toBe(409);
    expect((await snapshot(request, app)).vehicles[0].connection.id).toBe(actor.connection.id);
    await roles.control.getByRole('button', { name: '모의 도착', exact: true }).click();
    await parkedCar(roles.car);expect((await snapshot(request, app)).receivedTrips).toHaveLength(0);
    await finish(roles);await roles.control.getByRole('button', { name: '모의 무응답', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(1);
    const received = (await snapshot(request, app)).receivedTrips[0];
    expect(received.id).toBe(original.id);expect(received.distanceM).toBe(46800);
    expect(received.purpose).toBeNull();expect(received.detailedPurpose).toBeNull();expect(received.purposeConfirmed).toBe(false);
    await expect(history(roles.phone).locator(`[data-trip-id="${received.id}"]`)).toContainText(/미확정|확인 필요/);
    await expect(receivedList(roles.admin).locator(`[data-trip-id="${received.id}"]`)).toContainText(/미확정|확인 필요/);
  } finally { await roles.close(); }
});

test('MVP blocked uploads survive reload and driver handover; recovery keeps the original employee and one receipt', async ({ browser, context, page, request, app }) => {
  test.setTimeout(60000);
  const roles = await openRoles({ browser, context, page, app });
  try {
    const actor = await connect(roles, request, app);
    await roles.control.getByRole('button', { name: '운행 업로드 차단', exact: true }).click();
    await startAndPark(roles, request, app);await finish(roles);await answerAndConfirm(roles.control);
    await expect.poll(async () => (await snapshot(request, app)).pendingUploads.filter(event => event.status !== 'received').length).toBe(1);
    const blocked = await snapshot(request, app), pending = blocked.pendingUploads.find(event => event.status !== 'received');
    expect(blocked.receivedTrips).toHaveLength(0);await expect(receivedList(roles.admin)).toContainText(/없|0/);
    await expect(roles.car.locator('.mvp-car-screen')).toContainText('회사 전송 대기 1건');
    await roles.control.reload();await expect(roles.control.getByRole('button', { name: '운행 업로드 복구', exact: true })).toBeVisible();
    expect((await snapshot(request, app)).pendingUploads.find(event => event.eventId === pending.eventId).body).toBe(pending.body);
    await roles.phone.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).vehicles[0].connection).toBeNull();
    const second = await connect(roles, request, app, 1);
    await expect(history(roles.phone).locator(`[data-trip-id="${pending.tripId}"]`)).toHaveCount(0);
    expect(second.employee.id).not.toBe(actor.employee.id);
    await roles.control.getByRole('button', { name: '운행 업로드 복구', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(1);
    const received = (await snapshot(request, app)).receivedTrips[0];
    expect(received.id).toBe(pending.tripId);expect(received.employeeId).toBe(actor.employee.id);expect(received.connectionId).toBe(actor.connection.id);
    await expect(receivedList(roles.admin).locator(`[data-trip-id="${received.id}"]`)).toContainText(actor.employee.name);
    await expect(history(roles.phone).locator(`[data-trip-id="${received.id}"]`)).toHaveCount(0);
    await employeeSelect(roles.phone).selectOption(actor.employee.id);
    await expect(history(roles.phone).locator(`[data-trip-id="${received.id}"]`)).toContainText(/서버 수신/);
    await parkedCar(roles.car);
  } finally { await roles.close(); }
});

test('MVP recording stop and employee handover reject a hostile late speech completion from the old context', async ({ browser, context, page, request, app }) => {
  const roles = await openRoles({ browser, context, page, app }, 'spy');
  try {
    await roles.control.getByRole('button', { name: '시연 음성 준비', exact: true }).click();
    await roles.control.evaluate(() => { window.__tts.autoEnd = false; });
    const oldActor = await connect(roles, request, app);
    await roles.control.getByRole('button', { name: '운행 업로드 차단', exact: true }).click();
    await startAndPark(roles, request, app);await finish(roles);
    await expect.poll(() => roles.control.evaluate(question => window.__tts.texts.filter(text => text === question).length, QUESTION)).toBe(1);
    const before = await snapshot(request, app), oldPrompt = before.prompts.find(prompt => prompt.connectionId === oldActor.connection.id && prompt.status === 'claimed');
    expect(oldPrompt).toBeTruthy();
    await roles.control.evaluate(question => { window.__oldTts = window.__tts.utterances.find(utterance => utterance.text === question); }, QUESTION);
    await roles.car.getByRole('button', { name: '기록 종료', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).activeTrips.length).toBe(0);
    await roles.phone.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).vehicles[0].connection).toBeNull();
    const nextActor = await connect(roles, request, app, 1);
    await startAndPark(roles, request, app);await finish(roles);
    await expect.poll(() => roles.control.evaluate(question => window.__tts.texts.filter(text => text === question).length, QUESTION)).toBe(2);
    await roles.control.evaluate(() => { window.__oldTts.onend?.({ type: 'end' }); });
    const stale = await request.post(`${app.address}/mvp-api/voice/complete`, { data: { commandId: randomUUID(), promptId: oldPrompt.id, clientId: oldPrompt.claimedBy, outcome: 'played' } });
    expect(stale.ok()).toBe(false);
    const after = await snapshot(request, app), nextConversation = after.conversations.find(conversation => conversation.connectionId === nextActor.connection.id && conversation.isCurrent);
    expect(nextConversation.phase).toBe('question');expect(nextConversation.draft).toBeNull();
    expect(after.activeTrips).toHaveLength(1);expect(after.receivedTrips).toHaveLength(0);
    expect(after.pendingUploads.filter(event=>event.status!=='received')).toHaveLength(1);
  } finally { await roles.close(); }
});

test('MVP refusal, later, and unsupported answers preserve one fixed boundary without invented consent', async ({ browser, context, page, request, app }) => {
  const roles = await openRoles({ browser, context, page, app });
  try {
    const actor = await connect(roles, request, app);
    await startAndPark(roles, request, app);await finish(roles);
    const boundary=(await snapshot(request,app)).activeTrips[0].candidateEnd;
    await simulatePrompt(roles.control);await roles.control.getByRole('button', { name: '모의 발화 전달', exact: true }).click();
    await simulatePrompt(roles.control);await roles.control.getByRole('button', { name: '모의 아니요', exact: true }).click();
    await expect(roles.control.getByRole('button', { name: '안내 완료 모의', exact: true })).toBeEnabled();
    await simulatePrompt(roles.control);
    await roles.control.getByRole('combobox', { name: '모의 답변 예시', exact: true }).selectOption('ambiguous');
    await roles.control.getByRole('button', { name: '모의 발화 전달', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(1);
    const result = await snapshot(request, app);
    expect(result.receivedTrips[0].purpose).toBeNull();expect(result.receivedTrips[0].purposeConfirmed).toBe(false);
    expect(result.receivedTrips[0].endedAt).toBe(boundary.endedAt);expect(result.receivedTrips[0].endOdometerM).toBe(boundary.endOdometerM);
    expect(result.conversations.filter(conversation=>conversation.connectionId===actor.connection.id&&conversation.isCurrent)).toHaveLength(0);
    await startAndPark(roles, request, app);await finish(roles);
    const nextConversation=(await snapshot(request, app)).conversations.find(conversation=>conversation.connectionId===actor.connection.id&&conversation.isCurrent);
    expect(nextConversation.draft).toBeNull();expect(nextConversation.confirmed).toBe(false);
    await roles.control.getByRole('button', { name: '모의 나중에', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(2);
    const later = (await snapshot(request, app)).receivedTrips[1];
    expect(later.purpose).toBeNull();expect(later.purposeConfirmed).toBe(false);
    await parkedCar(roles.car);
  } finally { await roles.close(); }
});

test('MVP unavailable speech and mock silence preserve a review-needed record while parking UI remains visible', async ({ browser, context, page, request, app }) => {
  const roles = await openRoles({ browser, context, page, app });
  try {
    await roles.control.getByRole('button', { name: '시연 음성 준비', exact: true }).click();
    await expect(roles.control.locator('[data-speech-status="unavailable"]')).toContainText('사용할 수 없습니다');
    await connect(roles, request, app);await startAndPark(roles, request, app);await finish(roles);
    await roles.control.getByRole('button', { name: '모의 무응답', exact: true }).click();
    await expect.poll(async () => (await snapshot(request, app)).receivedTrips.length).toBe(1);
    const trip = (await snapshot(request, app)).receivedTrips[0];
    expect(trip.purpose).toBeNull();expect(trip.destination).toBeNull();expect(trip.purposeConfirmed).toBe(false);
    await expect(history(roles.phone).locator(`[data-trip-id="${trip.id}"]`)).toContainText(/미확정|확인 필요/);
    expect(await roles.phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await parkedCar(roles.car);
  } finally { await roles.close(); }
});
