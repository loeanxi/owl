import { useCallback, useEffect, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { LifeChannel, LifeProbeResult } from "../../bridge/protocol.ts";

const POLL_MS = 15_000;

export type LifeRound = "ok" | "failed" | "down";

export function useLifeProbe(input: {
	client: BridgeClient;
	connected: boolean;
	cwd: string;
	model: string;
}): { channels: LifeChannel[]; round: LifeRound; refresh: () => void } {
	const [channels, setChannels] = useState<LifeChannel[]>([]);
	const [round, setRound] = useState<LifeRound>("failed");

	const refresh = useCallback(() => {
		if (!input.connected) {
			setRound("down");
			return;
		}
		void input.client.request<LifeProbeResult>({
			type: "life.probe",
			cwd: input.cwd || undefined,
			model: input.model || undefined,
		}).then((response) => {
			if (!response.ok || !response.result) {
				setRound("failed");
				return;
			}
			const next = response.result.channels;
			setChannels((current) => sameReading(current, next) ? current : next);
			setRound("ok");
		}).catch(() => setRound("failed"));
	}, [input.client, input.connected, input.cwd, input.model]);

	useEffect(() => {
		refresh();
		const timer = window.setInterval(refresh, POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	return { channels, round, refresh };
}

/** 探测每轮都会换时间戳。灯号、说明和证据没变，就留着上一份，避免整墙重画。 */
function sameReading(current: readonly LifeChannel[], next: readonly LifeChannel[]): boolean {
	if (current.length !== next.length) return false;
	for (let index = 0; index < current.length; index += 1) {
		const left = current[index];
		const right = next[index];
		if (!left || !right || left.id !== right.id || left.level !== right.level || left.note !== right.note || left.evidence !== right.evidence) return false;
	}
	return true;
}
