import { mkdir, mkdtemp, rm, cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

export class BridgeError extends Error {
  constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
}
export const CREDENTIAL_KEYS = new Set(['CURSOR_API_KEY', 'COPILOT_GITHUB_TOKEN', 'QODERCN_PERSONAL_ACCESS_TOKEN']);
const SYSTEM_KEYS = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i;
export function isolatedEnvironment(source, home) {
  const env = {};
  for (const [k, v] of Object.entries(source)) if (SYSTEM_KEYS.test(k) || CREDENTIAL_KEYS.has(k)) env[k] = v;
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    QODERCN_CONFIG_DIR: path.join(home, '.qoder-cn'),
    NO_OPEN_BROWSER: '1', BROWSER: 'none', CI: '1', NO_COLOR: '1',
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
}
export async function createRuntime(home, inherited = process.env) {
  if (!path.isAbsolute(home)) throw new BridgeError('INVALID_HOME', '--home must be an absolute dedicated account directory');
  const root = path.resolve(home);
  const authHome = path.join(root, 'auth-home');
  const runBase = path.join(root, 'runtime');
  await Promise.all([mkdir(authHome, { recursive: true, mode: 0o700 }), mkdir(runBase, { recursive: true, mode: 0o700 })]);
  const runRoot = await mkdtemp(path.join(runBase, 'bridge-'));
  const cwd = path.join(runRoot, 'workspace');
  const sessionHome = path.join(runRoot, 'home');
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(sessionHome, { mode: 0o700 });
  const authEnv = isolatedEnvironment(inherited, authHome);
  const env = isolatedEnvironment(inherited, sessionHome);
  for (const source of [authEnv,env]) for (const name of ['APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','QODERCN_CONFIG_DIR']) await mkdir(source[name], { recursive: true, mode: 0o700 });
  const refreshAuth = async () => {
    // Source is exclusively this account's official-login directory. Runtime output
    // never writes there. Do not follow imported symlinks or load settings/plugins.
    const excluded = /^(debug|logs?|session-state|sessions?|projects|history\.jsonl|plugins|skills|settings\.json|AGENTS\.md|QODER\.md)$/i;
    await cp(authHome, sessionHome, {recursive:true,force:true,filter:async source=>{
      // Browser profiles created during device login can hold locked cookie databases.
      // They are not SDK credentials and must never be copied into an agent runtime.
      const relative=path.relative(authHome,source).replaceAll('\\','/').toLowerCase();
      if(/^appdata\/local\/microsoft\/(edge|edgewebview)(\/|$)/.test(relative))return false;
      if(excluded.test(path.basename(source)))return false;
      return !(await lstat(source)).isSymbolicLink();
    }});
  };
  try {await refreshAuth();}
  catch(error) {await rm(runRoot,{recursive:true,force:true,maxRetries:3});throw error;}
  return { root, authHome, sessionHome, runRoot, cwd, env, authEnv, refreshAuth,
    async cleanup() {
      // Delete only the freshly created run directory, never the account or credential directory.
      if (path.dirname(runRoot) !== runBase || !path.basename(runRoot).startsWith('bridge-')) throw new Error('Invalid cleanup target');
      await rm(runRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
export function safeSpawn(command, args, { cwd, env, signal } = {}) {
  return spawn(command, args, { cwd, env, signal, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
}
const require = createRequire(import.meta.url);
export function packageRoot(name) {
  try { return path.dirname(require.resolve(`${name}/package.json`)); } catch { /* SDK export maps can hide metadata. */ }
  let dir = path.dirname(require.resolve(name));
  // Known SDK entrypoints can be under dist; resolve package metadata via the entry's ancestor.
  const pieces = name.split('/');
  while (path.basename(dir) !== pieces.at(-1) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}
export class AsyncQueue {
  items = []; waiters = []; ended = false;
  push(value) { if (this.ended) throw new BridgeError('CLOSED', 'Input queue is closed'); const next = this.waiters.shift(); next ? next({value,done:false}) : this.items.push(value); }
  close() { this.ended = true; for (const w of this.waiters.splice(0)) w({done:true}); }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.items.length) return Promise.resolve({value:this.items.shift(),done:false}); if (this.ended) return Promise.resolve({done:true}); return new Promise(resolve=>this.waiters.push(resolve)); }
}
