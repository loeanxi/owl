/** A next-prompt hint grounded in the latest turn, shown until the model returns its own line. */
export function dynamicFollowUp(user: string, assistant: string): string | undefined {
	const topic = clip(user, 36);
	const reply = assistant.trim();
	if (!topic && !reply) return undefined;
	const chinese = /[\u4e00-\u9fff]/.test(`${user}\n${assistant}`);
	const question = [...reply.matchAll(/[^?？。!！\n]{4,}[?？]/g)].at(-1)?.[0]?.trim();
	if (question && !genericQuestion(question)) {
		const ask = clip(question.replace(/[?？]\s*$/, ""), chinese ? 32 : 56);
		return chinese ? `先说说：${ask}` : `Let's settle this: ${ask}`;
	}
	if (topic) {
		return chinese ? `接着「${topic}」，做下一小步并告诉我结果` : `Next step for “${topic}”, then show me the result`;
	}
	const offer = clip(reply, 36);
	return chinese ? `就按「${offer}」继续，并给我结果` : `Continue from “${offer}” and show me the result`;
}

export function latestTurn(entries: readonly { kind: string; text?: string; aborted?: boolean }[]): { user: string; assistant: string } | undefined {
	let assistant = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!assistant) {
			if (entry?.kind === "assistant" && entry.text?.trim() && !entry.aborted) assistant = entry.text.trim();
			continue;
		}
		if (entry?.kind === "user" && entry.text?.trim()) return { user: entry.text.trim(), assistant };
	}
	return assistant ? { user: "", assistant } : undefined;
}

function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

function genericQuestion(question: string): boolean {
	return /what can i help|how can i help|what would you like|你想|搞点什么|需要我做|帮你什么|有什么可以/i.test(question);
}
