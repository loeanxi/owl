import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recoverJavascriptSources } from '../../packages/coding-agent/src/core/research/javascript-recovery.ts';
const report = await recoverJavascriptSources({inputRoot:'D:/tool/mhub/MCHOSE HUB/resources/app',outputCwd:resolve(import.meta.dirname,'../..'),names:['out/main/index.js','out/main/bytecode-loader.cjs','out/preload/index.js','out/renderer/tips-assets/tips-8dRZxa9O.js']});
await writeFile(resolve(import.meta.dirname,'MCHOSE-HUB-visible-source.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,normalizer:report.normalizer,output:report.outputDirectory,files:report.files.map(file=>({path:file.path,status:file.normalization,readablePath:file.readablePath,bytes:file.bytes,readableBytes:file.readableBytes,clues:file.clues.length}))},null,2));
