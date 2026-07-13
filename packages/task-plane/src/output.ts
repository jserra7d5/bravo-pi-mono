import { closeSync, fchmodSync, fstatSync, openSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MiB=1024*1024;
export const MAX_EVENT_LINE_CHARS=64*1024;
export const EVENT_LINE_TRUNCATED_MARKER="[task-plane event line truncated]";
export function truncateEventLine(line:string):string{return line.length>MAX_EVENT_LINE_CHARS?`${line.slice(0,MAX_EVENT_LINE_CHARS)}${EVENT_LINE_TRUNCATED_MARKER}`:line;}
export const BASH_OUTPUT_CAP=10*MiB;
export const MONITOR_OUTPUT_CAP=5*MiB;

export interface OutputFsPort {
 open(path:string,flags:string,mode:number):number;
 close(fd:number):void;
 chmod(fd:number,mode:number):void;
 size(fd:number):number;
 write(fd:number,data:Buffer):void;
 read(fd:number,length:number,position:number):Buffer;
 replace(path:string,data:Buffer,mode:number):void;
 unlink(path:string):void;
}
export const nodeOutputFs:OutputFsPort={
 open:(path,flags,mode)=>openSync(path,flags,mode),close:closeSync,chmod:fchmodSync,size:fd=>fstatSync(fd).size,
 write:(fd,data)=>{let at=0;while(at<data.length)at+=writeSync(fd,data,at,data.length-at);},
 read:(fd,length,position)=>{const out=Buffer.allocUnsafe(length);let at=0;while(at<length){const n=readSync(fd,out,at,length-at,position+at);if(!n)break;at+=n;}return out.subarray(0,at);},
 replace:(path,data,mode)=>writeFileSync(path,data,{mode}),unlink:path=>unlinkSync(path),
};
export function sentinel(kind:"bash"|"monitor",message:string):string{return `\n[task-plane ${kind}] ${new Date().toISOString()} ${message}\n`;}
type Source="stdout"|"stderr";
type DecodeState={decoder:StringDecoder;text:string;discarding:boolean};
type Segment={source:Source;length:number;newline:boolean};

/** Payload bytes are accepted and durably written synchronously on arrival. A
 * descriptor which would split another descriptor's unfinished line is written
 * to its private spool until that line closes. At EOF/control boundaries an
 * unfinished descriptor is explicitly newline-terminated before another
 * descriptor is replayed, so independently produced lines can never merge. */
export class OutputWriter {
 private fd:number;private spoolFd:Record<Source,number>;private spoolRead:Record<Source,number>={stdout:0,stderr:0};
 private payloadBytes:number;private capped=false;private closed=false;private active?:Source;private queue:Segment[]=[];private monitorMark?:Buffer;
 private decode:Record<Source,DecodeState>={stdout:{decoder:new StringDecoder("utf8"),text:"",discarding:false},stderr:{decoder:new StringDecoder("utf8"),text:"",discarding:false}};
 constructor(readonly path:string,readonly kind:"bash"|"monitor",readonly cap=kind==="bash"?BASH_OUTPUT_CAP:MONITOR_OUTPUT_CAP,private fs:OutputFsPort=nodeOutputFs,initialPayloadBytes?:number){
  this.fd=fs.open(path,"a+",0o600);fs.chmod(this.fd,0o600);this.payloadBytes=initialPayloadBytes??fs.size(this.fd);
  this.spoolFd={stdout:fs.open(`${path}.stdout.pending`,"w+",0o600),stderr:fs.open(`${path}.stderr.pending`,"w+",0o600)};fs.chmod(this.spoolFd.stdout,0o600);fs.chmod(this.spoolFd.stderr,0o600);
 }
 get bytes(){return Math.min(this.payloadBytes,this.cap);}get outputCapped(){return this.capped;}
 get bufferedBytes(){return Buffer.byteLength(this.decode.stdout.text)+Buffer.byteLength(this.decode.stderr.text);}
 pendingText(source:Source){return this.decode[source].text;}
 write(source:Source,chunk:Buffer):{capped:boolean;lines:string[]}{if(this.closed)throw new Error("output writer is closed");const lines=this.decodeChunk(source,chunk);this.accept(source,chunk);return{capped:this.capped,lines};}
 frame(message:string){this.enqueueControl(Buffer.from(sentinel(this.kind,message)));}
 flushPartials():Array<{source:Source;line:string}>{const out:Array<{source:Source;line:string}>=[];for(const source of ["stdout","stderr"] as const){const s=this.decode[source],tail=s.decoder.end();if(tail)this.consumeText(s,tail,[]);if(s.text||s.discarding)out.push({source,line:this.eventLine(s)});s.text="";s.discarding=false;}return out;}
 close(){if(this.closed)return;this.flushPartials();this.drainAtBoundary();this.closed=true;for(const source of ["stdout","stderr"] as const){this.fs.close(this.spoolFd[source]);try{this.fs.unlink(`${this.path}.${source}.pending`);}catch{}}this.fs.close(this.fd);}
 private accept(source:Source,chunk:Buffer){if(!chunk.length)return;let data=chunk;if(this.kind==="bash"){if(this.capped)return;const take=Math.min(data.length,Math.max(0,this.cap-this.payloadBytes));data=data.subarray(0,take);this.payloadBytes+=take;if(take<chunk.length||this.payloadBytes>=this.cap)this.capped=true;}else{this.payloadBytes+=data.length;if(this.payloadBytes>this.cap)this.capped=true;}
  if(data.length){this.fs.write(this.spoolFd[source],data);for(const part of splitSegments(source,data)){const tail=this.queue.at(-1);if(tail?.source===part.source&&(source!==this.active||!(tail.newline&&!part.newline))){tail.length+=part.length;tail.newline=part.newline;}else this.queue.push(part);}this.drain();if(this.kind==="monitor")this.boundPending(source);}
  if(this.kind==="bash"&&this.capped)this.enqueueControl(Buffer.from(sentinel("bash",`output cap reached at ${this.cap} payload bytes; process stopped`)));
  if(this.kind==="monitor")this.rollMonitorIfNeeded();
 }
 private drain(){while(this.queue.length){let index=0;if(this.active){index=this.queue.findIndex(s=>s.source===this.active);if(index<0)break;}const segment=this.queue.splice(index,1)[0],data=this.fs.read(this.spoolFd[segment.source],segment.length,this.spoolRead[segment.source]);if(data.length!==segment.length)throw new Error("output spool short read");this.spoolRead[segment.source]+=segment.length;this.fs.write(this.fd,data);this.active=segment.newline?undefined:segment.source;}this.resetDrainedSpools();}
 private drainAtBoundary(hasFollowingOutput=true){this.drain();while(this.queue.length){if(this.active){this.fs.write(this.fd,Buffer.from("\n"));this.active=undefined;}this.drain();}if(hasFollowingOutput&&this.active)this.fs.write(this.fd,Buffer.from("\n"));this.active=undefined;this.resetDrainedSpools();if(this.kind==="monitor")this.rollMonitorIfNeeded();}
 private resetDrainedSpools(){for(const source of ["stdout","stderr"] as const)if(!this.queue.some(s=>s.source===source)&&this.spoolRead[source]===this.fs.size(this.spoolFd[source])){this.fs.close(this.spoolFd[source]);this.fs.replace(`${this.path}.${source}.pending`,Buffer.alloc(0),0o600);this.spoolFd[source]=this.fs.open(`${this.path}.${source}.pending`,"a+",0o600);this.fs.chmod(this.spoolFd[source],0o600);this.spoolRead[source]=0;}}
 private boundPending(source:Source){const size=this.fs.size(this.spoolFd[source]),unread=size-this.spoolRead[source];if(unread<=this.cap)return;const retained=this.fs.read(this.spoolFd[source],this.cap,size-this.cap),at=this.queue.findIndex(s=>s.source===source);this.fs.close(this.spoolFd[source]);this.fs.replace(`${this.path}.${source}.pending`,retained,0o600);this.spoolFd[source]=this.fs.open(`${this.path}.${source}.pending`,"a+",0o600);this.fs.chmod(this.spoolFd[source],0o600);this.spoolRead[source]=0;if(at>=0){this.queue=this.queue.filter(s=>s.source!==source);this.queue.splice(Math.min(at,this.queue.length),0,{source,length:retained.length,newline:retained.at(-1)===10});}}
 private enqueueControl(data:Buffer){this.drainAtBoundary();this.fs.write(this.fd,data);if(this.kind==="monitor")this.rollMonitorIfNeeded();}
 private rollMonitorIfNeeded(){const allowance=this.monitorMark?.length??0,size=this.fs.size(this.fd);if(size<=this.cap+allowance)return;let start=allowance;if(this.monitorMark){const prefix=this.fs.read(this.fd,this.monitorMark.length,0);if(!prefix.equals(this.monitorMark))start=0;}const available=Math.max(0,size-start),take=Math.min(available,this.cap),retained=this.fs.read(this.fd,take,size-take);this.monitorMark=Buffer.from(sentinel("monitor",`older output truncated; newest ${this.cap} physical bytes retained`));this.fs.replace(this.path,Buffer.concat([this.monitorMark,retained]),0o600);this.fs.close(this.fd);this.fd=this.fs.open(this.path,"a+",0o600);this.fs.chmod(this.fd,0o600);}
 private decodeChunk(source:Source,chunk:Buffer):string[]{const lines:string[]=[];this.consumeText(this.decode[source],this.decode[source].decoder.write(chunk),lines);return lines;}
 private eventLine(s:DecodeState):string{return `${s.text.replace(/\r$/,"" )}${s.discarding?EVENT_LINE_TRUNCATED_MARKER:""}`;}
 private consumeText(s:DecodeState,text:string,lines:string[]){for(const part of text.split(/(\n)/)){if(part==="\n"){lines.push(this.eventLine(s));s.text="";s.discarding=false;continue;}if(!part||s.discarding)continue;const remaining=MAX_EVENT_LINE_CHARS-s.text.length;if(part.length<=remaining)s.text+=part;else{s.text+=part.slice(0,Math.max(0,remaining));s.discarding=true;}}}
}
function splitSegments(source:Source,data:Buffer):Segment[]{const out:Segment[]=[];let start=0;for(let i=0;i<data.length;i++)if(data[i]===10){out.push({source,length:i-start+1,newline:true});start=i+1;}if(start<data.length)out.push({source,length:data.length-start,newline:false});return out;}
