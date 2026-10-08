import { randomUUID } from 'node:crypto';
import { BridgeError } from './runtime.mjs';
import { prepareMessages, validateTools, toolFailure } from './content.mjs';
import { qoderCnCheckin } from './qoder-cn-checkin.mjs';

const PLATFORM_KEY={CURSOR:'CURSOR_API_KEY',COPILOT:'COPILOT_GITHUB_TOKEN',QODER:'QODERCN_PERSONAL_ACCESS_TOKEN'};
const PLATFORM_ALIASES={CURSOR:['apiKey','authToken','token'],COPILOT:['githubToken','accessToken','authToken','apiKey','token'],QODER:['accessToken','personalAccessToken','authToken','apiKey','token']};
export function safeError(error){
  if(error instanceof BridgeError)return {code:error.code,message:error.message,retryable:error.retryable};
  const message=String(error?.message??'');
  if(/qoder cli executable not found/i.test(message))return {code:'QODER_CLI_UNAVAILABLE',message:'The bundled Qoder runtime could not start',retryable:false};
  if(/401|unauth|authentication|login required|not logged/i.test(message))return {code:'AUTH_REQUIRED',message:'Upstream authentication failed; sign in again',retryable:false};
  if(/429|rate.limit|quota/i.test(message))return {code:'RATE_LIMITED',message:'Upstream rate or quota limit reached',retryable:true};
  if(/403|forbidden|not authorized/i.test(message))return {code:'FORBIDDEN',message:'Upstream account is not authorized for this operation',retryable:false};
  if(/timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(message))return {code:'UPSTREAM_UNAVAILABLE',message:'Upstream connection failed',retryable:true};
  return {code:'UPSTREAM_ERROR',message:'The upstream runtime could not complete this operation',retryable:false};
}
export class BridgeProtocol {
  constructor({platform,runtime,providerFactory,emit,toolTimeoutMs=10*60*1000,turnTimeoutMs=30*60*1000,qoderCheckin=qoderCnCheckin}){
    this.platform=platform;this.runtime=runtime;this.providerFactory=providerFactory;this.emit=emit;this.toolTimeoutMs=toolTimeoutMs;this.turnTimeoutMs=turnTimeoutMs;
    this.turns=new Map();this.pending=new Map();this.activeIds=new Set();this.closed=false;this.loginAbort=undefined;this.qoderCheckin=qoderCheckin;this.qoderCheckinToken=undefined;
  }
  async provider(){if(!this.providerPromise)this.providerPromise=this.providerFactory();return this.providerPromise;}
  async dispatch(request){
    const id=request?.id;
    if(this.closed)return;
    if(typeof id!=='string'&&typeof id!=='number'){this.emit({id:null,event:'error',code:'INVALID_REQUEST',message:'A string or numeric id is required',retryable:false});return;}
    if(this.activeIds.has(id)){this.emit({id,event:'error',code:'DUPLICATE_ID',message:'Request id is already active',retryable:false});return;}
    this.activeIds.add(id);
    const send=event=>this.emit({id,...event});
    try {
      const p=request.params??{};
      if(request.method==='initialize') {
        if(this.turns.size||this.loginAbort)throw new BridgeError('BUSY','Cannot initialize while operations are active');
        const credentials=p.credentials??{};
        const key=PLATFORM_KEY[this.platform];
        const token=credentials[key]??PLATFORM_ALIASES[this.platform].map(k=>credentials[k]).find(v=>v!==undefined);
        if(token!==undefined){if(typeof token!=='string'||!token.trim())throw new BridgeError('INVALID_CREDENTIAL','Credential must be a nonempty string');this.runtime.env[key]=token;process.env[key]=token;}
        // Optional Cursor web-session token for real quota numbers; userHome lets the
        // quota lookup fall back to the desktop app's state.vscdb (env APPDATA is isolated).
        if(credentials.sessionToken!==undefined){
          if(typeof credentials.sessionToken!=='string'||!credentials.sessionToken.trim())throw new BridgeError('INVALID_CREDENTIAL','sessionToken must be a nonempty string');
          this.runtime.sessionToken=credentials.sessionToken.trim();
        }
        if(typeof p.userHome==='string'&&p.userHome.trim())this.runtime.userHome=p.userHome.trim();
        if(this.platform==='QODER'){
          const checkinToken=credentials.checkinToken??token;
          if(checkinToken!==undefined&&(typeof checkinToken!=='string'||!checkinToken.trim()))throw new BridgeError('INVALID_CREDENTIAL','签到凭证必须是非空字符串');
          this.qoderCheckinToken=checkinToken?.trim();
        }
        if(this.providerPromise)await(await this.providerPromise).close();this.providerPromise=undefined;
        send({event:'result',data:{initialized:true,protocolVersion:1,workspace:'isolated'}});
      } else if(request.method==='login_input'){
        if(!this.loginAbort||(p.requestId!==undefined&&this.loginAbort.id!==p.requestId)||!this.loginAbort.input)throw new BridgeError('LOGIN_NOT_WAITING','No matching official CLI authorization is waiting for input');
        if(typeof p.text!=='string'||!p.text.trim()||p.text.length>16384||/[\r\n]/.test(p.text))throw new BridgeError('INVALID_LOGIN_INPUT','Supply one authorization code or callback URL');
        this.loginAbort.input(p.text);send({event:'result',data:{accepted:true}});
      } else if(request.method==='tool_result'){
        const key=`${p.turnId}\0${p.toolCallId}`,pending=this.pending.get(key);
        if(!pending)throw new BridgeError('UNKNOWN_TOOL_CALL','Tool call is expired, cancelled or does not belong to this turn');
        if(p.isError!==undefined&&typeof p.isError!=='boolean')throw new BridgeError('INVALID_TOOL_RESULT','isError must be a boolean');
        this.pending.delete(key);clearTimeout(pending.timer);pending.resolve(p.isError?toolFailure(p.content):p.content);
        send({event:'result',data:{accepted:true}});
      } else if(request.method==='cancel'){
        const turn=this.turns.get(p.turnId);
        if(turn)turn.controller.abort();
        else if(p.requestId!==undefined&&this.loginAbort?.id===p.requestId)this.loginAbort.controller.abort();
        send({event:'result',data:{cancelled:Boolean(turn||this.loginAbort)}});
      } else if(request.method==='shutdown'){
        await this.close();send({event:'result',data:{shutdown:true}});
      } else if(request.method==='chat')await this.chat(p,send);
      else if(request.method==='catalog')send({event:'result',data:await(await this.provider()).catalog()});
      else if(request.method==='quota')send({event:'result',data:await(await this.provider()).quota()});
      else if(request.method==='auth_status')send({event:'result',data:await(await this.provider()).status()});
      else if(request.method==='checkin'){
        if(this.platform!=='QODER')throw new BridgeError('UNSUPPORTED_CHECKIN','This platform has no bridge check-in operation');
        send({event:'result',data:await this.qoderCheckin(this.qoderCheckinToken)});
      }
      else if(request.method==='login'){
        if(this.loginAbort||this.turns.size)throw new BridgeError('BUSY','Authorization requires an idle account');
        const controller=new AbortController();this.loginAbort={id,controller};
        try{send({event:'result',data:await(await this.provider()).login({signal:controller.signal,emit:send,setLoginInput:input=>{if(this.loginAbort)this.loginAbort.input=input;}})});}finally{this.loginAbort=undefined;}
      } else throw new BridgeError('METHOD_NOT_FOUND','Unknown bridge method');
    }catch(error){send({event:'error',...safeError(error)});}finally{this.activeIds.delete(id);}
  }
  async chat(p,send){
    if(typeof p.turnId!=='string'||!p.turnId||p.turnId.length>200||typeof p.model!=='string'||!p.model)throw new BridgeError('INVALID_CHAT','turnId and model are required');
    if(this.turns.has(p.turnId))throw new BridgeError('DUPLICATE_TURN','Turn is already running');
    const budget=p.outputTokenBudget??p.max_tokens;
    if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<1||budget>1000000))throw new BridgeError('INVALID_BUDGET','Output token budget must be a positive integer <= 1000000');
    for(const option of ['temperature','top_p'])if(p[option]!==undefined&&p[option]!==null)throw new BridgeError('UNSUPPORTED_OPTION',`The agent SDK does not expose ${option} control`);
    if(p.stop!==undefined&&p.stop!==null&&!(Array.isArray(p.stop)&&p.stop.length===0))throw new BridgeError('UNSUPPORTED_OPTION','Custom stop sequences are not available through this agent SDK');
    if(p.tool_choice!==undefined&&p.tool_choice!==null&&!['auto','none'].includes(p.tool_choice))throw new BridgeError('UNSUPPORTED_OPTION','This adapter supports auto and none tool choice');
    if(p.parallel_tool_calls!==undefined&&typeof p.parallel_tool_calls!=='boolean')throw new BridgeError('INVALID_OPTION','parallel_tool_calls must be a boolean');
    const controller=new AbortController();const signal=controller.signal;
    const turn={controller,pending:new Set()};this.turns.set(p.turnId,turn);
    let budgetReached=false,timedOut=false,toolTimedOut=false,bytes=0,known=false,invalidUsage=false,inputTokens=0,outputTokens=0,cacheReadTokens=null,cacheWriteTokens=null;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.turnTimeoutMs);
    const cancelPending=()=>{for(const key of turn.pending){const pending=this.pending.get(key);if(pending){this.pending.delete(key);clearTimeout(pending.timer);pending.reject(new BridgeError('CANCELLED','Tool wait was cancelled'));}}};
    signal.addEventListener('abort',cancelPending);
    const spend=text=>{
      if(!budget){bytes+=Buffer.byteLength(text);return text;}
      const allowance=Math.max(0,budget*3-bytes);let output='',used=0;
      for(const char of text){const size=Buffer.byteLength(char);if(used+size>allowance)break;output+=char;used+=size;}
      bytes+=used;
      if(output!==text||bytes>=budget*3)budgetReached=true;
      return output;
    };
    const ctx={abortController:controller,signal,
      text:text=>{if(signal.aborted||typeof text!=='string')return;const fragment=spend(text);if(fragment)send({event:'text_delta',text:fragment});if(budgetReached)controller.abort();},
      usage:(input,output,total=false,cache=null)=>{
        if(input==null&&output==null&&cache===null)return;
        if(invalidUsage)return;
        const invalidate=()=>{invalidUsage=true;known=false;};
        const valid=value=>Number.isSafeInteger(value)&&value>=0;
        if(!valid(input)||!valid(output)||cache!==null&&(typeof cache!=='object'||Array.isArray(cache))){invalidate();return;}
        const read=cache?.cacheReadTokens??null,write=cache?.cacheWriteTokens??null;
        if(read!==null&&!valid(read)||write!==null&&!valid(write)){invalidate();return;}
        const nextInput=total?input:inputTokens+input,nextOutput=total?output:outputTokens+output;
        const nextRead=total?read:!known?read:cacheReadTokens!==null&&read!==null?cacheReadTokens+read:null;
        const nextWrite=total?write:!known?write:cacheWriteTokens!==null&&write!==null?cacheWriteTokens+write:null;
        if(!valid(nextInput)||!valid(nextOutput)||nextRead!==null&&!valid(nextRead)||nextWrite!==null&&!valid(nextWrite)){invalidate();return;}
        if((nextRead??0)+(nextWrite??0)>nextInput){invalidate();return;}
        known=true;inputTokens=nextInput;outputTokens=nextOutput;cacheReadTokens=nextRead;cacheWriteTokens=nextWrite;
      },
      tool:(name,args,providedId)=>{
        if(signal.aborted)return Promise.reject(new BridgeError('CANCELLED','Tool request cancelled'));
        if(budget&&bytes+Buffer.byteLength(JSON.stringify(args))>budget*3){budgetReached=true;controller.abort();return Promise.reject(new BridgeError('OUTPUT_BUDGET','Gateway output budget exhausted'));}
        bytes+=Buffer.byteLength(JSON.stringify(args));
        const toolCallId=providedId||`call_${randomUUID().replaceAll('-','')}`;
        const key=`${p.turnId}\0${toolCallId}`;
        if(this.pending.has(key))return Promise.reject(new BridgeError('DUPLICATE_TOOL_CALL','Tool call id is already pending'));
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{toolTimedOut=true;this.pending.delete(key);turn.pending.delete(key);reject(new BridgeError('TOOL_TIMEOUT','Member tool result did not arrive before the deadline'));controller.abort();},this.toolTimeoutMs);
          this.pending.set(key,{resolve,reject,timer});turn.pending.add(key);
          send({event:'tool_call',toolCallId,name,arguments:args});
        });
      },
    };
    if(p.parallel_tool_calls===false){const dispatch=ctx.tool;let tail=Promise.resolve();ctx.tool=(...args)=>{const next=tail.then(()=>dispatch(...args));tail=next.then(()=>undefined,()=>undefined);return next;};}
    try{
      const provided=validateTools(p.tools);const definitions=p.tool_choice==='none'?[]:provided;const content=await prepareMessages(p.messages,signal);
      if(signal.aborted)throw new BridgeError('CANCELLED','Request cancelled');
      let result;
      try{result=await(await this.provider()).chat({...p,...content,definitions},ctx);}catch(error){if(!signal.aborted)throw error;}
      const usageSource=invalidUsage?'UNKNOWN':known?'KNOWN':bytes?'ESTIMATED':'UNKNOWN';
      send({event:'usage',inputTokens:known?inputTokens:null,outputTokens:known?outputTokens:!invalidUsage&&bytes?Math.ceil(bytes/3):null,
        cacheReadTokens:known?cacheReadTokens:null,cacheWriteTokens:known?cacheWriteTokens:null,
        usageSource,cumulative:true,...(!invalidUsage&&!known&&bytes?{estimateMethod:'UTF8_BYTES_DIV_3'}:{})});
      if(timedOut)throw new BridgeError('TURN_TIMEOUT','Upstream turn exceeded its time limit',true);
      if(toolTimedOut)throw new BridgeError('TOOL_TIMEOUT','Member tool result did not arrive before the deadline');
      send({event:'done',stopReason:budgetReached?'max_tokens':signal.aborted?'cancelled':result?.stopReason??'end_turn',...(budgetReached?{limitSource:'GATEWAY_ESTIMATE'}:{})});
    }finally{
      clearTimeout(timer);controller.abort();signal.removeEventListener('abort',cancelPending);this.turns.delete(p.turnId);
    }
  }
  async close(){
    if(this.closed)return;this.closed=true;this.loginAbort?.controller.abort();
    this.qoderCheckinToken=undefined;
    for(const turn of this.turns.values())turn.controller.abort();
    if(this.providerPromise){try{await(await this.providerPromise).close();}catch{}}
  }
}
