export type LifeLevel = "ok" | "bad" | "warn" | "idle" | "off";

export interface LifeChannel {
	id: string;
	level: LifeLevel;
	/** 短证据。不得包含 key、令牌、邮箱或完整本机路径。 */
	evidence: string;
	note: string;
	at: number;
}

export interface LifeProbeRequest {
	type: "life.probe";
	id: string;
	cwd?: string;
	/** 输入框当前选中的 `供应商/模型`。空表示没选。 */
	model?: string;
}

export interface LifeProbeResult {
	probedAt: number;
	channels: LifeChannel[];
}
