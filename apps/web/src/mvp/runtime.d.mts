export function browserSpeech(options?: any): any;
export class PromptSpeaker {
  constructor(options: any);
  state: {ready:boolean;status:string;message:string};
  prepare(): void; update(options:any):void;cancel(message?:string):void;dispose():void;
}
export class TripUploader {constructor(options:any);update(snapshot:any,enabled?:boolean):void;dispose():void;}
