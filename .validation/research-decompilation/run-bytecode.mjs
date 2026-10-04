import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBytecodeDecompiler, inspectBytecodeDecompilerAvailability } from '../../packages/coding-agent/src/core/research/bytecode-decompiler.ts';

process.env.OWL_RESEARCH_BYTECODE_HOME = 'D:/owl/owl-re-v1/data/owl/tools/research-decompilers';
const workspace = resolve(import.meta.dirname, '../..');
const availability = await inspectBytecodeDecompilerAvailability();
console.log(JSON.stringify({status:availability.status,reason:availability.reason}));
if (availability.status !== 'available') process.exit(1);
const report = await runBytecodeDecompiler({cwd:'D:/tool/mhub/MCHOSE HUB/resources/app',path:'out/main/index.jsc',outputCwd:workspace,timeoutMs:120000});
await mkdir(import.meta.dirname, {recursive:true});
await writeFile(resolve(import.meta.dirname,'MCHOSE-HUB-bytecode.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,functions:report.functionCount,opcodes:report.opcodeCount,artifacts:report.artifacts,warnings:report.warnings.slice(0,10),errors:report.errors},null,2));
