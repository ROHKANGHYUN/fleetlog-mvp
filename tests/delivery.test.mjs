import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController, MemoryStorage } from '../packages/domain/index.mjs';
import { deliveryStatus } from '../apps/web/src/delivery.mjs';

function create(sendEvent) {
  return new FleetController({ storage: new MemoryStorage(), sendEvent });
}
function defer(controller) {
  controller.start();controller.setDriving(true);controller.setDriving(false);controller.finish();controller.defer();
}
const ack = event => ({ eventId:event.eventId, ackedLocalRevision:event.localRevision, serverVersion:event.expectedServerVersion + 1 });
const status = controller => { const s=controller.getState();return deliveryStatus(s,s.records[0]); };

test('delivery presentation distinguishes offline pending from actual receipt', async () => {
  const c=create(async e=>ack(e));defer(c);c.setOnline(false);
  assert.equal(status(c).kind,'pending');assert.match(status(c).label,/오프라인/);
  await c.sync();assert.equal(status(c).kind,'pending');
  c.setOnline(true);await c.sync();assert.equal(status(c).kind,'received');
  c.editTrip(c.getState().records[0].tripId);c.setPurpose('commute');c.review();c.save();
  assert.equal(status(c).kind,'pending');assert.match(status(c).detail,/이전 수신본/);
});
test('failed predecessor is shown on a newer revision even when global error is absent', async () => {
  const c=create(async()=>{throw Error('connection lost');});defer(c);await c.sync();
  c.editTrip(c.getState().records[0].tripId);c.setPurpose('business');c.review();c.save();
  assert.equal(c.getState().lastError,null);
  assert.equal(status(c).kind,'failed');
});
test('conflict takes precedence over an unprepared dependent event', async () => {
  const c=create(async()=>{throw Object.assign(Error('conflict'),{status:409});});defer(c);
  c.editTrip(c.getState().records[0].tripId);c.setPurpose('business');c.review();c.save();await c.sync();
  assert.equal(status(c).kind,'conflict');
  assert.equal(c.getState().outbox[1].preparedEvent,null);
});
test('wrong ACK cannot produce received UI and retry clears the failure only after valid ACK', async () => {
  let valid=false;
  const c=create(async e=>valid?ack(e):{...ack(e),eventId:'wrong'});defer(c);
  await c.sync();assert.equal(status(c).kind,'failed');
  valid=true;await c.sync();assert.equal(status(c).kind,'received');
});

test('global sync does not claim an unsent record is waiting for its own response', async () => {
  let release,first=true;
  const c=create(e=>{if(first){first=false;return new Promise(resolve=>{release=()=>resolve(ack(e));});}return Promise.resolve(ack(e));});
  defer(c);c.setDriving(true);c.setDriving(false);c.finish();c.defer();
  const sending=c.sync(),s=c.getState();
  assert.equal(s.syncing,true);
  assert.equal(s.outbox[1].attempts,0);
  assert.equal(deliveryStatus(s,s.records[1]).kind,'pending');
  release();await sending;
  assert.equal(deliveryStatus(c.getState(),c.getState().records[1]).kind,'received');
});

test('only the actual in-flight trip displays sending while another trip remains pending', async () => {
  let release,first=true;
  const c=create(event=>{if(first){first=false;return new Promise(resolve=>release=()=>resolve(ack(event)));}return Promise.resolve(ack(event));});
  defer(c);c.setDriving(true);c.setDriving(false);c.finish();c.defer();
  const sending=c.sync(),s=c.getState();
  assert.equal(deliveryStatus(s,s.records[0]).kind,'sending');
  assert.equal(deliveryStatus(s,s.records[1]).kind,'pending');
  release();await sending;
  assert.equal(c.getState().inFlightEventId,null);
});

test('permanent errors and conflicts hold successors and present distinct reasons', async () => {
  for(const [http,kind] of [[403,'blocked'],[409,'conflict']]) {
    let calls=0;
    const c=create(async()=>{calls++;throw Object.assign(Error(`HTTP ${http}`),{status:http});});
    defer(c);const id=c.getState().records[0].tripId;
    c.editTrip(id);c.setPurpose('commute');c.review();c.save();
    await c.sync();await c.sync();
    assert.equal(status(c).kind,kind);
    assert.equal(calls,1);
    assert.equal(c.getState().outbox[1].preparedEvent,null);
    assert.throws(()=>c.editTrip(id),/확인|충돌/);
  }
});
