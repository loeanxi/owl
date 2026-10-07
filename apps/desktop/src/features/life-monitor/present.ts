import { LIFE_CHANNELS, summarizeLife } from "../../../../../packages/coding-agent/src/modes/desktop/life-channels.ts";
import type { LifeChannel } from "../../bridge/protocol.ts";
import type { LifeRound } from "./use-life-probe.ts";

export type LifeView = ReturnType<typeof presentLife>;

export function presentLife(channels: readonly LifeChannel[], round: LifeRound): {
	shown: LifeChannel[];
	summary: ReturnType<typeof summarizeLife>;
} {
	const byId = new Map(channels.map((item) => [item.id, item]));
	const shown = LIFE_CHANNELS.map((def) => {
		if (def.id === "bridge" && round === "down") {
			return { id: "bridge", level: "bad" as const, note: "down", evidence: "127.0.0.1", at: Date.now() };
		}
		return byId.get(def.id) ?? {
			id: def.id,
			level: "idle" as const,
			note: "read-failed",
			evidence: "",
			at: 0,
		};
	});
	return { shown, summary: summarizeLife(shown, round) };
}
