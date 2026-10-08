import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { CursorProvider } from '../bridge/providers.mjs';

const originalFetch = globalThis.fetch;
const temporaryHomes = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const sessionToken = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|user_session_fixture' })).toString('base64url')}.signature`;
const usage = { individualUsage: { plan: { remaining: 0, totalPercentUsed: 67, autoPercentUsed: 68, apiPercentUsed: 0 }, onDemand: { enabled: false } } };

function fixture({ storedKey = 'account-sdk-key', explicitKey, user = { userId: 101, userEmail: 'owner@example.invalid' }, expired = false, session, desktop = false } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'owl-cursor-account-source-'));
  temporaryHomes.push(home);
  const authCalls = [];
  const runtime = { authHome: path.join(home, 'auth-home'), userHome: home, env: explicitKey ? { CURSOR_API_KEY: explicitKey } : {}, ...(session ? { sessionToken: session } : {}) };
  const sdk = {
    FileCredentialStore: class {
      constructor(file) { authCalls.push(['store', file]); }
      async load() { return storedKey ? { version: 1, apiKey: storedKey, backendUrl: 'https://api.cursor.com', createdAtMs: 0, ...(expired ? { apiKeyExpiresAtMs: 1 } : {}) } : undefined; }
    },
    Cursor: {
      auth: { status: async () => ({ status: 'logged-in', email: 'unverified-cached-email@example.invalid' }) },
      me: async options => { authCalls.push(['me', options]); return user; },
    },
  };
  if (desktop) {
    const relative = process.platform === 'win32'
      ? ['AppData', 'Roaming', 'Cursor', 'User', 'globalStorage']
      : process.platform === 'darwin'
        ? ['Library', 'Application Support', 'Cursor', 'User', 'globalStorage']
        : ['.config', 'Cursor', 'User', 'globalStorage'];
    const directory = path.join(home, ...relative);
    mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, 'state.vscdb'));
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    insert.run('cursorAuth/accessToken', sessionToken);
    insert.run('cursorAuth/cachedEmail', 'owner@example.invalid');
    db.close();
  }
  return { runtime, sdk, authCalls, provider: new CursorProvider(runtime, sdk) };
}

test('status validates the account SDK file key rather than trusting cached local login status', async () => {
  const current = fixture();
  const status = await current.provider.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.sdkAuthenticated, true);
  assert.equal(status.credentialSource, 'ACCOUNT_HOME');
  assert.deepEqual(current.authCalls.find(call => call[0] === 'me')[1], { apiKey: 'account-sdk-key' });
  assert.equal(current.authCalls[0][1], path.join(current.runtime.authHome, '.cursor', 'sdk', 'auth.json'));
  assert.ok(!JSON.stringify(status).includes('account-sdk-key'));
});

test('explicit SDK account key wins over a different stored key', async () => {
  const current = fixture({ explicitKey: 'explicit-key' });
  const status = await current.provider.status();
  assert.equal(status.sdkAuthenticated, true);
  assert.equal(status.credentialSource, 'ACCOUNT_TOKEN');
  assert.deepEqual(current.authCalls.find(call => call[0] === 'me')[1], { apiKey: 'explicit-key' });
});

test('expired SDK file credentials do not authenticate the model using desktop credentials', async () => {
  const current = fixture({ expired: true, desktop: true });
  assert.equal((await current.provider.status()).authenticated, false);
  assert.equal(current.authCalls.filter(call => call[0] === 'me').length, 0);
});

test('upstream SDK key rejection is not authenticated by local cached login or desktop session', async () => {
  const current = fixture({ desktop: true });
  const rejection = new Error('SDK key rejected');
  current.sdk.Cursor.me = async () => { throw rejection; };
  globalThis.fetch = async () => { throw new Error('Desktop network must not be queried'); };
  await assert.rejects(current.provider.status(), error => error === rejection);
  const quota = await current.provider.quota();
  assert.equal(quota.sdkAuthenticated, false);
  assert.equal(quota.quotaReason, 'SDK_AUTH_REQUIRED');
});

test('SDK identity and desktop session identity must match even when cached desktop email matches', async () => {
  const current = fixture({ desktop: true });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return url.includes('GetUserMeta') ? Response.json({ userId: '202', email: 'other@example.invalid' }) : Response.json(usage);
  };
  const quota = await current.provider.quota();
  assert.equal(quota.source, 'CURSOR_DASHBOARD_ONLY');
  assert.equal(quota.quotaReason, 'ACCOUNT_MISMATCH');
  assert.equal(quota.sdkAuthenticated, true);
  assert.equal(quota.plan, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'https://api2.cursor.sh/aiserver.v1.AuthService/GetUserMeta');
  assert.equal(requests[0][1].method, 'POST');
  assert.equal(requests[0][1].body, '{}');
  assert.equal(requests[0][1].headers.Authorization, `Bearer ${sessionToken}`);
  assert.ok(!JSON.stringify(quota).includes('owner@example.invalid'));
});

test('verified numeric user ID match permits desktop quota and preserves upstream pool percentages', async () => {
  const current = fixture({ desktop: true });
  globalThis.fetch = async url => url.includes('GetUserMeta')
    ? Response.json({ userId: '101', email: 'changed-address@example.invalid' })
    : Response.json(usage);
  const quota = await current.provider.quota();
  assert.equal(quota.source, 'CURSOR_USAGE_SUMMARY');
  assert.equal(quota.credentialSource, 'LOCAL_DESKTOP');
  assert.equal(quota.sdkAuthenticated, true);
  assert.deepEqual(quota.plan, usage.individualUsage.plan);
});

test('normalized verified email can match when comparable numeric IDs are unavailable', async () => {
  const current = fixture({ desktop: true, user: { userEmail: ' Owner@Example.Invalid ' } });
  globalThis.fetch = async url => url.includes('GetUserMeta')
    ? Response.json({ email: 'owner@example.invalid' })
    : Response.json(usage);
  assert.equal((await current.provider.quota()).source, 'CURSOR_USAGE_SUMMARY');
});

test('desktop web session rejection leaves the verified account SDK authentication intact', async () => {
  for (const failedStage of ['identity', 'usage']) {
    const current = fixture({ desktop: true });
    globalThis.fetch = async url => {
      if (url.includes('GetUserMeta')) return failedStage === 'identity' ? Response.json({}, { status: 401 }) : Response.json({ userId: '101' });
      return Response.json({}, { status: 401 });
    };
    const quota = await current.provider.quota();
    assert.equal(quota.source, 'CURSOR_DASHBOARD_ONLY');
    assert.equal(quota.quotaReason, 'SESSION_REQUIRED');
    assert.equal(quota.sdkAuthenticated, true);
    assert.equal((await current.provider.status()).sdkAuthenticated, true);
  }
});

test('an account without SDK identity cannot borrow desktop balance or desktop model authentication', async () => {
  const current = fixture({ storedKey: null, desktop: true });
  globalThis.fetch = async () => { throw new Error('Desktop network must not be queried'); };
  const quota = await current.provider.quota();
  assert.equal(quota.source, 'CURSOR_DASHBOARD_ONLY');
  assert.equal(quota.sdkAuthenticated, false);
  assert.equal(quota.quotaReason, 'SDK_AUTH_REQUIRED');
  assert.equal((await current.provider.status()).authenticated, false);
});

test('an explicitly bound account session can query quota without authenticating the SDK model', async () => {
  const current = fixture({ storedKey: null, session: sessionToken });
  globalThis.fetch = async () => Response.json(usage);
  const quota = await current.provider.quota();
  assert.equal(quota.source, 'CURSOR_USAGE_SUMMARY');
  assert.equal(quota.credentialSource, 'ACCOUNT_SESSION');
  assert.equal(quota.sdkAuthenticated, false);
  assert.equal((await current.provider.status()).authenticated, false);
});

test('JWT, complete session cookie value, and named cookie normalize once without copying unrelated cookies', async () => {
  for (const session of [sessionToken, `user_session_fixture%3A%3A${sessionToken}`, `WorkosCursorSessionToken=user_session_fixture%3A%3A${sessionToken}; unrelated=private`]) {
    const current = fixture({ storedKey: null, session });
    let cookie;
    globalThis.fetch = async (_url, options) => { cookie = options.headers.Cookie; return Response.json(usage); };
    const quota = await current.provider.quota();
    assert.equal(quota.source, 'CURSOR_USAGE_SUMMARY');
    assert.equal(cookie, `WorkosCursorSessionToken=user_session_fixture%3A%3A${sessionToken}`);
    assert.ok(!JSON.stringify(quota).includes(sessionToken));
  }
});

test('inconsistent session-cookie user prefix produces a controlled error without leaking its value', async () => {
  const current = fixture({ storedKey: null, session: `user_other%3A%3A${sessionToken}` });
  globalThis.fetch = async (_url, options) => {
    assert.fail(`A malformed cookie must fail before network dispatch: ${Boolean(options.headers.Cookie)}`);
  };
  const quota = await current.provider.quota();
  assert.equal(quota.source, 'CURSOR_DASHBOARD_ONLY');
  assert.equal(quota.quotaReason, 'SESSION_INVALID');
  assert.equal(quota.sdkAuthenticated, false);
  assert.ok(!JSON.stringify(quota).includes(sessionToken));
});
