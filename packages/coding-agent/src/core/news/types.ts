/** Shared desktop/news contracts. No credentials or Node-only imports cross this interface. */
export type NewsSourceKind = "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external";
export type NewsTier = "T1" | "T1_5" | "T2" | "EXCLUDE_MP";
export type NewsParticipation = "editorial" | "hot_signal" | "isolated";
export type NewsCapability =
	| "prefilter"
	| "score"
	| "structure"
	| "understand"
	| "summarize"
	| "group"
	| "groupReview"
	| "digest"
	| "report"
	| "translate"
	| "assistant";
export type NewsReportKind = "daily" | "weekly" | "monthly";
export interface NewsModelRef {
	provider: string;
	id: string;
}
export interface NewsSource {
	id: string;
	name: string;
	kind: NewsSourceKind;
	config: Record<string, unknown>;
	tier: NewsTier;
	participation: NewsParticipation;
	enabled: boolean;
	intervalMinutes: number;
	owner?: string;
	publisherGroup?: string;
	siteFulltext: boolean;
	syndicateFulltext: boolean;
	lastCollectedAt: string | null;
	nextCollectedAt: string | null;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}
export type NewsSourceInput = Omit<
	NewsSource,
	"lastCollectedAt" | "nextCollectedAt" | "lastError" | "createdAt" | "updatedAt"
>;
export interface NewsMaterial {
	title: string;
	url: string;
	body?: string;
	publishedAt?: string;
	author?: string;
	externalId?: string;
	language?: string;
	backfill?: boolean;
	raw?: Record<string, unknown>;
}
export interface NewsFactFrame {
	subject: string;
	action: string;
	object: string;
	occurredAt: string | null;
	evidence: string[];
}
export interface NewsAnalysis {
	relevance: "pass" | "block" | "unknown";
	scores: number[];
	score: number | null;
	selectionCandidate: boolean;
	title: string;
	summary: string;
	reason: string;
	category: string;
	tags: string[];
	entities: string[];
	contentKind: "single" | "composite" | "unknown";
	fact: NewsFactFrame | null;
}
export interface NewsItem extends NewsAnalysis {
	id: string;
	sourceId: string;
	sourceName: string;
	sourceKind: NewsSourceKind;
	sourceTier: NewsTier;
	participantId: string;
	participation: NewsParticipation;
	originalTitle: string;
	url: string;
	body: string | null;
	originalBody: string | null;
	author: string | null;
	publishedAt: string;
	discoveredAt: string;
	updatedAt: string;
	timelineAt: string;
	revision: number;
	status: "pending" | "processing" | "ready" | "failed" | "blocked";
	selected: boolean;
	selectedReadyAt?: string | null;
	novel: boolean;
	storyId: string | null;
	factId?: string | null;
	mentionedStoryIds?: string[];
	fulltextAllowed: boolean;
	backfill: boolean;
	saved: boolean;
	read: boolean;
	withdrawn: boolean;
	error: string | null;
}
export interface NewsStory {
	id: string;
	title: string;
	summary: string;
	category: string;
	tags: string[];
	entities: string[];
	createdAt: string;
	updatedAt: string;
	reports: NewsItem[];
	sourceCount: number;
	manual: boolean;
	relatedStoryIds: string[];
}
export interface NewsHotEvent {
	story: NewsStory;
	heat: number;
	change: number | null;
	trend: "new" | "rising" | "steady";
}
export interface NewsRelation {
	storyId: string | null;
	relation: "same" | "update" | "unrelated";
	novel: boolean;
	reason: string;
	factId?: string | null;
	mentions?: string[];
}
export interface NewsReportSection {
	label: string;
	summary: string;
	items: NewsItem[];
}
export interface NewsReport {
	id: string;
	kind: NewsReportKind;
	key: string;
	periodStart: string;
	periodEnd: string;
	title: string;
	lead: string;
	sections: NewsReportSection[];
	briefs: NewsItem[];
	createdAt: string;
	sourceCount: number;
	storyCount: number;
	leadItemId?: string;
	highlights?: string[];
	relatedItems?: Record<string, NewsItem[]>;
}
export interface NewsTopic {
	id: string;
	name: string;
	group: "company" | "field" | "genre";
	tags: string[];
	entities: string[];
	count: number;
}
export interface NewsConfiguration {
	collectEnabled: boolean;
	modelCallsEnabled: boolean;
	intervalMinutes: number;
	maxItemsPerSource: number;
	retentionDays: number;
	models: Partial<Record<NewsCapability, NewsModelRef>>;
	thresholds: Record<NewsTier, number | null>;
	understandFloor: number;
	budget: { perMinute: number; perHour: number; perDay: number };
	embedding: { enabled: boolean; baseUrl: string; model: string; dimensions: number | null };
	serviceStatus: Record<string, boolean>;
	allowPrivateNetwork: boolean;
}
export interface NewsUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number | null;
}
export interface NewsModelCall {
	capability: NewsCapability;
	system: string;
	user: string;
	maxTokens?: number;
	temperature?: number;
	model?: NewsModelRef;
	purpose?: string;
	signal?: AbortSignal;
}
export interface NewsModelResponse {
	text: string;
	provider: string;
	model: string;
	usage: NewsUsage;
}
export interface NewsModelResponseCache {
	key(request: Omit<NewsModelCall, "signal">): Promise<string>;
	read(key: string): unknown | null;
	stage(key: string, value: unknown): void;
	commit(): void;
}
export type NewsModelCaller = ((request: NewsModelCall) => Promise<NewsModelResponse>) & {
	responseCache?: NewsModelResponseCache;
};
export interface NewsJob {
	id: string;
	kind: string;
	subject: string;
	status: "pending" | "running" | "completed" | "failed";
	attempts: number;
	createdAt: string;
	updatedAt: string;
	nextAttemptAt: string;
	error: string | null;
}
export interface NewsReceipt {
	id: string;
	capability: string;
	subject: string;
	model: string;
	status: "pending" | "received" | "completed" | "unknown" | "failed";
	createdAt: string;
	updatedAt: string;
	attempts: number;
	usage: NewsUsage | null;
	error: string | null;
}
export interface NewsStatus {
	collectEnabled: boolean;
	modelCallsEnabled: boolean;
	running: boolean;
	sourceCount: number;
	itemCount: number;
	selectedCount: number;
	storyCount: number;
	reportCount: number;
	pendingCount: number;
	failedCount: number;
	lastUpdatedAt: string | null;
	databasePath: string;
}
export interface NewsSnapshot {
	status: NewsStatus;
	configuration: NewsConfiguration;
	categories: { id: string; label: string }[];
	models: { provider: string; id: string; name: string }[];
}
export interface NewsListQuery {
	mode?: "selected" | "all" | "saved";
	query?: string;
	category?: string;
	topic?: string;
	limit?: number;
	offset?: number;
	from?: string;
	until?: string;
}
export interface NewsListResult {
	items: NewsItem[];
	total: number;
	offset: number;
	limit: number;
}
export interface NewsEvaluationSample {
	id: string;
	material: NewsMaterial;
	tier: NewsTier;
	gold: "select" | "reject" | "either";
}
export interface NewsEvaluation {
	id: string;
	createdAt: string;
	count: number;
	accuracy: number;
	precision: number;
	recall: number;
	cases: { id: string; gold: string; selected: boolean; score: number | null; error: string | null }[];
	thresholds: { threshold: number; precision: number; recall: number }[];
}
export interface NewsAssistantRequest {
	question: string;
	itemIds: string[];
	storyId?: string;
	reportId?: string;
	quote?: string;
}
export interface NewsAssistantResult {
	answer: string;
	citations: { id: number; itemId: string; title: string; url: string }[];
	usage: NewsUsage;
}
export type NewsRequest =
	| { action: "adminItems"; query?: NewsListQuery; status?: NewsItem["status"] | "withdrawn" }
	| { action: "adminItem"; id: string }
	| { action: "snapshot" }
	| { action: "list"; query?: NewsListQuery }
	| { action: "item"; id: string }
	| { action: "story"; id: string }
	| { action: "hot"; limit?: number }
	| { action: "topics" }
	| { action: "reports"; kind?: NewsReportKind; limit?: number }
	| { action: "report"; kind: NewsReportKind; key?: string }
	| { action: "sources" }
	| { action: "saveSource"; source: NewsSourceInput }
	| { action: "deleteSource"; id: string }
	| { action: "previewSource"; source: NewsSourceInput }
	| { action: "configure"; patch: Partial<NewsConfiguration>; secrets?: Record<string, string> }
	| { action: "run"; sourceId?: string }
	| { action: "retry"; itemId?: string; jobId?: string; receiptId?: string }
	| { action: "ingest"; sourceId: string; items: NewsMaterial[] }
	| { action: "bookmark"; id: string; saved: boolean }
	| { action: "read"; id: string; read: boolean }
	| { action: "withdraw"; id: string; withdrawn: boolean }
	| {
			action: "editItem";
			id: string;
			patch: Partial<Pick<NewsItem, "title" | "summary" | "category" | "tags" | "selected">>;
	  }
	| { action: "moveItem"; id: string; storyId: string | null }
	| { action: "jobs"; limit?: number }
	| { action: "receipts"; limit?: number }
	| { action: "evaluate"; samples: NewsEvaluationSample[] }
	| { action: "evaluations" }
	| { action: "assistant"; request: NewsAssistantRequest }
	| { action: "export"; format: "rss" | "json" | "markdown"; query?: NewsListQuery; fulltext?: boolean }
	| { action: "backup" };

export interface NewsResultByAction {
	adminItems: NewsListResult;
	adminItem: NewsItem | null;
	snapshot: NewsSnapshot;
	list: NewsListResult;
	item: NewsItem | null;
	story: NewsStory | null;
	hot: NewsHotEvent[];
	topics: NewsTopic[];
	reports: NewsReport[];
	report: NewsReport | null;
	sources: NewsSource[];
	saveSource: NewsSource;
	deleteSource: { ok: boolean };
	previewSource: NewsMaterial[];
	configure: NewsConfiguration;
	run: { queued: number };
	retry: { queued: number };
	ingest: { created: number; updated: number; ignored: number };
	bookmark: NewsItem | null;
	read: NewsItem | null;
	withdraw: NewsItem | null;
	editItem: NewsItem | null;
	moveItem: NewsItem | null;
	jobs: NewsJob[];
	receipts: NewsReceipt[];
	evaluate: NewsEvaluation;
	evaluations: NewsEvaluation[];
	assistant: NewsAssistantResult;
	export: { content: string; filename: string; mimeType: string };
	backup: { path: string; createdAt: string };
}
