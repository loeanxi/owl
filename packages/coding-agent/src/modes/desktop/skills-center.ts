/**
 * 技能中心（设置页 skills.* 路由的后端）：三级目录的浏览与 CRUD。
 *
 * 目录统一为 .owl：个人 = ~/.owl/agent/skills，全局 = ~/.owl/skills，
 * 项目 = <cwd>/.owl/skills。解析复用 core 的 loadSkillsFromDir，保证这里
 * 看到的技能与模型实际加载的一致；本模块不改变加载/注入语义，纯管理层。
 *
 * 安全模型（对齐写路径的唯一事实来源）：
 * - 写操作必须带「名字 + 路径」，执行前重新扫描并要求解析到同名且规范化路径
 *   完全一致的技能 —— 过期路径与同名回退一律拒绝。
 * - 符号链接技能（SKILL.md 或其任一祖先目录是链接）：可列表、可启停（改写
 *   链接目标自身的 frontmatter），禁止编辑与删除（会越出当前 skill 根）。
 * - 删除移入 <根>/.trash/（点目录，扫描器跳过，可手工恢复）。
 * - 创建/编辑内容上限 64KB；名称/描述按 Agent Skills 规范校验。
 */

import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { getAgentDir, getGlobalSkillsDir } from "../../config.ts";
import { isEnabledByOverrides } from "../../core/package-manager.ts";
import { loadSkillsFromDir, type SkillFrontmatter, validateDescription, validateName } from "../../core/skills.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type {
	SkillCenterEntry,
	SkillCenterRoots,
	SkillCenterTab,
	SkillsListResult,
	SkillsReadResult,
} from "./protocol.ts";

/** 创建/编辑的内容上限（正文 + 描述合计），与 DSH 技能中心一致。 */
const MAX_CONTENT_BYTES = 64 * 1024;

export class SkillCenterError extends Error {}

/** 三个 tab 的根目录（cwd 决定项目根）。 */
export function resolveSkillRoots(cwd: string, agentDir?: string): SkillCenterRoots {
	const base = agentDir ?? getAgentDir();
	return {
		personal: join(base, "skills"),
		global: agentDir ? join(dirname(agentDir), "skills") : getGlobalSkillsDir(),
		project: join(resolve(cwd), ".owl", "skills"),
	};
}

/** SKILL.md 或其从根下来的任一祖先目录是符号链接。 */
function isPathSymlink(target: string, root: string): boolean {
	const from = resolve(root);
	const rel = relative(from, resolve(target));
	if (rel.startsWith("..")) return false;
	let current = from;
	for (const seg of rel.split(sep)) {
		if (!seg) continue;
		current = join(current, seg);
		try {
			if (lstatSync(current).isSymbolicLink()) return true;
		} catch {
			return false;
		}
	}
	return false;
}

/** 扫描一个根目录，产出该 tab 的技能列表（同名先发现者胜，与 core 一致）。 */
function scanTab(tab: SkillCenterTab, root: string): SkillCenterEntry[] {
	const { skills } = loadSkillsFromDir({ dir: root, source: tab });
	const seen = new Set<string>();
	const entries: SkillCenterEntry[] = [];
	for (const skill of skills) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		entries.push({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
			dir: skill.baseDir,
			tab,
			disabled: skill.disableModelInvocation,
			isSymlink: isPathSymlink(skill.filePath, root),
			projectEnabled: true,
		});
	}
	return entries;
}

/**
 * 列出三个 tab 的全部技能（单 tab 失败不影响其他 tab）。
 * `skillOverrides` 是该项目 settings.json 的 skills 覆盖模式：有配置时逐条
 * 计算 projectEnabled（与 core 的 isEnabledByOverrides 同一实现），UI 的
 * 「勾选本项目需要的技能」直接以此渲染。
 */
export function listSkills(
	cwd: string,
	projectTrusted: boolean,
	agentDir?: string,
	skillOverrides?: string[],
): SkillsListResult {
	const roots = resolveSkillRoots(cwd, agentDir);
	const skills: SkillCenterEntry[] = [];
	for (const tab of ["personal", "global", "project"] as const) {
		if (tab === "project" && !projectTrusted) continue;
		try {
			const entries = scanTab(tab, roots[tab]);
			if (skillOverrides) {
				const baseDir = dirname(roots[tab]);
				for (const entry of entries) {
					entry.projectEnabled = isEnabledByOverrides(entry.path, skillOverrides, baseDir);
				}
			}
			skills.push(...entries);
		} catch {
			// 单个根读不了（权限等）就跳过，不让整个面板挂掉
		}
	}
	return { roots, skills, projectTrusted, projectSkillPatterns: skillOverrides ?? [] };
}

/** 项目 skills 模式的三种形态：未配置（全部可用）/ 纯名字勾选 / 含手写 glob 的自定义模式。 */
export type ProjectSelection =
	| { kind: "default" }
	| { kind: "names"; names: string[] }
	| { kind: "custom"; patterns: string[] };

export function parseProjectSelection(patterns: string[]): ProjectSelection {
	if (!patterns || patterns.length === 0) return { kind: "default" };
	const plain = patterns.every((p) => !p.startsWith("+") && !p.startsWith("-") && !p.startsWith("!"));
	return plain ? { kind: "names", names: [...patterns] } : { kind: "custom", patterns: [...patterns] };
}

/** 勾选结果 → settings.skills 模式：空勾选 = 全部禁用（!**）；否则纯名字列表。 */
export function selectionToPatterns(selectedNames: string[]): string[] {
	if (selectedNames.length === 0) return ["!**"];
	return [...selectedNames];
}

/** 写操作共用的身份校验：重新扫描并要求同名且路径精确一致。 */
function resolveForWrite(
	roots: SkillCenterRoots,
	tab: SkillCenterTab,
	name: string,
	claimedPath: string,
): SkillCenterEntry {
	const root = roots[tab];
	if (!root || !existsSync(root)) {
		throw new SkillCenterError(`技能根目录不存在：${root}`);
	}
	const entry = scanTab(tab, root).find((s) => s.name === name);
	if (!entry) {
		throw new SkillCenterError(`找不到技能「${name}」（可能已被删除或重命名）`);
	}
	if (resolve(entry.path) !== resolve(claimedPath)) {
		throw new SkillCenterError(`技能「${name}」的路径已变化，操作被拒绝（请刷新后重试）`);
	}
	return entry;
}

/** 单文件技能（根级散 .md）与其余（目录技能）的落盘形态判断。 */
function isSingleFileSkill(entry: SkillCenterEntry): boolean {
	return basename(entry.path) !== "SKILL.md";
}

function readRaw(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch (error) {
		throw new SkillCenterError(`无法读取技能文件：${error instanceof Error ? error.message : String(error)}`);
	}
}

function assertWritableSize(description: string, body: string): void {
	if (Buffer.byteLength(description, "utf-8") + Buffer.byteLength(body, "utf-8") > MAX_CONTENT_BYTES) {
		throw new SkillCenterError("内容超过 64KB 上限");
	}
}

/** 重建 SKILL.md：保留既有 frontmatter 的其余键，仅替换描述与正文。 */
function serializeSkillMd(frontmatter: SkillFrontmatter, body: string): string {
	const clean = body.replace(/\r\n/g, "\n").trim();
	const yamlText = yamlStringify(frontmatter, { lineWidth: 0 }).trimEnd();
	return `---\n${yamlText}\n---\n\n${clean}\n`;
}

export function readSkill(
	cwd: string,
	input: { name: string; path: string; tab: SkillCenterTab },
	agentDir?: string,
): SkillsReadResult {
	const roots = resolveSkillRoots(cwd, agentDir);
	const entry = resolveForWrite(roots, input.tab, input.name, input.path);
	const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(readRaw(entry.path));
	return {
		name: entry.name,
		description: typeof frontmatter.description === "string" ? frontmatter.description : entry.description,
		body,
		disabled: entry.disabled,
		isSymlink: entry.isSymlink,
	};
}

/** 启停 = 改写 frontmatter 的 disable-model-invocation（链接技能改写目标自身）。 */
export function setSkillEnabled(
	cwd: string,
	input: { name: string; path: string; tab: SkillCenterTab; enabled: boolean },
	agentDir?: string,
): void {
	const roots = resolveSkillRoots(cwd, agentDir);
	const entry = resolveForWrite(roots, input.tab, input.name, input.path);
	const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(readRaw(entry.path));
	if (input.enabled) {
		delete frontmatter["disable-model-invocation"];
	} else {
		frontmatter["disable-model-invocation"] = true;
	}
	writeFileSync(entry.path, serializeSkillMd(frontmatter, body), "utf-8");
}

/** 创建新技能（目录 + SKILL.md）。 */
export function createSkill(
	cwd: string,
	input: { tab: SkillCenterTab; name: string; description: string; body: string },
	projectTrusted: boolean,
	agentDir?: string,
): SkillCenterEntry {
	if (input.tab === "project" && !projectTrusted) {
		throw new SkillCenterError("项目尚未信任，无法写入项目技能");
	}
	const name = input.name.trim();
	if (!/^[a-z0-9-]+$/.test(name)) {
		throw new SkillCenterError("技能名只能包含小写字母、数字和连字符（不可开头/结尾或连续连字符）");
	}
	const nameErrors = validateName(name);
	if (nameErrors.length > 0) {
		throw new SkillCenterError(`技能名不合法：${nameErrors[0]}`);
	}
	const descErrors = validateDescription(input.description);
	if (descErrors.length > 0) {
		throw new SkillCenterError(`描述不合法：${descErrors[0]}`);
	}
	assertWritableSize(input.description, input.body);

	const roots = resolveSkillRoots(cwd, agentDir);
	const root = roots[input.tab];
	if (input.tab === "personal" || input.tab === "global") {
		try {
			mkdirSync(root, { recursive: true });
		} catch (error) {
			throw new SkillCenterError(`无法创建技能根目录：${error instanceof Error ? error.message : String(error)}`);
		}
	} else if (!existsSync(root)) {
		throw new SkillCenterError(`项目技能根目录不存在：${root}`);
	}

	const skillDir = join(root, name);
	if (existsSync(skillDir)) {
		throw new SkillCenterError(`同名技能已存在：${name}`);
	}
	try {
		mkdirSync(skillDir, { recursive: true });
	} catch (error) {
		throw new SkillCenterError(`无法创建技能目录：${error instanceof Error ? error.message : String(error)}`);
	}
	const frontmatter: SkillFrontmatter = { name, description: input.description };
	writeFileSync(join(skillDir, "SKILL.md"), serializeSkillMd(frontmatter, input.body), "utf-8");
	return {
		name,
		description: input.description,
		path: join(skillDir, "SKILL.md"),
		dir: skillDir,
		tab: input.tab,
		disabled: false,
		isSymlink: false,
		projectEnabled: true,
	};
}

/** 原地编辑：名称与位置不变，保留现有 frontmatter 其余键与启停状态。 */
export function updateSkill(
	cwd: string,
	input: { name: string; path: string; tab: SkillCenterTab; description: string; body: string },
	agentDir?: string,
): void {
	const roots = resolveSkillRoots(cwd, agentDir);
	const entry = resolveForWrite(roots, input.tab, input.name, input.path);
	if (entry.isSymlink) {
		throw new SkillCenterError("链接技能不可编辑（改写会越出当前技能根）");
	}
	const descErrors = validateDescription(input.description);
	if (descErrors.length > 0) {
		throw new SkillCenterError(`描述不合法：${descErrors[0]}`);
	}
	assertWritableSize(input.description, input.body);
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readRaw(entry.path));
	// 名称、位置与 disable-model-invocation 原样保留 —— 编辑不得静默重新启用已禁用的技能
	const next: SkillFrontmatter = {
		...frontmatter,
		name: entry.name,
		description: input.description,
	};
	writeFileSync(entry.path, serializeSkillMd(next, input.body), "utf-8");
}

/** 删除 = 移入 <根>/.trash/（带时间戳，可手工恢复）。链接技能拒绝。 */
export function deleteSkill(
	cwd: string,
	input: { name: string; path: string; tab: SkillCenterTab },
	agentDir?: string,
): void {
	const roots = resolveSkillRoots(cwd, agentDir);
	const entry = resolveForWrite(roots, input.tab, input.name, input.path);
	if (entry.isSymlink) {
		throw new SkillCenterError("链接技能不可删除（删除会把链接目标移出原位）");
	}
	const root = roots[input.tab];
	const trashDir = join(root, ".trash");
	try {
		mkdirSync(trashDir, { recursive: true });
	} catch (error) {
		throw new SkillCenterError(`无法创建回收站目录：${error instanceof Error ? error.message : String(error)}`);
	}
	const single = isSingleFileSkill(entry);
	const source = single ? entry.path : entry.dir;
	const trashName = `${basename(source)}-${Date.now()}`;
	const dest = join(trashDir, trashName);
	try {
		renameSync(source, dest);
	} catch {
		// 跨设备 rename 会失败（EXDEV）：回退到复制 + 删除
		try {
			if (single) {
				copyFileSync(source, dest);
				rmSync(source);
			} else {
				copyDirSync(source, dest);
				rmSync(source, { recursive: true, force: true });
			}
		} catch (fallbackError) {
			// 复制也失败：把已搬走的部分收回来
			try {
				rmSync(dest, { recursive: true, force: true });
			} catch {
				// 忽略清理失败
			}
			throw new SkillCenterError(
				`无法删除技能：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
			);
		}
	}
}

function copyDirSync(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const from = join(src, entry.name);
		const to = join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(from, to);
		} else if (entry.isFile()) {
			copyFileSync(from, to);
		}
	}
}
