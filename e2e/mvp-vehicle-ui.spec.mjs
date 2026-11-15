import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import jsQR from 'jsqr';
import { startMvpServer } from '../services/mvp/server.mjs';

// These checks replace only the superseded always-blank/arrival-finalizes rules.
// Actual server state, old record protections and duplicate rejection remain tested.
const test=base.extend({app:async({},use)=>{
  const directory=await mkdtemp(join(tmpdir(),'chagok-vehicle-ui-'));
  let clock=Date.now(),running;
  try{
    running=await startMvpServer({port:0,filename:join(directory,'mvp.sqlite'),staticDir:resolve('apps/web/dist'),now:()=>clock});
    await use({...running,advance:ms=>clock+=ms,setClock:instant=>clock=instant});
  }finally{await running?.close();await rm(directory,{recursive:true,force:true});}
}});
const screen=page=>page.locator('.mvp-car-screen');
const button=(page,name)=>page.getByRole('button',{name,exact:true});
async function state(request,app){const r=await request.get(app.address+'/mvp-api/state');expect(r.ok()).toBeTruthy();return r.json();}
async function qr(request,app,id='mvp-vehicle-001'){const r=await request.get(`${app.address}/mvp-api/vehicles/${id}/qr`);expect(r.ok()).toBeTruthy();return r.json();}
async function command(request,app,connection,type,extra={}){
  const r=await request.post(app.address+'/mvp-api/commands',{data:{commandId:randomUUID(),connectionId:connection.id,type,...extra}});
  expect(r.ok(),`${type}: ${await r.text()}`).toBeTruthy();return r.json();
}
async function connect(request,app,employeeId='mvp-employee-001'){
  const issued=await qr(request,app);
  const r=await request.post(app.address+'/mvp-api/connections',{data:{token:issued.token,employeeId}});
  expect(r.ok()).toBeTruthy();return(await r.json()).connection;
}
async function blank(page){
  await expect.poll(()=>screen(page).textContent()).toBe('');
  await expect(screen(page).locator(':scope > *')).toHaveCount(0);
  await expect(page.locator('button,input,select,form,[role="dialog"]')).toHaveCount(0);
}
async function parkLeg(request,app,connection){
  const departure=await command(request,app,connection,'depart');
  app.advance(60000);
  await command(request,app,connection,'arrive',{tripId:departure.trip.id});
  return(await state(request,app)).activeTrips[0];
}

test('vehicle connection confirmation performs only real queries and code/QR share one consumed issuance',async({page:car,context,request,app})=>{
  const posts=[];car.on('request',r=>{if(r.method()==='POST')posts.push(r.url());});
  await car.goto(app.address+'/mvp/car');
  await expect(screen(car).getByRole('heading',{name:'회사와 이 차량을 연결해 주세요',exact:true})).toBeVisible();
  const issued=await qr(request,app);
  expect(issued.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  expect(issued.validForMs).toBe(600000);
  await expect(screen(car)).toContainText(issued.code);
  await button(car,'연결 완료').click();await button(car,'다시 확인').click();
  expect(posts).toEqual([]);expect((await state(request,app)).connections).toHaveLength(0);
  await car.route('**/mvp-api/state',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEMPORARY',message:'가상 조회 실패'}})}));
  await button(car,'다시 확인').click();
  await expect(screen(car).locator('.mvp-qr svg')).toHaveCount(0);
  await expect(screen(car).getByText('주차 확인됨',{exact:true})).toHaveCount(0);
  await car.unroute('**/mvp-api/state');await expect(screen(car).locator('.mvp-qr svg')).toBeVisible();
  const phone=await context.newPage();await phone.goto(app.address+'/mvp/driver');
  await phone.getByRole('combobox',{name:'데모 계정 선택',exact:true}).selectOption('mvp-employee-001');
  await phone.getByRole('textbox',{name:'연결 코드',exact:true}).fill(issued.code);
  await button(phone,'코드 확인').click();
  await expect(button(phone,'이 차량에 연결')).toBeEnabled();
  expect((await state(request,app)).connections).toHaveLength(0);
  await button(phone,'이 차량에 연결').click();
  await expect(screen(car)).toContainText('가상 김차곡');
  await expect(screen(car).getByText('주차 확인됨',{exact:true})).toBeVisible();
  await expect(button(car,'운행 마치기')).toBeDisabled();
  const active=(await state(request,app)).vehicles[0].connection;
  const repeated=await request.post(app.address+'/mvp-api/connections',{data:{token:issued.token,employeeId:'mvp-employee-001'}});
  expect(repeated.ok()).toBeTruthy();expect((await repeated.json()).connection.id).toBe(active.id);
  const reused=await request.post(app.address+'/mvp-api/connections',{data:{token:issued.token,employeeId:'mvp-employee-002'}});
  expect(reused.status()).toBe(409);expect((await state(request,app)).connections).toHaveLength(1);
  await button(phone,'연결 해제').click();
  await expect.poll(async()=> (await state(request,app)).vehicles[0].connection).toBeNull();
  const fresh=await qr(request,app);expect(fresh.token).not.toBe(issued.token);expect(fresh.code).not.toBe(issued.code);
  expect((await request.get(`${app.address}/mvp-api/codes/${issued.code}`)).status()).toBe(410);
  expect((await request.get(`${app.address}/mvp-api/qr/${issued.token}`)).status()).toBe(410);
  await phone.goto(fresh.url);await phone.getByRole('combobox',{name:'데모 계정 선택',exact:true}).selectOption('mvp-employee-002');
  await button(phone,'이 차량에 연결').click();
  await expect.poll(async()=> (await state(request,app)).vehicles[0].connection?.employeeId).toBe('mvp-employee-002');
  const codeReuse=await request.post(app.address+'/mvp-api/connections',{data:{code:fresh.code,employeeId:'mvp-employee-001'}});
  expect(codeReuse.status()).toBe(409);
});

test('QR and connection code expire together at ten server minutes and mixed-method contention has one winner',async({request,app})=>{
  const issued=await qr(request,app);
  expect(Date.parse(issued.expiresAt)-Date.parse(issued.issuedAt)).toBe(600000);
  app.advance(599999);
  expect((await request.get(`${app.address}/mvp-api/codes/${issued.code}`)).ok()).toBeTruthy();
  expect((await request.get(`${app.address}/mvp-api/qr/${issued.token}`)).ok()).toBeTruthy();
  app.advance(1);
  expect((await request.get(`${app.address}/mvp-api/codes/${issued.code}`)).status()).toBe(410);
  expect((await request.get(`${app.address}/mvp-api/qr/${issued.token}`)).status()).toBe(410);
  const fresh=await qr(request,app);expect(fresh.code).not.toBe(issued.code);expect(fresh.token).not.toBe(issued.token);
  const outcomes=await Promise.all([
    request.post(app.address+'/mvp-api/connections',{data:{code:fresh.code,employeeId:'mvp-employee-001'}}),
    request.post(app.address+'/mvp-api/connections',{data:{token:fresh.token,employeeId:'mvp-employee-002'}}),
  ]);
  expect(outcomes.map(x=>x.status()).sort()).toEqual([200,409]);
  expect((await state(request,app)).connections).toHaveLength(1);
});

test('continue preserves the segment, unknown forbids finishing, and recording stop preserves observations without disconnecting',async({page:car,request,app})=>{
  const connection=await connect(request,app);
  await car.goto(app.address+'/mvp/car');await expect(button(car,'운행 마치기')).toBeDisabled();
  const departure=await command(request,app,connection,'depart');await blank(car);
  app.advance(60000);await command(request,app,connection,'arrive',{tripId:departure.trip.id});
  await expect(button(car,'운행 마치기')).toBeEnabled();
  let current=(await state(request,app)).activeTrips[0];
  expect(current.distanceM).toBe(23400);expect(current.endedAt).toBeNull();expect((await state(request,app)).pendingUploads).toHaveLength(0);
  await button(car,'운행 마치기').click();
  await expect.poll(async()=> (await state(request,app)).activeTrips[0].candidateEnd).not.toBeNull();
  const prompt=(await state(request,app)).prompts.at(-1);
  await button(car,'계속 운행').click();
  await expect.poll(async()=> (await state(request,app)).activeTrips[0].candidateEnd).toBeNull();
  current=(await state(request,app)).activeTrips[0];
  expect(current.id).toBe(departure.trip.id);expect(current.startedAt).toBe(departure.trip.startedAt);expect(current.startOdometerM).toBe(departure.trip.startOdometerM);
  expect((await state(request,app)).vehicleRuntime.find(x=>x.vehicleId==='mvp-vehicle-001').parking).toBe('parked');
  const late=await request.post(app.address+'/mvp-api/voice/complete',{data:{commandId:randomUUID(),promptId:prompt.id,clientId:'late-panel',outcome:'played'}});
  expect(late.status()).toBe(409);
  app.advance(30000);await command(request,app,connection,'depart');await blank(car);
  app.advance(60000);await command(request,app,connection,'arrive',{tripId:departure.trip.id});
  await expect(button(car,'운행 마치기')).toBeEnabled();
  current=(await state(request,app)).activeTrips[0];expect(current.distanceM).toBe(46800);
  await request.post(`${app.address}/mvp-api/vehicles/mvp-vehicle-001/upload-mode`,{data:{blocked:true}});
  const control=await car.context().newPage();await control.goto(app.address+'/mvp/control');
  await button(control,'모의 상태 불명확').click();
  await expect(screen(car).getByText('주차 확인됨',{exact:true})).toHaveCount(0);
  await expect(button(car,'운행 마치기').and(car.locator(':enabled'))).toHaveCount(0);
  const forbidden=await request.post(app.address+'/mvp-api/commands',{data:{commandId:randomUUID(),connectionId:connection.id,type:'finish',tripId:current.id}});
  expect(forbidden.status()).toBe(409);
  await expect(button(control,'모의 주차 확인')).toBeEnabled();await button(control,'모의 주차 확인').click();
  await expect(button(car,'운행 마치기')).toBeEnabled();await expect(button(car,'기록 종료')).toBeEnabled();
  expect((await state(request,app)).activeTrips[0].distanceM).toBe(46800);
  expect((await state(request,app)).activeTrips[0].quality).toBe('incomplete');
  app.advance(60000);await button(car,'기록 종료').click();
  await expect.poll(async()=> (await state(request,app)).activeTrips.length).toBe(0);
  const stopped=await state(request,app), queued=stopped.pendingUploads[0];
  expect(queued.trip.startedAt).toBe(departure.trip.startedAt);expect(queued.trip.endedAt).toBe(current.lastObservedAt);
  expect(queued.trip.endOdometerM).toBe(current.lastObservedOdometerM);expect(queued.trip.purpose).toBeNull();expect(queued.trip.quality).toBe('incomplete');
  expect(stopped.vehicles[0].connection.id).toBe(connection.id);
  await car.reload();await expect(button(car,'기록 시작')).toBeEnabled();
  const rejected=await request.post(app.address+'/mvp-api/commands',{data:{commandId:randomUUID(),connectionId:connection.id,type:'depart'}});expect(rejected.status()).toBe(409);
  await button(car,'기록 시작').click();await expect(button(car,'운행 마치기')).toBeDisabled();
  await button(car,'기록 종료').click();
  expect((await state(request,app)).pendingUploads).toHaveLength(1); // No invented empty trip.
});

for(const [width,height] of [[1920,1080],[1280,720],[960,540]]){
  test(`vehicle reference layout ${width}x${height}: real QR and observed parking screen fit the viewport`,async({page,request,app},testInfo)=>{
    await page.setViewportSize({width,height});
    app.setClock(Date.parse('2026-11-15T08:10:00+09:00'));
    await page.goto(app.address+'/mvp/car');
    await expect(screen(page).locator('.mvp-qr svg')).toBeVisible();
    await mkdir('test-results/mvp-vehicle-ui/screenshots',{recursive:true});
    async function geometry(label){
      await expect(screen(page).getByText('Fleetlog 운행기록',{exact:true})).toBeVisible();
      await expect(screen(page).getByText('주차 확인됨',{exact:true})).toBeVisible();
      const result=await screen(page).evaluate(root=>{
        const visible=[...root.querySelectorAll('button,svg,.mvp-qr')].filter(x=>x.getClientRects().length);
        const styles=getComputedStyle(root),header=root.querySelector('.vehicle-screen-header').getBoundingClientRect(),
          layout=root.querySelector('.vehicle-connection-layout,.vehicle-trip-layout').getBoundingClientRect(),
          qrCard=root.querySelector('.vehicle-qr-card')?.getBoundingClientRect(),tripCard=root.querySelector('.vehicle-trip-card')?.getBoundingClientRect();
        return {overflow:document.documentElement.scrollWidth>innerWidth,vertical:document.documentElement.scrollHeight>innerHeight+1,
          outside:visible.filter(node=>{const r=node.getBoundingClientRect();return r.left < -1||r.right>innerWidth+1||r.top < -1||r.bottom>innerHeight+1;}).map(node=>node.tagName+':'+(node.textContent||node.getAttribute('aria-label'))),
          short:[...root.querySelectorAll('button')].filter(x=>x.getClientRects().length&&x.getBoundingClientRect().height<56).map(x=>x.textContent),
          padding:[styles.paddingTop,styles.paddingRight,styles.paddingBottom,styles.paddingLeft].map(parseFloat),
          headerTop:header.top,headerLeft:header.left,layoutLeft:layout.left,layoutRight:innerWidth-layout.right,
          qrCardRight:qrCard ? innerWidth-qrCard.right : null,tripCardLeft:tripCard?.left??null};
      });
      expect(result.overflow,`${label} page horizontal overflow`).toBe(false);
      expect(result.vertical,`${label} page viewport height`).toBe(false);
      expect(result.outside,`${label} essential elements outside viewport`).toEqual([]);
      expect(result.short,`${label} target heights`).toEqual([]);
      const outer=width===1920?48:width===1280?32:24;
      for(const value of result.padding)expect(Math.abs(value-outer),`${label} outer padding`).toBeLessThanOrEqual(2);
      for(const key of ['headerLeft','layoutLeft','layoutRight',...(label==='qr'?['qrCardRight']:['tripCardLeft'])])
        expect(Math.abs(result[key]-outer),`${label} ${key}`).toBeLessThanOrEqual(2);
      expect(result.headerTop,`${label} header has top spacing`).toBeGreaterThanOrEqual(outer-1);
      await page.screenshot({path:`test-results/mvp-vehicle-ui/screenshots/${label}-${width}x${height}.png`});
      await testInfo.attach(`${label}-${width}x${height}-geometry`,{body:JSON.stringify(result),contentType:'application/json'});
    }
    await geometry('qr');
    const renderedQr=await page.locator('.mvp-qr svg').evaluate(async svg=>{
      const bounds=svg.getBoundingClientRect(), view=svg.viewBox.baseVal, modules=svg.querySelector('path').getBBox();
      const image=new Image();image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=Math.round(bounds.width);canvas.height=Math.round(bounds.height);
      const context=canvas.getContext('2d');context.drawImage(image,0,0,canvas.width,canvas.height);
      return {width:canvas.width,height:canvas.height,pixels:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data),
        quietZone:[modules.x,modules.y,view.width-modules.x-modules.width,view.height-modules.y-modules.height]};
    });
    expect(renderedQr.quietZone.every(space=>space>=4),'all four quiet-zone sides are intact').toBe(true);
    const decoded=jsQR(new Uint8ClampedArray(renderedQr.pixels),renderedQr.width,renderedQr.height);
    expect(decoded,'QR must decode at its actual displayed size').not.toBeNull();
    expect(decoded.data).toBe((await qr(request,app)).url);
    const connection=await connect(request,app);
    await request.post(`${app.address}/mvp-api/vehicles/mvp-vehicle-001/upload-mode`,{data:{blocked:true}});
    // Prepare a genuine older pending event, then display a second observed leg.
    let first=await parkLeg(request,app,connection);
    await command(request,app,connection,'finish',{tripId:first.id});
    const convo=(await state(request,app)).conversations.find(x=>x.isCurrent);
    await command(request,app,connection,'silence',{conversationId:convo.id});
    app.setClock(Date.parse('2026-11-15T08:20:00+09:00'));
    const second=await parkLeg(request,app,connection);
    await expect(screen(page)).toContainText('회사 전송 대기 1건');
    await expect(screen(page)).toContainText('가상 김차곡');await expect(button(page,'운행 마치기')).toBeEnabled();
    expect(second.distanceM).toBe(23400);
    await geometry('parked');
  });
}
