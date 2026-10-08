import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { CopilotProvider, CursorProvider } from '../bridge/providers.mjs';

const originalFetch = globalThis.fetch;
const temporaryHomes = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const sessionToken = `header.${Buffer.from(JSON.stringify({ sub: 'user_quota_test' })).toString('base64url')}.signature`;
const cursorUsage = {
  membershipType: 'pro',
  billingCycleStart: '2026-10-01T00:00:00Z',
  billingCycleEnd: '2026-11-01T00:00:00Z',
  individualUsage: {
    plan: { used: 2000, limit: 2000, remaining: 0, breakdown: { included: 2000, bonus: 28933, total: 30933 }, totalPercentUsed: 67 },
    onDemand: { enabled: false, used: 0, limit: null, remaining: null },
  },
};

test('Cursor account session quota identifies its source and preserves upstream pools', async () => {
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://cursor.com/api/usage-summary');
    assert.equal(options.method, undefined);
    assert.match(options.headers.Cookie, /^WorkosCursorSessionToken=user_quota_test%3A%3A/);
    return Response.json(cursorUsage);
  };
  const provider = new CursorProvider({ sessionToken, userHome: 'missing-desktop-home', env: {} }, {});
  const result = await provider.quota();
  assert.equal(result.credentialSource, 'ACCOUNT_SESSION');
  assert.equal(result.source, 'CURSOR_USAGE_SUMMARY');
  assert.deepEqual(result.plan, cursorUsage.individualUsage.plan);
  assert.deepEqual(result.onDemand, cursorUsage.individualUsage.onDemand);
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(result).includes(sessionToken));
});

test('Cursor desktop fallback identifies its source without importing desktop credentials', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'owl-cursor-quota-source-'));
  temporaryHomes.push(home);
  const relative = process.platform === 'win32'
    ? ['AppData', 'Roaming', 'Cursor', 'User', 'globalStorage']
    : process.platform === 'darwin'
      ? ['Library', 'Application Support', 'Cursor', 'User', 'globalStorage']
      : ['.config', 'Cursor', 'User', 'globalStorage'];
  const stateDirectory = path.join(home, ...relative);
  mkdirSync(stateDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(stateDirectory, 'state.vscdb'));
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', sessionToken);
  database.close();
  globalThis.fetch = async url => url.includes('GetUserMeta') ? Response.json({ userId: '123' }) : Response.json(cursorUsage);
  const runtime = { authHome: path.join(home, 'auth-home'), userHome: home, env: {} };
  const sdk = {
    FileCredentialStore: class { async load() { return { apiKey: 'account-sdk-key' }; } },
    Cursor: { me: async () => ({ userId: 123 }) },
  };
  const result = await new CursorProvider(runtime, sdk).quota();
  assert.equal(result.credentialSource, 'LOCAL_DESKTOP');
  assert.equal(result.sdkAuthenticated, true);
  assert.deepEqual(result.plan, cursorUsage.individualUsage.plan);
  assert.equal(runtime.sessionToken, undefined);
  assert.ok(!JSON.stringify(result).includes(sessionToken));
});

function copilotFixture(auth, token) {
  const calls = [];
  const quotaSnapshots = { premium_interactions: { entitlementRequests: 7000, usedRequests: 5180, remainingPercentage: 26 } };
  class Reader {
    constructor(options) { calls.push(['construct', options]); this.rpc = { account: { getQuota: async options => { calls.push(['quota', options]); return { quotaSnapshots }; } } }; }
    async start() { calls.push(['start']); }
    async getAuthStatus() { calls.push(['auth']); return auth; }
    async stop() { calls.push(['stop']); }
  }
  const provider = new CopilotProvider({ sessionHome: 'account-session-home', cwd: 'account-workspace', env: token ? { COPILOT_GITHUB_TOKEN: token } : {} }, { CopilotClient: Reader });
  return { provider, calls, quotaSnapshots };
}

test('Copilot fresh quota identifies the verified local GitHub CLI account without exposing auth data', async () => {
  const fixture = copilotFixture({ isAuthenticated: true, authType: 'gh-cli', login: 'loeanxi', statusMessage: 'private-auth-diagnostic' });
  const result = await fixture.provider.quota();
  assert.deepEqual(result, { quotaSnapshots: fixture.quotaSnapshots, credentialSource: 'LOCAL_GH', accountLogin: 'loeanxi', authenticated: true });
  assert.deepEqual(fixture.calls.slice(1).map(call => call[0]), ['start', 'auth', 'quota', 'stop']);
  assert.equal(fixture.provider.value, undefined);
  assert.equal(fixture.calls[0][1].env.COPILOT_DISABLE_KEYTAR, '1');
  assert.ok(!JSON.stringify(result).includes('private-auth-diagnostic'));
});

test('Copilot explicit account token takes precedence and is never returned with quota metadata', async () => {
  const fixture = copilotFixture({ isAuthenticated: true, authType: 'token', login: 'account-user' }, 'account-private-token');
  const result = await fixture.provider.quota();
  assert.equal(result.credentialSource, 'ACCOUNT_TOKEN');
  assert.equal(result.accountLogin, 'account-user');
  assert.equal(result.authenticated, true);
  assert.deepEqual(fixture.calls.find(call => call[0] === 'quota')[1], { gitHubToken: 'account-private-token' });
  assert.ok(!JSON.stringify(result).includes('account-private-token'));
});

test('Copilot incomplete or rejected authentication does not claim a verified identity', async () => {
  for (const auth of [{ isAuthenticated: false, authType: 'gh-cli', login: 'stale-user' }, { isAuthenticated: true, authType: 'gh-cli' }, { isAuthenticated: true, authType: 'gh-cli', login: '  ' }]) {
    const fixture = copilotFixture(auth);
    const result = await fixture.provider.quota();
    assert.deepEqual(result, { quotaSnapshots: fixture.quotaSnapshots });
    assert.equal(fixture.calls.at(-1)[0], 'stop');
  }
});
