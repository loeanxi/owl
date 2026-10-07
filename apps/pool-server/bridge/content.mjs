import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { BridgeError } from './runtime.mjs';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MEDIA = new Set(['image/png','image/jpeg','image/gif','image/webp']);
function publicAddress(ip) {
  if (isIP(ip) === 6) return !/^(::|fc|fd|fe[89ab]|ff|2001:db8)/i.test(ip) && !ip.includes('.');
  const [a,b] = ip.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) && !(a===192&&b===168) && !(a===100&&b>=64&&b<=127) && a<224;
}
async function remoteImage(raw, signal, redirects = 0) {
  const url = new URL(raw);
  if (url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443')) throw new BridgeError('INVALID_IMAGE', 'Remote images must use a public HTTPS URL on port 443');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await dns.lookup(host,{all:true});
  if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new BridgeError('INVALID_IMAGE','Private network image URLs are not allowed');
  const pinned = addresses[0];
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{signal,timeout:15000,lookup:(_h,opts,cb)=>opts?.all?cb(null,[pinned]):cb(null,pinned.address,pinned.family)},res=>{
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (redirects>=3 || !res.headers.location) return reject(new BridgeError('INVALID_IMAGE','Image redirect limit exceeded'));
        resolve(remoteImage(new URL(res.headers.location,url).href,signal,redirects+1));return;
      }
      const mimeType=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if (res.statusCode!==200 || !MEDIA.has(mimeType)) {res.resume();reject(new BridgeError('INVALID_IMAGE','Image response must be a supported image'));return;}
      const chunks=[];let length=0;
      res.on('data',c=>{length+=c.length;if(length>MAX_IMAGE_BYTES) res.destroy(new BridgeError('IMAGE_TOO_LARGE','Image exceeds 20 MiB'));else chunks.push(c);});
      res.on('error',reject);res.on('end',()=>resolve({data:Buffer.concat(chunks).toString('base64'),mimeType}));
    });
    req.on('timeout',()=>req.destroy(new BridgeError('IMAGE_TIMEOUT','Image download timed out',true)));req.on('error',reject);
  });
}
export async function readImage(url, signal) {
  if (typeof url!=='string') throw new BridgeError('INVALID_IMAGE','image_url.url is required');
  if (!url.startsWith('data:')) return remoteImage(url,signal);
  const m=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!m || m[2].length%4!==0) throw new BridgeError('INVALID_IMAGE','Expected a base64 PNG, JPEG, GIF or WebP data URI');
  if (Buffer.byteLength(m[2],'base64')>MAX_IMAGE_BYTES) throw new BridgeError('IMAGE_TOO_LARGE','Image exceeds 20 MiB');
  return {data:m[2],mimeType:m[1].toLowerCase()};
}
export function validateTools(tools=[]) {
  if (!Array.isArray(tools) || tools.length>128) throw new BridgeError('INVALID_TOOLS','tools must contain at most 128 function definitions');
  const names=new Set();
  return tools.map(t=>{
    const f=t?.function;
    if(t?.type!=='function'||!f||!/^[-_a-zA-Z0-9]{1,64}$/.test(f.name)||names.has(f.name)) throw new BridgeError('INVALID_TOOLS','Each function must have a unique valid name');
    names.add(f.name);
    const parameters=f.parameters??{type:'object',properties:{}};
    if(parameters.type!=='object') throw new BridgeError('INVALID_TOOLS','Function parameters must be a JSON object schema');
    return {name:f.name,description:String(f.description??''),parameters};
  });
}
export async function prepareMessages(messages, signal) {
  if(!Array.isArray(messages)||!messages.length) throw new BridgeError('INVALID_MESSAGES','messages must be a nonempty array');
  const systems=[],history=[],images=[];
  for(const message of messages) {
    if(!['system','developer','user','assistant','tool'].includes(message?.role)) throw new BridgeError('INVALID_MESSAGES','Unsupported message role');
    const parts=typeof message.content==='string'?[{type:'text',text:message.content}]:(message.content??[]);
    if(!Array.isArray(parts)) throw new BridgeError('INVALID_MESSAGES','Message content must be text or content blocks');
    const text=[];
    for(const part of parts) {
      if(part.type==='text') text.push(String(part.text??''));
      else if(part.type==='image_url') { images.push(await readImage(part.image_url?.url,signal));text.push(`[Image attachment ${images.length}]`); }
      else throw new BridgeError('UNSUPPORTED_CONTENT','Only text and image_url content blocks are supported');
    }
    if(message.tool_calls?.length) text.push(JSON.stringify({tool_calls:message.tool_calls}));
    if(message.role==='system'||message.role==='developer') systems.push(text.join('\n'));
    else history.push({role:message.role,...(message.tool_call_id?{tool_call_id:message.tool_call_id}:{}),content:text.join('\n')});
  }
  // These are agent SDKs, whose public send() API accepts a user turn, not arbitrary role history.
  // Preserve supplied history explicitly as transcript context; image bytes remain native attachments.
  const prompt=history.length===1&&history[0].role==='user'?history[0].content:
    `Continue this conversation. The following JSON is the supplied conversation history; role and tool IDs identify its entries. Reply to the most recent user request.\n${JSON.stringify(history)}`;
  return {system:systems.join('\n\n'),prompt,images};
}
export function imageBlocks(images) {return images.map(i=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.data}}));}
export function resultText(content) {return typeof content==='string'?content:JSON.stringify(content??'');}
const TOOL_FAILURE=Symbol('memberToolFailure');
export function toolFailure(content) {return {[TOOL_FAILURE]:true,content};}
/** @returns {Promise<{content:Array<{type:'text',text:string}|{type:'image',data:string,mimeType:string}>,isError?:boolean}>} */
export async function nativeToolResult(result, signal) {
  const isError=Boolean(result?.[TOOL_FAILURE]);const value=isError?result.content:result;
  /** @type {Array<{type:'text',text:string}|{type:'image',data:string,mimeType:string}>} */
  const content=[];
  if(!Array.isArray(value))content.push({type:'text',text:resultText(value)});
  else for(const block of value) {
    if(block?.type==='text')content.push({type:'text',text:String(block.text??'')});
    else if(block?.type==='image_url')content.push({type:'image',...await readImage(block.image_url?.url,signal)});
    else if(block?.type==='image'&&block.source?.type==='base64')content.push({type:'image',...await readImage(`data:${block.source.media_type};base64,${block.source.data}`,signal)});
    else if(block?.type==='image'&&typeof block.data==='string')content.push({type:'image',...await readImage(`data:${block.mimeType};base64,${block.data}`,signal)});
    else content.push({type:'text',text:resultText(block)});
  }
  return {content,...(isError?{isError:true}:{})};
}
