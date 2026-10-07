/**
 * 生命监护的廉价只读探测。
 *
 * 不发模型请求，不拉起子智能体，不把 key、令牌、邮箱或完整路径写进结果。
 * 桥能应答本身就说明本地桥是通的；桌面在请求失败时另把「本地桥」标成危急。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { getDefaultSessionDirPath } from "../../core/session-manager.ts";
import type { LifeChannel, LifeLevel, LifeProbeResult } from "./protocol.ts";

export { summarizeLife } from "./life-channels.ts";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

const PLUGIN_FOLDERS: Record<string, string> = {
	"ask-user": "owl-ask-user",
	"safety-net": "owl-safety-net",
	"diff-approval": "owl-diff-approval",
	context: "owl-context",
	"computer-use": "owl-computer-use",
	"web-access": "owl-web-access",
	genui: "owl-genui",
	office: "owl-univer-office",
	"image-gen": "owl-image",
	billion: "owl-billion-context",
	background: "owl-background-tasks",
	lens: "owl-lens",
	guide: "owl-life-guide",
	media: "owl-media-bridge",
	"subagent-entry": "owl-subagents",
};

const BENCH_KIND: Record<string, string> = {
	terminal: "terminal",
	browser: "browser",
	files: "files",
	editor: "editor",
	changes: "changes",
	document: "document",
	drama: "mirror",
	sidechat: "sidechat",
	image: "image",
	tasks: "tasks",
	impression: "impression",
};

interface PluginRef {
	source: string;
	disabled: boolean;
}

interface SettingsFile {
	shellPath?: string;
	mcpServers?: Record<string, unknown>;
	plugins?: unknown[];
	defaultTools?: string[];
	owlSidebar?: { disabledTabs?: unknown };
	owlNotifications?: unknown;
	owlWallpaper?: { enabled?: boolean };
	owlMemory?: { enabled?: boolean };
}

interface ProviderFile {
	baseUrl?: string;
	apiKey?: string;
	models?: { id?: string }[];
}

export interface LifeProbeInput {
	agentDir: string;
	cwd?: string;
	model?: string;
}

export function probeLife(input: LifeProbeInput): LifeProbeResult {
	const now = Date.now();
	const settings = readJson<SettingsFile>(join(input.agentDir, "settings.json"));
	const plugins = pluginRefs(settings?.plugins);
	const disabledTabs = stringList(settings?.owlSidebar?.disabledTabs);
	const packageBroken = !resolvePackage(plugins);
	const channels: LifeChannel[] = [
		channel("bridge", "ok", "up", "127.0.0.1", now),
		mcpChannel(settings, now),
		packageChannel(plugins, now),
		entryChannel(plugins, now),
		modelChannel(input, now),
		lastRunChannel(input, packageBroken, now),
		skillsChannel(input.agentDir, now),
		pluginsChannel(plugins, now),
		dirChannel("prompts", join(input.agentDir, "prompts"), now, true),
		memoryChannel(input.agentDir, settings, now),
		...pluginChannels(plugins, now),
		...benchChannels(disabledTabs, now),
		codemodeChannel(settings, now),
		mailChannel(input.agentDir, now),
		builtIn("news", now),
		builtIn("map", now),
		builtIn("evaluation", now),
		builtIn("research", now),
		builtIn("career", now),
		channel("myself", "off", "unwired", "rail", now),
		shellChannel(settings, now),
		modelsChannel(input.agentDir, now),
		sessionsChannel(input.agentDir, now),
		usageChannel(input.agentDir, now),
		builtIn("island", now),
		notificationsChannel(settings, now),
		archiveChannel(input.agentDir, now),
		wallpaperChannel(settings, now),
	];
	return { probedAt: now, channels };
}

export function interpretLatest(text: string | undefined, packageBroken: boolean): { level: LifeLevel; note: string } {
	if (text === undefined) return { level: "ok", note: "none" };
	const missing = /Cannot find package/i.test(text);
	const failed = missing || /Subagent run failed/i.test(text);
	if (!failed) return { level: "ok", note: "wrote" };
	if (packageBroken && missing) return { level: "ok", note: "explained" };
	return { level: "warn", note: "failed" };
}

function channel(id: string, level: LifeLevel, note: string, evidence: string, at: number): LifeChannel {
	return { id, level, note, evidence, at };
}

function builtIn(id: string, at: number): LifeChannel {
	return channel(id, "ok", "built-in", id, at);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pluginRefs(raw: unknown): PluginRef[] {
	if (!Array.isArray(raw)) return [];
	const refs: PluginRef[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim()) refs.push({ source: item, disabled: false });
		else if (item && typeof item === "object" && typeof (item as { source?: unknown }).source === "string") {
			const source = (item as { source: string; disabled?: unknown }).source;
			refs.push({ source, disabled: (item as { disabled?: unknown }).disabled === true });
		}
	}
	return refs;
}

function findPlugin(plugins: readonly PluginRef[], folder: string): PluginRef | undefined {
	return plugins.find((item) => basename(item.source.replace(/[\\/]+$/, "")) === folder);
}

function pluginFile(plugins: readonly PluginRef[], folder: string, relative: string): string | undefined {
	const plugin = findPlugin(plugins, folder);
	if (!plugin) return undefined;
	const path = join(plugin.source, relative);
	return existsSync(path) ? path : undefined;
}

function resolvePackage(plugins: readonly PluginRef[]): boolean {
	const child = childSessionFile(plugins);
	if (!child) return false;
	try {
		createRequire(child).resolve(PACKAGE_NAME);
		return true;
	} catch {
		return false;
	}
}

function childSessionFile(plugins: readonly PluginRef[]): string | undefined {
	for (const relative of [
		"src/runs/shared/child-session.js",
		"src/runs/shared/child-session.ts",
		"dist/runs/shared/child-session.js",
	]) {
		const path = pluginFile(plugins, "owl-subagents", relative);
		if (path) return path;
	}
	return undefined;
}

function packageChannel(plugins: readonly PluginRef[], now: number): LifeChannel {
	const child = childSessionFile(plugins);
	if (!child) return channel("package", "idle", "read-failed", PACKAGE_NAME, now);
	const at = mtime(child);
	if (resolvePackage(plugins)) return channel("package", "ok", "ok", PACKAGE_NAME, at);
	return channel("package", "bad", "missing", PACKAGE_NAME, at);
}

function entryChannel(plugins: readonly PluginRef[], now: number): LifeChannel {
	const plugin = findPlugin(plugins, "owl-subagents");
	if (!plugin) return channel("subagent-entry", "warn", "absent", "owl-subagents", now);
	if (plugin.disabled) return channel("subagent-entry", "off", "disabled", "owl-subagents", now);
	const child = childSessionFile(plugins);
	if (!child) return channel("subagent-entry", "bad", "missing", "owl-subagents", now);
	return channel("subagent-entry", "ok", "ok", "child-session.js", mtime(child));
}

function mcpChannel(settings: SettingsFile | undefined, now: number): LifeChannel {
	if (!settings) return channel("mcp", "idle", "read-failed", "mcpServers", now);
	const names = Object.keys(settings.mcpServers ?? {});
	return channel("mcp", "ok", names.length > 0 ? "named" : "empty", names.join(", ") || "0", now);
}

function modelChannel(input: LifeProbeInput, now: number): LifeChannel {
	const selected = input.model?.trim() ?? "";
	const slash = selected.indexOf("/");
	if (!selected || slash <= 0) return channel("model", "warn", "unselected", "provider/model", now);
	const providerId = selected.slice(0, slash);
	const modelId = selected.slice(slash + 1);
	const models = readJson<{ providers?: Record<string, ProviderFile> }>(join(input.agentDir, "models.json"));
	const provider = models?.providers?.[providerId];
	if (!provider) return channel("model", "warn", "unknown", providerId, now);
	if (!provider.baseUrl?.trim()) return channel("model", "warn", "no-url", providerId, now);
	const local = /^https?:\/\/(127\.0\.0\.1|localhost)\b/i.test(provider.baseUrl);
	const declaredKey = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
	if (!declaredKey && !local && !authReady(input.agentDir, providerId)) {
		return channel("model", "warn", "no-key", providerId, now);
	}
	if (!(provider.models ?? []).some((item) => item.id === modelId)) {
		return channel("model", "warn", "unknown-model", modelId, now);
	}
	return channel("model", "ok", "ok", `${providerId}/${modelId}`, mtime(join(input.agentDir, "models.json")));
}

function authReady(agentDir: string, providerId: string): boolean {
	const auth = readJson<Record<string, { type?: string }>>(join(agentDir, "auth.json"));
	const entry = auth?.[providerId];
	return entry?.type === "api_key" || entry?.type === "oauth";
}

function lastRunChannel(input: LifeProbeInput, packageBroken: boolean, now: number): LifeChannel {
	if (!input.cwd?.trim()) return channel("last-run", "ok", "no-project", "", now);
	let dir: string;
	try {
		dir = join(getDefaultSessionDirPath(input.cwd, input.agentDir), "subagent-artifacts");
	} catch {
		return channel("last-run", "idle", "read-failed", "subagent-artifacts", now);
	}
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith("_output.md"));
	} catch {
		return channel("last-run", "ok", "none", "subagent-artifacts", now);
	}
	if (names.length === 0) return channel("last-run", "ok", "none", "subagent-artifacts", now);
	let newest = names[0]!;
	let newestAt = 0;
	for (const name of names) {
		const at = mtime(join(dir, name));
		if (at >= newestAt) {
			newest = name;
			newestAt = at;
		}
	}
	let text = "";
	try {
		text = readFileSync(join(dir, newest), "utf-8").slice(0, 2000);
	} catch {
		return channel("last-run", "idle", "read-failed", newest, newestAt || now);
	}
	const judged = interpretLatest(text, packageBroken);
	return channel("last-run", judged.level, judged.note, newest, newestAt || now);
}

function skillsChannel(agentDir: string, now: number): LifeChannel {
	const candidates = [join(agentDir, "skills"), join(agentDir, "..", "skills")];
	const found = candidates.find((path) => existsSync(path));
	if (!found) return channel("skills", "warn", "absent", "skills", now);
	return channel("skills", "ok", "ok", "skills", mtime(found));
}

function pluginsChannel(plugins: readonly PluginRef[], now: number): LifeChannel {
	if (plugins.length === 0) return channel("plugins", "warn", "empty", "0", now);
	return channel("plugins", "ok", "ok", String(plugins.length), now);
}

function pluginChannels(plugins: readonly PluginRef[], now: number): LifeChannel[] {
	return Object.entries(PLUGIN_FOLDERS)
		.filter(([id]) => id !== "subagent-entry")
		.map(([id, folder]) => {
			const plugin = findPlugin(plugins, folder);
			if (!plugin) return channel(id, "warn", "absent", folder, now);
			if (plugin.disabled) return channel(id, "off", "disabled", folder, now);
			if (!existsSync(plugin.source)) return channel(id, "bad", "missing", folder, now);
			return channel(id, "ok", "ok", folder, mtime(plugin.source));
		});
}

function benchChannels(disabled: readonly string[], now: number): LifeChannel[] {
	return Object.entries(BENCH_KIND).map(([id, kind]) =>
		disabled.includes(kind) ? channel(id, "off", "disabled", kind, now) : channel(id, "ok", "built-in", kind, now),
	);
}

function codemodeChannel(settings: SettingsFile | undefined, now: number): LifeChannel {
	const tools = settings?.defaultTools ?? [];
	if (tools.includes("-codemode")) return channel("codemode", "off", "disabled", "codemode", now);
	return channel("codemode", "ok", tools.includes("+codemode") ? "ok" : "built-in", "codemode", now);
}

function mailChannel(agentDir: string, now: number): LifeChannel {
	const path = join(agentDir, "mail", "accounts.json");
	const data = readJson<{ accounts?: unknown[] }>(path);
	if (!data) return channel("mail", "warn", "no-account", "0", now);
	const count = Array.isArray(data.accounts) ? data.accounts.length : 0;
	if (count === 0) return channel("mail", "warn", "no-account", "0", now);
	return channel("mail", "ok", "ok", String(count), mtime(path));
}

function shellChannel(settings: SettingsFile | undefined, now: number): LifeChannel {
	const shell = settings?.shellPath?.trim() ?? "";
	if (!shell) return channel("shell", "ok", "default", "system", now);
	if (!existsSync(shell)) return channel("shell", "warn", "missing", basename(shell), now);
	return channel("shell", "ok", "ok", basename(shell), mtime(shell));
}

function modelsChannel(agentDir: string, now: number): LifeChannel {
	const path = join(agentDir, "models.json");
	const models = readJson<{ providers?: Record<string, unknown> }>(path);
	if (!models) return channel("models", "warn", "absent", "models.json", now);
	const count = Object.keys(models.providers ?? {}).length;
	if (count === 0) return channel("models", "warn", "empty", "0", now);
	return channel("models", "ok", "ok", String(count), mtime(path));
}

function sessionsChannel(agentDir: string, now: number): LifeChannel {
	const path = join(agentDir, "Owl-history");
	if (!existsSync(path)) return channel("sessions", "warn", "absent", "Owl-history", now);
	return channel("sessions", "ok", "ok", "Owl-history", mtime(path));
}

function usageChannel(agentDir: string, now: number): LifeChannel {
	const path = join(agentDir, "usage-stats.json");
	if (!existsSync(path) && !existsSync(join(agentDir, "Owl-history"))) {
		return channel("usage", "warn", "absent", "usage-stats", now);
	}
	return channel("usage", "ok", "ok", "usage-stats", existsSync(path) ? mtime(path) : now);
}

function notificationsChannel(settings: SettingsFile | undefined, now: number): LifeChannel {
	if (!settings?.owlNotifications || typeof settings.owlNotifications !== "object") {
		return channel("notifications", "ok", "default", "notifications", now);
	}
	return channel("notifications", "ok", "ok", "notifications", now);
}

function archiveChannel(agentDir: string, now: number): LifeChannel {
	const path = join(agentDir, "Owl-history", "archive.json");
	return channel(
		"archive",
		"ok",
		existsSync(path) ? "ok" : "built-in",
		"archive",
		existsSync(path) ? mtime(path) : now,
	);
}

function wallpaperChannel(settings: SettingsFile | undefined, now: number): LifeChannel {
	if (!settings) return channel("wallpaper", "idle", "read-failed", "owlWallpaper", now);
	if (settings.owlWallpaper?.enabled === true) return channel("wallpaper", "ok", "on", "owlWallpaper", now);
	return channel("wallpaper", "ok", "off", "owlWallpaper", now);
}

function memoryChannel(agentDir: string, settings: SettingsFile | undefined, now: number): LifeChannel {
	if (settings?.owlMemory?.enabled === false) return channel("memory", "off", "disabled", "memories", now);
	const path = join(agentDir, "memories");
	return channel("memory", "ok", existsSync(path) ? "ok" : "empty", "memories", existsSync(path) ? mtime(path) : now);
}

function dirChannel(id: string, path: string, now: number, missingIsEmpty: boolean): LifeChannel {
	if (!existsSync(path))
		return channel(id, missingIsEmpty ? "ok" : "warn", missingIsEmpty ? "empty" : "absent", basename(path), now);
	return channel(id, "ok", "ok", basename(path), mtime(path));
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return Date.now();
	}
}
