// @ts-check
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AsyncQueue, BridgeError } from './runtime.mjs';
import { imageBlocks, nativeToolResult } from './content.mjs';
import { memberMcpServer } from './mcp-tools.mjs';
import { runLogin, runCopilotDeviceFlow } from './login.mjs';

const imports={CURSOR:()=>import('@cursor/sdk'),COPILOT:()=>import('@github/copilot-sdk'),QODER:()=>import('@qodercn-ai/qodercn-agent-sdk')};
function modelRow(id,name,extra={}) {return {id,name:name??id,supportsImages:null,supportsTools:null,reasoningEfforts:null,defaultReasoningEffort:null,contextWindow:null,maxOutputTokens:null,...extra};}

/** Cursor user id (user_…) from the access token JWT `sub` claim; browser cookie shape needs it. */
function cursorUserIdFromAccessToken(accessToken){
  const payloadB64=String(accessToken).split('.')[1];
  if(!payloadB64)throw new BridgeError('INVALID_CREDENTIAL','Cursor accessToken is not a JWT');
  const padded=payloadB64.length%4===2?payloadB64+'==':payloadB64.length%4===3?payloadB64+'=':payloadB64;
  let payload;
  try{payload=JSON.parse(Buffer.from(padded,'base64url').toString('utf8'));}
  catch(error){throw new BridgeError('INVALID_CREDENTIAL','Cursor accessToken JWT payload is malformed');}
  const sub=String(payload.sub??'');
  const match=sub.match(/user_[A-Za-z0-9_]+/);
  if(!match)throw new BridgeError('INVALID_CREDENTIAL','Cursor accessToken JWT is missing a user id');
  return match[0];
}

/** Accept an account JWT, browser cookie value, or named session cookie. */
function cursorSessionCredential(session){
  let value=String(session).trim();
  if(/[\r\n]/.test(value))throw new BridgeError('INVALID_CREDENTIAL','Cursor session must be a single value');
  const named=value.match(/(?:^|;\s*)WorkosCursorSessionToken=([^;]+)/);
  if(named)value=named[1];
  try{value=decodeURIComponent(value);}catch{throw new BridgeError('INVALID_CREDENTIAL','Cursor session cookie is malformed');}
  const separator=value.indexOf('::');
  const accessToken=separator<0?value:value.slice(separator+2);
  const userId=cursorUserIdFromAccessToken(accessToken);
  if(separator>=0&&value.slice(0,separator)!==userId)throw new BridgeError('INVALID_CREDENTIAL','Cursor session cookie identity is inconsistent');
  return {accessToken,cookie:`WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`};
}

/** The one desktop-app state DB path candidate that exists, or null. */
function cursorDesktopStateDb(userHome){
  if(!userHome)return null;
  const candidates=process.platform==='win32'
    ?[path.join(userHome,'AppData','Roaming','Cursor','User','globalStorage','state.vscdb')]
    :process.platform==='darwin'
      ?[path.join(userHome,'Library','Application Support','Cursor','User','globalStorage','state.vscdb')]
      :[path.join(userHome,'.config','Cursor','User','globalStorage','state.vscdb')];
  return candidates.find(p=>{try{return existsSync(p)&&statSync(p).size>0;}catch{return false;}})??null;
}

/** Desktop Cursor keeps a long-lived accessToken in `cursorAuth/accessToken` (plain TEXT). */
async function desktopCursorAccessToken(userHome){
  const dbPath=cursorDesktopStateDb(userHome);
  if(!dbPath)return null;
  try{
    const db=new DatabaseSync(dbPath,{readOnly:true});
    try{
      const row=db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
      const value=row?.value;
      return typeof value==='string'&&value.trim()?value.trim():null;
    }finally{db.close();}
  }catch{return null;}
}

/** Cursor account usage pools (auto/included + on-demand) from the settings backend. */
async function cursorUsageSummary(accessToken){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch('https://cursor.com/api/usage-summary',{
      signal:controller.signal,
      headers:{
        Accept:'*/*',
        'Accept-Language':'en-US,en;q=0.9',
        Cookie:cursorSessionCredential(accessToken).cookie,
        Referer:'https://www.cursor.com/settings',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if(response.status===401||response.status===403){
      throw new BridgeError('AUTH_REQUIRED','Cursor 会话已过期：请重新登录 Cursor 桌面端，或在账号凭证中更新 sessionToken');
    }
    if(!response.ok){
      throw new BridgeError('UPSTREAM_ERROR',`Cursor usage-summary returned HTTP ${response.status}`);
    }
    const usage=await response.json();
    return {
      source:'CURSOR_USAGE_SUMMARY',
      membershipType:usage.membershipType??null,
      billingCycleStart:usage.billingCycleStart??null,
      billingCycleEnd:usage.billingCycleEnd??null,
      plan:usage.individualUsage?.plan??null,
      onDemand:usage.individualUsage?.onDemand??null,
    };
  }catch(error){
    if(error instanceof BridgeError)throw error;
    if(error?.name==='AbortError')throw new BridgeError('UPSTREAM_UNAVAILABLE','Cursor usage-summary timed out',true);
    throw new BridgeError('UPSTREAM_UNAVAILABLE','Cursor usage-summary request failed',true);
  }finally{clearTimeout(timer);}
}

/** Read-only identity RPC from the official desktop AuthService.GetUserMeta contract. */
async function cursorSessionIdentity(session){
  const {accessToken}=cursorSessionCredential(session);
  try{
    const response=await fetch('https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta',{
      method:'POST',body:'{}',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json','Connect-Protocol-Version':'1'},
    });
    if(response.status===401||response.status===403)throw new BridgeError('AUTH_REQUIRED','Cursor web session is unavailable');
    if(!response.ok)throw new BridgeError('UPSTREAM_UNAVAILABLE','Cursor session identity request failed',true);
    return await response.json();
  }catch(error){
    if(error instanceof BridgeError)throw error;
    throw new BridgeError('UPSTREAM_UNAVAILABLE','Cursor session identity request failed',true);
  }
}

function cursorIdentityMatches(account,session){
  const id=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):typeof value==='string'&&/^\d+$/.test(value.trim())?value.trim():null;
  const accountId=id(account.userId),sessionId=id(session.userId??session.user_id);
  if(accountId!==null&&sessionId!==null)return accountId===sessionId;
  const email=value=>typeof value==='string'&&value.trim()?value.trim().toLowerCase():null;
  const accountEmail=email(account.userEmail),sessionEmail=email(session.email);
  return accountEmail!==null&&sessionEmail!==null?accountEmail===sessionEmail:null;
}

const qoderSelectors=new Set(['auto','default','ultimate','performance','balanced','economy','efficient','fast','premium','smart-routing']);
/** @param {import('@qodercn-ai/qodercn-agent-sdk').ModelInfo} model */
function qoderBuiltIn(model){
  const id=model.value?.trim();
  if(!id||model.isEnabled===false||qoderSelectors.has(id.toLowerCase()))return false;
  if(model.source!=null)return model.source==='system';
  // Older catalog replies may omit source. Require a concrete ID and no BYOK markers.
  if([model.url,model.model,model.provider,model.outerProvider].some(value=>value!=null))return false;
  return model.modelId===id||/\d/.test(id);
}
/** @param {import('@qodercn-ai/qodercn-agent-sdk').ModelInfo} model */
function qoderModelRow(model){
  const contexts=model.availableContextWindows??(model.context_config?Object.values(model.context_config).map(item=>item.token_count):null);
  const defaultContext=model.defaultContextWindow??Object.values(model.context_config??{}).find(item=>item.is_default)?.token_count??null;
  const effortEntries=model.thinking_config?.enabled?.efforts;
  const advertisedEfforts=model.efforts??(effortEntries?Object.keys(effortEntries):model.isReasoning===false?[]:null);
  const supportsDisabled=model.supportsDisabled===true||Boolean(model.thinking_config?.disabled)||advertisedEfforts?.includes('none')===true;
  const disabledKnown=model.supportsDisabled!==undefined||model.thinking_config!==undefined||advertisedEfforts?.includes('none')===true;
  const efforts=supportsDisabled?[...new Set([...(advertisedEfforts??[]),'none'])]:advertisedEfforts;
  const defaultEffort=model.defaultEffort??(effortEntries?Object.keys(effortEntries).find(level=>effortEntries[level].is_default):undefined)??null;
  return modelRow(model.value,model.displayName,{
    supportsImages:model.isVl??null,reasoningEfforts:efforts,defaultReasoningEffort:defaultEffort,
    supportsDisabledReasoning:disabledKnown?supportsDisabled:null,
    availableContextWindows:contexts,contextWindow:defaultContext,maxOutputTokens:model.maxOutputTokens??null,
  });
}

export class CursorProvider {
  /** @param {any} runtime @param {typeof import('@cursor/sdk')} sdk */
  constructor(runtime,sdk){this.rt=runtime;this.sdk=sdk;this.models=[];}
  async accountIdentity(){
    const explicit=this.rt.env.CURSOR_API_KEY?.trim();
    const stored=explicit?undefined:await new this.sdk.FileCredentialStore(path.join(this.rt.authHome,'.cursor','sdk','auth.json')).load();
    if(!explicit&&(!stored?.apiKey||stored.apiKeyExpiresAtMs!==undefined&&stored.apiKeyExpiresAtMs<=Date.now()))return null;
    const user=await this.sdk.Cursor.me({apiKey:explicit||stored.apiKey});
    return {user,credentialSource:explicit?'ACCOUNT_TOKEN':'ACCOUNT_HOME'};
  }
  async status(){
    const identity=await this.accountIdentity();
    if(!identity)return {authenticated:false,sdkAuthenticated:false,label:'',message:'Cursor SDK sign-in required'};
    return {authenticated:true,sdkAuthenticated:true,credentialSource:identity.credentialSource,
      label:identity.user.userEmail??identity.user.apiKeyName,message:'Credential verified by Cursor'};
  }
  async login(ctx){const result=await this.sdk.Cursor.auth.login({openBrowser:false,onLoginUrl:url=>ctx.emit({event:'auth_url',url}),signal:ctx.signal,store:new this.sdk.FileCredentialStore(path.join(this.rt.authHome,'.cursor','sdk','auth.json'))});
    await this.rt.refreshAuth();this.rt.env.CURSOR_API_KEY=result.apiKey;process.env.CURSOR_API_KEY=result.apiKey;return {...await this.status(),credentialSource:'ACCOUNT_HOME'};}
  async catalog(){this.models=await this.sdk.Cursor.models.list({apiKey:this.rt.env.CURSOR_API_KEY});return this.models.map(m=>modelRow(m.id,m.displayName,{reasoningEfforts:m.parameters?.find(p=>/reasoning|effort/i.test(p.id))?.values.map(v=>v.value)??null}));}
  async quota(){
    // Model API-key health and web-session quota access are separate credentials.
    // A local desktop session is usable only after both upstream identities match.
    let identity;
    try{identity=await this.accountIdentity();}catch{identity=null;}
    const sdkAuthenticated=identity!==null;
    const dashboard=(quotaReason,credentialSource=identity?.credentialSource)=>({
      source:'CURSOR_DASHBOARD_ONLY',dashboardUrl:'https://cursor.com/dashboard/spending',
      sdkAuthenticated,quotaReason,...(credentialSource?{credentialSource}:{}),
    });
    if(!this.rt.sessionToken&&!identity)return dashboard('SDK_AUTH_REQUIRED');
    const session=this.rt.sessionToken||await desktopCursorAccessToken(this.rt.userHome);
    const credentialSource=this.rt.sessionToken?'ACCOUNT_SESSION':'LOCAL_DESKTOP';
    if(!session)return dashboard('SESSION_REQUIRED');
    try{
      if(identity){
        const sessionIdentity=await cursorSessionIdentity(session);
        const matches=cursorIdentityMatches(identity.user,sessionIdentity);
        if(matches!==true)return dashboard(matches===false?'ACCOUNT_MISMATCH':'IDENTITY_UNAVAILABLE',credentialSource);
      }
      return {...await cursorUsageSummary(session),credentialSource,sdkAuthenticated};
    }catch(error){
      return dashboard(error?.code==='AUTH_REQUIRED'?'SESSION_REQUIRED':error?.code==='INVALID_CREDENTIAL'?'SESSION_INVALID':'QUOTA_UNAVAILABLE',credentialSource);
    }
  }
  async chat(p,ctx){
    let params;
    if(p.reasoning_effort){if(!this.models.length)await this.catalog();const parameter=this.models.find(m=>m.id===p.model)?.parameters?.find(x=>/reasoning|effort/i.test(x.id)&&x.values.some(v=>v.value===p.reasoning_effort));
      if(!parameter)throw new BridgeError('UNSUPPORTED_REASONING','Requested reasoning effort is not advertised by this Cursor model');params=[{id:parameter.id,value:p.reasoning_effort}];}
    const storeDir=path.join(this.rt.runRoot,randomUUID());await mkdir(storeDir,{mode:0o700});
    const customTools=Object.fromEntries(p.definitions.map(t=>[t.name,{description:t.description,inputSchema:t.parameters,execute:async(args,info)=>nativeToolResult(await ctx.tool(t.name,args,info.toolCallId),ctx.signal)}]));
    const agent=await this.sdk.Agent.create({model:{id:p.model,...(params?{params}:{})},apiKey:this.rt.env.CURSOR_API_KEY,
      tools:p.definitions.length?['mcp']:[],mcpServers:{},agents:{},...(p.system?{systemPrompt:p.system}:{}),
      local:{cwd:this.rt.cwd,settingSources:[],store:new this.sdk.JsonlLocalAgentStore(storeDir),customTools,enableAgentRetries:false}});
    let run;const cancel=()=>run?.cancel().catch(()=>{});ctx.signal.addEventListener('abort',cancel,{once:true});
    try {
      run=await agent.send({text:p.prompt,images:p.images},{onDelta:({update})=>{if(update.type==='text-delta')ctx.text(update.text);}});
      if(ctx.signal.aborted)await run.cancel();
      for await(const event of run.stream()) if(event.type==='usage')ctx.usage(event.usage.inputTokens,event.usage.outputTokens);
      const result=await run.wait();
      if(result.status==='error')throw new BridgeError('UPSTREAM_ERROR','Cursor runtime failed');
      if(result.status==='cancelled'&&!ctx.signal.aborted)throw new BridgeError('UPSTREAM_CANCELLED','Cursor cancelled the run');
      if(result.usage)ctx.usage(result.usage.inputTokens,result.usage.outputTokens,true);
      return {stopReason:'end_turn'};
    } finally {ctx.signal.removeEventListener('abort',cancel);await agent.close();await rm(storeDir,{recursive:true,force:true});}
  }
  async close(){}
}

export class CopilotProvider {
  /** @param {any} runtime @param {typeof import('@github/copilot-sdk')} sdk */
  constructor(runtime,sdk){this.rt=runtime;this.sdk=sdk;}
  /** @returns {import('@github/copilot-sdk').CopilotClientOptions} */
  clientOptions(){return {mode:'empty',baseDirectory:path.join(this.rt.sessionHome,'.copilot'),workingDirectory:this.rt.cwd,
    env:{...this.rt.env,COPILOT_DISABLE_KEYTAR:'1'},gitHubToken:this.rt.env.COPILOT_GITHUB_TOKEN,useLoggedInUser:!this.rt.env.COPILOT_GITHUB_TOKEN,logLevel:'none'};}
  async client(){
    if(!this.started)this.started=(async()=>{
      this.value=new this.sdk.CopilotClient(this.clientOptions());
      await this.value.start();return this.value;
    })();return this.started;
  }
  async status(){const x=await(await this.client()).getAuthStatus();return {authenticated:x.isAuthenticated,label:x.login??'',message:x.isAuthenticated?'Credential verified by Copilot':'Copilot sign-in required'};}
  async login(ctx){await this.close();
    // The official CLI login stores its token in the OS keychain, which this isolated
    // runtime (keytar disabled, empty mode) can never read. Run the device flow here
    // and let the manager persist the token as the account's COPILOT_GITHUB_TOKEN.
    const {token,login:user}=await runCopilotDeviceFlow(ctx);
    return {authenticated:true,label:user,credentialSource:'DEVICE_FLOW_TOKEN',githubToken:token};}
  async catalog(){return (await(await this.client()).listModels()).filter(m=>m.policy?.state!=='disabled').map(m=>modelRow(m.id,m.name,{supportsImages:m.capabilities?.supports?.vision??null,reasoningEfforts:m.supportedReasoningEfforts??(m.capabilities?.supports?.reasoningEffort===false?[]:null),defaultReasoningEffort:m.defaultReasoningEffort??null,contextWindow:m.capabilities?.limits?.max_context_window_tokens??null,maxOutputTokens:m.capabilities?.limits?.max_output_tokens??null}));}
  async quota(){
    // The CLI currently caches account.getQuota for its process lifetime. A short
    // read-only client gets a fresh account snapshot without interrupting chats.
    const reader=new this.sdk.CopilotClient(this.clientOptions());
    try {
      await reader.start();
      const auth=await reader.getAuthStatus();
      const quota=await reader.rpc.account.getQuota(this.rt.env.COPILOT_GITHUB_TOKEN?{gitHubToken:this.rt.env.COPILOT_GITHUB_TOKEN}:{});
      // Project only verified identity and the quota pools. Local gh CLI auth can
      // succeed even with an empty account home; make that provenance explicit.
      const login=typeof auth.login==='string'?auth.login.trim():'';
      const identity=auth.isAuthenticated===true&&login?{
        authenticated:true,accountLogin:login,
        credentialSource:this.rt.env.COPILOT_GITHUB_TOKEN?'ACCOUNT_TOKEN':auth.authType==='gh-cli'?'LOCAL_GH':'ACCOUNT_HOME',
      }:{};
      return {quotaSnapshots:quota.quotaSnapshots,...identity};
    }
    finally {await reader.stop();}
  }
  async chat(p,ctx){
    const client=await this.client();const id=randomUUID();
    const session=await client.createSession({sessionId:id,model:p.model,reasoningEffort:p.reasoning_effort,streaming:true,
      tools:p.definitions.map(t=>({name:t.name,description:t.description,parameters:t.parameters,skipPermission:true,defer:'never',handler:async(args,info)=>this.sdk.convertMcpCallToolResult(await nativeToolResult(await ctx.tool(t.name,args,info.toolCallId),ctx.signal))})),
      availableTools:p.definitions.map(t=>`custom:${t.name}`),excludedTools:['builtin:*','mcp:*'],includedBuiltinSkills:[],customAgents:[],mcpServers:{},skillDirectories:[],pluginDirectories:[],instructionDirectories:[],
      enableConfigDiscovery:false,enableSessionStore:false,memory:{enabled:false},infiniteSessions:{enabled:false},enableSessionTelemetry:false,
      workingDirectory:this.rt.cwd,gitHubToken:this.rt.env.COPILOT_GITHUB_TOKEN,systemMessage:{mode:'replace',content:p.system||'Respond to the user. Use only the provided member tools when necessary.'},
      onPermissionRequest:async()=>({kind:'denied-no-approval-rule-and-could-not-request-from-user'}),
    });
    const unsubscribe=session.on(e=>{
      if(e.type==='assistant.message_delta')ctx.text(e.data.deltaContent);
      if(e.type==='assistant.usage')ctx.usage(e.data.inputTokens,e.data.outputTokens);
    });
    const cancel=()=>session.abort().catch(()=>{});ctx.signal.addEventListener('abort',cancel,{once:true});
    try {
      if(ctx.signal.aborted)throw new BridgeError('CANCELLED','Request cancelled');
      await session.sendAndWait({prompt:p.prompt,attachments:p.images.map((i,n)=>({type:'blob',data:i.data,mimeType:i.mimeType,displayName:`image-${n+1}`}))},30*60*1000);
      return {stopReason:'end_turn'};
    } finally {ctx.signal.removeEventListener('abort',cancel);unsubscribe();await session.disconnect();await client.deleteSession(id);}
  }
  async close(){if(this.value)await this.value.stop();this.value=undefined;this.started=undefined;}
}

export class QueryProvider {
  constructor(platform,runtime,sdk){this.platform=platform;this.rt=runtime;this.sdk=sdk;}
  options(ctx,extra={}) {
    const common=/** @satisfies {Partial<import('@qodercn-ai/qodercn-agent-sdk').Options>} */ ({cwd:this.rt.cwd,env:{...this.rt.env},settingSources:[],settings:{},tools:[],allowedTools:[],mcpServers:{},strictMcpConfig:true,plugins:[],skills:[],agents:{},
      includePartialMessages:true,persistSession:false,enableFileCheckpointing:false,permissionMode:'default',abortController:ctx.abortController,stderr:()=>{},
      canUseTool:async()=>({behavior:'deny',message:'Server-side tools are disabled'}),...extra});
    return /** @satisfies {import('@qodercn-ai/qodercn-agent-sdk').Options} */ ({...common,auth:this.rt.env.QODERCN_PERSONAL_ACCESS_TOKEN?this.sdk.accessToken(this.rt.env.QODERCN_PERSONAL_ACCESS_TOKEN):this.sdk.qodercliAuth(),
      // The CN Agent SDK starts its own pinned Worker runtime. It never resolves a
      // qoder/qoderclicn executable from PATH or a developer's global install.
      extensions:[],memory:{},evolution:{skill:{mode:'custom',generation:{enabled:false}}},promptSuggestions:false});
  }
  async control(fn){
    const queue=new AsyncQueue();const abortController=new AbortController();
    const q=this.sdk.query({prompt:queue,options:this.options({abortController})});
    const timer=setTimeout(()=>abortController.abort(),30000);
    try {return await fn(q);} finally {clearTimeout(timer);queue.close();await q.close();}
  }
  async status(){try{return await this.control(async q=>{const a=await q.accountInfo();const authenticated=Boolean(a.email||a.userId||a.subscriptionType||a.tokenSource&&a.tokenSource!=='none');return {authenticated,label:a.email??a.name??a.userId??'',message:authenticated?`${this.platform} account available`:`${this.platform} sign-in required`};});}
  catch(error){if(this.platform==='QODER'&&/transport closed/i.test(String(error?.message??'')))return {authenticated:false,label:'',message:'Qoder CN sign-in required'};throw error;}}
  async login(ctx){await runLogin(this.platform,this.rt,ctx);await this.rt.refreshAuth();delete this.rt.env.QODERCN_PERSONAL_ACCESS_TOKEN;delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;return {...await this.status(),credentialSource:'ACCOUNT_HOME'};}
  async catalog(){return this.control(async q=>{
    const models=this.platform==='QODER'?await q.getAvailableModels({fetchStrategy:'live'}):await q.supportedModels();
    if(this.platform==='QODER'){
      const seen=new Set();
      return models.filter(model=>qoderBuiltIn(model)&&!seen.has(model.value)&&seen.add(model.value)).map(qoderModelRow);
    }
    return models.filter(m=>m.isEnabled!==false).map(m=>modelRow(m.resolvedModel??m.modelId??m.value,m.displayName,{supportsImages:this.platform==='QODER'?(m.isVl??null):null,reasoningEfforts:m.efforts??m.supportedEffortLevels??(m.supportsEffort===false||m.isReasoning===false?[]:null),defaultReasoningEffort:m.defaultEffort??null,contextWindow:m.defaultContextWindow??null,maxOutputTokens:m.maxOutputTokens??null}));
  });}
  async quota(){if(this.platform!=='QODER')return {source:'UNAVAILABLE'};
    return this.control(async q=>{const usage=await q.getUsageInfo();if(!usage)throw new BridgeError('QUOTA_UNAVAILABLE','Qoder account quota is unavailable');return usage;});}
  async chat(p,ctx){
    const queue=new AsyncQueue();const server=memberMcpServer(this.sdk,p.definitions,ctx);
    const allowed=p.definitions.map(t=>`mcp__member__${t.name}`);
    const extra={model:p.model,systemPrompt:p.system||'Respond to the user. Only member tools are available.',mcpServers:{member:server},allowedTools:allowed,
      canUseTool:async(name,input)=>allowed.includes(name)?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Server-side tools are disabled'}};
    if(this.platform==='QODER')extra.resolveModel=()=>({model:p.model,parameters:{
      ...(p.reasoning_effort!=null?{reasoningEffort:p.reasoning_effort}:{}),
      ...(p.context_window!=null?{contextWindow:p.context_window}:{}),
    }});
    const q=this.sdk.query({prompt:queue,options:this.options(ctx,extra)});
    queue.push({type:'user',message:{role:'user',content:[{type:'text',text:p.prompt},...imageBlocks(p.images)]},parent_tool_use_id:null,...(this.platform==='QODER'?{client_composed:true}:{})});
    let deltaSeen=false,stopReason='end_turn';
    try {
      for await(const m of q) {
        if(m.parent_tool_use_id)continue;
        if(m.type==='stream_event'&&m.event?.type==='content_block_delta'&&m.event.delta?.type==='text_delta'){deltaSeen=true;ctx.text(m.event.delta.text);}
        if(m.type==='assistant') {
          if(m.error)throw new BridgeError('UPSTREAM_ERROR',`${this.platform} rejected the request`);
          if(!deltaSeen)for(const c of m.message?.content??[])if(c.type==='text')ctx.text(c.text);
          deltaSeen=false;
        }
        if(m.type==='result') {
          if(m.usage)ctx.usage(m.usage.input_tokens,m.usage.output_tokens,true);
          if(m.is_error)throw new BridgeError('UPSTREAM_ERROR',`${this.platform} runtime failed`);
          stopReason=m.stop_reason??'end_turn';break;
        }
      }
      return {stopReason};
    }finally{queue.close();await q.close();await server.instance.close();}
  }
  async close(){}
}

export async function createProvider(platform,runtime,sdk) {
  if(!imports[platform])throw new BridgeError('INVALID_PLATFORM','Expected CURSOR, COPILOT or QODER');
  sdk??=await imports[platform]();
  if(platform==='CURSOR')return new CursorProvider(runtime,sdk);
  if(platform==='COPILOT')return new CopilotProvider(runtime,sdk);
  return new QueryProvider(platform,runtime,sdk);
}
