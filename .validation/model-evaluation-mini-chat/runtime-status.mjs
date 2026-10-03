import { createRequire } from 'node:module';
const require = createRequire('D:/owl/owl-re-v1/owl-mono/package.json');
const { WebSocket } = require('ws');
const socket = new WebSocket('ws://127.0.0.1:18901/ws');
const waits = new Map(); let sequence = 0;
const timer = setTimeout(() => { socket.terminate(); console.error('Bridge status timed out'); process.exitCode = 1; }, 8000);
socket.on('message', bytes => { const value = JSON.parse(String(bytes)); const waiter = waits.get(value.id); if (!waiter) return; waits.delete(value.id); waiter(value); });
socket.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
function query(type, fields) { const id = `mini-chat-status-${++sequence}`; return new Promise(done => { waits.set(id,done); socket.send(JSON.stringify({id,type,...fields})); }); }
socket.on('open', async () => {
 try {
  const sessions = await query('session.running', {}); if (!sessions.ok) throw new Error(sessions.error);
  const response = await query('evaluation.request', {request:{action:'run.list'}}); if (!response.ok) throw new Error(response.error);
  const status = { activeChats:sessions.result.running.length, originalPending:0, followupPending:0, conversationContract:false, runs:[] };
  for (const summary of response.result) {
   const read = await query('evaluation.request',{request:{action:'run.get',runId:summary.id}}); if (!read.ok) throw new Error(read.error);
   const pending = read.result.results.flatMap(result => result.followups ?? []).filter(turn => turn.status === 'running' || turn.status === 'queued').length;
   status.originalPending += summary.pending; status.followupPending += pending;
   status.conversationContract ||= read.result.results.some(result => Array.isArray(result.followups));
   status.runs.push({name:summary.name,status:summary.status,completed:summary.completed,pending:summary.pending,followupPending:pending});
  }
  console.log(JSON.stringify(status));
  if(process.argv.includes('--require-idle')&&(status.activeChats||status.originalPending||status.followupPending))process.exitCode=3;
 } catch(error) { console.error(error.message); process.exitCode=1; }
 finally { clearTimeout(timer); socket.close(); }
});
