import { parseUserMessage } from "./user-message.ts";

export type SkillInvocation = { name: string; rest: string };

/** 技能调用：核心把 `/skill:name 附言` 展开成整段 `<skill>` 块写进用户消息；乐观行还是未展开的命令。 */
export function parseSkillInvocation(text: string): SkillInvocation | undefined {
	const block = text.match(/^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/);
	if (block) return { name: block[1]!, rest: block[2]?.trim() ?? "" };
	const command = text.match(/^\/skill:(\S+)(?:\s+([\s\S]*))?$/);
	if (command) return { name: command[1]!, rest: command[2]?.trim() ?? "" };
	return undefined;
}

/** 用户消息的原文：去掉附件清单/图片提示，技能调用还原成短命令，乐观行与核心回传的展开文本由此对上。 */
export function userSourceText(text: string): string {
	const body = parseUserMessage(text).body;
	const skill = parseSkillInvocation(body);
	if (!skill) return body;
	return skill.rest ? `/skill:${skill.name} ${skill.rest}` : `/skill:${skill.name}`;
}
