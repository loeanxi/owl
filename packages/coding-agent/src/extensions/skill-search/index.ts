import { Type } from "typebox";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { Skill } from "../../core/skills.ts";
import { Bm25Ranker } from "../tool-search/tool.ts";

/** Full metadata stays in the host; only a bounded search result enters the conversation. */
export function searchSkills(skills: readonly Skill[], query: string, offset = 0, limit = 5): Skill[] {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (!query.trim()) return visible.slice(offset, offset + limit);
	const exact = visible.filter((skill) => skill.name.toLowerCase() === query.trim().toLowerCase());
	const documents = visible.map((skill) => ({ name: skill.name, text: `${skill.name} ${skill.description}` }));
	const matches = new Bm25Ranker().rank(query, documents, visible.length);
	const names = [...new Set([...exact.map((skill) => skill.name), ...matches.map((match) => match.name)])];
	const byName = new Map(visible.map((skill) => [skill.name, skill]));
	return names.slice(offset, offset + limit).flatMap((name) => {
		const skill = byName.get(name);
		return skill ? [skill] : [];
	});
}

export function createSkillSearchExtension(): ExtensionFactory {
	return (pi) => {
		const catalogs = new Map<string, { skills: Skill[] }>();
		pi.on("before_agent_start", (event, ctx) => {
			// Retain the shared options object so later handlers' skill selection is respected.
			catalogs.set(ctx.sessionManager.getSessionId(), event.systemPromptOptions);
		});
		pi.on("session_shutdown", () => catalogs.clear());
		pi.registerTool({
			name: "skill_search",
			label: "Find a skill",
			description:
				"Find installed skills by task or exact name. Returns matching descriptions and SKILL.md paths to read before specialized work. Empty query browses with offset/limit. A skill describes a workflow; it does not prove tools or dependencies are available.",
			promptSnippet: "Find relevant skill instructions and their file paths",
			exposure: "model-only",
			parameters: Type.Object({
				query: Type.String({ description: "Task, skill name, or empty string to browse" }),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
			}),
			async execute(_toolCallId, { query, offset = 0, limit = 5 }, _signal, _onUpdate, ctx) {
				const catalog = catalogs.get(ctx.sessionManager.getSessionId())?.skills ?? [];
				const matches = searchSkills(catalog, query, offset, limit);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								skills: matches.map(({ name, description, filePath }) => ({
									name,
									description,
									path: filePath,
								})),
								offset,
								returned: matches.length,
								catalogSize: catalog.filter((skill) => !skill.disableModelInvocation).length,
								hint: matches.length
									? "Read the matching SKILL.md before using it."
									: "Try a skill name, broader terms, or an empty query to browse.",
							}),
						},
					],
					details: {},
				};
			},
		});
	};
}

export default createSkillSearchExtension();
