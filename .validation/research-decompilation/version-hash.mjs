function hash32(value) {
 let v = BigInt(value); const mask=0xffffffffn;
 v=(~v+(v<<15n))&mask; v^=v>>12n; v=(v+(v<<2n))&mask; v^=v>>4n;
 v=(v*2057n)&mask; v^=v>>16n; return v;
}
function v8VersionHash(parts){let seed=0n;const m=0xc6a4a7935bd1e995n, mask=(1n<<64n)-1n; for(const part of parts){ let h=(hash32(part)*m)&mask; h^=h>>47n;h=(h*m)&mask;seed^=h;seed=(seed*m)&mask;}return Number(seed&0xffffffffn);}
console.log(JSON.stringify({version:'12.6.228.30',hash:'0x'+v8VersionHash([12,6,228,30]).toString(16)}));
