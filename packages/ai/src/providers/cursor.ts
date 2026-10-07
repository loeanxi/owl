import { cursorAgentApi, discoverCursorNativeModels } from "../api/cursor-agent.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadCursorOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { CURSOR_MODELS } from "./cursor.models.ts";

const CURSOR_BASE_URL = "https://api2.cursor.sh";

function baselineModels(): Model<"cursor-native">[] {
	return Object.values(CURSOR_MODELS) as Model<"cursor-native">[];
}

export function cursorProvider(): Provider<"cursor-native"> {
	let dynamicModels: Model<"cursor-native">[] = [];

	return createProvider({
		id: "cursor",
		name: "Cursor",
		baseUrl: CURSOR_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("Cursor API key / access token", ["CURSOR_API_KEY", "CURSOR_ACCESS_TOKEN"]),
			oauth: lazyOAuth({
				name: "Cursor",
				isSubscription: true,
				loginLabel: "Sign in with Cursor",
				load: loadCursorOAuth,
			}),
		},
		models: baselineModels(),
		fetchModels: async (context: RefreshModelsContext) => {
			const access =
				context.credential?.type === "oauth"
					? context.credential.access
					: context.credential?.type === "api_key"
						? context.credential.key
						: undefined;
			if (!access || !context.allowNetwork || context.signal.aborted) {
				return dynamicModels.length > 0 ? dynamicModels : baselineModels();
			}
			try {
				// Live catalog via pi-cursor (protobuf GetUsableModels + AvailableModels).
				// JSON GetUsableModels is rejected by Cursor; without this the seed stays stale.
				const usable = await discoverCursorNativeModels(access, context.signal);
				if (usable.length === 0) return dynamicModels.length > 0 ? dynamicModels : baselineModels();
				dynamicModels = usable;
				return dynamicModels;
			} catch {
				return dynamicModels.length > 0 ? dynamicModels : baselineModels();
			}
		},
		api: cursorAgentApi(),
	});
}
