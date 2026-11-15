import type { FleetController } from './index.mjs';
import type { VoiceAdapter } from './voice-adapter.mjs';
export interface VoiceState {
  phase:'idle'|'prompting'|'listening'|'processing'|'draft'|'error';
  sessionId:string|null; tripId:string|null; interim:string; transcript:string;
  reason:'matched'|'missing'|'ambiguous'|'empty'|'too-long'|null;
  error:'failed'|'empty'|'timeout'|'unavailable'|'draft-failed'|null; cancelReason:string|null;
}
export class VoiceFlow {
  constructor(options:{controller:FleetController;adapter:VoiceAdapter;id?:()=>string;schedule?:(fn:()=>void,ms:number)=>any;unschedule?:(timer:any)=>void;promptTimeoutMs?:number;recognitionTimeoutMs?:number});
  connect():()=>void; disconnect():void; getState():VoiceState; subscribe(listener:(state:VoiceState)=>void):()=>void;
  start():boolean; cancel(reason?:string):void; clear():void; setForeground(value:boolean):void;
}
