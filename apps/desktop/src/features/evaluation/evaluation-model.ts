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

export interface EvaluationCriterionStatistics {
	key: string;
	id: string;
	label: string;
	description: string;
	taskIds: string[];
	total: number;
	count: number;
	sampleCount: number;
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
	criterionStats: EvaluationCriterionStatistics[];
	durationTotal: number;
	durationCount: number;
	costTotal: number;
	costCount: number;
}

/** Unknown metrics are excluded from means, with denominators retained for display. */
export function evaluationStatistics(run: EvaluationRunView, category: EvaluationCategory): EvaluationStatistics[] {
	const tasks = new Map(run.tasks.filter((task) => task.category === category).map((task) => [task.id, task]));
	const groups = new Map<string, EvaluationStatistics>();
	for (const result of run.results) {
		if (!result.revealed || !result.profile || !tasks.has(result.taskId) || !FINISHED_STATUSES.has(result.status)) continue;
		const task = tasks.get(result.taskId);
		if (!task) continue;
		const profile = result.profile;
		let stats = groups.get(profile.id);
		if (!stats) {
			stats = { key: profile.id, name: profile.model.name, thinkingLevel: profile.thinkingLevel, count: 0, passed: 0, checked: 0, unchecked: 0, failed: 0, scored: 0, criterionStats: [], durationTotal: 0, durationCount: 0, costTotal: 0, costCount: 0 };
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
		if (result.status === "completed") {
			let scored = false;
			for (const item of task.rubric) {
				// A familiar label can hide a different scoring rule; never combine those standards.
				const key = JSON.stringify([item.id, item.label, item.description]);
				let criterion = stats.criterionStats.find((entry) => entry.key === key);
				if (!criterion) {
					criterion = { key, id: item.id, label: item.label, description: item.description, taskIds: [], total: 0, count: 0, sampleCount: 0 };
					stats.criterionStats.push(criterion);
				}
				if (!criterion.taskIds.includes(task.id)) criterion.taskIds.push(task.id);
				criterion.sampleCount++;
				const score = result.rating?.scores[item.id];
				if (typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5) {
					criterion.total += score;
					criterion.count++;
					scored = true;
				}
			}
			if (scored) stats.scored++;
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
	const document = new DOMParser().parseFromString(type === "svg" ? `<!doctype html><html><body>${content}</body></html>` : content, "text/html");
	for (const element of document.querySelectorAll("base,meta[http-equiv],iframe,frame,object,embed,link")) element.remove();
	for (const element of document.querySelectorAll("[href],[xlink\\:href],[target],[action],[formaction]")) {
		for (const attribute of ["target", "action", "formaction"]) element.removeAttribute(attribute);
		for (const attribute of ["href", "xlink:href"]) {
			const value = element.getAttribute(attribute);
			if (value && !value.startsWith("#")) element.removeAttribute(attribute);
		}
	}
	if (type === "svg") {
		const svg = document.querySelector<SVGElement>("svg");
		if (svg) {
			// Fit the preview viewport, keeping the original stored artifact and its viewBox intact.
			if (!svg.hasAttribute("viewBox")) {
				const width = svg.getAttribute("width")?.match(/^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i)?.[1];
				const height = svg.getAttribute("height")?.match(/^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i)?.[1];
				if (width && height && Number(width) > 0 && Number(height) > 0) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
			}
			svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
			for (const property of ["width", "height", "max-width", "max-height"]) svg.style.setProperty(property, "100%", "important");
			for (const property of ["min-width", "min-height"]) svg.style.setProperty(property, "0", "important");
		}
	}
	const markup = type === "svg" ? `<style>html,body{margin:0;padding:0;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}body{display:flex;align-items:center;justify-content:center}body>svg{display:block;flex:0 1 100%;width:100%;height:100%;min-width:0;min-height:0;max-width:100%;max-height:100%;object-fit:contain}</style>${document.body.innerHTML}` : document.documentElement.outerHTML;
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
