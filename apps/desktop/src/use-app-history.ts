import { useEffect, useRef, useState } from "react";
import { recordPlace, samePlace, stepBack, stepForward, type AppHistory, type AppPlace } from "./app-history.ts";

/** 记住主区走过的位置，供顶栏左右按钮和 Ctrl+[ / Ctrl+] 回退。 */
export function useAppHistory(place: AppPlace): {
	canBack: boolean;
	canForward: boolean;
	back: () => AppPlace | undefined;
	forward: () => AppPlace | undefined;
	abandon: () => void;
} {
	const historyRef = useRef<AppHistory>({ back: [], forward: [], current: place });
	const placeRef = useRef(place);
	const applying = useRef<AppPlace | null>(null);
	const checkpoint = useRef<AppHistory | null>(null);
	const [, setRevision] = useState(0);
	placeRef.current = place;
	const { rail, settings, settingsTab, chatSession, researchSession, workspace } = place;

	useEffect(() => {
		const next: AppPlace = { rail, settings, settingsTab, chatSession, researchSession, workspace };
		if (applying.current) {
			if (!samePlace(next, applying.current)) return;
			applying.current = null;
			checkpoint.current = null;
		}
		const updated = recordPlace(historyRef.current, next);
		if (updated === historyRef.current) return;
		historyRef.current = updated;
		setRevision((value) => value + 1);
	}, [rail, settings, settingsTab, chatSession, researchSession, workspace]);

	const move = (direction: "back" | "forward"): AppPlace | undefined => {
		const previous = historyRef.current;
		const stepped = direction === "back" ? stepBack(previous) : stepForward(previous);
		if (!stepped) return undefined;
		historyRef.current = stepped.history;
		if (samePlace(stepped.place, placeRef.current)) {
			applying.current = null;
			checkpoint.current = null;
			setRevision((value) => value + 1);
			return undefined;
		}
		checkpoint.current = previous;
		applying.current = stepped.place;
		setRevision((value) => value + 1);
		return stepped.place;
	};

	return {
		canBack: historyRef.current.back.length > 0,
		canForward: historyRef.current.forward.length > 0,
		back: () => move("back"),
		forward: () => move("forward"),
		abandon: () => {
			applying.current = null;
			if (checkpoint.current) historyRef.current = checkpoint.current;
			checkpoint.current = null;
			setRevision((value) => value + 1);
		},
	};
}
