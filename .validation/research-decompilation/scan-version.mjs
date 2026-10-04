import fs from 'node:fs';
const fd = fs.openSync('D:/tool/mhub/MCHOSE HUB/MCHOSE HUB.exe','r');
const buf=Buffer.alloc(4*1024*1024); let offset=0, carry=''; const seen=new Set();
try { for (;;) { const n=fs.readSync(fd,buf,0,buf.length,offset); if(!n) break; const data=carry+buf.subarray(0,n).toString('latin1');
 for(const match of data.matchAll(/(?:Electron\/[0-9]+(?:\.[0-9]+){1,3}|Chrome\/[0-9]+(?:\.[0-9]+){1,3}|\b[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,6}(?:\.[0-9]{1,3})?-electron\.[0-9]+)/g)) { const key=match[0];if(!seen.has(key)){seen.add(key);console.log(JSON.stringify({offset:offset-carry.length+match.index,value:key,context:data.slice(Math.max(0,match.index-32),match.index+key.length+32).replace(/[^\x20-\x7e]/g,'.')}));}}
 carry=data.slice(-160); offset+=n; }
}finally{fs.closeSync(fd);}
