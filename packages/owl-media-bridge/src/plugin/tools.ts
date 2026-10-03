/**
 * 媒体桥的四个模型工具（owl ToolDefinition 版）。
 *
 * 从 dsh-media-bridge 的 tools.ts 移植：工具名、参数面、语义与 DSH 版保持
 * 一致，宿主 API 从 cordis defineTool 换成 owl 的 ToolDefinition（typebox）。
 * 控制命令的真正校验/能力门控仍在 MediaBridge.control 里——工具层只做映射；
 * Agent 控制开关（allowAgentControl，默认关）由运行时强制，不在这里。
 * @module owl-media-bridge/plugin/tools
 */

import type { ToolDefinition } from "@owl/owl-coding-agent";
import { Type } from "typebox";
import type { BridgeRuntime } from "../bridge-runtime.ts";
import type { MediaCommand } from "../domain/types.ts";

function toJson(value: unknown): string {
	return JSON.stringify(value);
}

const NoParams = Type.Object({});

/** media_bridge_status：读显式配置播放器的权威状态；绝不回退到别的播放器。 */
export function createStatusTool(runtime: BridgeRuntime): ToolDefinition<typeof NoParams, undefined> {
	return {
		name: "media_bridge_status",
		label: "媒体状态",
		description:
			"Read the current status of the explicitly configured local media player (QQ Music by default on this Windows machine). " +
			"Never controls or falls back to another player. Read-only.",
		promptSnippet: "media_bridge_status: 读本地音乐播放器的播放状态/曲目/音量",
		parameters: NoParams,
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: toJson(await runtime.status(signal)) }],
			details: undefined,
		}),
	};
}

const ControlParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("play-pause"),
			Type.Literal("next"),
			Type.Literal("previous"),
			Type.Literal("seek"),
			Type.Literal("set-volume"),
			Type.Literal("fade-volume"),
		],
		{ description: "The player action to perform." },
	),
	positionSeconds: Type.Optional(
		Type.Number({ description: "Required only when action is seek; target position in seconds." }),
	),
	volumePercent: Type.Optional(
		Type.Number({ description: "Required for set-volume and fade-volume; a value from 0 to 100." }),
	),
	durationSeconds: Type.Optional(
		Type.Number({
			description:
				"Only for fade-volume; seconds to glide from the current volume to volumePercent (0–180, default 5).",
		}),
	),
});

/** media_bridge_control：能力门控的播放控制；先 status 看 capabilities 再调。 */
export function createControlTool(runtime: BridgeRuntime): ToolDefinition<typeof ControlParams, undefined> {
	return {
		name: "media_bridge_control",
		label: "媒体控制",
		description:
			"Control the explicitly configured local media player. Use media_bridge_status first and only call operations listed as available in capabilities.",
		promptSnippet: "media_bridge_control: 播放/暂停/切歌/跳转/调音量（需用户开启 Agent 控制）",
		parameters: ControlParams,
		execute: async (_toolCallId, params, signal) => {
			if (params.action === "fade-volume") {
				return {
					content: [
						{
							type: "text",
							text: toJson(
								await runtime.fadeFromAgent(
									params.volumePercent ?? Number.NaN,
									params.durationSeconds ?? 5,
									signal,
								),
							),
						},
					],
					details: undefined,
				};
			}
			const command: MediaCommand =
				params.action === "seek"
					? { kind: "seek", positionSeconds: params.positionSeconds ?? Number.NaN }
					: params.action === "set-volume"
						? { kind: "set-volume", volumePercent: params.volumePercent ?? Number.NaN }
						: { kind: params.action };
			return {
				content: [{ type: "text", text: toJson(await runtime.controlFromAgent(command, signal)) }],
				details: undefined,
			};
		},
	};
}

const MemoryParams = Type.Object({
	action: Type.Union([Type.Literal("today-history"), Type.Literal("favorites")], {
		description:
			"'today-history' returns today's tracks with approximate listening time; 'favorites' returns locally kept favorite tracks.",
	}),
	limit: Type.Optional(
		Type.Number({ description: "Optional cap for returned rows (1–400, default 50 for history)." }),
	),
});

/** media_bridge_memory：本机听歌记忆只读视图；从不写回任何播放器。 */
export function createMemoryTool(runtime: BridgeRuntime): ToolDefinition<typeof MemoryParams, undefined> {
	return {
		name: "media_bridge_memory",
		label: "听歌记忆",
		description:
			"Read the local music memory of this machine's media bridge: today's listening history ('what played just now') and the local favorites list. Read-only; it never writes back to any music player.",
		promptSnippet: "media_bridge_memory: 读今天的听歌历史与本地收藏（只读）",
		parameters: MemoryParams,
		execute: async (_toolCallId, params) => {
			const limit = normalizeMemoryLimit(params.limit);
			if (params.action === "favorites") {
				return {
					content: [{ type: "text", text: toJson({ favorites: runtime.memoryFavorites() }) }],
					details: undefined,
				};
			}
			return {
				content: [
					{ type: "text", text: toJson({ today: runtime.memoryToday(), recent: runtime.memoryRecent(limit) }) },
				],
				details: undefined,
			};
		},
	};
}

/** media_bridge_explain_status：把桥状态讲成人话；只读。 */
export function createExplainTool(runtime: BridgeRuntime): ToolDefinition<typeof NoParams, undefined> {
	return {
		name: "media_bridge_explain_status",
		label: "解释播放状态",
		description:
			"Explain the current media bridge state in plain language: player and playback state, track and position, volume, available controls, and Agent playback authorization. Read-only.",
		promptSnippet: "media_bridge_explain_status: 用自然语言解释当前音乐播放状态",
		parameters: NoParams,
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: toJson(await runtime.explainStatus(signal)) }],
			details: undefined,
		}),
	};
}

function normalizeMemoryLimit(limit: number | undefined): number {
	if (limit === undefined) return 50;
	return Number.isInteger(limit) && limit >= 1 && limit <= 400 ? limit : 50;
}
