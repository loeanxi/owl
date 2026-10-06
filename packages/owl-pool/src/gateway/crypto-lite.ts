/**
 * 网关域共享哈希工具 —— 与 manager `MessageDigest`/`HexFormat` 等价的 SHA-256 十六进制。
 */
import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
