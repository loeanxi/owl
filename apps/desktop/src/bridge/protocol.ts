/**
 * Re-exports the kernel wire protocol so the UI and bridge share one definition.
 */
export type {
	DesktopClientRequest,
	DesktopClientRequestWithoutId,
	DesktopServerMessage,
	AuthCancelRequest,
	AuthLoginRequest,
	AuthPromptRespondRequest,
	AuthProvidersRequest,
	ModelInfoMessage,
	ModelsPutModelRequest,
	ModelsPutProviderRequest,
	ModelsRemoveModelRequest,
	ModelsRemoveProviderRequest,
	PermissionRequestMessage,
	ProjectCreateRequest,
	ProjectCreateResult,
	ProviderModelsMessage,
	ServerEventMessage,
	ServerResponseMessage,
	SessionAbortRequest,
	SessionCreateRequest,
	SessionListRequest,
	SessionPromptRequest,
	SessionSetModelRequest,
	SessionSetThinkingLevelRequest,
	SessionStatsRequest,
	SessionStatsResult,
	SettingsGetRequest,
	SettingsSetRequest,
	FsEntry,
	FsListing,
	FsReadResult,
	FsReadBinResult,
	FsSearchHit,
	GitStatusResult,
	GitStatusEntry,
	GitLogEntry,
} from "../../../../packages/coding-agent/src/modes/desktop/protocol.ts";

import type { PermissionRequestMessage } from "../../../../packages/coding-agent/src/modes/desktop/protocol.ts";

/** Alias used by UI components. */
export type PermissionRequest = PermissionRequestMessage;
