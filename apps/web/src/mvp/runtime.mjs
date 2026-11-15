/** Browser playback port only. It never creates a microphone or recognition object. */
export function browserSpeech({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance,
  schedule = (fn, ms) => setTimeout(fn, ms), unschedule = id => clearTimeout(id), timeoutMs = 15_000 } = {}) {
  return {
    available: !!synthesis && typeof synthesis.speak === 'function' && typeof Utterance === 'function',
    play(text, { end, error }) {
      let cancelled = false, finished = false, timer;
      const utterance = new Utterance(text);
      utterance.lang = 'ko-KR';
      const voices = synthesis.getVoices?.() ?? [];
      const voice = voices.find(item => item.lang.startsWith('ko') && item.localService) ?? voices.find(item => item.lang.startsWith('ko'));
      if (voice) utterance.voice = voice;
      const finish = callback => {
        if (cancelled || finished) return;
        finished = true;unschedule(timer);callback();
      };
      utterance.onend = () => finish(end);
      utterance.onerror = event => finish(() => error(event?.error ?? 'synthesis-failed'));
      timer = schedule(() => finish(() => { synthesis.cancel();error('playback-timeout'); }), timeoutMs);
      try { synthesis.speak(utterance); }
      catch (cause) { finish(() => error(cause instanceof Error ? cause.message : 'synthesis-failed')); }
      return { cancel() { if (cancelled || finished) return;cancelled = true;unschedule(timer);synthesis.cancel(); } };
    },
  };
}

/** A prompt can be claimed once on the server. Polling or reload never grants a new playback. */
export class PromptSpeaker {
  constructor({ speech, claim, complete, changed = () => {} }) {
    this.speech=speech;this.claim=claim;this.complete=complete;this.changed=changed;
    this.state={ ready:false, status:'unprepared', message:'이 시연 패널에서 음성을 먼저 준비하세요.' };
    this.epoch=0;this.key='';this.operation=null;this.seen=new Set();this.disposed=false;
  }
  emit(patch) { this.state={...this.state,...patch};this.changed(this.state); }
  cancel(message='안내를 중단했습니다. 필요한 경우 안내 완료 모의를 사용하세요.') {
    this.epoch++;this.operation?.cancel();this.operation=null;
    this.emit({ status:this.state.ready?'ready':'unprepared', message });
  }
  prepare() {
    if (this.disposed) return;
    this.cancel();
    if (!this.speech.available) { this.emit({ ready:false,status:'unavailable',message:'이 브라우저에서 음성 합성을 사용할 수 없습니다. 텍스트 또는 안내 완료 모의로 진행하세요.' });return; }
    const epoch=this.epoch;
    this.emit({ready:false,status:'preparing',message:'브라우저에 준비 안내 재생을 요청했습니다. 완료 이벤트를 기다립니다.'});
    let completed=false;
    try { const operation=this.speech.play('Fleetlog 시연 음성을 준비합니다.', {
      end:()=>{ if(completed||epoch!==this.epoch||this.disposed)return;completed=true;this.operation=null;this.emit({ready:true,status:'ready',message:'브라우저 준비 안내 완료 이벤트를 받았습니다. 실제 소리는 발표자가 확인해 주세요.'});this.attempt(); },
      error:reason=>{if(completed||epoch!==this.epoch||this.disposed)return;completed=true;this.operation=null;this.emit({ready:false,status:'error',message:`음성 준비 실패: ${reason}. 안내 완료 모의로 진행할 수 있습니다.`});},
    });if(!completed&&epoch===this.epoch)this.operation=operation; } catch(cause) { this.emit({ready:false,status:'error',message:`음성을 시작하지 못했습니다: ${cause.message}`}); }
  }
  update({ contextKey, prompt, stale=false }) {
    if(this.disposed)return;
    if(contextKey!==this.key||stale){this.key=contextKey;this.cancel(stale?'상태 조회 실패로 음성을 중단했습니다.':'이전 대화의 음성을 중단했습니다.');}
    if(this.operation&&prompt&&['simulated','cancelled'].includes(prompt.status))this.cancel('다른 화면에서 처리한 안내를 중단했습니다.');
    this.prompt=stale?null:prompt;
    if(prompt?.status==='claimed'&&!this.operation&&this.state.status!=='claiming') {
      this.emit({message:'이미 요청된 안내입니다. 자동으로 다시 재생하지 않습니다. 필요하면 안내 완료 모의를 사용하세요.'});
    }
    this.attempt();
  }
  async attempt() {
    const prompt=this.prompt;
    if(this.disposed||!this.state.ready||this.operation||!prompt||prompt.status!=='pending'||this.seen.has(prompt.id))return;
    this.seen.add(prompt.id);
    const epoch=this.epoch;
    this.emit({status:'claiming',message:'이 안내의 단일 재생 권한을 서버에 확인합니다.'});
    try {
      const result=await this.claim(prompt);
      if(this.disposed||epoch!==this.epoch)return;
      if(!result.claimed){this.emit({status:'ready',message:'다른 시연 패널이 요청한 안내입니다. 중복 재생하지 않습니다.'});return;}
      this.emit({status:'playing',message:'브라우저에 안내 재생을 요청했습니다. 실제 음성인식은 사용하지 않습니다.'});
      let completed=false;
      const finish=async(outcome,reason)=>{
        if(completed||epoch!==this.epoch||this.disposed)return;
        completed=true;this.operation=null;
        this.emit({status:outcome==='played'?'ready':'error',message:outcome==='played'?'안내 완료 이벤트를 받았습니다. 모의 답변을 전달할 수 있습니다.':`안내 재생 실패: ${reason}. 안내 완료 모의 또는 모의 나중에를 사용하세요.`});
        try{await this.complete(prompt,outcome);}catch(cause){if(epoch===this.epoch&&!this.disposed)this.emit({status:'error',message:`안내 결과의 서버 반영을 확인하지 못했습니다: ${cause.message}`});}
      };
      const operation=this.speech.play(prompt.text,{end:()=>void finish('played'),error:reason=>void finish('failed',reason)});
      if(!completed&&epoch===this.epoch)this.operation=operation;
    }catch(cause){if(epoch===this.epoch&&!this.disposed)this.emit({status:'error',message:`음성 요청 실패: ${cause.message}. 텍스트 또는 안내 완료 모의를 사용하세요.`});}
  }
  dispose(){this.disposed=true;this.epoch++;this.operation?.cancel();this.operation=null;}
}

/** Small prepared-event uploader; durable queue and receipts live in the isolated simulator DB. */
export class TripUploader {
  constructor({post,changed=()=>{},now=()=>Date.now(),schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id),retryMs=1500,maxAttempts=5}) {
    this.post=post;this.changed=changed;this.now=now;this.schedule=schedule;this.unschedule=unschedule;
    this.retryMs=retryMs;this.maxAttempts=maxAttempts;this.demoId=null;this.entries=new Map();this.snapshot=null;this.disposed=false;this.timer=null;this.inFlight=null;this.enabled=true;
  }
  update(snapshot,enabled=true){
    if(this.disposed)return;
    if(this.demoId!==snapshot.demoId){this.inFlight?.abort();this.entries.clear();this.demoId=snapshot.demoId;}
    const previouslyBlocked=new Set(this.snapshot?.uploadBlockedVehicles??[]),nowBlocked=new Set(snapshot.uploadBlockedVehicles??[]);
    for(const item of snapshot.pendingUploads??[]){
      const entry=this.entries.get(item.eventId);
      if(entry&&!entry.halted&&previouslyBlocked.has(item.vehicleId)&&!nowBlocked.has(item.vehicleId)){
        entry.attempts=0;entry.nextAt=0;entry.blockedAttempt=false;
      }
    }
    this.snapshot=snapshot;this.enabled=enabled;void this.pump();
  }
  async pump(){
    if(this.disposed||this.inFlight)return;
    this.unschedule(this.timer);this.timer=null;
    if(!this.snapshot||!this.enabled)return;
    const blocked=new Set(this.snapshot.uploadBlockedVehicles??[]),time=this.now();
    let selected;
    for(const item of this.snapshot.pendingUploads??[]){
      if(item.status!=='queued')continue;
      const entry=this.entries.get(item.eventId)??{attempts:0,nextAt:0,done:false,halted:false,blockedAttempt:false};
      if(!blocked.has(item.vehicleId))entry.blockedAttempt=false;
      this.entries.set(item.eventId,entry);
      if(entry.done||entry.halted||entry.attempts>=this.maxAttempts||entry.nextAt>time||item.nextAttemptAt>time)continue;
      if(blocked.has(item.vehicleId)&&(entry.blockedAttempt||item.lastError))continue;
      selected={item,entry};break;
    }
    if(!selected){this.timer=this.schedule(()=>void this.pump(),500);return;}
    const {item,entry}=selected, demoId=this.demoId,abort=new AbortController();
    this.inFlight=abort;entry.attempts++;entry.blockedAttempt=blocked.has(item.vehicleId);
    this.changed({status:'uploading',message:'종료 기록을 실제 MVP 수신 API로 전송 중입니다.',eventId:item.eventId});
    try{
      const ack=await this.post(item.body,abort.signal);
      if(this.disposed||demoId!==this.demoId)return;
      if(ack?.eventId!==item.eventId||ack?.tripId!==item.tripId||ack?.serverVersion!==1){
        entry.halted=true;this.changed({status:'error',message:'수신 ACK가 일치하지 않습니다. 대기 기록을 지우지 않고 확인이 필요합니다.',eventId:item.eventId});
      }else{entry.done=true;this.changed({status:'idle',message:'MVP 서버 ACK를 확인했습니다. 공통 수신 목록을 다시 조회합니다.',eventId:item.eventId});}
    }catch(cause){
      if(this.disposed||demoId!==this.demoId||abort.signal.aborted)return;
      const retryable=!cause.status||[408,429].includes(cause.status)||cause.status>=500;
      entry.halted=!retryable;
      entry.nextAt=this.now()+this.retryMs;
      this.changed({status:retryable&&entry.attempts<this.maxAttempts?'retrying':'error',message:retryable?`전송 대기를 유지합니다. 자동 재시도 ${entry.attempts}/${this.maxAttempts}. ${cause.message}`:`요청 확인이 필요합니다. 반복 전송을 멈췄습니다. ${cause.message}`,eventId:item.eventId});
    }finally{
      if(this.inFlight===abort)this.inFlight=null;
      if(!this.disposed)this.timer=this.schedule(()=>void this.pump(),this.retryMs);
    }
  }
  dispose(){this.disposed=true;this.inFlight?.abort();this.unschedule(this.timer);this.timer=null;}
}
