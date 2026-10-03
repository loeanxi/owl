import { createRequire } from 'node:module';
const require = createRequire('D:/owl/owl-re-v1/owl-mono/package.json');
const { WebSocket } = require('ws');
const socket = new WebSocket('ws://127.0.0.1:18901/ws');
let sequence = 0;
const waits = new Map();
const timeout = setTimeout(() => { console.error('Local bridge state query timed out'); socket.terminate(); process.exitCode = 1; }, 7000);
socket.on('message', data => {
  const message = JSON.parse(String(data));
  if (!waits.has(message.id)) return;
  const done = waits.get(message.id); waits.delete(message.id); done(message);
});
socket.on('error', error => { console.error(error.message); clearTimeout(timeout); process.exitCode = 1; });
async function query(request, type = 'evaluation.request') {
  const id = `evaluation-state-${++sequence}`;
  return await new Promise(done => { waits.set(id, done); socket.send(JSON.stringify({ id, type, ...(type === 'evaluation.request' ? { request } : request) })); });
}
socket.on('open', async () => {
  try {
    const sessions = await query({}, 'session.running');
    console.log(JSON.stringify({ activeChatSessions: sessions.result?.running?.length, ok: sessions.ok }));
    const listed = await query({ action: 'run.list' });
    if (!listed.ok) throw new Error(listed.error);
    console.log(JSON.stringify({ runs: listed.result.map(run => ({ name: run.name, status: run.status, pending: run.pending, completed: run.completed, failed: run.failed })) }));
    const run = listed.result.find(run => run.name === '日常比较2') ?? listed.result[0];
    if (run) {
      const got = await query({ action: 'run.get', runId: run.id });
      if (!got.ok) throw new Error(got.error);
      console.log(JSON.stringify({ name: got.result.name, status: got.result.status, results: got.result.results.map(item => ({ label: item.anonymousLabel, sample: item.sample, status: item.status, outputChars: item.output.length, thinkingPresent: Object.hasOwn(item, 'thinking'), thinkingChars: item.thinking?.length, phase: item.generationPhase })) }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(timeout); socket.close(); }
});
