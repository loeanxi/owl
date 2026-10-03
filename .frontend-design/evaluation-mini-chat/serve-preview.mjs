import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/mini-chat-surface.html' : url.pathname)}`);
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(path);
    const type = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json' }[extname(path)] ?? 'text/plain; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(0, '127.0.0.1', async () => {
  const metadata = { port: server.address().port, pid: process.pid, url: `http://127.0.0.1:${server.address().port}/` };
  await writeFile(resolve(root, 'preview-server.json'), JSON.stringify(metadata));
  console.log(metadata.url);
});
