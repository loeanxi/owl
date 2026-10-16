/**
 * Tool exposure rules — pure predicates over a tool registry snapshot.
 *
 * Extracted from AgentSession so the exposure/activation decisions can be unit tested
 * without constructing a session. Nothing here reads session state; callers pass the
 * registry view and the allow/deny sets they hold.
 */

import type { ToolDefinition, ToolExposure } from "./extensions/index.ts";
import type { SourceInfo } from "./source-info.ts";

/** How a tool's activation behaves: eager activates on registration, on-demand waits for activation. */
export type ToolActivationMode = "eager" | "on-demand";

/** A registered tool definition plus where it came from. */
export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/** Registry view the predicates read; AgentSession's private map satisfies it. */
export type ToolDefinitionMap = ReadonlyMap<string, ToolDefinitionEntry>;

/** Exposures that declare the tool to the model. */
export function isDeclarableExposure(exposure: ToolExposure): boolean {
	return exposure === "direct" || exposure === "model-only";
}

/** Exposures only reachable through another tool (codemode scripts or deferred lookups). */
export function isIndirectExposure(exposure: ToolExposure): boolean {
	return exposure === "codemode" || exposure === "deferred";
}

/** Exposure of a registered tool; unregistered names behave as `direct`. */
export function toolExposureOf(tools: ToolDefinitionMap, name: string): ToolExposure {
	return tools.get(name)?.definition.exposure ?? "direct";
}

/**
 * Whether the allow/deny configuration permits the tool at all.
 * An absent allow list means "everything not excluded".
 */
export function isAllowedToolName(
	name: string,
	allowed: ReadonlySet<string> | undefined,
	excluded: ReadonlySet<string> | undefined,
): boolean {
	return (!allowed || allowed.has(name)) && !excluded?.has(name);
}

/** Whether a tool can be called through `ctx.executeTool()`: active `direct`, or any indirect tool. */
export function isCallableExposure(name: string, exposure: ToolExposure, active: ReadonlySet<string>): boolean {
	return isIndirectExposure(exposure) || (exposure === "direct" && active.has(name));
}

export interface RegistrationActivationInput {
	readonly name: string;
	readonly activation: ToolActivationMode;
	readonly exposure: ToolExposure;
	/** Tool names active when the session started; on-demand only activates these. */
	readonly initialActiveToolNames: readonly string[];
	/** The definition's own opt-out; anything but `false` activates under eager mode. */
	readonly defaultActive: boolean | undefined;
}

/** Whether registering the tool activates it, which declares it to the model. */
export function isActivatedOnRegistration(input: RegistrationActivationInput): boolean {
	if (!isDeclarableExposure(input.exposure)) return false;
	if (input.activation === "on-demand") return input.initialActiveToolNames.includes(input.name);
	return input.defaultActive !== false;
}
