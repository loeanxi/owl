/**
 * Foreground persistence is opt-in; ordinary task routing remains the model's responsibility.
 * 授权有两条路：用户本轮明确要求，或助手此前在对话里向用户承诺过记住——后者必须能当轮
 * 用工具兑现，否则门控会逼模型用「记下了」这类空话应付用户（承诺即授权，说出口就要落盘）。
 */
export const MEMORY_WRITE_GUIDANCE =
	"先完成用户当前要求的工作。remember 与 update_user_impression 只用于两种情况：用户本轮明确要求记住、保存到长期记忆或更新用户印象；或你此前已在回复里向用户承诺记住（说过「记下了/已记住」就必须当轮调用工具兑现，禁止只用嘴承诺）。" +
	"功能需求、截图里的目标效果、待办和助手自己的计划都不是已实现事实，不能记成现状；记录记忆也不代表完成原任务。" +
	"两者都不满足时不要写入，继续执行原任务，稳定信息的自动沉淀由后台处理。";

/**
 * Only recognizes direct Chinese/English memory requests, not general task intent.
 * Quoted material and code can contain instructions without authorizing persistence.
 */
export function hasExplicitMemoryRequest(prompt: string): boolean {
	const directText = prompt
		.replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "\n")
		.replace(/^\s*>[^\n]*(?:\n|$)/gm, "\n")
		.replace(/^(?: {4}|\t)[^\n]*(?:\n|$)/gm, "\n")
		.replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, "引用内容");
	// An explicit restriction on persistence takes precedence over a positive phrase.
	if (
		/(?:不要|不用|不必|无需|禁止|别)(?:再)?(?:记住|记下|保存|记录|写入|存入|记入)/u.test(directText) ||
		/只(?:在|用于|限于)?(?:本|这)(?:一|个|次)?(?:轮|会话|对话|聊天)/u.test(directText) ||
		/\b(?:do not|don't|never)\s+(?:remember|memorize|save|store|record)\b/iu.test(directText) ||
		/\bonly\s+(?:for|in|during)\s+(?:this|the current)\s+(?:session|conversation|chat|turn)\b/iu.test(directText)
	)
		return false;
	const clauses = directText.split(/[\n。.！？!?；;，,]+/);
	return clauses.some((clause) => {
		const text = clause.trim().replace(/^[-*]\s+/, "");
		const chinese = text.replace(/^(?:(?:请|麻烦)(?:你)?\s*)?(?:(?:帮|替|给)我\s*)?/u, "");
		const english = text.replace(/^(?:(?:and|also)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/iu, "");
		return (
			/^(?:长期)?(?:记住|记下|记一下|记下来|牢记)(?!了?[吗没]|什么|哪些|按钮|功能|工具|这个词|一词)/u.test(
				chinese,
			) ||
			/^(?:把|将).{1,160}?(?:记下来|记住|记下)(?:吧|[：:]|$)/u.test(chinese) ||
			/^(?:以后|今后).{0,100}?(?:帮我|替我|请你)(?:长期)?(?:记住|记下|记下来)(?:吧|[：:]|$)/u.test(chinese) ||
			/^(?:(?:把|将).{1,160}?)?(?:保存|记录|添加|存|写|记)(?:入|到|进)\s*(?:(?:你的|我的|Owl\s*的)\s*)?(?:(?:跨会话|长期|持久|全局|项目)\s*)?记忆(?:里|中|库)?(?:\s|[：:]|$)/iu.test(
				chinese,
			) ||
			/^(?:更新|保存|修改)(?:一下)?(?:你的|对我的)?用户印象(?:\s|[：:]|$)/u.test(chinese) ||
			/^(?:remember|memorize)\s+(?!button\b|function\b|tool\b|is\b|means\b)\S/iu.test(english) ||
			/^(?:save|store|add|record)\b.{0,160}\b(?:to|in|as)\s+(?:(?:your|my|long-term|cross-session|persistent)\s+)*memory\b/iu.test(
				english,
			) ||
			/^(?:update|save)\s+(?:(?:your|my|the)\s+)?(?:user profile|user impression)\b/iu.test(english)
		);
	});
}

/**
 * 助手对话内承诺检测：可见回复里说了「记下了/已记住/存进记忆」就视同接下了保存义务。
 * 只扫助手正文（调用方负责剔除 thinking、工具结果和引用材料），否定句和疑问不算承诺。
 */
const MEMORY_COMMIT_RE =
	/(?<!不[用要会]|别|没[有]?|无需|未)(?:(?:记(?:住|下)(?:了(?![吗嘛没])|(?![了吗嘛]))|真记了)|(?:记|存|写|保存)(?:进|入|到)?(?:了)?(?:长期|跨会话|全局)?记忆|(?:更新|保存)(?:了)?(?:一下)?(?:你的|对我的)?用户印象)/u;

export function assistantCommittedToMemory(text: string): boolean {
	return MEMORY_COMMIT_RE.test(text);
}

export function memoryWriteDenial(prompt: string, enabled: boolean, assistantCommitted = false): string | undefined {
	if (!enabled) return "未保存：跨会话记忆已关闭。继续处理当前任务，不要通过其他记忆工具绕过此设置。";
	if (hasExplicitMemoryRequest(prompt) || assistantCommitted) return undefined;
	return "未保存：本轮用户没有明确要求写入长期记忆，你也没有在对话里承诺过要记住。不要把功能需求、截图目标或待办记成已有事实；当前任务仍未完成，请继续读取相关资料并执行用户要求。";
}
