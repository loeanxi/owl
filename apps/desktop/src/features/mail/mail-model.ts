import type {
	MailAccount,
	MailAgentContext,
	MailDraft,
	MailThreadList,
	MailThreadRef,
	MailThreadSummary,
} from "../../../../../packages/coding-agent/src/core/mail/types.ts";

/** Gmail thread IDs are unique within an account, not across accounts. */
export function mailThreadKey(ref: MailThreadRef): string {
	return JSON.stringify([ref.accountId, ref.threadId]);
}

export function summaryRef(thread: MailThreadSummary): MailThreadRef {
	return { accountId: thread.accountId, threadId: thread.id };
}

export function readableAccounts(accounts: MailAccount[]): MailAccount[] {
	return accounts.filter((account) => account.status === "connected" && account.capabilities.read);
}

/** Merge paged results without leaking duplicate IDs or losing per-account failures. */
export function mergeMailPage(current: MailThreadList, page: MailThreadList): MailThreadList {
	const threads = new Map(current.threads.map((thread) => [mailThreadKey(summaryRef(thread)), thread]));
	for (const thread of page.threads) threads.set(mailThreadKey(summaryRef(thread)), thread);
	return {
		threads: [...threads.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
		nextPageTokens: page.nextPageTokens,
		errors: [
			...current.errors.filter((previous) => !page.errors.some((next) => previous.accountId === next.accountId)),
			...page.errors,
		],
	};
}

export function threadContext(refs: MailThreadRef[]): MailAgentContext {
	const unique = [...new Map(refs.map((ref) => [mailThreadKey(ref), ref])).values()];
	return { mode: "threads", accountIds: [...new Set(unique.map((ref) => ref.accountId))], threads: unique };
}

export function sameMailContext(a: MailAgentContext, b: MailAgentContext): boolean {
	return (
		a.mode === b.mode &&
		JSON.stringify([...a.accountIds].sort()) === JSON.stringify([...b.accountIds].sort()) &&
		JSON.stringify((a.threads ?? []).map(mailThreadKey).sort()) ===
			JSON.stringify((b.threads ?? []).map(mailThreadKey).sort())
	);
}

/** Remote draft IDs do not change the message the user approved. */
export function sameMailDraft(a: MailDraft, b: MailDraft): boolean {
	return (["accountId", "threadId", "to", "cc", "bcc", "subject", "body", "inReplyTo", "references"] as const).every(
		(field) => (a[field] ?? "") === (b[field] ?? ""),
	);
}

/** Only successful, scoped mailbox reads become clickable source references. */
export function mailReadSource(
	value: unknown,
	context: MailAgentContext,
): (MailThreadRef & { subject: string }) | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	if (event.toolName !== "mail_read_thread" || event.isError === true) return undefined;
	const result = event.type === "tool_execution_end" ? event.result : event.role === "toolResult" ? event : undefined;
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const thread = (details as { thread?: unknown }).thread;
	if (!thread || typeof thread !== "object") return undefined;
	const item = thread as { accountId?: unknown; id?: unknown; subject?: unknown };
	if (
		typeof item.accountId !== "string" ||
		typeof item.id !== "string" ||
		!context.accountIds.includes(item.accountId)
	)
		return undefined;
	if (
		context.mode === "threads" &&
		!context.threads?.some((ref) => ref.accountId === item.accountId && ref.threadId === item.id)
	)
		return undefined;
	return {
		accountId: item.accountId,
		threadId: item.id,
		subject: typeof item.subject === "string" ? item.subject : "",
	};
}
