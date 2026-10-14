import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { LifeChannel, LifeProbeResult } from "../../bridge/protocol.ts";

/** 后台只为标题栏的异常提醒兜底；连上、换项目、换模型时会立刻补一轮。 */
const POLL_MS = 5 * 60_000;

export type LifeRound = "ok" | "failed" | "down";

export interface LifeProbe {
	channels: LifeChannel[];
	round: LifeRound;
	checkedAt: number | undefined;
	refresh: () => Promise<void>;
}

export function useLifeProbe(input: {
	client: BridgeClient;
	connected: boolean;
	cwd: string;
	model: string;
}): LifeProbe {
	const [channels, setChannels] = useState<LifeChannel[]>([]);
	const [round, setRound] = useState<LifeRound>("failed");
	const [checkedAt, setCheckedAt] = useState<number>();
	// 启动时桥还没连上不算掉线，免得标题栏先闪一下红。
	const everConnected = useRef(false);

	const refresh = useCallback(async (): Promise<void> => {
		if (!input.connected) {
			setRound(everConnected.current ? "down" : "failed");
			return;
		}
		everConnected.current = true;
		try {
			const response = await input.client.request<LifeProbeResult>({
				type: "life.probe",
				cwd: input.cwd || undefined,
				model: input.model || undefined,
			});
			if (!response.ok || !response.result) {
				setRound("failed");
				return;
			}
			const next = response.result.channels;
			setChannels((current) => sameReading(current, next) ? current : next);
			setRound("ok");
			setCheckedAt(response.result.probedAt);
		} catch {
			setRound("failed");
		}
	}, [input.client, input.connected, input.cwd, input.model]);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), POLL_MS);
		return () => window.clearInterval(timer);
	}, [refresh]);

	return { channels, round, checkedAt, refresh };
}

/** 探测每轮都会换时间戳。灯号、说明和证据没变，就留着上一份，避免重画。 */
function sameReading(current: readonly LifeChannel[], next: readonly LifeChannel[]): boolean {
	if (current.length !== next.length) return false;
	for (let index = 0; index < current.length; index += 1) {
		const left = current[index];
		const right = next[index];
		if (!left || !right || left.id !== right.id || left.level !== right.level || left.note !== right.note || left.evidence !== right.evidence) return false;
	}
	return true;
}
