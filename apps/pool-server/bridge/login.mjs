import path from 'node:path';
import { BridgeError, packageRoot, safeSpawn } from './runtime.mjs';

export function loginCommand(platform) {
  if(platform==='QODER') return [process.execPath,[path.join(packageRoot('@qodercn-ai/qoderclicn'),'bundle/qoderclicn.js'),'login']];
  throw new BridgeError('UNSUPPORTED_LOGIN','Unsupported CLI login platform');
}
export function parseAuthOutput(text) {
  const clean=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const urls=[...clean.matchAll(/https:\/\/[^\s<>"\x1b]+/g)].map(m=>m[0].replace(/[),.;]+$/,''));
  const userCode=clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  return {urls,userCode};
}
export async function runLogin(platform, runtime, ctx) {
  const [command,args]=loginCommand(platform);
  const env={...runtime.authEnv,COPILOT_HOME:path.join(runtime.authHome,'.copilot'),COPILOT_DISABLE_KEYTAR:'1'};
  // Ensure a requested new authorization does not silently reuse an injected token.
  for(const k of ['COPILOT_GITHUB_TOKEN','QODERCN_PERSONAL_ACCESS_TOKEN']) delete env[k];
  const child=safeSpawn(command,args,{cwd:runtime.cwd,env,signal:ctx.signal});
  ctx.setLoginInput?.(text=>child.stdin.write(text+'\n'));
  let output='';const seen=new Set();
  const onData=chunk=>{
    output=(output+chunk.toString()).slice(-65536);
    const {urls,userCode}=parseAuthOutput(output);
    for(const url of urls) {
      // Only official authorization destinations, never arbitrary diagnostic URLs.
      const host=new URL(url).hostname;
      const allowed=platform==='COPILOT'?/^(github\.com|[^.]+\.ghe\.com)$/.test(host):/(^|\.)(qoder\.cn|qoder\.com\.cn|aliyun\.com|alibabacloud\.com)$/.test(host);
      const key=`${url}|${userCode??''}`;
      if(allowed&&!seen.has(key)){seen.add(key);ctx.emit({event:'auth_url',url,...(userCode?{userCode}:{})});}
    }
  };
  child.stdout.on('data',onData);child.stderr.on('data',onData);
  const timer=setTimeout(()=>child.kill(),5*60*1000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    if(code!==0) throw new BridgeError('LOGIN_FAILED','Official authorization did not complete; retry login or import an account credential');
  } finally {clearTimeout(timer);child.stdin.destroy();ctx.setLoginInput?.(undefined);output='';}
}

// Copilot's OAuth device flow runs in the bridge itself instead of the official CLI:
// the CLI persists its token in the OS keychain (it has no COPILOT_DISABLE_KEYTAR
// support and no file fallback while the system store exists), which the isolated
// per-account runtime can never read. The bridge performs the same grant and hands
// the token to the manager, which saves it as the account's COPILOT_GITHUB_TOKEN.
// Client id and scope mirror the official Copilot CLI runtime.
export const COPILOT_DEVICE_FLOW={
  clientId:'Ov23ctDVkRmgkPke0Mmm', scope:'read:user,read:org,repo,gist,codespace',
  deviceCodeUrl:'https://github.com/login/device/code', tokenUrl:'https://github.com/login/oauth/access_token',
  userUrl:'https://api.github.com/copilot_internal/user',
  // The manager cancels still-pending logins after 10 minutes; stop before that.
  maxPollSeconds:540,
};

function proxyBypassed(host){
  const list=(process.env.NO_PROXY??process.env.no_proxy??'').split(',').map(item=>item.trim().toLowerCase()).filter(Boolean);
  return list.some(entry=>entry==='*'||host===entry.replace(/^\./,'')||host.endsWith(entry.startsWith('.')?entry:'.'+entry));
}

/** Fetch that honors HTTP(S)_PROXY/NO_PROXY for just this request, leaving the default global dispatcher untouched. */
export async function deviceFlowFetch(url,options={}){
  const proxy=[process.env.HTTPS_PROXY,process.env.https_proxy,process.env.HTTP_PROXY,process.env.http_proxy].find(value=>value&&value.trim());
  if(!proxy||proxyBypassed(new URL(url).hostname))return fetch(url,options);
  const {fetch:undiciFetch,ProxyAgent}=await import('undici');
  return undiciFetch(url,{...options,dispatcher:new ProxyAgent(proxy.trim())});
}

function sleep(millis,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new BridgeError('CANCELLED','授权已取消'));
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},millis);
    const onAbort=()=>{clearTimeout(timer);reject(new BridgeError('CANCELLED','授权已取消'));};
    signal?.addEventListener('abort',onAbort,{once:true});
  });
}

async function parseJsonResponse(response,fallback){
  const text=await response.text();
  try{return JSON.parse(text);}catch{throw new BridgeError('UPSTREAM_UNAVAILABLE',`${fallback}（HTTP ${response.status}）`,true);}
}

async function validateCopilotToken(token,doFetch){
  let response;
  try{response=await doFetch(COPILOT_DEVICE_FLOW.userUrl,{headers:{Accept:'application/json',Authorization:`Bearer ${token}`,'User-Agent':'manager-account-bridge'}});}
  catch{throw new BridgeError('UPSTREAM_UNAVAILABLE','验证 Copilot 授权失败：无法访问 GitHub API',true);}
  if(response.status===401||response.status===403)throw new BridgeError('AUTH_REQUIRED','该 GitHub 账号没有可用的 Copilot 订阅或授权不足');
  if(!response.ok)throw new BridgeError('UPSTREAM_UNAVAILABLE',`验证 Copilot 授权失败（HTTP ${response.status}）`,true);
  const user=await parseJsonResponse(response,'验证 Copilot 授权失败');
  return {token,login:String(user.login??'')};
}

/** Runs one GitHub OAuth device-code grant and resolves with {token, login} once the user approves. */
export async function runCopilotDeviceFlow(ctx,deps={}){
  const doFetch=deps.fetch??deviceFlowFetch;
  const doSleep=deps.sleep??sleep;
  const headers={Accept:'application/json','Content-Type':'application/x-www-form-urlencoded','User-Agent':'manager-account-bridge'};
  let start;
  try{start=await parseJsonResponse(await doFetch(COPILOT_DEVICE_FLOW.deviceCodeUrl,{method:'POST',headers,
    body:new URLSearchParams({client_id:COPILOT_DEVICE_FLOW.clientId,scope:COPILOT_DEVICE_FLOW.scope})}),'发起设备码授权失败');}
  catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError('UPSTREAM_UNAVAILABLE','发起设备码授权失败：无法访问 GitHub',true);}
  if(typeof start.device_code!=='string'||typeof start.user_code!=='string'||typeof start.verification_uri!=='string')
    throw new BridgeError('LOGIN_FAILED','GitHub 设备码响应无效，请重新发起授权');
  const expiresSeconds=Number(start.expires_in)>0?Number(start.expires_in):900;
  const deadline=Date.now()+Math.min(expiresSeconds,COPILOT_DEVICE_FLOW.maxPollSeconds)*1000;
  ctx.emit({event:'auth_url',url:start.verification_uri,userCode:start.user_code});
  let interval=Number(start.interval)>0?Number(start.interval):5;
  while(true){
    if(Date.now()>=deadline)throw new BridgeError('LOGIN_FAILED','设备码已过期，请重新发起授权');
    await doSleep(interval*1000,ctx.signal);
    let poll;
    try{poll=await parseJsonResponse(await doFetch(COPILOT_DEVICE_FLOW.tokenUrl,{method:'POST',headers,
      body:new URLSearchParams({client_id:COPILOT_DEVICE_FLOW.clientId,device_code:start.device_code,
        grant_type:'urn:ietf:params:oauth:grant-type:device_code'})}),'校验设备码失败');}
    catch(error){if(error instanceof BridgeError&&error.code==='UPSTREAM_UNAVAILABLE')throw error;
      if(error instanceof BridgeError)throw error;throw new BridgeError('UPSTREAM_UNAVAILABLE','校验设备码失败：无法访问 GitHub',true);}
    if(typeof poll.access_token==='string'&&poll.access_token)return validateCopilotToken(poll.access_token,doFetch);
    switch(poll.error){
      case 'authorization_pending':break;
      case 'slow_down':interval+=5;break;
      case 'expired_token':throw new BridgeError('LOGIN_FAILED','设备码已过期，请重新发起授权');
      default:throw new BridgeError('LOGIN_FAILED',poll.error?`GitHub 授权失败：${poll.error}`:'GitHub 授权响应无效，请重新发起授权');
    }
  }
}
