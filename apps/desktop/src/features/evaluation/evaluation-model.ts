import type {
	EvaluationCategory, EvaluationProfileInput, EvaluationResultView, EvaluationRunView, EvaluationThinkingLevel,
} from "../../../../../packages/coding-agent/src/core/evaluation/types.ts";

export const QUICK_TASKS = ["G01", "G06", "W01", "W03", "C02", "C07"];
export const CATEGORIES: EvaluationCategory[] = ["svg", "html", "code"];
export const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function profileKey(provider: string, modelId: string, thinkingLevel: EvaluationThinkingLevel): string {
	return JSON.stringify([provider, modelId, thinkingLevel]);
}

export function selectProfile(profiles: EvaluationProfileInput[], profile: EvaluationProfileInput, selected: boolean): EvaluationProfileInput[] {
	const filtered = profiles.filter((item) => item.id !== profile.id);
	return selected ? [...filtered, profile] : filtered;
}

/** Always use the server's frozen order; revealing identity must never reorder cards. */
export function groupResults(run: EvaluationRunView, taskId: string, sample: number): EvaluationResultView[] {
	const order = run.groups.find((group) => group.taskId === taskId && group.sample === sample)?.resultIds ?? [];
	const results = new Map(run.results.map((result) => [result.id, result]));
	return order.flatMap((id) => {
		const result = results.get(id);
		return result ? [result] : [];
	});
}

export interface EvaluationStatistics {
	key: string;
	name: string;
	thinkingLevel: EvaluationThinkingLevel;
	count: number;
	passed: number;
	checked: number;
	unchecked: number;
	failed: number;
	scored: number;
	scoreTotal: number;
	durationTotal: number;
	durationCount: number;
	costTotal: number;
	costCount: number;
}

/** Unknown metrics are excluded from means, with denominators retained for display. */
export function evaluationStatistics(run: EvaluationRunView, category: EvaluationCategory): EvaluationStatistics[] {
	const taskIds = new Set(run.tasks.filter((task) => task.category === category).map((task) => task.id));
	const groups = new Map<string, EvaluationStatistics>();
	for (const result of run.results) {
		if (!result.revealed || !result.profile || !taskIds.has(result.taskId) || !FINISHED_STATUSES.has(result.status)) continue;
		const profile = result.profile;
		let stats = groups.get(profile.id);
		if (!stats) {
			stats = { key: profile.id, name: profile.model.name, thinkingLevel: profile.thinkingLevel, count: 0, passed: 0, checked: 0, unchecked: 0, failed: 0, scored: 0, scoreTotal: 0, durationTotal: 0, durationCount: 0, costTotal: 0, costCount: 0 };
			groups.set(profile.id, stats);
		}
		stats.count++;
		if (result.status !== "completed") stats.failed++;
		const hasUnchecked = result.checks.length === 0 || result.checks.some((check) => check.status === "unchecked");
		if (hasUnchecked) stats.unchecked++;
		if (result.status === "completed" && result.checks.length > 0 && !hasUnchecked) {
			stats.checked++;
			if (result.checks.every((check) => check.status === "passed")) stats.passed++;
		}
		const scores = Object.values(result.rating?.scores ?? {});
		if (scores.length > 0) {
			stats.scored++;
			stats.scoreTotal += scores.reduce((sum, score) => sum + score, 0) / scores.length;
		}
		if (typeof result.durationMs === "number") { stats.durationTotal += result.durationMs; stats.durationCount++; }
		if (typeof result.costUsd === "number") { stats.costTotal += result.costUsd; stats.costCount++; }
	}
	return [...groups.values()];
}

const PREVIEW_POLICY = "default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; navigate-to 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Generated markup is only returned as an isolated iframe document, never injected in the app DOM. */
export function isolatedPreview(content: string, type: "svg" | "html"): string {
	const policy = type === "svg" ? PREVIEW_POLICY.replace("script-src 'unsafe-inline'", "script-src 'none'") : PREVIEW_POLICY;
	const document = new DOMParser().parseFromString(content, "text/html");
	for (const element of document.querySelectorAll("base,meta[http-equiv],iframe,frame,object,embed,link,form")) {
		if (element.tagName === "FORM") element.replaceWith(...element.childNodes);
		else element.remove();
	}
	for (const element of document.querySelectorAll("[href],[xlink\\:href],[target],[action],[formaction]")) {
		for (const attribute of ["target", "action", "formaction"]) element.removeAttribute(attribute);
		for (const attribute of ["href", "xlink:href"]) {
			const value = element.getAttribute(attribute);
			if (value && !value.startsWith("#")) element.removeAttribute(attribute);
		}
	}
	const markup = type === "svg" ? `<style>html,body{margin:0;width:100%;height:100%;display:grid;place-items:center}svg{max-width:100%;max-height:100%}</style>${document.body.innerHTML}` : document.documentElement.outerHTML;
	return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${markup}`;
}

export function downloadEvaluationArtifact(content: string, filename: string, type: string): void {
	const mime = type === "svg" ? "image/svg+xml" : type === "html" ? "text/html" : type === "json" ? "application/json" : "text/plain";
	const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename.replace(/[<>:"/\\|?*]/g, "-");
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
