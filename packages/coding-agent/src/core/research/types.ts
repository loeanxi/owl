/** Research is a persistent conversation scope, separate from ordinary and mailbox sessions. */
export type ResearchMode = "auto" | "crawl" | "web" | "model" | "osint";

export type ResearchCell = string | number | boolean | null;

export interface ResearchColumn {
	key: string;
	label: string;
}

export interface ResearchSource {
	id: string;
	title: string;
	/** An observed HTTP(S) URL. Local files and user-provided material can omit it. */
	url?: string;
	note?: string;
}

export interface ResearchFinding {
	kind: "fact" | "inference" | "unverified";
	text: string;
	/** References to sources in the same result, not invented external identifiers. */
	sourceIds: string[];
}

/** Agent-authored synthesis. Structural validation does not independently verify its claims. */
export interface ResearchResultInput {
	mode: Exclude<ResearchMode, "auto">;
	status: "sample" | "complete" | "partial";
	title: string;
	summary: string;
	columns: ResearchColumn[];
	rows: Record<string, ResearchCell>[];
	sources: ResearchSource[];
	findings: ResearchFinding[];
}

export interface ResearchResult extends ResearchResultInput {
	id: string;
	createdAt: string;
}

/** Stored in the normal tool-result transcript; no separate result database is needed. */
export interface ResearchResultDetails {
	researchResult: ResearchResult;
}
