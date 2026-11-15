import { useEffect, useRef, useState } from 'react';
import type { ServerState } from './workflow-types';
import { browserSpeech, PromptSpeaker, TripUploader } from './runtime.mjs';

const identifier=()=>globalThis.crypto?.randomUUID?.()??`demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function post(path:string,body:unknown,signal?:AbortSignal){
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body),signal,cache:'no-store'});
  const result=await response.json().catch(()=>{throw Object.assign(new Error('서버 JSON 응답을 확인하지 못했습니다.'),{status:400});});
  if(!response.ok)throw Object.assign(new Error(result?.error?.message??'MVP 요청 실패'),{status:response.status});
  return result;
}

export function RuntimeControl({state,vehicleId,stale,onRefresh}:{state:ServerState;vehicleId:string;stale:boolean;onRefresh:()=>void}){
  const [speechState,setSpeechState]=useState({ready:false,status:'unprepared',message:'이 시연 패널에서 음성을 먼저 준비하세요.'});
  const [uploadState,setUploadState]=useState({status:'idle',message:'종료된 대기 기록을 자동 전송합니다.'});
  const [error,setError]=useState('');
  const clientId=useRef(identifier());
  const refresh=useRef(onRefresh);refresh.current=onRefresh;
  const speaker=useRef<PromptSpeaker|null>(null),uploader=useRef<TripUploader|null>(null);
  const connection=state.vehicles.find(item=>item.id===vehicleId)?.connection;
  const runtime=state.vehicleRuntime?.find(item=>item.vehicleId===vehicleId);
  const voiceAllowed=runtime?.parking==='parked'&&runtime.sessionActive&&runtime.connectionId===connection?.id;
  const conversation=voiceAllowed?state.conversations?.find(item=>item.connectionId===connection?.id&&item.isCurrent&&!['cancelled','driving','completed'].includes(item.phase)):undefined;
  const prompt=state.prompts?.find(item=>item.id===conversation?.promptId);
  const contextKey=`${state.demoId}/${vehicleId}/${connection?.id??''}/${conversation?.id??''}/${prompt?.id??''}`;
  useEffect(()=>{
    const current=new PromptSpeaker({speech:browserSpeech(),changed:setSpeechState,
      claim:(target:any)=>post('/mvp-api/voice/claim',{promptId:target.id,clientId:clientId.current}),
      complete:async(target:any,outcome:string)=>{await post('/mvp-api/voice/complete',{commandId:identifier(),promptId:target.id,clientId:clientId.current,outcome});refresh.current();},
    });
    const upload=new TripUploader({changed:(value:any)=>{setUploadState(value);if(value.status==='idle')refresh.current();},post:(body:string,signal:AbortSignal)=>post('/mvp-api/trip-events',body,signal)});
    speaker.current=current;uploader.current=upload;
    const inactive=()=>{if(document.hidden)current.cancel('시연 패널이 비활성화되어 음성을 중단했습니다.');};
    document.addEventListener('visibilitychange',inactive);
    return()=>{document.removeEventListener('visibilitychange',inactive);current.dispose();upload.dispose();speaker.current=null;uploader.current=null;};
  },[]);
  useEffect(()=>{speaker.current?.update({contextKey,prompt,stale});uploader.current?.update(state,!stale);},[state,contextKey,prompt,stale]);
  async function simulate(){
    if(!connection||!conversation||!prompt)return;
    setError('');speaker.current?.cancel('실제 재생이 아닌 명시적 안내 완료 모의를 전달합니다.');
    try{await post('/mvp-api/commands',{commandId:identifier(),connectionId:connection.id,conversationId:conversation.id,type:'simulate_prompt',promptId:prompt.id});refresh.current();}
    catch(cause){setError(cause instanceof Error?cause.message:'안내 완료 모의를 전달하지 못했습니다.');}
  }
  return <section className="mvp-card mvp-runtime" aria-label="시연 음성 및 자동 전송">
    <h2>시연 음성</h2><p>이 패널에서만 브라우저 음성 합성을 요청합니다. 마이크·실제 음성인식은 사용하지 않습니다.</p>
    <button className="button secondary" disabled={stale||runtime?.parking!=='parked'||['preparing','claiming','playing'].includes(speechState.status)} onClick={()=>speaker.current?.prepare()}>시연 음성 준비</button>
    <p role="status" data-speech-status={speechState.status}>{speechState.message}</p>
    <button className="button secondary" disabled={stale||!voiceAllowed||!prompt||!['pending','claimed','failed'].includes(prompt.status)} onClick={()=>void simulate()}>안내 완료 모의</button>
    <p className="mvp-muted">이 버튼은 실제 재생 성공이 아닙니다. 텍스트를 확인한 뒤 다음 모의 대화로 진행합니다.</p>
    {error&&<p role="alert">{error}</p>}
    <h3>자동 운행 전송</h3><p role="status">{uploadState.message}</p><p className="mvp-muted">업로드 차단은 운행 수신 요청만 막습니다. QR·조회·제어 통신은 계속됩니다.</p>
  </section>;
}
