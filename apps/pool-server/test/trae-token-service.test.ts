/**
 * Trae IDE token 凭证链路 —— trae-auth 服务、对话直取、积分 401 强刷重试、签到回落。
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Account, InMemoryAccountStore, TraeCheckInProvider, UpstreamException } from "owl-pool";
import { describe, expect, it } from "vitest";
import { query } from "../src/account/credits.ts";
import { pingAccount } from "../src/account/ping.ts";
import { TraeTokenService } from "../src/account/trae-auth.ts";
import { TraeChatClient } from "../src/gateway/trae-client.ts";

const SALT_A = Uint8Array.from([
	82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52,
	142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161,
	102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Uint8Array.from([
	31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229,
	122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4,
	126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);

function encryptTc(auth: Record<string, unknown>): string {
	const random = randomBytes(32);
	const salt = Buffer.from(SALT_A.map((b, i) => b ^ SALT_B[i]));
	const h1 = createHash("sha512").update(random).digest();
	const final = createHash("sha512")
		.update(Buffer.concat([h1, salt]))
		.digest();
	const body = Buffer.from(JSON.stringify(auth), "utf-8");
	const hash = createHash("sha512").update(body).digest();
	const cipher = createCipheriv("aes-128-cbc", final.subarray(0, 16), final.subarray(16, 32));
	const encrypted = Buffer.concat([cipher.update(Buffer.concat([hash, body])), cipher.final()]);
	return Buffer.concat([Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]), random, encrypted]).toString("base64");
}

function writeStorageFile(auth: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "trae-storage-"));
	const path = join(dir, "storage.json");
	writeFileSync(path, JSON.stringify({ "iCubeAuthInfo://icube.cloudide": encryptTc(auth) }));
	return path;
}

function account(credentials: Record<string, unknown>, id = "trae-1"): Account {
	return { id, name: "trae 测试号", platform: "TRAE", credentials, enabled: true, createdAt: 0, updatedAt: 0 };
}

function json(response: unknown, status = 200): Response {
	return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
}

const USAGE_OK = {
	code: 0,
	data: {
		user_entitlement_pack_list: [
			{
				entitlement_base_info: { quota: { credits_limit: 100 }, product_type: 1 },
				usage: { credits_amount: 30 },
			},
		],
	},
};

describe("TraeTokenService", () => {
	it("token 未过期：直接返回，不发任何网络请求", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{
				name: "t",
				platform: "TRAE",
				credentials: { token: "jwt-a", refreshToken: "rt", userId: "u1", expiredAt: "2026-10-24T07:00:00.000Z" },
				enabled: true,
			},
			0,
		);
		const service = new TraeTokenService({
			accounts,
			fetchImpl: (async () => {
				throw new Error("不应发起网络请求");
			}) as typeof fetch,
			now: () => new Date("2026-10-13T00:00:00.000Z").getTime(),
		});
		await expect(service.resolveJwt(account(created.credentials, created.id))).resolves.toBe("jwt-a");
	});

	it("token 已过期：用 refreshToken 续期，轮换结果写回账号", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{
				name: "t",
				platform: "TRAE",
				credentials: {
					token: "jwt-old",
					refreshToken: "rt-1",
					userId: "u1",
					expiredAt: "2026-10-01T00:00:00.000Z",
				},
				enabled: true,
			},
			0,
		);
		const bodies: unknown[] = [];
		const service = new TraeTokenService({
			accounts,
			fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				return json({
					Result: {
						Token: "jwt-new",
						RefreshToken: "rt-2",
						TokenExpireAt: "2026-10-25T00:00:00.000Z",
					},
				});
			}) as typeof fetch,
			now: () => new Date("2026-10-13T00:00:00.000Z").getTime(),
		});
		await expect(service.resolveJwt(account(created.credentials, created.id))).resolves.toBe("jwt-new");

		const request = bodies[0] as Record<string, unknown>;
		expect(request.RefreshToken).toBe("rt-1");
		expect(request.UserID).toBe("u1");
		expect(request.ClientID).toBe("ono9krqynydwx5");
		const persisted = accounts.require(created.id).credentials;
		expect(persisted).toMatchObject({ token: "jwt-new", refreshToken: "rt-2", userId: "u1" });
		expect(Date.parse(String(persisted.expiredAt))).toBe(Date.parse("2026-10-25T00:00:00.000Z"));
	});

	it("refreshToken 被吊销（401）→ AUTH，提示重新导入", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{
				name: "t",
				platform: "TRAE",
				credentials: { token: "jwt-old", refreshToken: "rt-1", expiredAt: "2026-10-01T00:00:00.000Z" },
				enabled: true,
			},
			0,
		);
		const service = new TraeTokenService({
			accounts,
			fetchImpl: (async () => new Response("denied", { status: 401 })) as typeof fetch,
			now: () => new Date("2026-10-13T00:00:00.000Z").getTime(),
		});
		await expect(service.refresh(account(created.credentials, created.id))).rejects.toMatchObject({
			name: "UpstreamException",
			kind: "AUTH",
		});
	});

	it("只有 session 没有 IDE 凭证：resolveJwt 返回 null，走原 session 交换", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{ name: "t", platform: "TRAE", credentials: { session: "sess-1" }, enabled: true },
			0,
		);
		const service = new TraeTokenService({ accounts, now: () => 0 });
		await expect(service.resolveJwt(account(created.credentials, created.id))).resolves.toBeNull();
	});

	it("storageFile 模式：每次读文件取最新 token，不发起续期", async () => {
		const accounts = new InMemoryAccountStore();
		const storageFile = writeStorageFile({
			token: "file-jwt",
			refreshToken: "rt-file",
			userId: "u-1",
			expiredAt: "2026-10-24T00:00:00.000Z",
		});
		const created = accounts.create({ name: "t", platform: "TRAE", credentials: { storageFile }, enabled: true }, 0);
		const service = new TraeTokenService({
			accounts,
			fetchImpl: (async () => {
				throw new Error("storageFile 模式不应发起任何网络请求");
			}) as typeof fetch,
			now: () => new Date("2026-10-13T00:00:00.000Z").getTime(),
		});
		await expect(service.resolveJwt(account(created.credentials, created.id))).resolves.toBe("file-jwt");
		rmSync(join(storageFile, ".."), { recursive: true, force: true });
	});

	it("storageFile 里的 token 已过期 → AUTH 提示去 IDE 重登", async () => {
		const accounts = new InMemoryAccountStore();
		const storageFile = writeStorageFile({
			token: "stale-jwt",
			refreshToken: "rt-file",
			expiredAt: "2026-10-01T00:00:00.000Z",
		});
		const created = accounts.create({ name: "t", platform: "TRAE", credentials: { storageFile }, enabled: true }, 0);
		const service = new TraeTokenService({
			accounts,
			now: () => new Date("2026-10-13T00:00:00.000Z").getTime(),
		});
		await expect(service.resolveJwt(account(created.credentials, created.id))).rejects.toMatchObject({
			kind: "AUTH",
			message: expect.stringContaining("已过期"),
		});
		rmSync(join(storageFile, ".."), { recursive: true, force: true });
	});

	it("storageFile 路径不存在 → AUTH", async () => {
		const accounts = new InMemoryAccountStore();
		const created = accounts.create(
			{ name: "t", platform: "TRAE", credentials: { storageFile: "C:/no/such/storage.json" }, enabled: true },
			0,
		);
		const service = new TraeTokenService({ accounts, now: () => 0 });
		await expect(service.resolveJwt(account(created.credentials, created.id))).rejects.toMatchObject({
			kind: "AUTH",
			message: expect.stringContaining("不存在"),
		});
	});
});

describe("TraeChatClient IDE token 直取", () => {
	function client(jwt: string | null) {
		const requests: Array<{ url: string; headers: Record<string, string> }> = [];
		const trae = new TraeChatClient({
			config: {
				chatBaseUrl: "https://trae-api-cn.mchost.guru",
				chatPath: "/api/agent/v3/llm_utils_chat",
				appId: "icube-ai",
				ideVersion: "2.63.2",
				ideVersionCode: "2630200",
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init?.headers ?? {})) {
					headers[name.toLowerCase()] = String(value);
				}
				requests.push({ url: String(input), headers });
				return new Response(
					'event: output\ndata: {"response":"好"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}) as typeof fetch,
			resolveJwt: async () => jwt,
		});
		return { trae, requests };
	}

	it("有 IDE token：跳过 GetUserToken，直接 Cloud-IDE-JWT 对话", async () => {
		const { trae, requests } = client("ide-jwt-1");
		await trae.chatCompletionStream(account({ token: "ide-jwt-1" }), { model: "m", messages: [] }, () => {});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat");
		expect(requests[0]!.headers.authorization).toBe("Cloud-IDE-JWT ide-jwt-1");
	});

	it("没有 IDE 凭证：回落 session 交换，原行为不变", async () => {
		const requests: Array<{ url: string; headers: Record<string, string> }> = [];
		const trae = new TraeChatClient({
			config: {
				chatBaseUrl: "https://trae-api-cn.mchost.guru",
				chatPath: "/api/agent/v3/llm_utils_chat",
				appId: "icube-ai",
				ideVersion: "2.63.2",
				ideVersionCode: "2630200",
				timeoutMs: 5000,
			},
			fetchImpl: (async (input: string | URL, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init?.headers ?? {})) {
					headers[name.toLowerCase()] = String(value);
				}
				requests.push({ url: String(input), headers });
				if (String(input).includes("GetUserToken")) {
					return json({ code: 0, Result: { Token: "jwt-1" } });
				}
				return new Response(
					'event: output\ndata: {"response":"好"}\n\nevent: done\ndata: {"finish_reason":"stop"}\n\n',
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}) as typeof fetch,
		});
		await trae.chatCompletionStream(account({ session: "sess-1" }), { model: "m", messages: [] }, () => {});
		expect(requests[0]!.url).toBe("https://api.trae.cn/cloudide/api/v3/common/GetUserToken");
		expect(requests[1]!.headers.authorization).toBe("Cloud-IDE-JWT jwt-1");
	});
});

describe("Trae 积分查询 401 强刷重试", () => {
	function hooks(fetchCalls: Array<{ url: string; status: number }>, refreshes: string[]) {
		let call = 0;
		return {
			fetchImpl: (async () => {
				const current = fetchCalls[Math.min(call, fetchCalls.length - 1)]!;
				call++;
				return current.status === 200 ? json(USAGE_OK) : new Response("denied", { status: current.status });
			}) as typeof fetch,
			workbuddyBaseUrl: "https://example.invalid",
			workbuddyAuthRoots: [],
			exchangeTraeToken: async () => "session-jwt",
			resolveTraeJwt: async () => "ide-jwt",
			refreshTraeJwt: async () => {
				refreshes.push("refresh");
				return "ide-jwt-2";
			},
		};
	}

	it("401 → refreshToken 续期 → 重试成功", async () => {
		const refreshes: string[] = [];
		const hook = hooks(
			[
				{ url: "", status: 401 },
				{ url: "", status: 200 },
			],
			refreshes,
		);
		const snapshot = await query(account({ token: "ide-jwt", refreshToken: "rt", userId: "u1" }), hook);
		expect(snapshot.ok).toBe(true);
		expect(snapshot.credits).toBe(70);
		expect(refreshes).toEqual(["refresh"]);
	});

	it("续期后仍 401 → 凭证过期，提示重新登录", async () => {
		const refreshes: string[] = [];
		const hook = hooks([{ url: "", status: 401 }], refreshes);
		const snapshot = await query(account({ token: "ide-jwt", refreshToken: "rt" }), hook);
		expect(snapshot.ok).toBe(false);
		expect(snapshot.authRejected).toBe(true);
		expect(refreshes).toEqual(["refresh"]);
	});
});

describe("Trae Ping IDE 凭证", () => {
	it("IDE token 可用：ping 直接通过", async () => {
		const result = await pingAccount(account({ token: "ide-jwt", refreshToken: "rt" }), {
			workbuddyBaseUrl: "https://example.invalid",
			workbuddyAuthRoots: [],
			exchangeTraeToken: async () => {
				throw new Error("不应走 session 交换");
			},
			resolveTraeJwt: async () => "ide-jwt",
		});
		expect(result.ok).toBe(true);
		expect(result.message).toBe("Trae IDE 凭证可用");
	});

	it("IDE 链路失效且无 session：抛出更具体的错误", async () => {
		const result = await pingAccount(account({ token: "ide-jwt", refreshToken: "rt" }), {
			workbuddyBaseUrl: "https://example.invalid",
			workbuddyAuthRoots: [],
			exchangeTraeToken: async () => "session-jwt",
			resolveTraeJwt: async () => {
				throw new UpstreamException("AUTH", "Trae refreshToken 已失效，请从 Trae CN 重新导入");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("refreshToken 已失效");
	});
});

describe("Trae 签到 IDE 凭证", () => {
	function providerUnderTest(options: {
		claimStatuses: number[];
		resolveJwt?: (account: Account) => Promise<string | null>;
		refreshJwt?: (account: Account) => Promise<string>;
	}): TraeCheckInProvider {
		let claim = 0;
		return new TraeCheckInProvider({
			fetchImpl: (async (input: string | URL) => {
				if (String(input).includes("checkin_credits/claim")) {
					const status = options.claimStatuses[Math.min(claim, options.claimStatuses.length - 1)]!;
					claim++;
					return json({ code: 0, checked_in: true, credits: 5 }, status);
				}
				throw new Error("不应走 GetUserToken");
			}) as typeof fetch,
			sleepImpl: async () => {},
			resolveJwt: options.resolveJwt,
			refreshJwt: options.refreshJwt,
		});
	}

	it("IDE token 直取签到成功，不碰 session 交换", async () => {
		const provider = providerUnderTest({ claimStatuses: [200], resolveJwt: async () => "ide-jwt" });
		const result = await provider.checkIn(account({ token: "ide-jwt", refreshToken: "rt" }));
		expect(result.status).toBe("SUCCESS");
	});

	it("claim 401 → refreshToken 续期 → 重试成功", async () => {
		const refreshes: string[] = [];
		const provider = providerUnderTest({
			claimStatuses: [401, 200],
			resolveJwt: async () => "ide-jwt",
			refreshJwt: async () => {
				refreshes.push("r");
				return "ide-jwt-2";
			},
		});
		const result = await provider.checkIn(account({ token: "ide-jwt", refreshToken: "rt" }));
		expect(result.status).toBe("SUCCESS");
		expect(refreshes).toEqual(["r"]);
	});

	it("IDE 链路失效且无 session → AUTH 错误带重新导入提示", async () => {
		const provider = providerUnderTest({
			claimStatuses: [200],
			resolveJwt: async () => {
				throw new UpstreamException("AUTH", "Trae refreshToken 已失效，请从 Trae CN 重新导入");
			},
		});
		const result = await provider.checkIn(account({ token: "ide-jwt", refreshToken: "rt" }));
		expect(result.status).toBe("AUTH_ERROR");
		expect(result.message).toContain("重新导入");
	});
});
