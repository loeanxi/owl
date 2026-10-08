import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { InMemoryAccountStore } from "owl-pool";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ClaudeOauthLogin } from "../src/account/claude-oauth.ts";
import { AccountLoginService } from "../src/account/login.ts";
import { SdkBridgeManager } from "../src/gateway/sdk-bridge.ts";

const directories: string[] = [];
const managers: SdkBridgeManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
});
afterAll(async () => {
	// Runtime clients stop their workers asynchronously before removing workspaces.
	await new Promise((done) => setTimeout(done, 1100));
	for (const directory of directories) {
		if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error("Invalid fixture directory");
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture(credentials: Record<string, unknown> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "owl-account-login-"));
	directories.push(directory);
	const script = join(directory, "fake-bridge.mjs");
	writeFileSync(
		script,
		`import { createInterface } from "node:readline";
let loginRequests = 0;
let loginRequest;
let pendingStatusId;
let status = { authenticated: false, sdkAuthenticated: false };
const send = (id, event, extra = {}) => process.stdout.write(JSON.stringify({ id, event, ...extra }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send(id, "result", { data: { initialized: true } });
  if (method === "login") { loginRequests++; loginRequest = id; send(id, "auth_url", { url: "https://cursor.com/loginDeepControl?challenge=fixture-only" }); }
  if (method === "auth_status") {
    if (status.throwError) send(id, "error", { code: "UPSTREAM_UNAVAILABLE" });
    else if (status.defer) pendingStatusId = id;
    else send(id, "result", { data: status });
  }
  if (method === "test_status") { status = params; send(id, "result", { data: {} }); }
  if (method === "test_complete") {
    send(loginRequest, "result", { data: params });
    send(id, "result", { data: { loginRequests } });
  }
  if (method === "test_count") send(id, "result", { data: { loginRequests } });
  if (method === "test_pending_status") send(id, "result", { data: { pendingStatus: Boolean(pendingStatusId) } });
  if (method === "test_release_status") { send(pendingStatusId, "result", { data: status }); send(id, "result", { data: {} }); }
  if (method === "cancel") send(id, "result", { data: { cancelled: true } });
});`,
		"utf8",
	);
	const accounts = new InMemoryAccountStore();
	const created = accounts.create({ name: "Cursor fixture", platform: "CURSOR", credentials }, 0);
	const account = accounts.patchState(created.id, {
		credentialStatus: "ERROR",
		credentialMessage: "账号没有凭证",
		credentialCheckedAt: 1,
		credentialExpiresAt: 1,
	});
	const manager = new SdkBridgeManager(
		{
			nodeExecutable: process.execPath,
			script,
			homeRoot: join(directory, "accounts"),
			requestTimeoutMs: 2000,
			idleRecycleMs: 60_000,
			userHome: directory,
		},
		accounts,
	);
	managers.push(manager);
	const claude = new ClaudeOauthLogin(accounts, {
		clientId: "fixture-only",
		tokenUrl: "https://unused.invalid/token",
		authorizeUrl: "https://unused.invalid/authorize",
		redirectUri: "https://unused.invalid/callback",
		scopes: "fixture-only",
	});
	return { accounts, account, manager, service: new AccountLoginService(accounts, manager, claude) };
}

describe("SDK account login persistence", () => {
	it("persists account-home authorization and clears stale credential errors without storing returned secrets", async () => {
		const { accounts, account, manager, service } = fixture({ note: "keep existing fields" });
		const client = await manager.clientFor(account);
		await service.login(account);
		await client.request(
			"test_complete",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME", apiKey: "never-persist" },
			2000,
		);
		expect(accounts.require(account.id)).toMatchObject({
			credentials: { note: "keep existing fields", authSource: "ACCOUNT_HOME" },
			credentialStatus: "OK",
			credentialExpiresAt: null,
		});
		expect(accounts.require(account.id).credentialCheckedAt).toBeGreaterThan(1);
		expect(accounts.require(account.id).credentials).not.toHaveProperty("apiKey");
	});

	it("recovers a stale error from the account's independently verified SDK credentials", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request(
			"test_status",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" },
			2000,
		);
		expect(await service.status(account)).toMatchObject({ authenticated: true, login: { status: "COMPLETED" } });
		expect(accounts.require(account.id)).toMatchObject({
			credentials: {},
			credentialStatus: "OK",
			credentialExpiresAt: null,
		});
		expect(await manager.clientFor(accounts.require(account.id))).toBe(client);
	});

	it("does not restore SDK health from another local desktop quota identity", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request(
			"test_status",
			{ authenticated: true, sdkAuthenticated: false, credentialSource: "LOCAL_DESKTOP" },
			2000,
		);
		expect(await service.status(account)).toMatchObject({ authenticated: false, login: { status: "FAILED" } });
		expect(accounts.require(account.id).credentialStatus).toBe("ERROR");
		expect(accounts.require(account.id).credentials).toEqual({});
	});

	it("keeps previous health when an SDK status network request fails", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request("test_status", { throwError: true }, 2000);
		await expect(service.status(account)).rejects.toMatchObject({ code: "upstream_unavailable" });
		expect(accounts.require(account.id).credentialStatus).toBe("ERROR");
		expect(accounts.require(account.id).credentialCheckedAt).toBe(1);
	});

	it("does not let a late login result overwrite credentials edited during authorization", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await service.login(account);
		accounts.updateFields(account.id, { credentials: { sessionToken: "new-fixture-credential" } }, Date.now());
		await client.request(
			"test_complete",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" },
			2000,
		);
		expect(accounts.require(account.id).credentials).toEqual({ sessionToken: "new-fixture-credential" });
		expect(accounts.require(account.id).credentialStatus).toBe("ERROR");
		expect(await service.status(accounts.require(account.id))).toMatchObject({
			authenticated: false,
			login: { status: "CANCELLED" },
		});
	});

	it("ignores a successful login result arriving after cancellation", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await service.login(account);
		await service.cancel(account, null);
		await client.request(
			"test_complete",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" },
			2000,
		);
		expect(accounts.require(account.id).credentialStatus).toBe("ERROR");
		expect(await service.status(account)).toMatchObject({ authenticated: false, login: { status: "CANCELLED" } });
	});

	it("reuses the active authorization when login is requested again", async () => {
		const { account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		const first = await service.login(account);
		const second = await service.login(account);
		expect(second.login).toMatchObject({ id: (first.login as Record<string, unknown>).id, status: "PENDING" });
		expect(await client.request("test_count", {}, 2000)).toEqual({ loginRequests: 1 });
	});

	it("keeps new authorization pending even when the account's old SDK key remains valid", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request(
			"test_status",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" },
			2000,
		);
		await service.login(account);
		expect(await service.status(account)).toMatchObject({ authenticated: false, login: { status: "PENDING" } });
		expect(accounts.require(account.id).credentials).toEqual({});
		expect((await manager.clientFor(accounts.require(account.id))).isAlive()).toBe(true);
		expect(await client.request("test_count", {}, 2000)).toEqual({ loginRequests: 1 });
	});

	it("does not complete a stale status request after credentials have been replaced", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request(
			"test_status",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME", defer: true },
			2000,
		);
		const pending = service.status(account);
		await expect.poll(() => client.request("test_pending_status", {}, 2000)).toEqual({ pendingStatus: true });
		accounts.updateFields(account.id, { credentials: { sessionToken: "replacement-fixture" } }, Date.now());
		await client.request("test_release_status", {}, 2000);
		expect(await pending).toMatchObject({ authenticated: false, login: { status: "CANCELLED" } });
		expect(accounts.require(account.id)).toMatchObject({
			credentials: { sessionToken: "replacement-fixture" },
			credentialStatus: "ERROR",
		});
	});

	it("allows its own completed authorization to persist while a pending status request is in flight", async () => {
		const { accounts, account, manager, service } = fixture();
		const client = await manager.clientFor(account);
		await client.request("test_status", { authenticated: true, sdkAuthenticated: true, defer: true }, 2000);
		await service.login(account);
		const pending = service.status(account);
		await expect.poll(() => client.request("test_pending_status", {}, 2000)).toEqual({ pendingStatus: true });
		await client.request(
			"test_complete",
			{ authenticated: true, sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" },
			2000,
		);
		await client.request("test_release_status", {}, 2000);
		expect(await pending).toMatchObject({ authenticated: true, login: { status: "COMPLETED" } });
		expect(accounts.require(account.id).credentialStatus).toBe("OK");
	});
});
