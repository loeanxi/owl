import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSkill,
	deleteSkill,
	listSkills,
	parseProjectSelection,
	readSkill,
	resolveSkillRoots,
	selectionToPatterns,
	SkillCenterError,
	setSkillEnabled,
	updateSkill,
} from "../src/modes/desktop/skills-center.ts";
import { SYMLINKS_SUPPORTED } from "./capabilities.ts";

describe("skills-center", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `skills-center-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "owl", "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("maps the three tabs to the unified .owl directories", () => {
		const roots = resolveSkillRoots(cwd, agentDir);
		expect(roots.personal).toBe(join(agentDir, "skills"));
		expect(roots.global).toBe(join(tempDir, "owl", "skills"));
		expect(roots.project).toBe(join(cwd, ".owl", "skills"));
	});

	it("lists skills per tab and hides the project tab when untrusted", () => {
		mkdirSync(join(agentDir, "skills", "personal-one"), { recursive: true });
		writeFileSync(
			join(agentDir, "skills", "personal-one", "SKILL.md"),
			"---\nname: personal-one\ndescription: mine\n---\n",
		);
		mkdirSync(join(tempDir, "owl", "skills", "global-one"), { recursive: true });
		writeFileSync(
			join(tempDir, "owl", "skills", "global-one", "SKILL.md"),
			"---\nname: global-one\ndescription: shared\n---\n",
		);
		mkdirSync(join(cwd, ".owl", "skills", "project-one"), { recursive: true });
		writeFileSync(
			join(cwd, ".owl", "skills", "project-one", "SKILL.md"),
			"---\nname: project-one\ndescription: local\n---\n",
		);

		const untrusted = listSkills(cwd, false, agentDir);
		expect(untrusted.skills.map((s) => s.name).sort()).toEqual(["global-one", "personal-one"]);
		expect(untrusted.projectTrusted).toBe(false);

		const trusted = listSkills(cwd, true, agentDir);
		expect(trusted.skills.map((s) => s.name).sort()).toEqual(["global-one", "personal-one", "project-one"]);
	});

	it("creates a skill with frontmatter and rejects invalid or duplicate names", () => {
		const entry = createSkill(
			cwd,
			{ tab: "personal", name: "my-skill", description: "测试技能", body: "# 步骤" },
			true,
			agentDir,
		);
		expect(existsSync(join(entry.dir, "SKILL.md"))).toBe(true);
		const raw = readFileSync(entry.path, "utf-8");
		expect(raw).toContain("name: my-skill");
		expect(raw).toContain("description: 测试技能");
		expect(raw).toContain("# 步骤");

		expect(() =>
			createSkill(cwd, { tab: "personal", name: "Bad Name", description: "x", body: "" }, true, agentDir),
		).toThrow(SkillCenterError);
		expect(() =>
			createSkill(cwd, { tab: "personal", name: "my-skill", description: "x", body: "" }, true, agentDir),
		).toThrow(SkillCenterError);
		expect(() =>
			createSkill(cwd, { tab: "project", name: "proj-skill", description: "x", body: "" }, false, agentDir),
		).toThrow(SkillCenterError);
	});

	it("toggles disable-model-invocation in the frontmatter", () => {
		const entry = createSkill(cwd, { tab: "global", name: "toggle-me", description: "d", body: "b" }, true, agentDir);

		setSkillEnabled(cwd, { name: "toggle-me", path: entry.path, tab: "global", enabled: false }, agentDir);
		let raw = readFileSync(entry.path, "utf-8");
		expect(raw).toContain("disable-model-invocation: true");
		expect(listSkills(cwd, true, agentDir).skills.find((s) => s.name === "toggle-me")?.disabled).toBe(true);

		setSkillEnabled(cwd, { name: "toggle-me", path: entry.path, tab: "global", enabled: true }, agentDir);
		raw = readFileSync(entry.path, "utf-8");
		expect(raw).not.toContain("disable-model-invocation");
	});

	it("updates description and body in place, preserving name, location and disabled state", () => {
		const entry = createSkill(
			cwd,
			{ tab: "personal", name: "edit-me", description: "before", body: "old body" },
			true,
			agentDir,
		);
		setSkillEnabled(cwd, { name: "edit-me", path: entry.path, tab: "personal", enabled: false }, agentDir);

		updateSkill(
			cwd,
			{ name: "edit-me", path: entry.path, tab: "personal", description: "after", body: "new body" },
			agentDir,
		);

		const raw = readFileSync(entry.path, "utf-8");
		expect(raw).toContain("name: edit-me");
		expect(raw).toContain("description: after");
		expect(raw).toContain("new body");
		// 编辑不得静默重新启用已禁用的技能
		expect(raw).toContain("disable-model-invocation: true");
	});

	it("rejects writes with stale or wrong paths", () => {
		const entry = createSkill(
			cwd,
			{ tab: "personal", name: "guard-me", description: "d", body: "b" },
			true,
			agentDir,
		);
		expect(() =>
			updateSkill(
				cwd,
				{
					name: "guard-me",
					path: join(agentDir, "skills", "elsewhere", "SKILL.md"),
					tab: "personal",
					description: "x",
					body: "y",
				},
				agentDir,
			),
		).toThrow(/路径已变化/);
		expect(() => readSkill(cwd, { name: "missing-skill", path: entry.path, tab: "personal" }, agentDir)).toThrow(
			/找不到技能/,
		);
	});

	it("deletes into .trash and keeps the rest of the root intact", () => {
		const entry = createSkill(
			cwd,
			{ tab: "personal", name: "delete-me", description: "d", body: "b" },
			true,
			agentDir,
		);
		const kept = createSkill(cwd, { tab: "personal", name: "keep-me", description: "d", body: "b" }, true, agentDir);

		deleteSkill(cwd, { name: "delete-me", path: entry.path, tab: "personal" }, agentDir);

		expect(existsSync(entry.dir)).toBe(false);
		const trashDir = join(agentDir, "skills", ".trash");
		expect(existsSync(trashDir)).toBe(true);
		// 回收站条目带时间戳后缀：按前缀找
		const trashed = readdirSync(trashDir).find((name) => name.startsWith("delete-me"));
		expect(trashed).toBeDefined();
		expect(readFileSync(join(trashDir, trashed!, "SKILL.md"), "utf-8")).toContain("name: delete-me");
		expect(existsSync(join(kept.dir, "SKILL.md"))).toBe(true);
		// .trash 是点目录，不应出现在列表里
		expect(listSkills(cwd, true, agentDir).skills.map((s) => s.name)).not.toContain("delete-me");
	});

	it("rejects content over the 64KB cap", () => {
		const bigBody = "x".repeat(65 * 1024);
		expect(() =>
			createSkill(cwd, { tab: "personal", name: "too-big", description: "d", body: bigBody }, true, agentDir),
		).toThrow(/64KB/);
	});

	it("treats symlinked skills as list/enable-only", async () => {
		if (!SYMLINKS_SUPPORTED) return;
		// 真身放在 personal 根之外，链接进 global 根
		const targetDir = join(tempDir, "real-skill");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "SKILL.md"), "---\nname: linked\ndescription: linked\n---\n");
		const globalRoot = join(tempDir, "owl", "skills");
		mkdirSync(globalRoot, { recursive: true });
		const linkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(targetDir, join(globalRoot, "linked"), linkType);

		const listed = listSkills(cwd, true, agentDir).skills.find((s) => s.name === "linked");
		expect(listed?.isSymlink).toBe(true);

		// 启停允许（改写目标自身的 frontmatter）
		setSkillEnabled(cwd, { name: "linked", path: listed!.path, tab: "global", enabled: false }, agentDir);
		expect(readFileSync(join(targetDir, "SKILL.md"), "utf-8")).toContain("disable-model-invocation: true");

		expect(() =>
			updateSkill(cwd, { name: "linked", path: listed!.path, tab: "global", description: "x", body: "y" }, agentDir),
		).toThrow(/链接技能不可编辑/);
		expect(() => deleteSkill(cwd, { name: "linked", path: listed!.path, tab: "global" }, agentDir)).toThrow(
			/链接技能不可删除/,
		);
		// 链接目标安然无恙
		expect(existsSync(join(targetDir, "SKILL.md"))).toBe(true);
	});
});
