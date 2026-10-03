import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GmailThread } from "../src/core/mail/mime.js";
import { MailService } from "../src/core/mail/service.js";
import type {
	MailAccount,
	MailAuthStart,
	MailAuthStatus,
	MailDraft,
	MailSendConfirmation,
	MailThreadList,
} from "../src/core/mail/types.js";

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const CLIENT_JSON = JSON.stringify({
	installed: { client_id: "owl-test.apps.googleusercontent.com", client_secret: "fixture-client-secret" },
});

interface RecordedRequest {
	url: URL;
	init: RequestInit;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fixtureThread(id: string): GmailThread {
	return {
		id,
		messages: [
			{
				id: `message-${id}`,
				internalDate: "1791032400000",
				labelIds: ["INBOX", "UNREAD"],
				snippet: "项目进度",
				payload: {
					mimeType: "text/plain",
					headers: [
						{ name: "From", value: "Colleague <colleague@example.com>" },
						{ name: "To", value: "work@example.com" },
						{ name: "Subject", value: "项目进度" },
						{ name: "Message-ID", value: `<message-${id}@example.com>` },
						{ name: "References", value: "<earlier@example.com>" },
					],
					body: { data: Buffer.from("请确认本周的项目进度。").toString("base64url") },
				},
			},
		],
	};
}

class FakeGoogle {
	readonly calls: RecordedRequest[] = [];
	readonly grants = new Map<string, string>();
	readonly refreshScopes = new Map<string, string>();
	readonly invalidRefreshes = new Set<string>();
	readonly unavailableThreads = new Set<string>();
	readonly nextPages = new Map<string, string>();
	readonly refreshCount = new Map<string, number>();
	sendError: "network" | "unauthorized" | undefined;
	refreshBarrier?: Promise<void>;
	verifier = "";
	challenge = "";

	readonly fetch: typeof fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		this.calls.push({ url, init });
		if (url.hostname === "oauth2.googleapis.com") {
			const body = new URLSearchParams(String(init.body));
			if (url.pathname === "/revoke") return json({});
			if (body.get("grant_type") === "authorization_code") {
				const code = body.get("code") ?? "";
				this.verifier = body.get("code_verifier") ?? "";
				expect(createHash("sha256").update(this.verifier).digest("base64url")).toBe(this.challenge);
				return json({
					access_token: `access:${code}`,
					refresh_token: `refresh:${code}`,
					expires_in: 3600,
					scope: this.grants.get(code) ?? READ,
				});
			}
			const refresh = body.get("refresh_token") ?? "";
			this.refreshCount.set(refresh, (this.refreshCount.get(refresh) ?? 0) + 1);
			if (this.refreshBarrier) await this.refreshBarrier;
			if (this.invalidRefreshes.has(refresh)) return json({ error: "invalid_grant" }, 400);
			return json({
				access_token: refresh.replace("refresh:", "access:"),
				expires_in: 3600,
				scope: this.refreshScopes.get(refresh),
			});
		}
		const token = new Headers(init.headers).get("Authorization")?.replace("Bearer access:", "") ?? "";
		if (url.pathname.endsWith("/profile")) return json({ emailAddress: `${token}@example.com` });
		if (url.pathname.endsWith("/send")) {
			if (this.sendError === "network") throw new Error("connection lost after request accepted");
			if (this.sendError === "unauthorized") return json({}, 401);
			return json({ id: "sent-message", threadId: "work-thread" });
		}
		if (url.pathname.includes("/drafts")) return json({ id: "saved-draft" });
		if (url.pathname.endsWith("/threads")) {
			return json({ threads: [{ id: `${token}-thread` }], nextPageToken: this.nextPages.get(token) });
		}
		const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
		if (this.unavailableThreads.has(id) || !id.startsWith(`${token}-`)) return json({}, 404);
		return json(fixtureThread(id));
	};
}

const fixtures: Array<{ service: MailService; directory: string }> = [];

async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "owl-mail-test-"));
	const google = new FakeGoogle();
	let now = Date.parse("2026-10-03T13:00:00Z");
	const service = new MailService({
		agentDir: directory,
		fetch: google.fetch,
		now: () => now,
		seal: async (value) => Buffer.from(value).toString("base64"),
		unseal: async (value) => Buffer.from(value, "base64").toString("utf8"),
	});
	fixtures.push({ service, directory });
	await service.handle({ action: "configure", clientJson: CLIENT_JSON });
	return {
		service,
		google,
		directory,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
	};
}

async function start(
	service: MailService,
	google: FakeGoogle,
	name: string,
	permission: "read" | "send" = "read",
	accountId?: string,
) {
	const result = (await service.handle({ action: "auth.start", permission, accountId })) as MailAuthStart;
	const url = new URL(result.authorizationUrl);
	google.grants.set(name, url.searchParams.get("scope") ?? READ);
	google.challenge = url.searchParams.get("code_challenge") ?? "";
	const callback = new URL(url.searchParams.get("redirect_uri")!);
	callback.search = new URLSearchParams({ code: name, state: url.searchParams.get("state")! }).toString();
	return { result, url, callback };
}

async function connect(
	service: MailService,
	google: FakeGoogle,
	name: string,
	permission: "read" | "send" = "read",
	accountId?: string,
) {
	const auth = await start(service, google, name, permission, accountId);
	expect((await fetch(auth.callback)).status).toBe(200);
	const status = (await service.handle({ action: "auth.status", authId: auth.result.authId })) as MailAuthStatus;
	expect(status.state).toBe("complete");
	return status.account!;
}

function draft(account: MailAccount): MailDraft {
	return {
		accountId: account.id,
		to: "recipient@example.com",
		cc: "copy@example.com",
		bcc: "private@example.com",
		subject: "项目回复",
		body: "已确认，明天回复详细计划。",
	};
}

afterEach(async () => {
	for (const { service, directory } of fixtures.splice(0)) {
		await service.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

describe("Google mailbox authorization", () => {
	it("requests PKCE, offline read access, rejects a wrong state, and completes through loopback", async () => {
		const { service, google } = await harness();
		const auth = await start(service, google, "personal");
		expect(auth.url.hostname).toBe("accounts.google.com");
		expect(auth.url.searchParams.get("scope")).toBe(READ);
		expect(auth.url.searchParams.get("access_type")).toBe("offline");
		expect(auth.url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(auth.callback.hostname).toBe("127.0.0.1");
		const wrong = new URL(auth.callback);
		wrong.searchParams.set("state", "wrong-state");
		expect((await fetch(wrong)).status).toBe(400);
		expect(await service.handle({ action: "auth.status", authId: auth.result.authId })).toMatchObject({
			state: "pending",
		});
		expect(google.calls.filter((call) => call.url.pathname === "/token")).toHaveLength(0);
		expect((await fetch(auth.callback)).status).toBe(200);
		expect(google.verifier.length).toBeGreaterThanOrEqual(43);
		expect(await service.handle({ action: "accounts" })).toMatchObject([
			{ email: "personal@example.com", capabilities: { read: true, send: false } },
		]);
	});

	it("deduplicates a repeated email, retains its ID and send permission when reconnecting", async () => {
		const { service, google } = await harness();
		const account = await connect(service, google, "work", "send");
		await service.handle({ action: "rename", accountId: account.id, label: "工作" });
		const repeated = await connect(service, google, "work", "send");
		expect(repeated.id).toBe(account.id);
		expect(repeated.label).toBe("工作");
		expect(await service.handle({ action: "accounts" })).toHaveLength(1);
		const auth = await start(service, google, "work", "read", account.id);
		expect(auth.url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining([READ, COMPOSE, SEND]));
		expect((await fetch(auth.callback)).status).toBe(200);
		expect(await service.handle({ action: "accounts" })).toMatchObject([
			{ id: account.id, capabilities: { compose: true, send: true } },
		]);
	});

	it("does not replace an existing account with a different authorized Gmail address", async () => {
		const { service, google } = await harness();
		const account = await connect(service, google, "work");
		const auth = await start(service, google, "personal", "read", account.id);
		expect((await fetch(auth.callback)).status).toBe(400);
		expect(await service.handle({ action: "auth.status", authId: auth.result.authId })).toMatchObject({
			state: "failed",
			error: expect.stringContaining("不同"),
		});
		expect(await service.handle({ action: "accounts" })).toMatchObject([
			{ id: account.id, email: "work@example.com" },
		]);
		expect(await service.handle({ action: "accounts" })).toHaveLength(1);
	});

	it("cancels and expires listeners without connecting any account", async () => {
		const { service, google, advance } = await harness();
		const cancelled = await start(service, google, "personal");
		expect(await service.handle({ action: "auth.cancel", authId: cancelled.result.authId })).toEqual({
			state: "cancelled",
		});
		await expect(fetch(cancelled.callback)).rejects.toThrow();
		const expired = await start(service, google, "personal");
		advance(5 * 60_000 + 1);
		expect(await service.handle({ action: "auth.status", authId: expired.result.authId })).toMatchObject({
			state: "failed",
			error: expect.stringContaining("过期"),
		});
		await expect(fetch(expired.callback)).rejects.toThrow();
		expect(await service.handle({ action: "accounts" })).toEqual([]);
	});

	it("protects persisted client/token values and returns only public account settings", async () => {
		const { service, google, directory } = await harness();
		await connect(service, google, "personal");
		const file = await readFile(join(directory, "mail", "accounts.json"), "utf8");
		expect(file).not.toContain("fixture-client-secret");
		expect(file).not.toContain("access:personal");
		expect(file).not.toContain("refresh:personal");
		const projection = JSON.stringify([
			await service.handle({ action: "settings" }),
			await service.handle({ action: "accounts" }),
		]);
		expect(projection).not.toContain("clientSecret");
		expect(projection).not.toContain("accessToken");
		expect(projection).not.toContain("refreshToken");
	});
});

describe("multiple Gmail accounts", () => {
	it("isolates an invalid refresh and paginates the remaining account with its own folder/query", async () => {
		const { service, google, advance } = await harness();
		const personal = await connect(service, google, "personal");
		const work = await connect(service, google, "work");
		google.invalidRefreshes.add("refresh:work");
		google.nextPages.set("personal", "personal-next");
		advance(3_600_000);
		const list = (await service.handle({
			action: "threads.list",
			accountIds: [personal.id, work.id],
			folder: "unread",
			query: "from:colleague",
			pageTokens: { [personal.id]: "personal-page" },
		})) as MailThreadList;
		expect(list.threads).toHaveLength(1);
		expect(list.threads[0].accountId).toBe(personal.id);
		expect(list.errors).toMatchObject([{ accountId: work.id, error: expect.stringContaining("过期") }]);
		expect(list.nextPageTokens).toEqual({ [personal.id]: "personal-next" });
		const call = google.calls.find((request) => request.url.pathname.endsWith("/threads"))!;
		expect(call.url.searchParams.get("labelIds")).toBe("UNREAD");
		expect(call.url.searchParams.get("q")).toBe("from:colleague");
		expect(call.url.searchParams.get("pageToken")).toBe("personal-page");
		expect(await service.handle({ action: "accounts" })).toMatchObject([
			{ id: personal.id, status: "connected" },
			{ id: work.id, status: "expired" },
		]);
	});

	it("deduplicates concurrent refreshes and safely disconnects only the chosen account", async () => {
		const { service, google, advance } = await harness();
		const personal = await connect(service, google, "personal");
		const work = await connect(service, google, "work");
		advance(3_600_000);
		await Promise.all([
			service.handle({ action: "thread.get", accountId: personal.id, threadId: "personal-thread" }),
			service.handle({ action: "thread.get", accountId: personal.id, threadId: "personal-thread" }),
		]);
		expect(google.refreshCount.get("refresh:personal")).toBe(1);
		await service.handle({ action: "disconnect", accountId: work.id });
		const accounts = (await service.handle({ action: "accounts" })) as MailAccount[];
		expect(accounts.find((account) => account.id === personal.id)?.status).toBe("connected");
		expect(accounts.find((account) => account.id === work.id)).toMatchObject({
			status: "disconnected",
			capabilities: { read: false, send: false },
		});
		expect(
			new URLSearchParams(String(google.calls.find((call) => call.url.pathname === "/revoke")?.init.body)).get(
				"token",
			),
		).toBe("refresh:work");
	});

	it("binds replies to the account and rejects a message ID outside the original thread", async () => {
		const { service, google } = await harness();
		const personal = await connect(service, google, "personal", "send");
		await expect(
			service.handle({ action: "send.prepare", draft: { ...draft(personal), threadId: "work-thread" } }),
		).rejects.toThrow("不存在");
		await expect(
			service.handle({
				action: "send.prepare",
				draft: { ...draft(personal), threadId: "personal-thread", inReplyTo: "<foreign@example.com>" },
			}),
		).rejects.toThrow("不属于");
		const prepared = (await service.handle({
			action: "send.prepare",
			draft: { ...draft(personal), threadId: "personal-thread" },
		})) as MailSendConfirmation;
		expect(prepared.draft.inReplyTo).toBe("<message-personal-thread@example.com>");
		expect(prepared.draft.references).toBe("<earlier@example.com> <message-personal-thread@example.com>");
	});
});

describe("explicit send confirmation", () => {
	it("sends the exact preview once, binds the sender, and ignores later draft mutations", async () => {
		const { service, google } = await harness();
		const work = await connect(service, google, "work", "send");
		const input = { ...draft(work), from: "spoof@example.com" };
		const prepared = (await service.handle({ action: "send.prepare", draft: input })) as MailSendConfirmation;
		input.to = "changed@example.com";
		input.body = "changed content";
		prepared.draft.body = "changed preview object";
		expect(google.calls.filter((call) => call.url.pathname.endsWith("/send"))).toHaveLength(0);
		await service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId });
		const send = google.calls.find((call) => call.url.pathname.endsWith("/send"))!;
		const raw = JSON.parse(String(send.init.body)) as { raw: string };
		const mime = Buffer.from(raw.raw, "base64url").toString("utf8");
		expect(mime).toContain("From: work@example.com\r\n");
		expect(mime).toContain("To: recipient@example.com\r\n");
		expect(mime).not.toContain("spoof");
		expect(mime).not.toContain("changed@example.com");
		expect(Buffer.from(mime.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(
			"已确认，明天回复详细计划。",
		);
		await expect(service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId })).rejects.toThrow(
			"已使用",
		);
		expect(google.calls.filter((call) => call.url.pathname.endsWith("/send"))).toHaveLength(1);
	});

	it("expires confirmations and blocks compose/send for a read-only grant", async () => {
		const { service, google, advance } = await harness();
		const personal = await connect(service, google, "personal");
		await expect(service.handle({ action: "draft.save", draft: draft(personal) })).rejects.toThrow("只读");
		await expect(service.handle({ action: "send.prepare", draft: draft(personal) })).rejects.toThrow("只读");
		const work = await connect(service, google, "work", "send");
		const prepared = (await service.handle({ action: "send.prepare", draft: draft(work) })) as MailSendConfirmation;
		advance(5 * 60_000 + 1);
		await expect(service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId })).rejects.toThrow(
			"过期",
		);
		expect(google.calls.filter((call) => call.url.pathname.endsWith("/send"))).toHaveLength(0);
	});

	it("rechecks permissions after refresh and refuses a downgraded grant", async () => {
		const { service, google, advance } = await harness();
		const work = await connect(service, google, "work", "send");
		advance(3_600_000 - 60_000);
		const prepared = (await service.handle({ action: "send.prepare", draft: draft(work) })) as MailSendConfirmation;
		google.refreshScopes.set("refresh:work", READ);
		await expect(service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId })).rejects.toThrow(
			"只读",
		);
		expect(google.calls.filter((call) => call.url.pathname.endsWith("/send"))).toHaveLength(0);
	});

	it("never retries an uncertain send or reuses its confirmation", async () => {
		const { service, google } = await harness();
		const work = await connect(service, google, "work", "send");
		const prepared = (await service.handle({ action: "send.prepare", draft: draft(work) })) as MailSendConfirmation;
		google.sendError = "network";
		await expect(service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId })).rejects.toThrow(
			"避免重复",
		);
		await expect(service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId })).rejects.toThrow(
			"已使用",
		);
		expect(google.calls.filter((call) => call.url.pathname.endsWith("/send"))).toHaveLength(1);
	});

	it("saves an account-bound Gmail draft and sends it with the immutable preview MIME", async () => {
		const { service, google } = await harness();
		const work = await connect(service, google, "work", "send");
		const saved = (await service.handle({
			action: "draft.save",
			draft: { ...draft(work), threadId: "work-thread" },
		})) as MailDraft;
		expect(saved.id).toBe("saved-draft");
		const prepared = (await service.handle({ action: "send.prepare", draft: saved })) as MailSendConfirmation;
		await service.handle({ action: "send.confirm", confirmationId: prepared.confirmationId });
		const send = google.calls.find((call) => call.url.pathname.endsWith("/drafts/send"))!;
		const sent = JSON.parse(String(send.init.body)) as { id: string; message: { raw: string; threadId: string } };
		expect(sent.id).toBe("saved-draft");
		expect(sent.message.threadId).toBe("work-thread");
		expect(Buffer.from(sent.message.raw, "base64url").toString()).toContain(
			"In-Reply-To: <message-work-thread@example.com>",
		);
	});

	it("rejects header injection before creating a draft or confirmation", async () => {
		const { service, google } = await harness();
		const work = await connect(service, google, "work", "send");
		await expect(
			service.handle({
				action: "send.prepare",
				draft: { ...draft(work), subject: "主题\r\nBcc: attacker@example.com" },
			}),
		).rejects.toThrow("换行");
		await expect(
			service.handle({
				action: "draft.save",
				draft: { ...draft(work), to: "user@example.com\nBcc: attacker@example.com" },
			}),
		).rejects.toThrow("换行");
	});
});
