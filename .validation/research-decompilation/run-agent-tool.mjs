import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createResearchDecompileTool } from '../../packages/coding-agent/src/core/research/decompile-tools.ts';
import { normalizeResearchResult } from '../../packages/coding-agent/src/core/research/agent.ts';
const cwd = resolve(import.meta.dirname,'../..');
const path = 'D:/tool/mhub/MCHOSE HUB/MCHOSE HUB.exe';
const tool = createResearchDecompileTool();
const output = await tool.execute('real-MCHOSE-static-decompile',{path,timeoutMs:120000},undefined,undefined,{cwd});
const {id,createdAt,...card}=output.details.researchResult;
normalizeResearchResult(card);
await writeFile(resolve(import.meta.dirname,'MCHOSE-HUB-agent-tool.json'),JSON.stringify(output,null,2));
const report=output.details.researchDecompile;
console.log(JSON.stringify({tool:tool.name,method:report.method,status:report.status,bytecode:report.bytecode.map(item=>({input:item.inputPath,status:item.status,functions:item.functionCount,opcodes:item.opcodeCount,output:item.outputDirectory,errors:item.errors})),javascript:report.javascript?.files.map(item=>({path:item.path,readable:item.readablePath,status:item.normalization})),pending:report.pendingPaths,cardRows:card.rows.length},null,2));
if(report.pendingPaths.length){
 const outputs=[];
 for(let index=0;index<report.pendingPaths.length;index+=8){
  const next=await tool.execute(`real-MCHOSE-remaining-${index}`,{path,names:report.pendingPaths.slice(index,index+8)},undefined,undefined,{cwd});
  outputs.push(next);
 }
 await writeFile(resolve(import.meta.dirname,'MCHOSE-HUB-remaining-source.json'),JSON.stringify(outputs,null,2));
 console.log(`Recovered ${outputs.length} additional scoped source batches`);
}
