/**
 * Bundled skills are copied into the cross-project skills directory next to the
 * agent dir (the directory Owl discovers global skills from). A user who turned
 * a skill off in settings must keep that switch across updates.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBundledSkills } from "../src/core/bundled-skills.ts";

const roots: string[] = [];

function makeAgentDir(): { agentDir: string; skillsDir: string } {
	const root = mkdtempSync(join(tmpdir(), "owl-bundled-skills-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return { agentDir, skillsDir: join(root, "skills") };
}

afterEach(() => {
	while (roots.length) {
		const root = roots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("installBundledSkills", () => {
	it("installs the bundled skills next to the agent dir", () => {
		const { agentDir, skillsDir } = makeAgentDir();

		installBundledSkills(agentDir);

		expect(existsSync(join(skillsDir, "control-in-app-browser", "SKILL.md"))).toBe(true);
		expect(existsSync(join(skillsDir, "html-plan", "SKILL.md"))).toBe(true);
		const skill = readFileSync(join(skillsDir, "control-in-app-browser", "SKILL.md"), "utf8");
		expect(skill).toMatch(/^name: control-in-app-browser$/m);
	});

	it("refreshes a stale bundled copy instead of leaving it behind", () => {
		const { agentDir, skillsDir } = makeAgentDir();
		const target = join(skillsDir, "control-in-app-browser");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "---\nname: control-in-app-browser\n---\nstale\n", "utf8");

		installBundledSkills(agentDir);

		const skill = readFileSync(join(target, "SKILL.md"), "utf8");
		expect(skill).not.toContain("stale");
		expect(skill).toContain("browser_query");
	});

	it("keeps the user's disable-model-invocation switch across updates", () => {
		const { agentDir, skillsDir } = makeAgentDir();
		const target = join(skillsDir, "control-in-app-browser");
		mkdirSync(target, { recursive: true });
		writeFileSync(
			join(target, "SKILL.md"),
			"---\nname: control-in-app-browser\ndisable-model-invocation: true\n---\nuser copy\n",
			"utf8",
		);

		installBundledSkills(agentDir);

		const skill = readFileSync(join(target, "SKILL.md"), "utf8");
		expect(skill).toMatch(/^disable-model-invocation: true$/m);
		expect(skill).toContain("browser_query");
	});

	it("does not add a disable switch the user never set", () => {
		const { agentDir, skillsDir } = makeAgentDir();

		installBundledSkills(agentDir);

		const skill = readFileSync(join(skillsDir, "control-in-app-browser", "SKILL.md"), "utf8");
		expect(skill).not.toMatch(/^disable-model-invocation:/m);
	});
});
