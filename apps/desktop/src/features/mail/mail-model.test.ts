import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	MailAccount,
	MailDraft,
	MailThreadList,
	MailThreadSummary,
} from "../../../../../packages/coding-agent/src/core/mail/types.ts";
import {
	mailReadSource,
	mailThreadKey,
	mergeMailPage,
	readableAccounts,
	sameMailContext,
	sameMailDraft,
	threadContext,
} from "./mail-model.ts";

function summary(accountId: string, id: string, date: string, subject = id): MailThreadSummary {
	return {
		id,
		accountId,
		date,
		subject,
		from: "sender@example.test",
		snippet: "Mail body",
		unread: false,
		starred: false,
		messageCount: 1,
		attachmentCount: 0,
	};
}

test("same Gmail thread ID in two accounts stays distinct in pagination and Agent scope", () => {
	const personal = { accountId: "personal", threadId: "identical-id" };
	const work = { accountId: "work", threadId: "identical-id" };
	assert.notEqual(mailThreadKey(personal), mailThreadKey(work));
	assert.deepEqual(threadContext([personal, work, personal]), {
		mode: "threads",
		accountIds: ["personal", "work"],
		threads: [personal, work],
	});
	const first: MailThreadList = {
		threads: [
			summary("personal", "identical-id", "2026-10-02T08:00:00Z"),
			summary("work", "identical-id", "2026-10-02T09:00:00Z"),
		],
		nextPageTokens: { personal: "next" },
		errors: [{ accountId: "expired", error: "expired" }],
	};
	const merged = mergeMailPage(first, {
		threads: [
			summary("personal", "identical-id", "2026-10-02T10:00:00Z", "Updated"),
			summary("work", "second", "2026-10-01T08:00:00Z"),
		],
		nextPageTokens: {},
		errors: [],
	});
	assert.equal(merged.threads.length, 3);
	assert.equal(merged.threads[0].subject, "Updated");
	assert.equal(merged.threads[1].accountId, "work");
	assert.equal(first.threads[0].subject, "identical-id");
	assert.deepEqual(merged.nextPageTokens, {});
	assert.deepEqual(merged.errors, [{ accountId: "expired", error: "expired" }]);
});

test("one expired or unreadable account does not prevent healthy accounts from being selected", () => {
	const base: MailAccount = {
		id: "personal",
		label: "Personal",
		email: "personal@example.test",
		status: "connected",
		capabilities: { read: true, compose: false, send: false, modify: false },
	};
	const accounts = [
		base,
		{ ...base, id: "work", status: "expired" as const },
		{ ...base, id: "no-read", capabilities: { ...base.capabilities, read: false } },
	];
	assert.deepEqual(
		readableAccounts(accounts).map((account) => account.id),
		["personal"],
	);
	assert.equal(accounts.length, 3);
});

test("a fixed Agent scope ignores ordering but never treats another account as the same mail", () => {
	const first = threadContext([
		{ accountId: "one", threadId: "mail-a" },
		{ accountId: "two", threadId: "mail-b" },
	]);
	assert.equal(sameMailContext(first, threadContext([...first.threads!].reverse())), true);
	assert.equal(
		sameMailContext(
			first,
			threadContext([
				{ accountId: "one", threadId: "mail-a" },
				{ accountId: "one", threadId: "mail-b" },
			]),
		),
		false,
	);
	assert.equal(sameMailContext(first, { mode: "accounts", accountIds: first.accountIds }), false);
});

test("sent draft comparison tracks sender, all recipients and approved content independent of remote ID", () => {
	const draft: MailDraft = {
		accountId: "work",
		threadId: "source",
		to: "recipient@example.test",
		cc: "copy@example.test",
		bcc: "private@example.test",
		subject: "Reply",
		body: "Approved body",
		inReplyTo: "<source@example.test>",
	};
	assert.equal(sameMailDraft(draft, { ...draft, id: "gmail-draft-id" }), true);
	for (const field of ["accountId", "to", "cc", "bcc", "subject", "body", "threadId", "inReplyTo"] as const) {
		assert.equal(sameMailDraft(draft, { ...draft, [field]: "changed" }), false, field);
	}
});

test("only a successful source read within the Agent scope can add an actionable source link", () => {
	const context = threadContext([{ accountId: "work", threadId: "shared-id" }]);
	const read = {
		type: "tool_execution_end",
		toolName: "mail_read_thread",
		isError: false,
		result: { details: { thread: { accountId: "work", id: "shared-id", subject: "Actual mail" } } },
	};
	assert.deepEqual(mailReadSource(read, context), {
		accountId: "work",
		threadId: "shared-id",
		subject: "Actual mail",
	});
	assert.equal(mailReadSource({ ...read, isError: true }, context), undefined);
	assert.equal(
		mailReadSource(
			{
				...read,
				result: { details: { thread: { accountId: "personal", id: "shared-id", subject: "Other account" } } },
			},
			context,
		),
		undefined,
	);
	assert.equal(
		mailReadSource(
			{
				...read,
				result: { details: { thread: { accountId: "work", id: "other-thread", subject: "Outside selection" } } },
			},
			context,
		),
		undefined,
	);
	assert.equal(mailReadSource({ ...read, toolName: "mail_search" }, context), undefined);
	assert.deepEqual(
		mailReadSource({ role: "toolResult", toolName: "mail_read_thread", details: read.result.details }, context),
		{ accountId: "work", threadId: "shared-id", subject: "Actual mail" },
	);
});
