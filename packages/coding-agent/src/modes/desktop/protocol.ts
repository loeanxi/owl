/**
 * pire desktop wire protocol — shared between the bridge (serve.ts) and the
 * desktop UI. Types only: import from the UI with `import type` so nothing
 * server-side leaks into the browser bundle.
 */

export interface SessionCreateRequest {
	type: "session.create";
	id: string;
	cwd?: string;
	provider?: string;
	model?: string;
	agentDir?: string;
	/** "confirm" routes tool calls to the UI as permission_request messages; default "auto". */
	approvalMode?: "auto" | "confirm";
}

export interface SessionPromptRequest {
	type: "session.prompt";
	id: string;
	sessionId: string;
	message: string;
	images?: unknown[];
}

export interface SessionAbortRequest {
	type: "session.abort";
	id: string;
	sessionId: string;
}

export interface SessionListRequest {
	type: "session.list";
	id: string;
	sessionDir?: string;
}

export interface ModelsListRequest {
	type: "models.list";
	id: string;
}

export interface SettingsGetRequest {
	type: "settings.get";
	id: string;
}

export interface SettingsSetRequest {
	type: "settings.set";
	id: string;
	values: Record<string, unknown>;
}

export interface PingRequest {
	type: "ping";
	id: string;
}

export interface PermissionResponseRequest {
	type: "permission.response";
	id: string;
	requestId: string;
	approved: boolean;
}

export type DesktopClientRequest =
	| SessionCreateRequest
	| SessionPromptRequest
	| SessionAbortRequest
	| SessionListRequest
	| ModelsListRequest
	| SettingsGetRequest
	| SettingsSetRequest
	| PingRequest
	| PermissionResponseRequest;

export interface ModelInfoMessage {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
}

export type ServerEventMessage = {
	type: "event";
	sessionId: string;
	event: unknown; // JsonAgentSessionEvent, kept loose so the UI can render forward-compat payloads
};

export type PermissionRequestMessage = {
	type: "permission_request";
	requestId: string;
	sessionId: string;
	toolName: string;
	input: unknown;
};

export type ServerResponseMessage = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

export type DesktopServerMessage = ServerEventMessage | ServerResponseMessage | PermissionRequestMessage;
