/**
 * owl desktop wire protocol — shared between the bridge (serve.ts) and the
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

export interface ProjectCreateRequest {
	type: "project.create";
	id: string;
	/**
	 * Absolute project directory (支持 ~ 前缀). Created recursively when missing,
	 * so this doubles as "open existing project" (mkdir on an existing dir is a no-op).
	 */
	path: string;
}

export interface ProjectCreateResult {
	/** Resolved absolute path (backslashes on Windows) — use as session.create cwd. */
	path: string;
}

export interface ModelsListRequest {
	type: "models.list";
	id: string;
}

export interface SettingsGetRequest {
	type: "settings.get";
	id: string;
}

export interface ModelsPutProviderRequest {
	type: "models.putProvider";
	id: string;
	provider: {
		key: string;
		name?: string;
		baseUrl: string;
		api: string;
		apiKey?: string;
	};
}

export interface ModelsPutModelRequest {
	type: "models.putModel";
	id: string;
	providerKey: string;
	model: { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean };
}

export interface ModelsRemoveModelRequest {
	type: "models.removeModel";
	id: string;
	providerKey: string;
	modelId: string;
}

export interface ModelsRemoveProviderRequest {
	type: "models.removeProvider";
	id: string;
	providerKey: string;
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

export interface ProviderModelsMessage {
	id: string;
	name?: string;
	/** owl 固定为 "models_json"：模型只来自声明文件，不复用内置目录 */
	authSource?: string;
	models: ModelInfoMessage[];
}

export type DesktopClientRequest =
	| SessionCreateRequest
	| SessionPromptRequest
	| SessionAbortRequest
	| SessionListRequest
	| ProjectCreateRequest
	| ModelsListRequest
	| ModelsPutProviderRequest
	| ModelsPutModelRequest
	| ModelsRemoveModelRequest
	| ModelsRemoveProviderRequest
	| AuthProvidersRequest
	| AuthLoginRequest
	| AuthPromptRespondRequest
	| AuthCancelRequest
	| SettingsGetRequest
	| SettingsSetRequest
	| PingRequest
	| PermissionResponseRequest;

/** 内置厂商目录（供桌面端下拉选择，非模型列表）。 */
export interface AuthProvidersRequest {
	type: "auth.providers";
	id: string;
}

/**
 * 登录/存 key（对应 pi 的 /login）。
 * - authType "oauth"：桥会打开浏览器，进度通过 auth_notify 事件广播，长请求。
 * - authType "api_key"：apiKey 随请求带上，写入 auth.json。
 */
export interface AuthLoginRequest {
	type: "auth.login";
	id: string;
	provider: string;
	authType: "api_key" | "oauth";
	apiKey?: string;
}

/** 回答登录流程的提问（AuthPrompt：text/secret 填字符串，select 填 option id）。 */
export interface AuthPromptRespondRequest {
	type: "auth.prompt.respond";
	id: string;
	answer: string;
}

/** 取消进行中的登录流程。 */
export interface AuthCancelRequest {
	type: "auth.cancel";
	id: string;
}

export interface ModelInfoMessage {
	id: string;
	name: string;
	contextWindow?: number;
}

/**
 * One provider's slice of the model selector, mirroring the pi TUI ModelSelector's
 * data source: only providers with configured credentials (the runtime's available
 * snapshot), grouped and annotated with where the credentials come from.
 */
export interface ProviderModelsMessage {
	id: string;
	name?: string;
	/** pi AuthStatus.source: "stored" | "runtime" | "environment" | "models_json_key" | … */
	authSource?: string;
	models: ModelInfoMessage[];
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

/** Omit that distributes over unions (so each request variant keeps its fields). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DesktopClientRequestWithoutId = DistributiveOmit<DesktopClientRequest, "id">;
