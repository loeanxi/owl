/** 生命监护的通道清单。纯数据，桌面和桥共用，不要在这里读文件。 */
import type { LifeLevel } from "./types.ts";

export type LifeGroup = "link" | "agent" | "bench" | "power" | "desk" | "body";

export interface LifeChannelDef {
	id: string;
	group: LifeGroup;
	/** 出问题时去设置里哪一页处理。 */
	fix?: "models" | "plugins" | "skills";
}

export const LIFE_GROUPS: LifeGroup[] = ["link", "agent", "bench", "power", "desk", "body"];

export const LIFE_CHANNELS: readonly LifeChannelDef[] = [
	{ id: "bridge", group: "link" },
	{ id: "mcp", group: "link" },
	{ id: "package", group: "agent", fix: "plugins" },
	{ id: "subagent-entry", group: "agent", fix: "plugins" },
	{ id: "model", group: "agent", fix: "models" },
	{ id: "last-run", group: "agent" },
	{ id: "skills", group: "agent", fix: "skills" },
	{ id: "plugins", group: "agent", fix: "plugins" },
	{ id: "prompts", group: "agent" },
	{ id: "memory", group: "agent" },
	{ id: "presets", group: "agent" },
	{ id: "trajectory", group: "agent" },
	{ id: "ask-user", group: "agent", fix: "plugins" },
	{ id: "safety-net", group: "agent", fix: "plugins" },
	{ id: "diff-approval", group: "agent", fix: "plugins" },
	{ id: "context", group: "agent", fix: "plugins" },
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
	{ id: "manager", group: "bench" },
	{ id: "computer-use", group: "power", fix: "plugins" },
	{ id: "web-access", group: "power", fix: "plugins" },
	{ id: "genui", group: "power", fix: "plugins" },
	{ id: "office", group: "power", fix: "plugins" },
	{ id: "image-gen", group: "power", fix: "plugins" },
	{ id: "codemode", group: "power" },
	{ id: "billion", group: "power", fix: "plugins" },
	{ id: "background", group: "power", fix: "plugins" },
	{ id: "lens", group: "power", fix: "plugins" },
	{ id: "news", group: "desk" },
	{ id: "map", group: "desk" },
	{ id: "mail", group: "desk" },
	{ id: "media", group: "desk", fix: "plugins" },
	{ id: "evaluation", group: "desk" },
	{ id: "research", group: "desk" },
	{ id: "guide", group: "desk", fix: "plugins" },
	{ id: "career", group: "desk" },
	{ id: "myself", group: "desk" },
	{ id: "projects", group: "desk" },
	{ id: "automation", group: "desk" },
	{ id: "expert", group: "desk" },
	{ id: "bagu", group: "desk" },
	{ id: "market", group: "desk" },
	{ id: "shell", group: "body" },
	{ id: "models", group: "body", fix: "models" },
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
