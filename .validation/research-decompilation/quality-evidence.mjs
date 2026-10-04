import fs from 'node:fs';
import path from 'node:path';
const notes='D:/owl/owl-re-v1/owl-mono/.validation/research-decompilation';
const coverage=JSON.parse(fs.readFileSync(path.join(notes,'quality-coverage.json'),'utf8'));
const root=coverage.inputArtifacts;
const dump=fs.readFileSync(path.join(root,'disasm.txt'),'utf8').split(/\r?\n/);
const code=fs.readFileSync(path.join(root,'reconstructed.js'),'utf8').split(/\r?\n/);
const wanted=['_isLifecycleVersionCurrent','updateTooltip','resolveTargetUpdaterProtocol'];
const safeProperties=new Set(['_getDeviceLifecycleVersion','tray','setToolTip','protocol','protocolVersion','updaterProtocol','updaterProtocolVersion','isDestroyed']);
function sanitize(line){return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,(s)=>{const key=s.slice(1,-1);return safeProperties.has(key)?s:'"[literal redacted]"';});}
const evidence=wanted.map(name=>{
 const fn=coverage.functions.find(fn=>fn.originalName===name);
 const raw=dump.slice(fn.rawStartLine-1,fn.rawEndLine);
 const ops=raw.flatMap((line,i)=>/@\s+\d+\s*:\s*[0-9a-f ]+\s+[A-Z]/.test(line)?[{line:fn.rawStartLine+i,text:line.trim()}]:[]);
 const constants=raw.flatMap((line,i)=>{const m=/^\s*(\d+):.*<String\[\d+\]:\s*#([^>]*)>/.exec(line);return m&&safeProperties.has(m[2])?[{line:fn.rawStartLine+i,index:Number(m[1]),name:m[2]}]:[];});
 return {name,address:fn.address,reconstructedStart:fn.startLine,reconstructedEnd:fn.endLine,rawStart:fn.rawStartLine,rawEnd:fn.rawEndLine,body:code.slice(fn.startLine-1,fn.endLine).map((line,i)=>({line:fn.startLine+i,text:sanitize(line)})),rawOpcodes:ops,selectedPropertyConstants:constants,unresolvedMarkers:fn.incompleteMarkers,verifiedSemantics:false};
});
fs.writeFileSync(path.join(notes,'quality-evidence.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
