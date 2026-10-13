/**
 * 本机 Trae IDE 凭证导入 —— tc 解密、扫描视图脱敏、绑定路由。
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAccountStore } from "owl-pool";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildIdeCredentials,
	decryptTcValue,
	requireLocalTraeCredential,
	scanLocalTraeCredentials,
} from "../src/account/trae-local.ts";
import { registerAccountRoutes } from "../src/http/accounts-api.ts";
import { readJsonBody, respondErr } from "../src/http/respond.ts";
import { Router } from "../src/http/router.ts";

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

/** 按 tc 格式加密一段 JSON（测试专用，算法与 trae-local 解密互为逆）。 */
function encryptTcValue(auth: Record<string, unknown>): string {
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

function fixtureAuth(token = "ide-jwt"): Record<string, unknown> {
	return {
		token,
		refreshToken: "rt-1",
		userId: "u-42",
		host: "https://api.trae.cn",
		expiredAt: "2026-10-24T07:00:00.000Z",
		refreshExpiredAt: "2027-04-08T07:00:00.000Z",
		account: { username: "测试用户", nonPlainTextMobile: "138****0000" },
	};
}

describe("decryptTcValue", () => {
	it("tc 密文往返：解出原始 JSON 且哈希校验通过", () => {
		expect(decryptTcValue(encryptTcValue(fixtureAuth()))).toMatchObject({ token: "ide-jwt", userId: "u-42" });
	});

	it("篡改密文 → 哈希校验失败", () => {
		const blob = Buffer.from(encryptTcValue(fixtureAuth()), "base64");
		// 破坏 hash 区（偏移 50 在末尾 padding 之前），保持 AES padding 合法、只让明文哈希对不上
		blob[50] ^= 0xff;
		expect(() => decryptTcValue(blob.toString("base64"))).toThrow(/哈希校验/);
	});

	it("未知加密头 → 明确报错", () => {
		const blob = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6]), randomBytes(120)]).toString("base64");
		expect(() => decryptTcValue(blob)).toThrow(/未知加密头/);
	});
});

function writeStorage(root: string, subdir: string, blob: string | null): string {
	const storage = join(root, subdir, "User", "globalStorage", "storage.json");
	mkdirSync(join(root, subdir, "User", "globalStorage"), { recursive: true });
	writeFileSync(storage, JSON.stringify(blob === null ? {} : { "iCubeAuthInfo://icube.cloudide": blob }));
	return storage;
}

describe("scanLocalTraeCredentials", () => {
	it("扫描出已登录 edition，未登录的带明确原因", () => {
		const root = mkdtempSync(join(tmpdir(), "trae-local-"));
		try {
			writeStorage(root, "Trae CN", encryptTcValue(fixtureAuth()));
			writeStorage(root, "TRAE SOLO CN", null);
			const scan = scanLocalTraeCredentials({ appDataRoot: root });
			expect(scan).toHaveLength(2);
			const cn = scan.find((entry) => entry.edition === "cn")!;
			expect(cn.username).toBe("测试用户 / 138****0000");
			expect(cn.tokenExpiresAt).toBe("2026-10-24T07:00:00.000Z");
			expect(cn.credentials).toMatchObject({ refreshToken: "rt-1" });
			const solo = scan.find((entry) => entry.edition === "solo-cn")!;
			expect(solo.error).toMatch(/没有登录凭证/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("buildIdeCredentials 只保留号池键", () => {
		expect(Object.keys(buildIdeCredentials(fixtureAuth())).sort()).toEqual([
			"expiredAt",
			"host",
			"refreshExpiredAt",
			"refreshToken",
			"token",
			"userId",
		]);
	});

	it("requireLocalTraeCredential：缺 refreshToken 的条目 → 明确报错", () => {
		const broken = [
			{
				edition: "cn",
				label: "Trae CN",
				storagePath: "x",
				username: "",
				userId: "",
				tokenExpiresAt: null,
				refreshExpiresAt: null,
				credentials: { token: "ide-jwt" },
			},
		];
		expect(() => requireLocalTraeCredential(broken, { edition: "cn" })).toThrow(/refreshToken/);
	});
});

describe("本机 Trae 导入路由", () => {
	const scanResult = [
		{
			edition: "cn",
			label: "Trae CN",
			storagePath: "C:\\mock\\Trae CN\\storage.json",
			username: "测试用户 / 138****0000",
			userId: "u-42",
			tokenExpiresAt: "2026-10-24T07:00:00.000Z",
			refreshExpiresAt: "2027-04-08T07:00:00.000Z",
			credentials: {
				token: "ide-jwt",
				refreshToken: "rt-1",
				userId: "u-42",
				host: "https://api.trae.cn",
				expiredAt: "2026-10-24T07:00:00.000Z",
			},
		},
	];
	let baseUrl = "";
	let closeServer = async () => {};
	let accounts: InMemoryAccountStore;
	let createdId = "";

	beforeAll(async () => {
		accounts = new InMemoryAccountStore();
		createdId = accounts.create(
			{
				name: "trae-7520",
				platform: "TRAE",
				credentials: { session: "old-sess", deviceId: "1234567890123456" },
				enabled: true,
			},
			Date.now(),
		).id;
		accounts.create(
			{ name: "wb", platform: "WORKBUDDY", credentials: { accessToken: "wb" }, enabled: true },
			Date.now(),
		);
		const router = new Router();
		registerAccountRoutes(router, { accounts, traeLocalScan: () => scanResult });
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
			const readBody = <T>() => readJsonBody(request, 1024 * 1024) as Promise<T>;
			void router.handle(request, response, url, readBody).then(
				(handled) => {
					if (!handled && !response.writableEnded) respondErr(response, "common.notFound", "missing");
				},
				(error: unknown) => {
					if (response.writableEnded) return;
					respondErr(response, error instanceof Error ? error.message : "common.internal", String(error));
				},
			);
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
	});

	afterAll(async () => {
		await closeServer();
	});

	async function call(
		path: string,
		method = "GET",
		body?: unknown,
	): Promise<{ status: number; data: Record<string, unknown> }> {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = (await response.json()) as { data?: Record<string, unknown>; code?: string };
		return { status: response.status, data: payload.data ?? { code: payload.code } };
	}

	it("LIST 不泄露任何密钥字段", async () => {
		const { status, data } = await call("/api/trae/local");
		expect(status).toBe(200);
		const payload = JSON.stringify(data);
		expect(payload).toContain("Trae CN");
		expect(payload).toContain("138****0000");
		expect(payload).not.toContain("ide-jwt");
		expect(payload).not.toContain("rt-1");
	});

	it("POST 绑定：合并凭证（保留 session/deviceId）+ 写 credentialExpiresAt/Status", async () => {
		const { status, data } = await call(`/api/accounts/${createdId}/trae/import-local`, "POST", { edition: "cn" });
		expect(status).toBe(200);
		expect(data.credentialStatus).toBe("OK");
		const credentials = accounts.require(createdId).credentials;
		expect(credentials).toMatchObject({
			token: "ide-jwt",
			refreshToken: "rt-1",
			session: "old-sess",
			deviceId: "1234567890123456",
		});
		expect(accounts.require(createdId).credentialExpiresAt).toBe(Date.parse("2026-10-24T07:00:00.000Z"));
	});

	it("POST 绑定到非 TRAE 账号 → 拒绝", async () => {
		const wbId = accounts.list().find((a) => a.platform === "WORKBUDDY")!.id;
		const { status, data } = await call(`/api/accounts/${wbId}/trae/import-local`, "POST", { edition: "cn" });
		expect(status).toBeGreaterThanOrEqual(400);
		expect(String(data.code ?? "")).toMatch(/trae|wrong/i);
	});

	it("POST 未知 edition → 404 语义的明确错误", async () => {
		const { status } = await call(`/api/accounts/${createdId}/trae/import-local`, "POST", { edition: "nope" });
		expect(status).toBeGreaterThanOrEqual(400);
	});
});
