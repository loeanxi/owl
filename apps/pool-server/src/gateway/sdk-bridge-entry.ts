import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SDK_BRIDGE_SCRIPT = "bridge/main.mjs";

/** The source entry and compiled entry sit one directory below the shipped bridge. */
export function resolveSdkBridgeScript(script: string, entryUrl: string, cwd = process.cwd()): string {
	const configured = resolve(cwd, script);
	if (existsSync(configured) || script !== DEFAULT_SDK_BRIDGE_SCRIPT) return configured;
	return fileURLToPath(new URL("../bridge/main.mjs", entryUrl));
}
