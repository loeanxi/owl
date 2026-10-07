import { createInterface } from 'node:readline';
import { createRuntime } from './runtime.mjs';
import { BridgeProtocol, safeError } from './protocol.mjs';

// Reserve stdout exclusively for protocol frames, including during SDK imports.
const writeProtocol=process.stdout.write.bind(process.stdout);
process.stdout.write=(...args)=>process.stderr.write(...args);
const args=process.argv.slice(2);
const platform=args[args.indexOf('--platform')+1];
const home=args[args.indexOf('--home')+1];
const emit=frame=>writeProtocol(JSON.stringify(frame)+'\n');
let runtime,bridge;
try {
  if(!['CURSOR','COPILOT','QODER'].includes(platform)||!home)throw new Error('Invalid startup arguments');
  runtime=await createRuntime(home);
  // An account worker cannot fall back to a developer's credentials, configs or env secrets.
  for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,runtime.env);
  process.chdir(runtime.cwd);
  const {createProvider}=await import('./providers.mjs');
  bridge=new BridgeProtocol({platform,runtime,providerFactory:()=>createProvider(platform,runtime),emit});
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  const jobs=new Set();
  input.on('line',line=>{
    if(Buffer.byteLength(line)>64*1024*1024){emit({id:null,event:'error',code:'REQUEST_TOO_LARGE',message:'Protocol line exceeds 64 MiB',retryable:false});return;}
    let request;try{request=JSON.parse(line);}catch{emit({id:null,event:'error',code:'INVALID_JSON',message:'Expected a JSON object',retryable:false});return;}
    const job=bridge.dispatch(request).finally(()=>{jobs.delete(job);if(request.method==='shutdown')input.close();});jobs.add(job);
  });
  await new Promise(resolve=>input.once('close',resolve));
  await bridge.close();
  await Promise.race([Promise.allSettled([...jobs]),new Promise(resolve=>{const timer=setTimeout(resolve,5000);timer.unref();})]);
}catch(error){emit({id:null,event:'error',...safeError(error)});process.exitCode=1;}
finally{if(runtime){process.chdir(runtime.root);await runtime.cleanup();}}
