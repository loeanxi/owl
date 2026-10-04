import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const outputRoot=process.argv[2] ?? 'D:/owl/owl-re-v1/owl-mono/.owl/research/decompiled/jsc-oc3xNN';
const notesRoot='D:/owl/owl-re-v1/owl-mono/.validation/research-decompilation';
const sourceRoot='D:/owl/owl-re-v1/data/owl/tools/research-decompilers/view8';
const dump=fs.readFileSync(path.join(outputRoot,'disasm.txt'),'utf8');
const recovered=fs.readFileSync(path.join(outputRoot,'reconstructed.js'),'utf8');
const diagnostics=fs.readFileSync(path.join(outputRoot,'diagnostics.txt'),'utf8');
const canonicalAddress=value=>'0x'+BigInt('0x'+value.replace(/^0x/i,'')).toString(16);
const dumpLines=dump.split(/\r?\n/), recoveredLines=recovered.split(/\r?\n/);
const raw=[]; const stack=[];
for(let i=0;i<dumpLines.length;i++){
 const line=dumpLines[i];
 if(line.trim()==='Start SharedFunctionInfo') stack.push({startLine:i+1,constantStrings:0,opcodes:{},jumpOffsets:[],unknowns:0});
 const active=stack.at(-1); if(!active)continue;
 const address=/^\s*((?:0x)?[a-f0-9]+):\s*\[SharedFunctionInfo\]/i.exec(line); if(address)active.address=canonicalAddress(address[1]);
 const name=/^-\s*name:\s*.*<String\[\d+\]:\s*#([^>]*)>/i.exec(line.trim()); if(name)active.originalName=name[1].trim();
 const opcode=/@\s+(\d+)\s*:\s*[0-9a-f ]+\s+([A-Z][A-Za-z0-9_.]+)(?:\s+(.*))?$/.exec(line);
 if(opcode){ active.opcodes[opcode[2]]=(active.opcodes[opcode[2]]??0)+1; if(/Jump|Switch|Loop/.test(opcode[2]))active.jumpOffsets.push({offset:Number(opcode[1]),opcode:opcode[2],operands:(opcode[3]??'').slice(0,150)}); }
 if(/<String\[/.test(line))active.constantStrings++;
 if(/<unknown>|<Hole>|<Corrupted/.test(line))active.unknowns++;
 if(line.trim()==='End SharedFunctionInfo'){const entry=stack.pop();entry.endLine=i+1;raw.push(entry);}
}
const byAddress=new Map();for(const fn of raw){if(!fn.address)continue; const previous=byAddress.get(fn.address);if(!previous||Object.values(fn.opcodes).reduce((a,b)=>a+b,0)>Object.values(previous.opcodes).reduce((a,b)=>a+b,0))byAddress.set(fn.address,fn);}
const reconstructed=[];
for(let i=0;i<recoveredLines.length;i++){
 const match=/^function (.+)\((.*)\)\s*$/.exec(recoveredLines[i]);if(!match)continue;
 if(reconstructed.length)reconstructed.at(-1).endLine=i;
 const address=/_((?:0x)?[a-f0-9]+)$/i.exec(match[1]);const key=address?canonicalAddress(address[1]):undefined;const rawFn=key?byAddress.get(key):undefined;
 reconstructed.push({name:match[1],address:key,originalName:rawFn?.originalName,startLine:i+1,endLine:recoveredLines.length,rawStartLine:rawFn?.startLine,rawEndLine:rawFn?.endLine,rawOpcodeCount:rawFn?Object.values(rawFn.opcodes).reduce((a,b)=>a+b,0):0,rawUnknownObjects:rawFn?.unknowns??0});
}
for(const fn of reconstructed){
 const lines=recoveredLines.slice(fn.startLine,fn.endLine);fn.bodyLines=lines.filter(line=>line.trim()).length;
 fn.scopeReferences=lines.filter(line=>/Scope\[/.test(line)).length;
 fn.unknownMarkers=lines.filter(line=>/<unknown>|<Hole>|<Corrupted|func_unknown|placeholder|unknown bytecode|unsupported opcode/i.test(line)).length;
 fn.emptyObjectConstructor=lines.filter(line=>/new\s+\{\}/.test(line)).length;
 fn.incompleteMarkers=fn.scopeReferences+fn.unknownMarkers+fn.emptyObjectConstructor;
 fn.reconstructedBranchLines=lines.filter(line=>/^\s*(?:if|for|while|switch|try|catch)\b/.test(line)).length;
 fn.rawBranchInstructions=byAddress.get(fn.address)?.jumpOffsets.length??0;
}
const executableModules=['view8.py','Parser/sfi_file_parser.py','Parser/shared_function_info.py','Translate/translate.py','Translate/translate_table.py','Translate/jump_blocks.py','Simplify/simplify.py','Simplify/function_context_stack.py','parse.py'];
const sourceAudit=executableModules.map(file=>{const code=fs.readFileSync(path.join(sourceRoot,file),'utf8');const lines=code.split(/\r?\n/);return {path:file,bytes:Buffer.byteLength(code),sha256:crypto.createHash('sha256').update(code).digest('hex'),imports:lines.filter(line=>/^(?:from|import)\s/.test(line.trim())),dynamicExecutionCalls:lines.flatMap((line,i)=>/(?<![\w.])(?:eval|exec|__import__)\s*\(|\b(?:subprocess|os\.system|Popen)\b/.test(line)?[{line:i+1,source:line.trim()}]:[]),literalEvalCalls:lines.flatMap((line,i)=>/\bast\.literal_eval\s*\(/.test(line)?[{line:i+1,source:line.trim()}]:[])}});
const translationSource=fs.readFileSync(path.join(sourceRoot,'Translate/translate_table.py'),'utf8');
const supportedOpcodes=new Set(Array.from(translationSource.matchAll(/^\s*["']([A-Z][A-Za-z0-9_. ]+)["']\s*:\s*lambda/gm),match=>match[1]));
const opcodeCounts=[...byAddress.values()].reduce((acc,fn)=>{for(const [op,n]of Object.entries(fn.opcodes))acc[op]=(acc[op]??0)+n;return acc;},{});
const unsupportedOpcodeCounts=Object.fromEntries(Object.entries(opcodeCounts).filter(([name])=>!supportedOpcodes.has(name)));
const droppedOpcodeCounts=Object.fromEntries(Object.entries(opcodeCounts).filter(([name])=>['Throw','ReThrow','ThrowSuperNotCalledIfHole','ThrowSuperAlreadyCalledIfNotHole','ThrowIfNotSuperConstructor','ThrowSymbolIteratorInvalid','ThrowReferenceErrorIfHole','SuspendGenerator','ResumeGenerator','SetPendingMessage','SwitchOnGeneratorState','ForInPrepare'].includes(name)));
const quality={
 generatedAt:new Date().toISOString(),inputArtifacts:outputRoot,
 labels:{disassembly:'V8 Ignition 反汇编证据',reconstruction:'近似反编译伪代码（不可直接执行）',sourceRecovery:'不构成原始源码或语义等价证明'},
 raw:{sfiBlocks:raw.length,uniqueFunctions:byAddress.size,opcodeLines:Object.values(opcodeCounts).reduce((a,b)=>a+b,0),unclosedBlocks:stack.length,unknownObjectMetadataLines:[...byAddress.values()].reduce((a,b)=>a+b.unknowns,0),opcodeCounts,unsupportedOpcodeCounts,droppedOpcodeCounts,unknownOpcodeCount:Object.values(unsupportedOpcodeCounts).reduce((a,b)=>a+b,0),droppedOpcodeCount:Object.values(droppedOpcodeCounts).reduce((a,b)=>a+b,0)},
 reconstructed:{functions:reconstructed.length,functionsMatchedRaw:reconstructed.filter(fn=>fn.rawStartLine).length,totalBodyLines:reconstructed.reduce((a,b)=>a+b.bodyLines,0),withScope:reconstructed.filter(fn=>fn.scopeReferences).length,withUnknown:reconstructed.filter(fn=>fn.unknownMarkers).length,withEmptyConstructor:reconstructed.filter(fn=>fn.emptyObjectConstructor).length,withAnyIncomplete:reconstructed.filter(fn=>fn.incompleteMarkers).length,withBranches:reconstructed.filter(fn=>fn.reconstructedBranchLines).length},
 sourceAudit,
 diagnostics:{bytes:Buffer.byteLength(diagnostics),hasWarnings:/warning|error|failed|stopped after/i.test(diagnostics)},
 functions:reconstructed,
 rawFunctions:[...byAddress.values()].map(({constantStrings,...fn})=>({...fn,constantStrings})),
};
fs.writeFileSync(path.join(notesRoot,'quality-coverage.json'),JSON.stringify(quality,null,2));
console.log(JSON.stringify({raw:quality.raw,reconstructed:quality.reconstructed,sourceAudit:sourceAudit.map(({path,dynamicExecutionCalls,literalEvalCalls})=>({path,dynamicExecutionCalls,literalEvalCalls})),namedCandidates:reconstructed.filter(fn=>fn.originalName&&!/^\(|^anonymous/.test(fn.originalName)).sort((a,b)=>a.rawOpcodeCount-b.rawOpcodeCount).filter(fn=>/Version|version|Device|device|update|Update|init|Init|connect|Connect/i.test(fn.originalName)).slice(0,35)},null,2));
