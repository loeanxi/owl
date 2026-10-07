/** 生命监护的通道清单。纯数据，桌面和桥共用，不要在这里读文件。 */
import type { LifeLevel } from "./protocol.ts";

export type LifeGroup = "link" | "agent" | "bench" | "power" | "desk" | "body";

export interface LifeChannelDef {
	id: string;
	group: LifeGroup;
	span?: 2;
}

export const LIFE_GROUPS: LifeGroup[] = ["link", "agent", "bench", "power", "desk", "body"];

export const LIFE_CHANNELS: readonly LifeChannelDef[] = [
	{ id: "bridge", group: "link", span: 2 },
	{ id: "mcp", group: "link" },
	{ id: "package", group: "agent" },
	{ id: "subagent-entry", group: "agent" },
	{ id: "model", group: "agent" },
	{ id: "last-run", group: "agent" },
	{ id: "skills", group: "agent" },
	{ id: "plugins", group: "agent" },
	{ id: "prompts", group: "agent" },
	{ id: "memory", group: "agent" },
	{ id: "ask-user", group: "agent" },
	{ id: "safety-net", group: "agent" },
	{ id: "diff-approval", group: "agent" },
	{ id: "context", group: "agent" },
	{ id: "terminal", group: "bench" },
	{ id: "browser", group: "bench" },
	{ id: "files", group: "bench" },
	{ id: "editor", group: "bench" },
	{ id: "changes", group: "bench" },
	{ id: "document", group: "bench" },
	{ id: "drama", group: "bench" },
	{ id: "sidechat", group: "bench" },
	{ id: "image", group: "bench" },
	{ id: "tasks", group: "bench" },
	{ id: "impression", group: "bench" },
	{ id: "computer-use", group: "power" },
	{ id: "web-access", group: "power" },
	{ id: "genui", group: "power" },
	{ id: "office", group: "power" },
	{ id: "image-gen", group: "power" },
	{ id: "codemode", group: "power" },
	{ id: "billion", group: "power" },
	{ id: "background", group: "power" },
	{ id: "lens", group: "power" },
	{ id: "news", group: "desk" },
	{ id: "map", group: "desk" },
	{ id: "mail", group: "desk" },
	{ id: "media", group: "desk" },
	{ id: "evaluation", group: "desk" },
	{ id: "research", group: "desk" },
	{ id: "guide", group: "desk" },
	{ id: "career", group: "desk" },
	{ id: "myself", group: "desk" },
	{ id: "shell", group: "body" },
	{ id: "models", group: "body" },
	{ id: "sessions", group: "body" },
	{ id: "usage", group: "body" },
	{ id: "island", group: "body" },
	{ id: "notifications", group: "body" },
	{ id: "archive", group: "body" },
	{ id: "wallpaper", group: "body" },
];

/** 标题栏的点。红优先于黄，黄优先于灰，灰优先于绿。停用不计入。 */
export function summarizeLife(
	channels: readonly { level: LifeLevel }[],
	round: "ok" | "failed" | "down",
): { dot: "ok" | "bad" | "warn" | "idle"; count: number } {
	const count = channels.filter((item) => item.level === "bad" || item.level === "warn").length;
	if (channels.some((item) => item.level === "bad")) return { dot: "bad", count };
	if (channels.some((item) => item.level === "warn")) return { dot: "warn", count };
	if (round !== "ok" || channels.some((item) => item.level === "idle")) return { dot: "idle", count: 0 };
	return { dot: "ok", count: 0 };
}
