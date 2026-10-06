/**
 * 口令与哈希基元 —— 移植自 manager `AdminAuthService` 的密码学部分。
 * PBKDF2-HMAC-SHA256（120k 迭代 / 256 位 / base64 输出，与 Java 版逐字节兼容，
 * 管理员凭据可从 manager 库直接搬入）；token 只以 SHA-256 形态保存。
 */
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const PBKDF2_ITERATIONS = 120_000;
export const PBKDF2_KEY_BITS = 256;

/** SHA-256 十六进制（token 存储态、指纹）。 */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 随机字节的十六进制串（salt 用 16 字节、token 用 32 字节，对齐 Java randomHex）。 */
export function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

/** PBKDF2-HMAC-SHA256，salt 为 UTF-8 字节，输出 base64（对齐 Java pbkdf2）。 */
export function pbkdf2Base64(password: string, salt: string): string {
	return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BITS / 8, "sha256").toString("base64");
}

/**
 * 常量时间比较 —— 对齐 Java MessageDigest.isEqual 的语义：
 * 长度不同也不能提前暴露（先各做一次 SHA-256 抹平长度，再 timingSafeEqual）。
 */
export function constantTimeEquals(expected: string, actual: string): boolean {
	const a = sha256Hex(expected);
	const b = sha256Hex(actual);
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
