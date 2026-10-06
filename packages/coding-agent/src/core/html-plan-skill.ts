import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";

/**
 * Copy the bundled html-plan skill into ~/.owl/skills (sibling of the agent dir).
 * Owl discovers skills from that directory. A user who turned the skill off in
 * settings keeps that switch across updates.
 */
export function installHtmlPlanSkill(agentDir = getAgentDir()): void {
	const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "html-plan");
	if (!existsSync(join(bundled, "SKILL.md"))) return;

	const target = join(dirname(agentDir), "skills", "html-plan");
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
