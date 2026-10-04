import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runNativeDecompiler, inspectNativeDecompilerAvailability } from '../../packages/coding-agent/src/core/research/native-decompiler.ts';
const cwd = resolve(import.meta.dirname,'../..');
const fixture = resolve(import.meta.dirname,'native-fixture');
await mkdir(fixture,{recursive:true});
const bytes=Buffer.alloc(0x400);
bytes.writeUInt16LE(0x5a4d,0);bytes.writeUInt32LE(0x80,0x3c);bytes.writeUInt32LE(0x4550,0x80);
bytes.writeUInt16LE(0x8664,0x84);bytes.writeUInt16LE(1,0x86);bytes.writeUInt16LE(240,0x94);bytes.writeUInt16LE(0x22,0x96);
const optional=0x98;bytes.writeUInt16LE(0x20b,optional);bytes.writeUInt32LE(0x200,optional+4);bytes.writeUInt32LE(0x1000,optional+16);bytes.writeUInt32LE(0x1000,optional+20);bytes.writeBigUInt64LE(0x140000000n,optional+24);bytes.writeUInt32LE(0x1000,optional+32);bytes.writeUInt32LE(0x200,optional+36);bytes.writeUInt32LE(0x2000,optional+56);bytes.writeUInt32LE(0x200,optional+60);bytes.writeUInt16LE(3,optional+68);bytes.writeUInt32LE(16,optional+108);
const section=optional+240;bytes.write('.text',section,'ascii');bytes.writeUInt32LE(0x200,section+8);bytes.writeUInt32LE(0x1000,section+12);bytes.writeUInt32LE(0x200,section+16);bytes.writeUInt32LE(0x200,section+20);bytes.writeUInt32LE(0x60000020,section+36);
// Known benign x64 machine instructions: MOV EAX,7; RET. This fixture is never executed.
Buffer.from([0xb8,7,0,0,0,0xc3]).copy(bytes,0x200);
await writeFile(resolve(fixture,'return-seven.exe'),bytes);
const inventory=await inspectNativeDecompilerAvailability();console.log(JSON.stringify(inventory));
const report=await runNativeDecompiler({cwd:fixture,path:'return-seven.exe',outputCwd:cwd,maxFunctions:4,maxStrings:8,maxCrossReferences:8,timeoutMs:120000});
await writeFile(resolve(import.meta.dirname,'native-golden-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,message:report.message,functions:report.functions,artifacts:report.artifacts,originalUnchanged:report.originalUnchanged},null,2));
