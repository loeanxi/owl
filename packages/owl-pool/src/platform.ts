/**
 * 支持的上游平台 —— 移植自 manager `account/Platform`（Java 枚举 → 字面量联合，
 * 枚举名逐字保留，数据库里的历史数据零转换）。
 * 新增平台：追加字面量 + 实现对应 Provider。
 */
export const PLATFORMS = [
	"WORKBUDDY",
	"TRAE",
	"CODEX",
	"CURSOR",
	"COPILOT",
	"QODER",
	"ZCODE",
	"MIMO",
	/** Anthropic：Claude OAuth 订阅号（Claude Code 客户端身份）+ API Key，Anthropic Messages 直连。 */
	"CLAUDE",
	/** Google Gemini：AI Studio API Key，Gemini generateContent 协议直连。 */
	"GEMINI",
	/** xAI Grok：API Key，OpenAI 兼容协议直连。 */
	"GROK",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
	return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** 这些平台经 Node SDK 桥（manager/bridge 子进程，stdio JSON 行协议）转发。 */
export function usesSdkBridge(platform: Platform): boolean {
	return platform === "CURSOR" || platform === "COPILOT" || platform === "QODER";
}
