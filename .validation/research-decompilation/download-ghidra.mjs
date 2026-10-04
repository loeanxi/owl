import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const base = 'D:/owl/owl-re-v1/data/owl/tools/research-decompilers/downloads';
const parts = join(base,'ghidra-parts');
const url = 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip';
const total = 569649598;
const count = 8;
const expected = 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db';
await mkdir(parts,{recursive:true});
const transfers=await Promise.allSettled(Array.from({length:count}, async(_,index)=>{
 const start=Math.floor(total*index/count),end=Math.floor(total*(index+1)/count)-1;
 const path=join(parts,`part-${index}`);
 for(let attempt=0;attempt<25;attempt++){
 let existing=0;try{existing=(await stat(path)).size;}catch{}
 if(existing>end-start+1)throw new Error('Invalid cached part');
 if(existing===end-start+1)return;
 try{
 const response=await fetch(url,{headers:{Range:`bytes=${start+existing}-${end}`,'User-Agent':'OWL-static-analysis'},signal:AbortSignal.timeout(60000)});
 if(response.status!==206||response.headers.get('content-range')!==`bytes ${start+existing}-${end}/${total}`)throw new Error('Unexpected range response');
 let received=existing;
 const stream=Readable.fromWeb(response.body);
 stream.on('data',chunk=>{received+=chunk.length;if(received>end-start+1)stream.destroy(new Error('Part overrun'));});
 await pipeline(stream,createWriteStream(path,{flags:existing?'a':'w'}));
 if(received!==end-start+1)throw new Error('Truncated part');
 console.log(`Part ${index+1}/${count} complete`);
 return;
 }catch(error){console.log(`Part ${index+1} connection retry ${attempt+1}`);if(attempt===24)throw error;}
 }
}));
if(transfers.some(result=>result.status==='rejected'))throw new Error('Ghidra transfer incomplete; verified part cache preserved');
const output=join(base,'ghidra-verified.zip');
const writer=createWriteStream(output);
const hash=createHash('sha256');let bytes=0;
for(let index=0;index<count;index++){
 for await(const chunk of createReadStream(join(parts,`part-${index}`))){hash.update(chunk);bytes+=chunk.length;if(!writer.write(chunk))await new Promise(resolve=>writer.once('drain',resolve));}
}
await new Promise((resolve,reject)=>{writer.once('error',reject);writer.end(resolve);});
if(bytes!==total||hash.digest('hex')!==expected)throw new Error('Official Ghidra archive digest mismatch');
console.log(`Verified official Ghidra archive: ${output}`);
