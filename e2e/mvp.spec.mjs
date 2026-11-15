import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import jsQR from 'jsqr';
import { startMvpServer } from '../services/mvp/server.mjs';

// This suite never opens the development origin or its database. Separate
// browser contexts model the driver's phone and the PC car/admin displays.
const test = base.extend({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'chagok-mvp-e2e-'));
    let clock = Date.now(), running;
    try {
      running = await startMvpServer({ port: 0, filename: join(directory, 'mvp.sqlite'),
        staticDir: resolve('apps/web/dist'), now: () => clock, tokenTtlMs: 600000 });
      await use({ ...running, advance: milliseconds => { clock += milliseconds; } });
    } finally {
      await running?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function state(request, app) {
  const response = await request.get(`${app.address}/mvp-api/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function qr(request, app, vehicleId) {
  const response = await request.get(`${app.address}/mvp-api/vehicles/${vehicleId}/qr`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const carScreen = page => page.locator('.mvp-car-screen');
const current = page => page.locator('.mvp-current-connection');
const employeeSelect = page => page.getByRole('combobox', { name: '데모 계정 선택', exact: true });
const vehicleCard = (page, id) => page.locator(`.mvp-vehicle-card[data-vehicle-id="${id}"]`);

// Latest vehicle requirements: parking shows the live waiting UI; only driving is blank.
async function parkedCar(page) {
  await expect(carScreen(page).getByText('주차 확인됨', { exact: true })).toBeVisible();
  await expect(carScreen(page).getByText('Fleetlog 운행기록', { exact: true })).toBeVisible();
  await expect(carScreen(page).getByRole('button', { name: '운행 마치기', exact: true })).toBeDisabled();
  await expect(carScreen(page).locator('input,select,form,[role="dialog"]')).toHaveCount(0);
  await expect(carScreen(page).locator('.mvp-qr')).toHaveCount(0);
}
async function decodeDisplayedQr(page) {
  const pixels = await page.evaluate(async () => {
    const svg = document.querySelector('.mvp-qr svg');
    if (!svg) throw Error('No encoded QR in the car display');
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 512;canvas.height = 512;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';context.fillRect(0, 0, 512, 512);
    context.drawImage(image, 0, 0, 512, 512);
    return { data: Array.from(context.getImageData(0, 0, 512, 512).data), width: 512, height: 512 };
  });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  expect(decoded, 'The rendered image must decode as a QR, not merely resemble one').not.toBeNull();
  return decoded.data;
}

test('MVP QR-first selection connects real shared state, shows the parked waiting screen, and restores after reload', async ({ browser, page: admin, request, app }) => {
  const initial = await state(request, app), vehicle = initial.vehicles[0], employee = initial.employees[0];
  expect(initial.employees).toHaveLength(2);expect(initial.vehicles).toHaveLength(2);
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const carContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const phone = await phoneContext.newPage(), car = await carContext.newPage();
    await admin.goto(`${app.address}/mvp/admin`);
    await car.goto(`${app.address}/mvp/car?vehicleId=${vehicle.id}`);
    await expect(carScreen(car).locator('.mvp-qr svg')).toBeVisible();
    const issued = await qr(request, app, vehicle.id);
    expect(await decodeDisplayedQr(car)).toBe(issued.url);
    expect([...new URL(issued.url).searchParams.keys()]).toEqual(['token']);
    expect(issued.url).not.toContain(employee.name);
    await phone.goto(issued.url);
    await expect(employeeSelect(phone)).toBeVisible();
    // Opening/scanning never commits a connection, including before account selection.
    expect((await state(request, app)).connections).toHaveLength(0);
    await employeeSelect(phone).selectOption(employee.id);
    await expect(phone.getByRole('button', { name: '이 차량에 연결', exact: true })).toBeVisible();
    await expect(phone.locator('body')).toContainText(employee.department);
    await expect(phone.locator('body')).toContainText(employee.title);
    expect((await state(request, app)).connections).toHaveLength(0);
    await phone.getByRole('button', { name: '이 차량에 연결', exact: true }).click();
    await expect(current(phone)).toContainText(vehicle.name);
    await expect(vehicleCard(admin, vehicle.id)).toContainText(employee.name);
    await parkedCar(car);
    const connected = (await state(request, app)).vehicles.find(row => row.id === vehicle.id).connection;
    expect(connected.employeeId).toBe(employee.id);
    expect(connected.companyId).toBe(initial.company.id);
    await expect(current(phone)).toHaveAttribute('data-connection-id', connected.id);
    // Repeated acknowledgement uses the same row, not a local success flag.
    const repeated = await request.post(`${app.address}/mvp-api/connections`, { data: { token: issued.token, employeeId: employee.id } });
    expect(repeated.ok()).toBeTruthy();
    expect((await repeated.json()).connection.id).toBe(connected.id);
    expect((await state(request, app)).connections).toHaveLength(1);
    await phone.reload();await car.reload();await admin.reload();
    await expect(current(phone)).toHaveAttribute('data-connection-id', connected.id);
    await expect(vehicleCard(admin, vehicle.id)).toContainText(employee.name);
    await parkedCar(car);
    // Admin failure must preserve its last result and identify a query error.
    await admin.route('**/mvp-api/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY', message: '가상 일시 조회 오류' } }) }));
    await expect(admin.getByRole('alert')).toBeVisible();
    await expect(vehicleCard(admin, vehicle.id)).toContainText(employee.name);
    await expect(admin.locator('body')).toContainText(/이전|마지막/);
    await admin.unroute('**/mvp-api/state');
    await expect(admin.getByRole('alert')).toHaveCount(0);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await phoneContext.close();await carContext.close(); }
});

test('MVP account-first flow disconnects, rotates the QR, and rejects stale requests without changing the new connection', async ({ page, request, app }) => {
  const initial = await state(request, app), [firstEmployee, secondEmployee] = initial.employees, vehicle = initial.vehicles[0];
  const car = await page.context().newPage();
  await car.goto(`${app.address}/mvp/car?vehicleId=${vehicle.id}`);
  await expect(carScreen(car).locator('.mvp-qr svg')).toBeVisible();
  await page.goto(`${app.address}/mvp/driver`);
  await employeeSelect(page).selectOption(firstEmployee.id);
  const first = await qr(request, app, vehicle.id);
  // A camera/link may open another tab in the same browser profile. Only the
  // demo account preference carries across tabs; opening still does not connect.
  const driver = await page.context().newPage();
  await driver.goto(first.url);
  await expect(employeeSelect(driver)).toHaveValue(firstEmployee.id);
  expect((await state(request, app)).connections).toHaveLength(0);
  await driver.getByRole('button', { name: '이 차량에 연결', exact: true }).click();
  await expect(current(driver)).toBeVisible();
  await parkedCar(car);
  const original = (await state(request, app)).vehicles[0].connection;
  await driver.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect.poll(async () => (await state(request, app)).vehicles[0].connection).toBeNull();
  const next = await qr(request, app, vehicle.id);
  expect(next.token).not.toBe(first.token);
  await expect(carScreen(car).locator('.mvp-qr svg')).toBeVisible();
  expect(await decodeDisplayedQr(car)).toBe(next.url);
  await driver.goto(next.url);await employeeSelect(driver).selectOption(secondEmployee.id);
  // Changing the preference elsewhere must not silently switch this tab's employee.
  await expect(employeeSelect(page)).toHaveValue(firstEmployee.id);
  await driver.getByRole('button', { name: '이 차량에 연결', exact: true }).click();
  await expect(current(driver)).toBeVisible();
  await parkedCar(car);
  const latest = (await state(request, app)).vehicles[0].connection;
  expect(latest.employeeId).toBe(secondEmployee.id);expect(latest.id).not.toBe(original.id);
  const delayed = await request.post(`${app.address}/mvp-api/connections`, { data: { token: first.token, employeeId: firstEmployee.id } });
  expect(delayed.status()).toBe(410);
  const lateDisconnect = await request.post(`${app.address}/mvp-api/connections/${original.id}/disconnect`, { data: { employeeId: firstEmployee.id } });
  expect(lateDisconnect.ok()).toBeTruthy();
  expect((await state(request, app)).vehicles[0].connection).toEqual(latest);
  expect((await state(request, app)).connections).toHaveLength(2);
});

test('MVP expires tokens on the server, refuses invalid links, and requires explicit confirmation', async ({ page, request, app }) => {
  // Freeze background polling after the initial load so this explicitly tests
  // an already displayed confirmation arriving after server-side expiration.
  await page.clock.install({ time: new Date('2026-11-15T01:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-11-15T01:00:01.000Z'));
  const initial = await state(request, app), vehicle = initial.vehicles[0], employee = initial.employees[0];
  const old = await qr(request, app, vehicle.id);
  await page.goto(old.url);await employeeSelect(page).selectOption(employee.id);
  app.advance(600001);
  await page.getByRole('button', { name: '이 차량에 연결', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(/만료|유효/);
  expect((await state(request, app)).connections).toHaveLength(0);
  const next = await qr(request, app, vehicle.id);expect(next.token).not.toBe(old.token);
  await page.goto(`${app.address}/mvp/driver?token=not-a-valid-token`);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '이 차량에 연결', exact: true })).toHaveCount(0);
  expect((await state(request, app)).connections).toHaveLength(0);
});

test('MVP concurrent different employees have one winner and a consumed QR cannot be reused by another employee', async ({ browser, request, app }) => {
  const initial = await state(request, app), vehicle = initial.vehicles[0], token = await qr(request, app, vehicle.id);
  const contexts = await Promise.all(initial.employees.map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all(pages.map(async (page, i) => {
      await page.goto(token.url);await employeeSelect(page).selectOption(initial.employees[i].id);
      await expect(page.getByRole('button', { name: '이 차량에 연결', exact: true })).toBeVisible();
    }));
    const responses = await Promise.all(contexts.map((context, i) => context.request.post(`${app.address}/mvp-api/connections`, { data: { token: token.token, employeeId: initial.employees[i].id } })));
    expect(responses.map(response => response.status()).sort()).toEqual([200, 409]);
    const winner = responses.findIndex(response => response.ok()), loser = winner === 0 ? 1 : 0;
    const snapshot = await state(request, app);
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.vehicles[0].connection.employeeId).toBe(initial.employees[winner].id);
    await expect(current(pages[winner])).toContainText(vehicle.name);
    await pages[loser].reload();
    await expect(pages[loser].getByRole('alert')).toBeVisible();
    expect((await state(request, app)).connections).toHaveLength(1);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('MVP screens coexist with an occupied legacy writer lock and never touch the legacy storage key', async ({ context, page: control, request, app }) => {
  const initial = await state(request, app), vehicle = initial.vehicles[1];
  await control.goto(`${app.address}/mvp/control`);
  const sentinel = 'existing legacy content must remain byte-for-byte unchanged';
  await control.evaluate(async value => {
    localStorage.setItem('fleetlog.mock.v1', value);
    window.__mvpTestLockHeld = false;
    void navigator.locks.request('fleetlog-writer-v1', async () => {
      window.__mvpTestLockHeld = true;
      await new Promise(resolve => { window.__releaseMvpTestLock = resolve; });
    });
  }, sentinel);
  await expect.poll(() => control.evaluate(() => window.__mvpTestLockHeld)).toBe(true);
  const car = await context.newPage(), admin = await context.newPage(), driver = await context.newPage();
  await Promise.all([car.goto(`${app.address}/mvp/car?vehicleId=${vehicle.id}`), admin.goto(`${app.address}/mvp/admin`), driver.goto(`${app.address}/mvp/driver`)]);
  await expect(carScreen(car).locator('.mvp-qr svg')).toBeVisible();
  await expect(employeeSelect(driver)).toBeVisible();
  await expect(vehicleCard(admin, vehicle.id)).toBeVisible();
  await expect(control.getByRole('combobox', { name: '시연 차량', exact: true })).toBeVisible();
  for (const page of [car, admin, driver, control]) {
    expect(await page.evaluate(() => localStorage.getItem('fleetlog.mock.v1'))).toBe(sentinel);
    await expect(page.getByText('다른 탭에서 Fleetlog를 사용 중입니다', { exact: true })).toHaveCount(0);
  }
  await control.evaluate(() => window.__releaseMvpTestLock());
});

test('MVP driver controls stay usable at a narrow mobile width', async ({ page, request, app }) => {
  const initial = await state(request, app), token = await qr(request, app, initial.vehicles[0].id);
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto(token.url);await employeeSelect(page).selectOption(initial.employees[0].id);
  await expect(page.getByRole('button', { name: '이 차량에 연결', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = await page.locator('button,select').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => ({ label: element.textContent, height: element.getBoundingClientRect().height })));
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.filter(control => control.height < 56)).toEqual([]);
});
