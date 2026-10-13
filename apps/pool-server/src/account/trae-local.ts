/**
 * 本机 Trae 系 IDE 凭证导入 —— 扫描 %APPDATA% 下的 Trae CN / TRAE SOLO CN /
 * 国际版 storage.json，解密 iCubeAuthInfo://icube.cloudide，供「重新登录」
 * 弹窗一键绑定到号池账号。加密格式与 D:\developTool\wb-decrypt\trae-helper.js
 * 一致（tc 头 + AES-128-CBC，盐取自 Trae CN 前端常量）；IDE 端会自己续期，
 * 这里只读取当前登录的那一份。
 */
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BusinessError } from "owl-pool";

export const TRAE_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";

export interface TraeEdition {
	id: string;
	label: string;
	/** %APPDATA% 下的子目录名。 */
	subdir: string;
}

export const TRAE_EDITIONS: TraeEdition[] = [
	{ id: "cn", label: "Trae CN", subdir: "Trae CN" },
	{ id: "solo-cn", label: "TRAE SOLO CN", subdir: "TRAE SOLO CN" },
	{ id: "sg", label: "Trae 国际版", subdir: "Trae" },
	{ id: "solo-sg", label: "TRAE SOLO 国际版", subdir: "TRAE SOLO" },
];

// 4 组硬编码盐（64 字节，取自 Trae CN 前端 JS），与 trae-helper.js 逐字一致。
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
const SALT_C = Uint8Array.from([
	191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211,
	102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140,
	55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
]);
const SALT_D = Uint8Array.from([
	246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244,
	207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173,
	125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
]);

function detectEncType(header: Uint8Array): "AES" | "AES_PRIVATE" | "UNKNOWN" {
	if (header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 && header[3] === 0x10) return "AES";
	if (header[0] === 18 && header[1] === 57 && header[2] === 32 && header[3] === 32) return "AES_PRIVATE";
	return "UNKNOWN";
}

/** 解密 storage.json 里的单个 tc 密文（base64），返回明文 JSON 对象。 */
export function decryptTcValue(base64Value: string): Record<string, unknown> {
	const buffer = Buffer.from(base64Value, "base64");
	if (buffer.length < 38 + 80) {
		throw new Error("tc 密文长度不足");
	}
	const encType = detectEncType(buffer.subarray(0, 6));
	if (encType === "UNKNOWN") {
		throw new Error(`未知加密头: ${buffer.subarray(0, 6).toString("hex")}`);
	}
	const primary = encType === "AES_PRIVATE" ? SALT_C : SALT_A;
	const secondary = encType === "AES_PRIVATE" ? SALT_D : SALT_B;
	const salt = Buffer.from(primary.map((byte, i) => byte ^ secondary[i]));
	const hashOfRandom = createHash("sha512").update(buffer.subarray(6, 38)).digest();
	const finalHash = createHash("sha512")
		.update(Buffer.concat([hashOfRandom, salt]))
		.digest();
	const decipher = createDecipheriv("aes-128-cbc", finalHash.subarray(0, 16), finalHash.subarray(16, 32));
	const plain = Buffer.concat([decipher.update(buffer.subarray(38)), decipher.final()]);
	if (plain.length < 65) {
		throw new Error("明文长度不足");
	}
	const body = plain.subarray(64);
	if (!createHash("sha512").update(body).digest().equals(plain.subarray(0, 64))) {
		throw new Error("SHA-512 哈希校验失败");
	}
	const parsed: unknown = JSON.parse(body.toString("utf-8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("明文不是 JSON 对象");
	}
	return parsed as Record<string, unknown>;
}

export interface LocalTraeCredential {
	edition: string;
	label: string;
	storagePath: string;
	/** 账号昵称 + Trae 预脱敏手机号（服务端本来就是掩码形态）。 */
	username: string;
	userId: string;
	tokenExpiresAt: string | null;
	refreshExpiresAt: string | null;
	/** 解密/解析失败原因；有此字段时 credentials 为空。 */
	error?: string;
	/** 完整凭证——只允许走绑定的 POST 在服务端使用，LIST 视图必须剥掉。 */
	credentials?: Record<string, unknown>;
}

function toIso(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	const stamp = new Date(value as string | number);
	return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
}

function accountLabel(auth: Record<string, unknown>): string {
	const account =
		auth.account !== null && typeof auth.account === "object" ? (auth.account as Record<string, unknown>) : {};
	const name = typeof account.username === "string" && account.username.length > 0 ? account.username : "未命名账号";
	const mobile = typeof account.nonPlainTextMobile === "string" ? account.nonPlainTextMobile : "";
	return mobile.length > 0 ? `${name} / ${mobile}` : name;
}

/** 从解密出的 auth 里挑号池需要的键（与 wb-decrypt 产出的形态一致）。 */
export function buildIdeCredentials(auth: Record<string, unknown>): Record<string, unknown> {
	const credentials: Record<string, unknown> = {};
	for (const key of ["token", "refreshToken", "userId", "host", "expiredAt", "refreshExpiredAt"]) {
		const value = auth[key];
		if (value !== null && value !== undefined && value !== "") {
			credentials[key] = value;
		}
	}
	return credentials;
}

export function scanLocalTraeCredentials(options?: {
	appDataRoot?: string;
	extraPaths?: string[];
}): LocalTraeCredential[] {
	const roots: Array<{ edition: string; label: string; storage: string }> = [];
	const appData = options?.appDataRoot ?? join(process.env.APPDATA ?? "", "");
	for (const edition of TRAE_EDITIONS) {
		roots.push({
			edition: edition.id,
			label: edition.label,
			storage: join(appData, edition.subdir, "User", "globalStorage", "storage.json"),
		});
	}
	(options?.extraPaths ?? []).forEach((path, i) => {
		roots.push({ edition: `custom-${i + 1}`, label: path, storage: path });
	});

	const found: LocalTraeCredential[] = [];
	for (const root of roots) {
		if (!existsSync(root.storage)) {
			continue;
		}
		const entry: LocalTraeCredential = {
			edition: root.edition,
			label: root.label,
			storagePath: root.storage,
			username: "",
			userId: "",
			tokenExpiresAt: null,
			refreshExpiresAt: null,
		};
		try {
			const store = JSON.parse(readFileSync(root.storage, "utf-8")) as Record<string, unknown>;
			const blob = store[TRAE_AUTH_KEY];
			if (typeof blob !== "string" || blob.length === 0) {
				entry.error = "没有登录凭证（未登录或版本不匹配）";
				found.push(entry);
				continue;
			}
			const auth = decryptTcValue(blob);
			const token = typeof auth.token === "string" ? auth.token : "";
			if (token.trim().length === 0) {
				entry.error = "凭证里没有 token";
				found.push(entry);
				continue;
			}
			const credentials = buildIdeCredentials(auth);
			entry.username = accountLabel(auth);
			entry.userId = typeof auth.userId === "string" ? auth.userId : "";
			entry.tokenExpiresAt = toIso(auth.expiredAt);
			entry.refreshExpiresAt = toIso(auth.refreshExpiredAt);
			entry.credentials = credentials;
			found.push(entry);
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
			found.push(entry);
		}
	}
	return found;
}

export function requireLocalTraeCredential(
	scan: LocalTraeCredential[],
	selector: { edition?: string; storagePath?: string },
): LocalTraeCredential {
	const matched = scan.find((entry) =>
		selector.edition !== undefined && selector.edition.length > 0
			? entry.edition === selector.edition
			: entry.storagePath === selector.storagePath,
	);
	if (matched === undefined) {
		throw BusinessError.of("trae.localNotFound", "没有找到对应的本机 Trae 凭证，请先扫描");
	}
	if (matched.error !== undefined || matched.credentials === undefined) {
		throw BusinessError.of("trae.localUnusable", `该 IDE 凭证不可用: ${matched.error ?? "未知原因"}`);
	}
	if (typeof matched.credentials.refreshToken !== "string" || matched.credentials.refreshToken.length === 0) {
		throw BusinessError.of("trae.localNoRefresh", "该凭证缺少 refreshToken，无法由号池续期");
	}
	return matched;
}
