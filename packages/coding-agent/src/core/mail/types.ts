/** Public mailbox data. OAuth secrets and tokens never cross the desktop bridge. */
export type MailFolder = "inbox" | "unread" | "starred" | "sent" | "drafts";
export type MailPermission = "read" | "send";
export type MailAccountStatus = "connected" | "expired" | "disconnected";

export interface MailAccount {
	id: string;
	email: string;
	label: string;
	status: MailAccountStatus;
	capabilities: { read: boolean; compose: boolean; send: boolean; modify: boolean };
	unreadCount?: number;
	lastSyncedAt?: string;
	error?: string;
}

export interface MailSettings {
	configured: boolean;
	clientId?: string;
}

export interface MailAttachment {
	id?: string;
	name: string;
	mimeType: string;
	size: number;
}

export interface MailMessage {
	id: string;
	from: string;
	to: string;
	cc?: string;
	subject: string;
	date: string;
	bodyText: string;
	snippet: string;
	messageId?: string;
	references?: string;
	attachments: MailAttachment[];
}

export interface MailThreadSummary {
	id: string;
	accountId: string;
	subject: string;
	from: string;
	snippet: string;
	date: string;
	unread: boolean;
	starred: boolean;
	messageCount: number;
	attachmentCount: number;
}

export interface MailThread {
	id: string;
	accountId: string;
	subject: string;
	messages: MailMessage[];
}

export interface MailThreadList {
	threads: MailThreadSummary[];
	nextPageTokens: Record<string, string>;
	errors: Array<{ accountId: string; error: string }>;
}

export interface MailDraft {
	id?: string;
	accountId: string;
	threadId?: string;
	to: string;
	cc?: string;
	bcc?: string;
	subject: string;
	body: string;
	inReplyTo?: string;
	references?: string;
}

export interface MailSendConfirmation {
	confirmationId: string;
	expiresAt: string;
	accountEmail: string;
	draft: MailDraft;
}

export interface MailAuthStart {
	authId: string;
	authorizationUrl: string;
	expiresAt: string;
}

export interface MailAuthStatus {
	state: "pending" | "complete" | "failed" | "cancelled";
	account?: MailAccount;
	error?: string;
}

export interface MailThreadRef {
	accountId: string;
	threadId: string;
}

/** A mailbox Agent session fixes its scope at creation. */
export interface MailAgentContext {
	mode: "threads" | "accounts";
	accountIds: string[];
	threads?: MailThreadRef[];
}

export interface MailAgentStartResult {
	sessionId: string;
	context: MailAgentContext;
}

export type MailRequest =
	| { action: "settings" }
	| { action: "configure"; clientJson: string }
	| { action: "accounts" }
	| { action: "auth.start"; accountId?: string; permission: MailPermission }
	| { action: "auth.status"; authId: string }
	| { action: "auth.cancel"; authId: string }
	| { action: "disconnect"; accountId: string }
	| { action: "rename"; accountId: string; label: string }
	| {
			action: "threads.list";
			accountIds: string[];
			folder: MailFolder;
			query?: string;
			pageTokens?: Record<string, string>;
			maxResults?: number;
	  }
	| { action: "thread.get"; accountId: string; threadId: string }
	| { action: "draft.save"; draft: MailDraft }
	| { action: "send.prepare"; draft: MailDraft }
	| { action: "send.confirm"; confirmationId: string };
