import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";

/** 随发行版一起安装的技能。 */
const BUNDLED_SKILLS = ["html-plan", "control-in-app-browser"] as const;

/**
 * Copy bundled skills into the global skills directory (the sibling of the
 * agent dir, `~/.owl/skills/` by default). Owl discovers skills from that
 * directory. A user who turned a skill off in settings keeps that switch
 * across updates.
 */
export function installBundledSkills(agentDir = getAgentDir()): void {
	for (const name of BUNDLED_SKILLS) installSkill(name, agentDir);
}

function installSkill(name: string, agentDir: string): void {
	const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", name);
	if (!existsSync(join(bundled, "SKILL.md"))) return;

	const target = join(dirname(agentDir), "skills", name);
	const targetSkill = join(target, "SKILL.md");
	const disabled =
		existsSync(targetSkill) && /^disable-model-invocation:\s*true\s*$/m.test(readFileSync(targetSkill, "utf8"));

	mkdirSync(target, { recursive: true });
	cpSync(bundled, target, { recursive: true });

	if (!disabled) return;
	const raw = readFileSync(targetSkill, "utf8");
	if (/^disable-model-invocation:/m.test(raw)) return;
	writeFileSync(targetSkill, raw.replace(/^---\r?\n/, "---\ndisable-model-invocation: true\n"), "utf8");
}
