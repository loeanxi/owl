import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const home = 'D:/owl/owl-re-v1/data/owl/tools/research-decompilers';
const cache = join(home, 'downloads');
await mkdir(cache, { recursive: true });
const headers = { 'User-Agent': 'OWL-authorized-static-analysis', Accept: 'application/vnd.github+json' };
const sha256 = data => createHash('sha256').update(data).digest('hex');
async function download(url, path, expected, maxBytes) {
  try { const data = await readFile(path); if (sha256(data) === expected) return; } catch {}
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Download ${response.status}: ${url}`);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) throw new Error('Download exceeds declared cap');
  let bytes = 0; const hash = createHash('sha256');
  const stream = Readable.fromWeb(response.body);
  stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); if (bytes > maxBytes) stream.destroy(new Error('Download cap exceeded')); });
  await pipeline(stream, createWriteStream(path));
  if (hash.digest('hex') !== expected) throw new Error(`Hash mismatch: ${basename(path)}`);
  console.log(`Verified ${basename(path)} (${bytes} bytes)`);
}
const d8Url = 'https://github.com/xqy2006/jsc2js/releases/download/12.6.228.30/d8-12.6.228.30-windows.zip';
const d8Digest = 'b8c87c661ebb561db4363ebf48eb9e92288961d233b947f465e1d0303854a6b4';
await download(d8Url, join(cache, 'd8-12.6.228.30-windows.zip'), d8Digest, 12000000);
const commit = 'd240cec90dd3ea371504c24bb1fb1ea5aad4e81a';
const treeResponse = await fetch(`https://api.github.com/repos/xqy2006/jsc2js/git/trees/${commit}?recursive=1`, { headers });
if (!treeResponse.ok) throw new Error('Pinned source tree unavailable');
const tree = await treeResponse.json();
const files = [];
for (const entry of tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith('View8/') && /(?:\.py|README\.md|LICENSE)$/.test(entry.path))) {
  if (entry.size > 100000) throw new Error('Unexpected large View8 source');
  const response = await fetch(`https://raw.githubusercontent.com/xqy2006/jsc2js/${commit}/${entry.path}`, { headers });
  if (!response.ok) throw new Error(`Missing source: ${entry.path}`);
  const data = Buffer.from(await response.arrayBuffer());
  const blobHash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (blobHash !== entry.sha) throw new Error('Pinned Git blob mismatch');
  const relativePath = entry.path.replace(/^View8\//, 'view8/');
  if (relativePath.includes('..') || relativePath.includes('\\')) throw new Error('Unsafe source path');
  const path = join(home, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  files.push({ path: relativePath, sha256: sha256(data) });
}
const parseMetadata = await (await fetch('https://pypi.org/pypi/parse/1.20.2/json')).json();
const wheel = parseMetadata.urls.find(file => file.filename === 'parse-1.20.2-py2.py3-none-any.whl');
if (!wheel || !wheel.url.startsWith('https://files.pythonhosted.org/')) throw new Error('Pinned parse wheel missing');
await download(wheel.url, join(cache, wheel.filename), wheel.digests.sha256, 200000);
await writeFile(join(home, 'provision-record.json'), JSON.stringify({home,createdAt:new Date().toISOString(),sourceCommit:commit,decoderSourceCommit:'87a35e1e186bd1d86fca6ba500e203a273a6e1bb',releaseUrl:d8Url,releaseArchiveSha256:d8Digest,files,parse: { version:'1.20.2',wheel:wheel.filename,sha256:wheel.digests.sha256 }}, null, 2));
console.log(`Verified ${files.length} pinned View8 source files`);
if (process.argv.includes('--ghidra')) {
  const ghidra = { url: 'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip', sha256:'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db' };
  await download(ghidra.url, join(cache, 'ghidra_12.1.4_PUBLIC_20260921.zip'), ghidra.sha256, 600000000);
}
