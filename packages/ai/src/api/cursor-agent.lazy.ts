import type { Model, ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

type Discover = typeof import("./cursor-agent.ts").discoverCursorNativeModels;

let discoverBoot: Promise<Discover> | undefined;

async function loadDiscover(): Promise<Discover> {
	discoverBoot ??= import("./cursor-agent.ts")
		.then((m) => m.discoverCursorNativeModels)
		.catch((error) => {
			discoverBoot = undefined;
			throw error;
		});
	return discoverBoot;
}

export const cursorAgentApi = (): ProviderStreams =>
	lazyApi(() => import("./cursor-agent.ts").then((m) => m.cursorAgentApi()));

/** Lazy wrapper so provider construction does not pull pi-cursor until refresh. */
export async function discoverCursorNativeModels(
	accessToken: string,
	signal?: AbortSignal,
): Promise<Model<"cursor-native">[]> {
	const discover = await loadDiscover();
	return discover(accessToken, signal);
}
