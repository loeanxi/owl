import { RESEARCH_PUBLISH_TOOL } from "./agent.ts";
import { RESEARCH_CHECKPOINT_TOOL } from "./checkpoint.ts";
import { RESEARCH_DECOMPILE_TOOL } from "./decompile-tools.ts";
import { RESEARCH_EXECUTABLE_TOOL } from "./executable-tools.ts";
import { RESEARCH_MODEL_LAB_TOOL } from "./model-lab.ts";
import { RESEARCH_REA_TOOL } from "./rea-tools.ts";

/** Research sessions expose their core capabilities and retain discovery of browser, MCP and plugin tools. */
export function researchToolLoadout(active: readonly string[]): string[] {
	return [
		...new Set([
			...active,
			RESEARCH_PUBLISH_TOOL,
			RESEARCH_CHECKPOINT_TOOL,
			RESEARCH_EXECUTABLE_TOOL,
			RESEARCH_DECOMPILE_TOOL,
			RESEARCH_MODEL_LAB_TOOL,
			RESEARCH_REA_TOOL,
			"tool_search",
			"skill_search",
		]),
	];
}
