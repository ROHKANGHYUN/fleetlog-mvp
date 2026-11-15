import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startMvpServer } from '../services/mvp/server.mjs';
import { MvpStore } from '../services/mvp/store.mjs';

const vehicle='mvp-vehicle-001',employee='mvp-employee-001',other='mvp-employee-002',base='http://127.0.0.1:4321';
const memory=(t,options)=>{const store=new MvpStore(options);t.after(()=>store.close());return store;};
const rejects=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('QR and random fallback code are the same ten-minute issuance, without a connection from lookup',t=>{
  const store=memory(t,{now:()=>1000}),qr=store.qr(vehicle,base),again=store.qr(vehicle,base);
  assert.match(qr.code,/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.equal(qr.validForMs,600000);assert.equal(Date.parse(qr.expiresAt)-Date.parse(qr.issuedAt),600000);
  assert.equal(qr.code,again.code);assert.equal(qr.token,again.token);
  assert.deepEqual(store.resolveCode(qr.code),store.resolve(qr.token));assert.deepEqual(store.state().connections,[]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mvp_qr_tokens').get().n,1);
  const rows=store.db.prepare('SELECT * FROM mvp_pairing_codes').all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(qr.code.replace('-','')));
});

test('fallback code and QR expire together at the exact server boundary and are both replaced',t=>{
  let now=1000;const store=memory(t,{now:()=>now}),qr=store.qr(vehicle,base);
  now=600999;assert.equal(store.resolveCode(qr.code).status,'available');
  now=601000;rejects(()=>store.resolve(qr.token),'TOKEN_EXPIRED');rejects(()=>store.resolveCode(qr.code),'TOKEN_EXPIRED');
  rejects(()=>store.connectCode(qr.code,employee),'TOKEN_EXPIRED');
  const fresh=store.qr(vehicle,base);assert.notEqual(fresh.code,qr.code);assert.notEqual(fresh.token,qr.token);
  assert.equal(store.connectCode(fresh.code,employee).employeeId,employee);
  rejects(()=>store.connect(qr.token,other),'TOKEN_EXPIRED');
});

test('code confirmation consumes its QR atomically; exact employee retry stays one connection',t=>{
  const store=memory(t),qr=store.qr(vehicle,base),connected=store.connectCode(qr.code.toLowerCase().replace('-',' '),employee);
  assert.deepEqual(store.connect(qr.token,employee),connected);assert.deepEqual(store.connectCode(qr.code,employee),connected);
  rejects(()=>store.connect(qr.token,other),'TOKEN_USED');rejects(()=>store.connectCode(qr.code,other),'TOKEN_USED');
  assert.equal(store.state().connections.length,1);assert.equal(store.resolve(qr.token).status,'connected');
});

test('QR confirmation consumes its fallback code and old code/QR cannot affect a replacement connection',t=>{
  const store=memory(t),qr=store.qr(vehicle,base),old=store.connect(qr.token,employee);
  rejects(()=>store.connectCode(qr.code,other),'TOKEN_USED');store.disconnect(old.id,employee);
  rejects(()=>store.connectCode(qr.code,employee),'TOKEN_INVALIDATED');
  const next=store.qr(vehicle,base),current=store.connectCode(next.code,other);
  store.disconnect(old.id,employee);rejects(()=>store.connect(qr.token,employee),'TOKEN_INVALIDATED');
  assert.deepEqual(store.state().vehicles[0].connection,current);assert.notEqual(next.code,qr.code);
});

test('code confirms only a registered same-company employee and preserves the issuance after write failure',t=>{
  const store=memory(t),qr=store.qr(vehicle,base);
  rejects(()=>store.resolveCode('K!Q-42M'),'INVALID_CODE');rejects(()=>store.connectCode(qr.code,'missing'),'EMPLOYEE_NOT_FOUND');
  store.db.exec("INSERT INTO mvp_companies VALUES('foreign','가상 외부');INSERT INTO mvp_employees VALUES('foreign-person','가상 직원','foreign','팀','직책');");
  rejects(()=>store.connectCode(qr.code,'foreign-person'),'COMPANY_MISMATCH');
  store.db.exec("CREATE TRIGGER fail_code BEFORE INSERT ON mvp_connections BEGIN SELECT RAISE(ABORT,'simulated storage failure');END;");
  assert.throws(()=>store.connectCode(qr.code,employee),/storage failure/);
  assert.equal(store.resolve(qr.token).status,'available');assert.equal(store.resolveCode(qr.code).status,'available');
  store.db.exec('DROP TRIGGER fail_code');assert.equal(store.connectCode(qr.code,employee).status,'active');
});

test('concurrent real HTTP QR/code confirmations have one winner; mixed credentials are invalid',async t=>{
  const app=await startMvpServer();t.after(()=>app.close());
  const qr=await(await fetch(`${app.address}/mvp-api/vehicles/${vehicle}/qr`)).json();
  const preview=await fetch(`${app.address}/mvp-api/codes/${qr.code}`);assert.equal(preview.status,200);
  const post=body=>fetch(`${app.address}/mvp-api/connections`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({token:qr.token,code:qr.code,employeeId:employee})).status,400);
  const outcomes=await Promise.all([post({token:qr.token,employeeId:employee}),post({code:qr.code,employeeId:other})]);
  assert.deepEqual(outcomes.map(x=>x.status).sort(),[200,409]);assert.equal(app.store.state().connections.length,1);
});

test('querying and rechecking connection status never creates a driver binding',async t=>{
  const app=await startMvpServer();t.after(()=>app.close());
  for(let i=0;i<3;i++){
    await fetch(`${app.address}/mvp-api/state`);await fetch(`${app.address}/mvp-api/vehicles/${vehicle}/qr`);
  }
  assert.deepEqual(app.store.state().connections,[]);
  const response=await fetch(`${app.address}/mvp-api/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:randomUUID(),connectionId:'missing',type:'finish'})});
  assert.equal(response.status,409);assert.deepEqual(app.store.state().receivedTrips,[]);
});
