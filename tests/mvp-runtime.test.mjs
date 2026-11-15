import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptSpeaker, TripUploader, browserSpeech } from '../apps/web/src/mvp/runtime.mjs';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function speechFixture() {
  const calls=[];
  return { calls, available:true, play(text, callbacks){const call={text,...callbacks,cancelled:false};calls.push(call);return{cancel(){call.cancelled=true;}};} };
}
function speakerFixture(t,{claim=async()=>({claimed:true}),complete=async()=>{}}={}) {
  const speech=speechFixture(),completions=[],claims=[];
  const speaker=new PromptSpeaker({speech,claim:async p=>{claims.push(p.id);return claim(p);},complete:async(p,outcome)=>{completions.push({id:p.id,outcome});return complete(p,outcome);}});
  t.after(()=>speaker.dispose());
  return {speaker,speech,claims,completions,ready:async()=>{speaker.prepare();speech.calls.at(-1).end();await flush();}};
}
const prompt=(id='prompt-one')=>({id,text:'어디로 가시며, 어떤 목적으로 운행하시나요?',status:'pending'});

test('browser speech port requests synthesis only, preserves Korean text, and suppresses duplicate or cancelled callbacks',()=>{
  const spoken=[],timers=new Map();let next=0,cancels=0,ends=0,errors=0;
  class Utterance{constructor(text){this.text=text;}}
  const port=browserSpeech({Utterance,synthesis:{speak:u=>spoken.push(u),cancel:()=>cancels++,getVoices:()=>[{lang:'ko-KR',localService:true}]},
    schedule:fn=>{timers.set(++next,fn);return next;},unschedule:id=>timers.delete(id)});
  assert.equal(port.available,true);
  port.play('모의 질문',{end:()=>ends++,error:()=>errors++});
  assert.equal(spoken[0].text,'모의 질문');assert.equal(spoken[0].lang,'ko-KR');
  spoken[0].onend();spoken[0].onend();spoken[0].onerror({error:'late'});
  assert.equal(ends,1);assert.equal(errors,0);assert.equal(timers.size,0);
  const operation=port.play('취소할 질문',{end:()=>ends++,error:()=>errors++});operation.cancel();
  spoken[1].onend();spoken[1].onerror({error:'canceled'});
  assert.equal(cancels,1);assert.equal(ends,1);assert.equal(errors,0);
});

test('unavailable or rejected speech preparation never claims or completes a dialogue',async t=>{
  const {speaker,speech,claims,completions}=speakerFixture(t);
  speech.available=false;speaker.prepare();assert.equal(speaker.state.status,'unavailable');
  speaker.update({contextKey:'one',prompt:prompt()});await flush();assert.deepEqual(claims,[]);
  speech.available=true;speaker.prepare();speech.calls.at(-1).error('not-allowed');await flush();
  assert.equal(speaker.state.ready,false);assert.match(speaker.state.message,/not-allowed/);assert.deepEqual(completions,[]);
});

test('a playback timeout reports failure exactly once without an end callback or consent',()=>{
  let deadline,ends=0,cancelled=0;const errors=[];
  class Utterance{constructor(text){this.text=text;}}
  const port=browserSpeech({Utterance,synthesis:{speak(){},cancel(){cancelled++;},getVoices:()=>[]},
    schedule:fn=>{deadline=fn;return 1;},unschedule(){}});
  port.play('확인 안내',{end:()=>ends++,error:code=>errors.push(code)});
  deadline();deadline();assert.equal(ends,0);assert.deepEqual(errors,['playback-timeout']);assert.equal(cancelled,1);
});

test('polling one pending prompt requests one playback and duplicate end events create one completion',async t=>{
  const f=speakerFixture(t);await f.ready();
  for(let i=0;i<5;i++)f.speaker.update({contextKey:'connection/conversation/question',prompt:prompt()});
  await flush();assert.deepEqual(f.claims,['prompt-one']);assert.equal(f.speech.calls.length,2);
  const question=f.speech.calls[1];question.end();question.end();question.error('late');await flush();
  assert.deepEqual(f.completions,[{id:'prompt-one',outcome:'played'}]);
  f.speaker.update({contextKey:'connection/conversation/question',prompt:prompt()});await flush();
  assert.equal(f.speech.calls.length,2);
});

test('a prompt already claimed before reload is never replayed by preparing a new panel',async t=>{
  const f=speakerFixture(t);
  f.speaker.update({contextKey:'old',prompt:{...prompt(),status:'claimed'}});await f.ready();
  for(let i=0;i<3;i++)f.speaker.update({contextKey:'old',prompt:{...prompt(),status:'claimed'}});
  await flush();assert.equal(f.speech.calls.length,1);assert.deepEqual(f.claims,[]);
});

test('a claim arriving after disconnect or selected vehicle change cannot start the old prompt',async t=>{
  let release;const claim=new Promise(ok=>release=ok),f=speakerFixture(t,{claim:()=>claim});await f.ready();
  f.speaker.update({contextKey:'employee-A/conversation-A',prompt:prompt()});await flush();
  f.speaker.update({contextKey:'employee-B/conversation-B',prompt:null});release({claimed:true});await flush();
  assert.equal(f.speech.calls.length,1);assert.deepEqual(f.completions,[]);
});

test('driving, page departure, and a changed connection cancel playback and ignore hostile late callbacks',async t=>{
  const f=speakerFixture(t);await f.ready();f.speaker.update({contextKey:'A',prompt:prompt()});await flush();
  const first=f.speech.calls[1];f.speaker.update({contextKey:'driving',prompt:null});
  assert.equal(first.cancelled,true);first.end();await flush();assert.deepEqual(f.completions,[]);
  f.speaker.update({contextKey:'B',prompt:prompt('new-question')});await flush();
  const second=f.speech.calls[2];f.speaker.cancel('화면 이탈');second.end();await flush();
  assert.equal(second.cancelled,true);assert.deepEqual(f.completions,[]);
});

test('speech failure reports failure rather than playback completion or consent',async t=>{
  const f=speakerFixture(t);await f.ready();f.speaker.update({contextKey:'A',prompt:prompt()});await flush();
  f.speech.calls[1].error('audio-busy');await flush();
  assert.deepEqual(f.completions,[{id:'prompt-one',outcome:'failed'}]);assert.equal(f.speaker.state.status,'error');
});

test('explicit simulated completion from another panel cancels the original audible request',async t=>{
  const f=speakerFixture(t);await f.ready();f.speaker.update({contextKey:'A',prompt:prompt()});await flush();
  const playing=f.speech.calls[1];f.speaker.update({contextKey:'A',prompt:{...prompt(),status:'simulated'}});
  assert.equal(playing.cancelled,true);playing.end();await flush();assert.deepEqual(f.completions,[]);
});

function uploadFixture(t,post,options={}){
  let now=1000;const jobs=new Set(),states=[];
  const uploader=new TripUploader({post,changed:x=>states.push(x),now:()=>now,schedule:fn=>{jobs.add(fn);return fn;},unschedule:id=>jobs.delete(id),...options});
  t.after(()=>uploader.dispose());
  return{uploader,states,tick:async(ms=1500)=>{now+=ms;const current=[...jobs];jobs.clear();for(const fn of current)fn();await flush();}};
}
const event={eventId:'event-one',tripId:'trip-A',vehicleId:'vehicle-one',body:'{"eventId":"event-one","tripId":"trip-A","employeeId":"employee-A"}',status:'queued',attempts:0,lastError:null,nextAttemptAt:0};
const snapshot=(changes={})=>({demoId:'run-one',pendingUploads:[{...event}],uploadBlockedVehicles:[],...changes});
const ack={eventId:event.eventId,tripId:event.tripId,serverVersion:1};

test('temporary upload errors retain the exact prepared body and retry after the controlled interval',async t=>{
  const bodies=[];let fails=true;const f=uploadFixture(t,async body=>{bodies.push(body);if(fails)throw Object.assign(Error('503'),{status:503});return ack;});
  f.uploader.update(snapshot());await flush();assert.equal(bodies.length,1);assert.equal(f.states.at(-1).status,'retrying');
  await f.tick(100);assert.equal(bodies.length,1);fails=false;await f.tick(1400);
  assert.equal(bodies.length,2);assert.equal(bodies[0],event.body);assert.equal(bodies[1],event.body);
  await f.tick();assert.equal(bodies.length,2);assert.equal(f.states.at(-1).status,'idle');
});

test('one in-flight upload cannot be duplicated by repeated snapshots, and only matching ACK completes it',async t=>{
  let release;const result=new Promise(ok=>release=ok),bodies=[];
  const f=uploadFixture(t,body=>{bodies.push(body);return result;});
  for(let i=0;i<5;i++)f.uploader.update(snapshot());await flush();assert.equal(bodies.length,1);
  release(ack);await flush();await f.tick();assert.equal(bodies.length,1);assert.equal(f.states.at(-1).status,'idle');
});

test('upload blocking holds one attempted request until recovery, preserving the original employee body',async t=>{
  let blocked=true;const bodies=[];
  const f=uploadFixture(t,async body=>{bodies.push(body);if(blocked)throw Object.assign(Error('blocked'),{status:503});return ack;});
  f.uploader.update(snapshot({uploadBlockedVehicles:['vehicle-one']}));await flush();
  for(let i=0;i<3;i++)await f.tick();assert.equal(bodies.length,1);
  blocked=false;f.uploader.update(snapshot());await flush();
  assert.equal(bodies.length,2);assert.equal(bodies[1],event.body);assert.match(bodies[1],/employee-A/);
});

test('wrong ACK, contract errors, and conflicts halt automatic attempts without discarding the queue',async t=>{
  for(const outcome of ['wrong',400,409]){
    let calls=0;const f=uploadFixture(t,async()=>{calls++;if(outcome==='wrong')return{...ack,eventId:'someone-else'};throw Object.assign(Error('check'),{status:outcome});});
    const original=snapshot();f.uploader.update(original);await flush();await f.tick();f.uploader.update(original);await flush();
    assert.equal(calls,1);assert.equal(f.states.at(-1).status,'error');assert.equal(original.pendingUploads[0].body,event.body);
    f.uploader.dispose();
  }
});

test('bounded retries stop at five, and a new demo never reuses a prior pending snapshot',async t=>{
  const bodies=[];const f=uploadFixture(t,async body=>{bodies.push(body);throw Error('network');});
  f.uploader.update(snapshot());await flush();for(let i=0;i<8;i++)await f.tick();assert.equal(bodies.length,5);
  f.uploader.update(snapshot({demoId:'new-run',pendingUploads:[]}));await flush();await f.tick();assert.equal(bodies.length,5);
});
