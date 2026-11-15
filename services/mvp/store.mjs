import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MvpWorkflow } from './workflow.mjs';
import { MvpReporting } from './reporting.mjs';

export class MvpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const problem = (status, code, message) => { throw new MvpError(status, code, message); };
const digest = token => createHash('sha256').update(token).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function normalizeCode(code) {
  if (typeof code !== 'string' || code.length > 20) problem(404, 'INVALID_CODE', '유효하지 않은 연결 코드입니다.');
  const normalized=code.toUpperCase().replace(/[\s-]/g,'');
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(normalized)) problem(404, 'INVALID_CODE', '연결 코드 여섯 자리를 확인해 주세요.');
  return normalized;
}
const connection = row => row && ({ id: row.id, companyId: row.company_id, employeeId: row.employee_id,
  vehicleId: row.vehicle_id, connectedAt: row.connected_at, disconnectedAt: row.disconnected_at, status: row.status });
const vehicle = row => row && ({ id: row.id, name: row.name, plate: row.plate, companyId: row.company_id });
const employee = row => ({ id: row.id, name: row.name, companyId: row.company_id, department: row.department, title: row.title });

/** Separate, disposable MVP database. This store never opens or imports trip data. */
export class MvpStore {
  constructor({ filename = ':memory:', now = () => Date.now(), tokenTtlMs = 600_000 } = {}) {
    if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) throw new Error('tokenTtlMs must be positive.');
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.now = now;
    this.tokenTtlMs = tokenTtlMs;
    // Plaintext is retained only in this process to redisplay an outstanding QR.
    this.currentTokens = new Map();
    this.currentCodes = new Map();
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS mvp_companies(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_employees(id TEXT PRIMARY KEY,name TEXT NOT NULL,company_id TEXT NOT NULL REFERENCES mvp_companies(id),department TEXT NOT NULL,title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_vehicles(id TEXT PRIMARY KEY,name TEXT NOT NULL,plate TEXT NOT NULL,company_id TEXT NOT NULL REFERENCES mvp_companies(id),generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mvp_connections(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES mvp_companies(id),employee_id TEXT NOT NULL REFERENCES mvp_employees(id),vehicle_id TEXT NOT NULL REFERENCES mvp_vehicles(id),connected_at TEXT NOT NULL,disconnected_at TEXT,status TEXT NOT NULL CHECK(status IN ('active','disconnected')));
      CREATE UNIQUE INDEX IF NOT EXISTS mvp_one_active_vehicle ON mvp_connections(vehicle_id) WHERE status='active';
      CREATE UNIQUE INDEX IF NOT EXISTS mvp_one_active_employee ON mvp_connections(employee_id) WHERE status='active';
      CREATE TABLE IF NOT EXISTS mvp_qr_tokens(token_hash TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL REFERENCES mvp_vehicles(id),generation INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('available','used','revoked')),connection_id TEXT);
      CREATE TABLE IF NOT EXISTS mvp_pairing_codes(code_hash TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE REFERENCES mvp_qr_tokens(token_hash));
      INSERT OR IGNORE INTO mvp_companies VALUES('mvp-company-001','가상 Fleetlog 주식회사');
      INSERT OR IGNORE INTO mvp_employees VALUES('mvp-employee-001','가상 김차곡','mvp-company-001','가상 영업팀','가상 매니저');
      INSERT OR IGNORE INTO mvp_employees VALUES('mvp-employee-002','가상 이연결','mvp-company-001','가상 운영팀','가상 대리');
      INSERT OR IGNORE INTO mvp_vehicles(id,name,plate,company_id) VALUES('mvp-vehicle-001','가상 업무 차량 1','가상 00가 1001','mvp-company-001');
      INSERT OR IGNORE INTO mvp_vehicles(id,name,plate,company_id) VALUES('mvp-vehicle-002','가상 업무 차량 2','가상 00가 1002','mvp-company-001');
    `);
    this.workflow = new MvpWorkflow(this);
    this.reporting = new MvpReporting(this);
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM mvp_connections WHERE status='active'").all()) this.workflow.connected(connection(row));
    });
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  activeForVehicle(id) { return connection(this.db.prepare("SELECT * FROM mvp_connections WHERE vehicle_id=? AND status='active'").get(id)); }
  state() {
    const workflow = this.workflow.state();
    return {
      company: this.db.prepare("SELECT id,name FROM mvp_companies WHERE id='mvp-company-001'").get(),
      employees: this.db.prepare("SELECT * FROM mvp_employees WHERE company_id='mvp-company-001' ORDER BY id").all().map(employee),
      vehicles: this.db.prepare("SELECT * FROM mvp_vehicles WHERE company_id='mvp-company-001' ORDER BY id").all().map(row => ({ ...vehicle(row), connection: this.activeForVehicle(row.id) ?? null })),
      connections: this.db.prepare('SELECT * FROM mvp_connections ORDER BY connected_at,id').all().map(connection),
      serverTime: new Date(this.now()).toISOString(),
      ...workflow,
      receivedTrips: this.reporting.enrichTrips(workflow.receivedTrips),
    };
  }
  requireVehicle(id) {
    const row = this.db.prepare('SELECT * FROM mvp_vehicles WHERE id=?').get(id);
    if (!row || row.company_id !== 'mvp-company-001') problem(404, 'VEHICLE_NOT_FOUND', '해당 가상 차량을 찾을 수 없습니다.');
    return row;
  }
  qr(vehicleId, baseUrl) {
    return this.transaction(() => {
      const row = this.requireVehicle(vehicleId), active = this.activeForVehicle(vehicleId);
      if (active) return { vehicleId, status: 'connected', connection: active };
      let token = this.currentTokens.get(vehicleId);
      let found = token && this.db.prepare('SELECT * FROM mvp_qr_tokens WHERE token_hash=?').get(digest(token));
      if (!found || found.status !== 'available' || found.generation !== row.generation || found.expires_at <= this.now()) {
        // Rotating invalidates every older QR, including outstanding requests.
        this.db.prepare("UPDATE mvp_qr_tokens SET status='revoked' WHERE vehicle_id=? AND status='available' AND expires_at>?").run(vehicleId, this.now());
        this.db.prepare('UPDATE mvp_vehicles SET generation=generation+1 WHERE id=?').run(vehicleId);
        token = randomBytes(32).toString('base64url');
        const generation = row.generation + 1, expiresAt = this.now() + this.tokenTtlMs;
        this.db.prepare("INSERT INTO mvp_qr_tokens VALUES(?,?,?,?,'available',NULL)").run(digest(token), vehicleId, generation, expiresAt);
        this.currentTokens.set(vehicleId, token);
        found = { expires_at: expiresAt };
      }
      const url = new URL('/mvp/driver', baseUrl);
      url.searchParams.set('token', token);
      const tokenHash=digest(token);
      let current=this.currentCodes.get(vehicleId);
      if (!current || current.tokenHash!==tokenHash) {
        let code;
        do { code=[...randomBytes(6)].map(byte=>CODE_ALPHABET[byte&31]).join(''); }
        while(this.db.prepare('SELECT 1 FROM mvp_pairing_codes WHERE code_hash=?').get(digest(code)));
        this.db.prepare('INSERT INTO mvp_pairing_codes VALUES(?,?)').run(digest(code),tokenHash);
        current={tokenHash,code:`${code.slice(0,3)}-${code.slice(3)}`};this.currentCodes.set(vehicleId,current);
      }
      return { vehicleId, status: 'available', token, code:current.code, url: url.href,
        issuedAt:new Date(found.expires_at-this.tokenTtlMs).toISOString(),validForMs:this.tokenTtlMs,expiresAt: new Date(found.expires_at).toISOString() };
    });
  }
  requireToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) problem(404, 'INVALID_TOKEN', '유효하지 않은 QR 링크입니다. 차량 화면에서 새 QR을 확인해 주세요.');
    const found = this.db.prepare('SELECT * FROM mvp_qr_tokens WHERE token_hash=?').get(digest(token));
    if (!found) problem(404, 'INVALID_TOKEN', '유효하지 않은 QR 링크입니다. 차량 화면에서 새 QR을 확인해 주세요.');
    return this.validateTokenRecord(found);
  }
  requireCode(code) {
    const normalized=normalizeCode(code);
    const pair=this.db.prepare('SELECT token_hash FROM mvp_pairing_codes WHERE code_hash=?').get(digest(normalized));
    if (!pair) problem(404,'INVALID_CODE','해당 연결 코드를 찾을 수 없습니다. 차량 화면의 새 코드를 확인해 주세요.');
    const found=this.db.prepare('SELECT * FROM mvp_qr_tokens WHERE token_hash=?').get(pair.token_hash);
    if (!found) problem(404,'INVALID_CODE','연결 발급 정보를 찾을 수 없습니다.');
    return this.validateTokenRecord(found);
  }
  validateTokenRecord(found) {
    const row = this.requireVehicle(found.vehicle_id);
    if (found.status === 'used') {
      const active = connection(this.db.prepare('SELECT * FROM mvp_connections WHERE id=?').get(found.connection_id));
      if (!active || active.status !== 'active' || found.generation !== row.generation) problem(410, 'TOKEN_INVALIDATED', '이 QR의 연결은 종료됐습니다. 차량 화면에서 새 QR을 스캔해 주세요.');
      return { found, row, active };
    }
    if (found.expires_at <= this.now()) problem(410, 'TOKEN_EXPIRED', 'QR 유효기간이 지났습니다. 차량 화면의 새 QR을 스캔해 주세요.');
    if (found.status !== 'available' || found.generation !== row.generation) problem(410, 'TOKEN_INVALIDATED', '이전 QR은 사용할 수 없습니다. 차량 화면의 새 QR을 스캔해 주세요.');
    return { found, row, active: null };
  }
  resolve(token) {
    return this.lookup(this.requireToken(token));
  }
  resolveCode(code) { return this.lookup(this.requireCode(code)); }
  lookup({ found,row,active }) {
    return { vehicle: { ...vehicle(row), connection: active ?? null }, expiresAt: new Date(found.expires_at).toISOString(),
      status: active ? 'connected' : 'available', ...(active ? { connection: active } : {}) };
  }
  connect(token, employeeId) {
    return this.transaction(() => this.connectResolved(this.requireToken(token),employeeId));
  }
  connectCode(code,employeeId) {
    return this.transaction(() => this.connectResolved(this.requireCode(code),employeeId));
  }
  connectResolved({found,row,active},employeeId) {
      const person = this.db.prepare('SELECT * FROM mvp_employees WHERE id=?').get(employeeId);
      if (!person) problem(400, 'EMPLOYEE_NOT_FOUND', '선택한 데모 직원을 찾을 수 없습니다.');
      if (person.company_id !== row.company_id || person.company_id !== 'mvp-company-001') problem(403, 'COMPANY_MISMATCH', '직원과 차량의 소속 회사가 일치하지 않습니다.');
      if (active) {
        if (active.employeeId === employeeId) { this.workflow.connected(active);return active; }
        problem(409, 'TOKEN_USED', '이미 다른 데모 직원이 연결한 QR입니다. 기존 연결을 덮어쓰지 않았습니다.');
      }
      if (this.activeForVehicle(row.id)) problem(409, 'VEHICLE_CONNECTED', '이미 사용 중인 차량입니다. 먼저 기존 연결을 해제해 주세요.');
      if (this.db.prepare("SELECT id FROM mvp_connections WHERE employee_id=? AND status='active'").get(employeeId)) problem(409, 'EMPLOYEE_CONNECTED', '선택한 직원은 다른 차량에 연결 중입니다. 먼저 기존 연결을 해제해 주세요.');
      const value = { id: randomUUID(), companyId: row.company_id, employeeId, vehicleId: row.id, connectedAt: new Date(this.now()).toISOString(), disconnectedAt: null, status: 'active' };
      this.db.prepare("UPDATE mvp_qr_tokens SET status='used',connection_id=? WHERE token_hash=?").run(value.id, found.token_hash);
      this.db.prepare('INSERT INTO mvp_connections VALUES(?,?,?,?,?,?,?)').run(value.id, value.companyId, value.employeeId, value.vehicleId, value.connectedAt, null, value.status);
      this.workflow.connected(value);
      return value;
  }
  disconnect(id, employeeId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM mvp_connections WHERE id=?').get(id);
      if (!row) problem(404, 'CONNECTION_NOT_FOUND', '연결 정보를 찾을 수 없습니다.');
      if (row.employee_id !== employeeId) problem(403, 'EMPLOYEE_MISMATCH', '이 연결의 데모 직원을 선택해 주세요.');
      if (row.status === 'disconnected') return connection(row); // Does not touch a later connection.
      this.workflow.beforeDisconnect(id);
      const disconnectedAt = new Date(this.now()).toISOString();
      this.db.prepare("UPDATE mvp_connections SET status='disconnected',disconnected_at=? WHERE id=? AND status='active'").run(disconnectedAt, id);
      this.db.prepare('UPDATE mvp_vehicles SET generation=generation+1 WHERE id=?').run(row.vehicle_id);
      this.db.prepare("UPDATE mvp_qr_tokens SET status='revoked' WHERE vehicle_id=? AND status='available'").run(row.vehicle_id);
      this.currentTokens.delete(row.vehicle_id);
      this.currentCodes.delete(row.vehicle_id);
      this.workflow.disconnected(id);
      return connection({ ...row, status: 'disconnected', disconnected_at: disconnectedAt });
    });
  }
  close() { this.currentTokens.clear();this.currentCodes.clear(); this.db.close(); }
}
