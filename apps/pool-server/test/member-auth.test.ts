import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyService } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMemberRoutes } from "../src/http/member-api.ts";
import { readJsonBody, respondErr } from "../src/http/respond.ts";
import { Router } from "../src/http/router.ts";
import { pbkdf2Base64 } from "../src/security/crypto.ts";
import { SqliteBillingStore } from "../src/store/billing-store.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteApiKeyStore, SqliteCatalogStore } from "../src/store/gateway-stores.ts";
import { SqliteMemberStore } from "../src/store/member-store.ts";

let workdir: string;
let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "owl-member-"));
	const db = openDb(join(workdir, "pool.db"));
	const members = new SqliteMemberStore(db);
	members.save({
		id: "member-wdl",
		username: "wdl",
		displayName: "王多鱼",
		passwordSalt: "aabbccddeeff00112233445566778899",
		passwordHash: pbkdf2Base64("correct-horse", "aabbccddeeff00112233445566778899"),
		enabled: true,
		maxConcurrentRequests: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	members.save({
		id: "member-off",
		username: "ll1",
		displayName: "停用",
		passwordSalt: "aabbccddeeff00112233445566778899",
		passwordHash: pbkdf2Base64("correct-horse", "aabbccddeeff00112233445566778899"),
		enabled: false,
		maxConcurrentRequests: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	const keys = new ApiKeyService({ store: new SqliteApiKeyStore(db) });
	keys.create({ name: "wdl-root", ownerMemberId: "member-wdl" });
	const billing = new SqliteBillingStore(db);
	billing.ensureWallet("member-wdl");
	billing.creditWallet("member-wdl", 1234);

	const router = new Router();
	registerMemberRoutes(router, {
		db,
		keys,
		catalog: new SqliteCatalogStore(db),
		billingStore: billing,
		dataDir: workdir,
		trustedProxyCount: 0,
		completeChat: async (_auth, payload) => ({
			choices: [{ message: { content: `echo:${String(payload.model)}` } }],
			usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
		}),
	});
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
		const readBody = <T>() => readJsonBody(request, 1024 * 1024) as Promise<T>;
		void router.handle(request, response, url, readBody).then((handled) => {
			if (!handled) {
				respondErr(response, "common.notFound", `路径不存在: ${request.method} ${url.pathname}`);
			}
		});
	});
	await new Promise<void>((resolveListen) => {
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	closeServer = () =>
		new Promise((resolveClose) => {
			server.close(() => {
				db.close();
				resolveClose();
			});
		});
});

afterAll(async () => {
	await closeServer();
	rmSync(workdir, { recursive: true, force: true });
});

interface Envelope {
	success?: boolean;
	code?: string;
	data?: {
		authenticated?: boolean;
		enabled?: boolean;
		username?: string;
		displayName?: string;
		member?: { username?: string; id?: string; enabled?: boolean };
		wallet?: { balance?: string };
		key?: { status?: string; id?: string; name?: string; isRoot?: boolean } | null;
		plaintext?: string;
		items?: Array<{ id?: string }>;
		rootKeyId?: string | null;
		editable?: boolean;
		currency?: string;
		content?: string;
		memberLimits?: { total?: string | null };
		effectiveLimits?: { total?: string | null };
		usage?: { totalTokens?: number };
	};
}

async function readEnvelope(response: Response): Promise<Envelope> {
	return (await response.json()) as Envelope;
}

describe("member login", () => {
	it("wrong password is 401, not a missing route", async () => {
		const response = await fetch(`${baseUrl}/api/member/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "wdl", password: "nope" }),
		});
		const body = await readEnvelope(response);
		expect(response.status).toBe(401);
		expect(body.success).toBe(false);
		expect(body.code).toBe("member.loginFailed");
	});

	it("disabled member cannot log in", async () => {
		const response = await fetch(`${baseUrl}/api/member/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "ll1", password: "correct-horse" }),
		});
		expect(response.status).toBe(401);
	});

	it("correct password sets loean_member and opens the overview", async () => {
		const response = await fetch(`${baseUrl}/api/member/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "WDL", password: "correct-horse" }),
		});
		const body = await readEnvelope(response);
		expect(response.status).toBe(200);
		expect(body.data?.authenticated).toBe(true);
		expect(body.data?.username).toBe("wdl");
		expect(body.data?.displayName).toBe("王多鱼");
		const cookie = String(response.headers.get("set-cookie"));
		expect(cookie).toContain("loean_member=");
		const token = cookie.split(";")[0] ?? "";

		const session = await fetch(`${baseUrl}/api/member/session`, { headers: { Cookie: token } });
		const sessionBody = await readEnvelope(session);
		expect(sessionBody.data?.authenticated).toBe(true);

		const overview = await fetch(`${baseUrl}/api/member/overview`, { headers: { Cookie: token } });
		const overviewBody = await readEnvelope(overview);
		expect(overview.status).toBe(200);
		expect(overviewBody.data?.member?.username).toBe("wdl");
		expect(overviewBody.data?.wallet?.balance).toBe("12.34");
		expect(overviewBody.data?.key?.status).toBe("ACTIVE");

		const keys = await fetch(`${baseUrl}/api/member/keys`, { headers: { Cookie: token } });
		const keysBody = await readEnvelope(keys);
		expect(keysBody.data?.items).toHaveLength(1);
		expect(keysBody.data?.rootKeyId).toBe(keysBody.data?.items?.[0]?.id);

		const loggedOut = await fetch(`${baseUrl}/api/member/logout`, {
			method: "POST",
			headers: { Cookie: token },
		});
		expect((await readEnvelope(loggedOut)).data?.authenticated).toBe(false);
	});

	it("overview without a cookie is 401", async () => {
		const response = await fetch(`${baseUrl}/api/member/overview`);
		expect(response.status).toBe(401);
	});
});

describe("member keys and playground", () => {
	let cookie = "";

	beforeAll(async () => {
		const response = await fetch(`${baseUrl}/api/member/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "wdl", password: "correct-horse" }),
		});
		cookie = String(response.headers.get("set-cookie")).split(";")[0] ?? "";
	});

	it("creates, rotates and revokes a child key, and refuses to revoke the root", async () => {
		const listed = await readEnvelope(await fetch(`${baseUrl}/api/member/keys`, { headers: { Cookie: cookie } }));
		const rootId = listed.data?.rootKeyId ?? "";
		const created = await readEnvelope(
			await fetch(`${baseUrl}/api/member/keys`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({
					name: "笔记本",
					allowedModels: null,
					allowedIps: null,
					rateLimitPerMinute: null,
					expiresAt: null,
				}),
			}),
		);
		expect(created.data?.key?.name).toBe("笔记本");
		expect(created.data?.key?.isRoot).toBe(false);
		expect(String(created.data?.plaintext ?? "")).toMatch(/^sk-/);

		const rotated = await readEnvelope(
			await fetch(`${baseUrl}/api/member/keys/${created.data?.key?.id}/rotate`, {
				method: "POST",
				headers: { Cookie: cookie },
			}),
		);
		expect(rotated.data?.plaintext).not.toBe(created.data?.plaintext);

		const rootRevoke = await fetch(`${baseUrl}/api/member/keys/${rootId}`, {
			method: "DELETE",
			headers: { Cookie: cookie },
		});
		expect(rootRevoke.status).toBe(400);

		const revoked = await fetch(`${baseUrl}/api/member/keys/${created.data?.key?.id}`, {
			method: "DELETE",
			headers: { Cookie: cookie },
		});
		expect(revoked.status).toBe(200);
	});

	it("opens the budget dialog data and saves a child limit", async () => {
		const created = await readEnvelope(
			await fetch(`${baseUrl}/api/member/keys`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ name: "预算", allowedModels: null }),
			}),
		);
		const id = created.data?.key?.id;
		const view = await readEnvelope(
			await fetch(`${baseUrl}/api/member/keys/${id}/budget`, { headers: { Cookie: cookie } }),
		);
		expect(view.data?.editable).toBe(true);
		expect(view.data?.currency).toBe("CNY");
		const saved = await readEnvelope(
			await fetch(`${baseUrl}/api/member/keys/${id}/budget`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ total: "12.50", daily: null, weekly: null }),
			}),
		);
		expect(saved.data?.memberLimits?.total).toBe("12.50");
		expect(saved.data?.effectiveLimits?.total).toBe("12.50");
	});

	it("admin can provision a member, and disabling that member logs them out", async () => {
		const created = await readEnvelope(
			await fetch(`${baseUrl}/api/members`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "new-member",
					displayName: "新成员",
					password: "secret-pass1",
					enabled: true,
				}),
			}),
		);
		expect(created.data?.member?.username).toBe("new-member");
		expect(String(created.data?.plaintext ?? "")).toMatch(/^sk-/);
		const loginResponse = await fetch(`${baseUrl}/api/member/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "new-member", password: "secret-pass1" }),
		});
		const login = await readEnvelope(loginResponse);
		expect(login.data?.authenticated).toBe(true);
		const token = String(loginResponse.headers.get("set-cookie")).split(";")[0] ?? "";
		const disabled = await readEnvelope(
			await fetch(`${baseUrl}/api/members/${created.data?.member?.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: false }),
			}),
		);
		expect(disabled.data?.enabled).toBe(false);
		const session = await readEnvelope(await fetch(`${baseUrl}/api/member/session`, { headers: { Cookie: token } }));
		expect(session.data?.authenticated).toBe(false);
		const removed = await fetch(`${baseUrl}/api/members/${created.data?.member?.id}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
	});

	it("playground returns the assistant text from the gateway", async () => {
		const response = await readEnvelope(
			await fetch(`${baseUrl}/api/member/playground`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: "hi" }] }),
			}),
		);
		expect(response.data?.content).toBe("echo:demo");
		expect(response.data?.usage?.totalTokens).toBe(8);
	});
});
