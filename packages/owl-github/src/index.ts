/**
 * owl-github：基于 gh CLI 的类型化 GitHub 工具（PR / Issue / Actions / Release）。
 * 移植自 amitkot/pi-tools 的 safe-github 0.2.0（MIT），与上游的差异见 README「OWL-PATCHES」，
 * 源码里以 `OWL-PATCH` 注释标出。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ToolAnnotations } from "@owl/owl-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

const EXEC_TIMEOUT = 30_000; // 30 seconds
const LOG_EXEC_TIMEOUT = 60_000; // logs can be larger/slower
const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB
const MAX_OUTPUT_CHARS = 4000;
const MAX_LOG_CHARS = 12_000;
const MAX_ERROR_CHARS = 500;
const PR_STATES = new Set(["open", "closed", "merged", "all"]);
const ISSUE_STATES = new Set(["open", "closed", "all"]);
const RUN_STATUSES = new Set([
	"queued",
	"completed",
	"in_progress",
	"requested",
	"waiting",
	"pending",
	"action_required",
	"cancelled",
	"failure",
	"neutral",
	"skipped",
	"stale",
	"startup_failure",
	"success",
	"timed_out",
]);
const PR_REVIEW_EVENTS = new Set(["approve", "comment", "request_changes"]);
const PR_MERGE_STRATEGIES = new Set(["merge", "squash", "rebase"]);

// =============================================================================
// Types and helpers
// =============================================================================

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; details: unknown };

type PrSelector = { number?: number; url?: string };
type IssueSelector = { number?: number; url?: string };

function commandLabel(cmd: string, args: string[]): string {
	return [cmd, ...args.slice(0, 3)].join(" ");
}

function sanitizeStderr(stderr: string | undefined): string {
	if (!stderr) return "";
	let text = stderr.trim();

	// Redact common GitHub token forms.
	text = text.replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[redacted-token]");
	text = text.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted-token]");

	// Avoid exposing full home-local credential/config paths.
	// OWL-PATCH: Windows 上家目录在 USERPROFILE，HOME 通常不存在。
	for (const home of [process.env.HOME, process.env.USERPROFILE]) {
		if (home) text = text.replaceAll(home, "~");
	}

	if (text.length > MAX_ERROR_CHARS) {
		text = `${text.slice(0, MAX_ERROR_CHARS)}... [truncated]`;
	}
	return text;
}

/**
 * Inherit a minimal set of environment variables so gh and git can locate
 * credentials and SSH agent. Do NOT forward the full process.env (avoids
 * leaking secrets).
 *
 * OWL-PATCH: upstream forwarded only HOME/PATH/SSH_AUTH_SOCK/GH_CONFIG_DIR/
 * XDG_CONFIG_HOME, which breaks on Windows: gh keeps its login under APPDATA,
 * Go networking fails without SystemRoot, and Git Credential Manager needs the
 * profile dirs. Proxy variables are forwarded because the Owl bridge injects
 * the configured proxy into process.env. Prompts are disabled so a missing
 * credential fails fast instead of hanging until the timeout.
 */
const CHILD_ENV_KEYS = [
	"HOME",
	"PATH",
	"SSH_AUTH_SOCK",
	"GH_CONFIG_DIR",
	"XDG_CONFIG_HOME",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_HOST",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SystemRoot",
	"windir",
	"ComSpec",
	"PATHEXT",
	"TEMP",
	"TMP",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"ProgramData",
	"ProgramFiles",
];

function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	env.GH_PROMPT_DISABLED = "1";
	env.GH_NO_UPDATE_NOTIFIER = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

/**
 * Run a command with argument arrays (no shell). Returns { stdout, stderr } or
 * throws a sanitized error that does not leak tokens, credential paths, or
 * environment variables.
 */
async function run(
	cmd: string,
	args: string[],
	options: { cwd: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
	const timeout = options.timeout ?? EXEC_TIMEOUT;
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			cwd: options.cwd,
			encoding: "utf-8",
			maxBuffer: options.maxBuffer ?? MAX_BUFFER,
			timeout,
			windowsHide: true,
			env: childEnv(),
		});
		return { stdout, stderr };
	} catch (error: any) {
		const label = commandLabel(cmd, args);
		if (error.code === "ETIMEDOUT") {
			throw new Error(`${label} timed out after ${timeout}ms`);
		}

		const stderr = sanitizeStderr(error.stderr);
		throw new Error(`${label} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return run("git", args, { cwd });
}

function gh(
	args: string[],
	cwd: string,
	options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	return run("gh", args, { cwd, ...options });
}

async function ghJson<T = any>(args: string[], cwd: string): Promise<T> {
	const { stdout } = await gh(args, cwd);
	return JSON.parse(stdout) as T;
}

function truncate(text: string, maxChars: number = MAX_OUTPUT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n... [truncated]`;
}

function tailLines(text: string, maxLines: number): string {
	const lines = text.split(/\r?\n/);
	if (lines.length <= maxLines) return text;
	return `[showing last ${maxLines} of ${lines.length} lines]\n${lines.slice(-maxLines).join("\n")}`;
}

export function requirePositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
}

function requireNonEmptyString(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`${label} is required.`);
	return trimmed;
}

function normalizeLimit(input: number | undefined, defaultValue: number, maxValue: number): number {
	const raw = input ?? defaultValue;
	if (!Number.isFinite(raw)) {
		throw new Error("limit must be a finite number.");
	}
	return Math.min(Math.max(Math.trunc(raw), 1), maxValue);
}

export function normalizePrListLimit(input: number | undefined): number {
	return normalizeLimit(input, 20, 50);
}

function normalizeRunListLimit(input: number | undefined): number {
	return normalizeLimit(input, 20, 100);
}

function normalizeIssueListLimit(input: number | undefined): number {
	return normalizeLimit(input, 20, 100);
}

function normalizeReleaseListLimit(input: number | undefined): number {
	return normalizeLimit(input, 30, 100);
}

function normalizeWorkflowListLimit(input: number | undefined): number {
	return normalizeLimit(input, 50, 100);
}

export function isGitHubPrUrl(url: string): boolean {
	return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#].*)?$/.test(url.trim());
}

function isGitHubIssueUrl(url: string): boolean {
	return /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+(?:[/?#].*)?$/.test(url.trim());
}

function validatePrSelector(params: PrSelector): void {
	if (params.number !== undefined && params.url !== undefined) {
		throw new Error("Provide either number or url, not both.");
	}
	if (params.number !== undefined) requirePositiveInteger(params.number, "number");
	if (params.url !== undefined && !isGitHubPrUrl(params.url)) {
		throw new Error("url must be a GitHub pull request URL.");
	}
}

function prSelectorArg(params: PrSelector): string | undefined {
	validatePrSelector(params);
	if (params.number !== undefined) return params.number.toString();
	if (params.url !== undefined) return params.url;
	return undefined;
}

function appendPrSelector(args: string[], params: PrSelector): void {
	const selector = prSelectorArg(params);
	if (selector) args.push(selector);
}

function validateIssueSelector(params: IssueSelector): void {
	if (params.number !== undefined && params.url !== undefined) {
		throw new Error("Provide either number or url, not both.");
	}
	if (params.number !== undefined) requirePositiveInteger(params.number, "number");
	if (params.url !== undefined && !isGitHubIssueUrl(params.url)) {
		throw new Error("url must be a GitHub issue URL.");
	}
}

function issueSelectorArg(params: IssueSelector): string {
	validateIssueSelector(params);
	if (params.number !== undefined) return params.number.toString();
	if (params.url !== undefined) return params.url;
	throw new Error("Provide either number or url.");
}

function appendIssueSelector(args: string[], params: IssueSelector): void {
	args.push(issueSelectorArg(params));
}

function requirePrSelectorArg(params: PrSelector): string {
	const selector = prSelectorArg(params);
	if (!selector) throw new Error("Provide either number or url.");
	return selector;
}

function formatLogin(value: any): string {
	return value?.login ? `@${value.login}` : "unknown";
}

function labelsText(labels: unknown): string {
	if (!Array.isArray(labels) || labels.length === 0) return "none";
	return labels.map((label: any) => label.name ?? String(label)).join(", ");
}

function validateInputPairs(inputs: { name: string; value: string }[] | undefined): { name: string; value: string }[] {
	if (!inputs) return [];
	return inputs.map((input, index) => {
		const name = requireNonEmptyString(input.name, `inputs[${index}].name`);
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
			throw new Error(`inputs[${index}].name contains unsupported characters.`);
		}
		return { name, value: String(input.value ?? "") };
	});
}

function ensureStringArray(values: string[] | undefined, label: string): string[] {
	if (!values) return [];
	return values.map((value, index) => requireNonEmptyString(value, `${label}[${index}]`));
}

function validateNoNewline(value: string, label: string): void {
	if (/[\r\n]/.test(value)) throw new Error(`${label} must not contain newlines.`);
}

// =============================================================================
// Repository info
// =============================================================================

interface RepoInfo {
	owner: string;
	repo: string;
	currentBranch: string;
	defaultBranch: string;
	repoUrl: string;
	worktreeRoot: string;
	visibility?: string;
	isPrivate?: boolean;
	viewerPermission?: string;
}

/**
 * Parse a GitHub remote URL of the forms:
 *   https://github.com/OWNER/REPO.git
 *   https://github.com/OWNER/REPO
 *   git@github.com:OWNER/REPO.git
 *   ssh://git@github.com/OWNER/REPO.git
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
	const trimmed = remoteUrl.trim();

	// OWL-PATCH: accept a `user@` prefix and a trailing slash (Git for Windows / GCM remotes).
	const httpsMatch = trimmed.match(/^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	const scpMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/);
	if (scpMatch) return { owner: scpMatch[1], repo: scpMatch[2] };

	const sshMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
	if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

	return null;
}

async function getRepoInfo(cwd: string): Promise<RepoInfo> {
	const { stdout: root } = await git(["rev-parse", "--show-toplevel"], cwd);
	const { stdout: remoteUrl } = await git(["remote", "get-url", "origin"], cwd);
	const { stdout: branch } = await git(["branch", "--show-current"], cwd);

	if (!branch.trim()) {
		throw new Error("Detached HEAD. Please checkout a branch before proceeding.");
	}

	const parsed = parseGitHubRemote(remoteUrl);
	if (!parsed) {
		throw new Error(`Origin remote is not an unambiguous GitHub remote: ${remoteUrl.trim()}`);
	}

	const { owner, repo } = parsed;
	const ghInfo = await ghJson<any>(
		[
			"repo",
			"view",
			`${owner}/${repo}`,
			"--json",
			"nameWithOwner,defaultBranchRef,url,visibility,isPrivate,viewerPermission",
		],
		cwd,
	);

	return {
		owner,
		repo,
		currentBranch: branch.trim(),
		defaultBranch: ghInfo.defaultBranchRef.name,
		repoUrl: ghInfo.url,
		worktreeRoot: root.trim(),
		visibility: ghInfo.visibility,
		isPrivate: ghInfo.isPrivate,
		viewerPermission: ghInfo.viewerPermission,
	};
}

// =============================================================================
// Safety assertions
// =============================================================================

async function assertCleanWorktree(cwd: string): Promise<void> {
	const { stdout } = await git(["status", "--porcelain"], cwd);
	if (stdout.trim()) {
		throw new Error("Worktree is dirty. Please commit or stash changes before creating a PR.");
	}
}

async function assertNotDefaultBranch(info: RepoInfo): Promise<void> {
	if (info.currentBranch === info.defaultBranch) {
		throw new Error(
			`You are on the default branch (${info.defaultBranch}). ` +
				"PR creation is not allowed from the default branch.",
		);
	}
}

async function checkUpstream(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

// =============================================================================
// Markdown builders
// =============================================================================

function summarizeChecks(statusCheckRollup: unknown): string | undefined {
	if (!Array.isArray(statusCheckRollup)) return undefined;
	const total = statusCheckRollup.length;
	if (total === 0) return "0 checks";
	const counts = new Map<string, number>();
	for (const check of statusCheckRollup as any[]) {
		const key = check.conclusion ?? check.status ?? check.state ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([key, count]) => `${key}: ${count}`)
		.join(", ");
}

function checksList(statusCheckRollup: unknown): string[] {
	if (!Array.isArray(statusCheckRollup)) return [];
	return statusCheckRollup.map((check: any) => {
		const name = check.name ?? check.workflowName ?? check.context ?? check.__typename ?? "check";
		const status = check.conclusion ?? check.status ?? check.state ?? "unknown";
		const url = check.detailsUrl ?? check.url ?? check.link ?? "";
		return `- ${name}: ${status}${url ? ` — ${url}` : ""}`;
	});
}

function summarizeReviews(latestReviews: unknown): string | undefined {
	if (!Array.isArray(latestReviews)) return undefined;
	if (latestReviews.length === 0) return "0 latest reviews";
	const counts = new Map<string, number>();
	for (const review of latestReviews as any[]) {
		const key = review.state ?? "unknown";
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([key, count]) => `${key}: ${count}`)
		.join(", ");
}

function buildPrViewMarkdown(pr: Record<string, unknown>): string {
	const draftTag = pr.isDraft ? " [DRAFT]" : "";
	const lines = [
		`## #${pr.number} — ${pr.title}${draftTag}`,
		"",
		`**State:** ${pr.state} | **Base:** \`${pr.baseRefName}\` → **Head:** \`${pr.headRefName}\``,
		`**URL:** ${pr.url}`,
		`**Author:** ${formatLogin(pr.author)}`,
		`**Created:** ${pr.createdAt}`,
		`**Changed files:** ${pr.changedFiles ?? "unknown"}`,
	];

	if (pr.mergeable) lines.push(`**Mergeable:** ${pr.mergeable}`);
	if (pr.mergeStateStatus) lines.push(`**Merge state:** ${pr.mergeStateStatus}`);
	if (pr.reviewDecision) lines.push(`**Review decision:** ${pr.reviewDecision}`);
	const reviewSummary = summarizeReviews(pr.latestReviews);
	if (reviewSummary) lines.push(`**Latest reviews:** ${reviewSummary}`);
	const checksSummary = summarizeChecks(pr.statusCheckRollup);
	if (checksSummary) lines.push(`**Checks:** ${checksSummary}`);

	const checks = checksList(pr.statusCheckRollup);
	if (checks.length > 0) {
		lines.push("", "### Check details", "", ...checks.slice(0, 40));
	}

	if (pr.body) lines.push("", "### Description", "", truncate(pr.body as string, 2000));
	return lines.join("\n");
}

function buildRunMarkdown(run: any): string {
	const lines = [
		`## Run ${run.databaseId ?? run.number ?? "unknown"} — ${run.displayTitle ?? run.name ?? "workflow run"}`,
		"",
		`**Workflow:** ${run.workflowName ?? run.name ?? "unknown"}`,
		`**Status:** ${run.status ?? "unknown"} | **Conclusion:** ${run.conclusion ?? "none"}`,
		`**Branch:** ${run.headBranch ?? "unknown"}`,
		`**SHA:** ${run.headSha ?? "unknown"}`,
		`**Event:** ${run.event ?? "unknown"}`,
		`**URL:** ${run.url ?? "unknown"}`,
	];

	if (Array.isArray(run.jobs) && run.jobs.length > 0) {
		lines.push("", "### Jobs", "");
		for (const job of run.jobs) {
			lines.push(
				`- ${job.name ?? job.databaseId}: ${job.status ?? "unknown"}/${job.conclusion ?? "none"}` +
					`${job.databaseId ? ` (databaseId: ${job.databaseId})` : ""}` +
					`${job.url ? ` — ${job.url}` : ""}`,
			);
			if (Array.isArray(job.steps)) {
				const failedSteps = job.steps.filter(
					(step: any) =>
						step.conclusion && !["success", "skipped", "neutral"].includes(String(step.conclusion).toLowerCase()),
				);
				for (const step of failedSteps.slice(0, 10)) {
					lines.push(`  - step ${step.name}: ${step.status ?? "unknown"}/${step.conclusion}`);
				}
			}
		}
	}

	return lines.join("\n");
}

function checkProblems(statusCheckRollup: unknown): { failing: string[]; pending: string[] } {
	const failing: string[] = [];
	const pending: string[] = [];
	if (!Array.isArray(statusCheckRollup)) return { failing, pending };

	for (const check of statusCheckRollup as any[]) {
		const name = check.name ?? check.workflowName ?? check.context ?? "check";
		const conclusion = String(check.conclusion ?? check.state ?? "").toLowerCase();
		const status = String(check.status ?? "").toLowerCase();
		if (["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)) {
			failing.push(`${name}: ${conclusion}`);
		} else if (!conclusion && status && !["completed", "success"].includes(status)) {
			pending.push(`${name}: ${status}`);
		} else if (conclusion && !["success", "skipped", "neutral"].includes(conclusion)) {
			failing.push(`${name}: ${conclusion}`);
		}
	}
	return { failing, pending };
}

// =============================================================================
// Schemas
// =============================================================================

const CWD_PROP = Type.Optional(Type.String({ description: "Working directory (defaults to the session cwd)" }));
const PR_SELECTOR_PROPS = {
	number: Type.Optional(Type.Number({ description: "PR number" })),
	url: Type.Optional(Type.String({ description: "PR URL" })),
};
const ISSUE_SELECTOR_PROPS = {
	number: Type.Optional(Type.Number({ description: "Issue number" })),
	url: Type.Optional(Type.String({ description: "Issue URL" })),
};

const AUTH_STATUS_SCHEMA = Type.Object({});
const REPO_INFO_SCHEMA = Type.Object({ cwd: CWD_PROP });
const BRANCH_INFO_SCHEMA = Type.Object({
	branch: Type.Optional(Type.String({ description: "Branch name (defaults to current branch)" })),
	cwd: CWD_PROP,
});
const PR_LIST_SCHEMA = Type.Object({
	state: Type.Optional(
		Type.String({ enum: ["open", "closed", "merged", "all"], default: "open", description: "PR state filter" }),
	),
	author: Type.Optional(Type.String({ description: "Filter by author login" })),
	head: Type.Optional(Type.String({ description: "Filter by head branch name" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 20, description: "Max PRs to return" })),
	cwd: CWD_PROP,
});
const PR_VIEW_SCHEMA = Type.Object({ ...PR_SELECTOR_PROPS, cwd: CWD_PROP });
const PR_CHECKS_SCHEMA = Type.Object({ ...PR_SELECTOR_PROPS, cwd: CWD_PROP });
const PR_FILES_SCHEMA = Type.Object({ ...PR_SELECTOR_PROPS, cwd: CWD_PROP });
const PR_DIFF_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	patch: Type.Optional(Type.Boolean({ default: false, description: "Return patch format" })),
	maxChars: Type.Optional(
		Type.Number({ minimum: 1000, maximum: 50000, default: 12000, description: "Maximum diff characters" }),
	),
	cwd: CWD_PROP,
});
const PR_CREATE_SCHEMA = Type.Object({
	title: Type.String({ description: "PR title" }),
	body: Type.String({ description: "PR body (markdown)" }),
	base: Type.Optional(Type.String({ description: "Target branch (default: repo default branch)" })),
	draft: Type.Optional(Type.Boolean({ default: false, description: "Create as draft PR" })),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set to true to create the PR; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});
const PR_EDIT_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	title: Type.Optional(Type.String({ description: "New PR title" })),
	body: Type.Optional(Type.String({ description: "New PR body (markdown)" })),
	cwd: CWD_PROP,
});
const PR_COMMENT_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	body: Type.String({ description: "Comment body" }),
	cwd: CWD_PROP,
});
const PR_REVIEW_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	event: Type.String({ enum: ["approve", "comment", "request_changes"], description: "Review action" }),
	body: Type.Optional(Type.String({ description: "Review body" })),
	cwd: CWD_PROP,
});
const PR_READY_SCHEMA = Type.Object({ ...PR_SELECTOR_PROPS, cwd: CWD_PROP });
const PR_CLOSE_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	comment: Type.Optional(Type.String({ description: "Optional close comment" })),
	deleteBranch: Type.Optional(Type.Boolean({ default: false, description: "Delete branch after closing" })),
	cwd: CWD_PROP,
});
const PR_REOPEN_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	comment: Type.Optional(Type.String({ description: "Optional reopen comment" })),
	cwd: CWD_PROP,
});
const PR_MERGE_SCHEMA = Type.Object({
	...PR_SELECTOR_PROPS,
	strategy: Type.String({ enum: ["merge", "squash", "rebase"], description: "Merge strategy" }),
	deleteBranch: Type.Optional(Type.Boolean({ default: false, description: "Delete branch after merge" })),
	subject: Type.Optional(Type.String({ description: "Merge commit subject" })),
	body: Type.Optional(Type.String({ description: "Merge commit body" })),
	matchHeadCommit: Type.Optional(Type.String({ description: "Expected PR head SHA" })),
	requirePassingChecks: Type.Optional(
		Type.Boolean({ default: true, description: "Refuse merge when checks are failing or pending" }),
	),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to merge; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});

const RUN_LIST_SCHEMA = Type.Object({
	branch: Type.Optional(Type.String({ description: "Filter by branch" })),
	status: Type.Optional(Type.String({ description: "Filter by run status/conclusion" })),
	event: Type.Optional(Type.String({ description: "Filter by event" })),
	workflow: Type.Optional(Type.String({ description: "Filter by workflow name or file" })),
	user: Type.Optional(Type.String({ description: "Filter by triggering user" })),
	commit: Type.Optional(Type.String({ description: "Filter by commit SHA" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20, description: "Max runs to return" })),
	cwd: CWD_PROP,
});
const RUN_VIEW_SCHEMA = Type.Object({ runId: Type.Number({ description: "Workflow run database id" }), cwd: CWD_PROP });
const RUN_LOGS_SCHEMA = Type.Object({
	runId: Type.Number({ description: "Workflow run database id" }),
	jobId: Type.Optional(Type.String({ description: "Optional job database id" })),
	tailLines: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 1000,
			default: 200,
			description: "Number of log lines to return from the end",
		}),
	),
	cwd: CWD_PROP,
});
const COMMIT_STATUS_SCHEMA = Type.Object({
	sha: Type.Optional(Type.String({ description: "Commit SHA (defaults to HEAD)" })),
	cwd: CWD_PROP,
});

const ISSUE_LIST_SCHEMA = Type.Object({
	state: Type.Optional(
		Type.String({ enum: ["open", "closed", "all"], default: "open", description: "Issue state filter" }),
	),
	author: Type.Optional(Type.String({ description: "Filter by author" })),
	assignee: Type.Optional(Type.String({ description: "Filter by assignee" })),
	label: Type.Optional(Type.Array(Type.String(), { description: "Labels to filter by" })),
	search: Type.Optional(Type.String({ description: "Search query" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20, description: "Max issues to return" })),
	cwd: CWD_PROP,
});
const ISSUE_VIEW_SCHEMA = Type.Object({ ...ISSUE_SELECTOR_PROPS, cwd: CWD_PROP });
const ISSUE_CREATE_SCHEMA = Type.Object({
	title: Type.String({ description: "Issue title" }),
	body: Type.Optional(Type.String({ description: "Issue body" })),
	label: Type.Optional(Type.Array(Type.String(), { description: "Labels to add" })),
	assignee: Type.Optional(Type.Array(Type.String(), { description: "Assignees to add" })),
	cwd: CWD_PROP,
});
const ISSUE_COMMENT_SCHEMA = Type.Object({
	...ISSUE_SELECTOR_PROPS,
	body: Type.String({ description: "Comment body" }),
	cwd: CWD_PROP,
});
const ISSUE_EDIT_SCHEMA = Type.Object({
	...ISSUE_SELECTOR_PROPS,
	title: Type.Optional(Type.String({ description: "New issue title" })),
	body: Type.Optional(Type.String({ description: "New issue body" })),
	cwd: CWD_PROP,
});
const ISSUE_CLOSE_SCHEMA = Type.Object({
	...ISSUE_SELECTOR_PROPS,
	comment: Type.Optional(Type.String({ description: "Optional close comment" })),
	cwd: CWD_PROP,
});
const ISSUE_REOPEN_SCHEMA = Type.Object({
	...ISSUE_SELECTOR_PROPS,
	comment: Type.Optional(Type.String({ description: "Optional reopen comment" })),
	cwd: CWD_PROP,
});

const WORKFLOW_LIST_SCHEMA = Type.Object({
	all: Type.Optional(Type.Boolean({ default: false, description: "Include disabled workflows" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 50, description: "Max workflows to return" })),
	cwd: CWD_PROP,
});
const WORKFLOW_VIEW_SCHEMA = Type.Object({
	workflow: Type.String({ description: "Workflow id, name, or file" }),
	ref: Type.Optional(Type.String({ description: "Branch or tag ref" })),
	yaml: Type.Optional(Type.Boolean({ default: false, description: "Return workflow YAML" })),
	cwd: CWD_PROP,
});
const WORKFLOW_DISPATCH_SCHEMA = Type.Object({
	workflow: Type.String({ description: "Workflow id, name, or file" }),
	ref: Type.Optional(Type.String({ description: "Branch or tag ref" })),
	inputs: Type.Optional(
		Type.Array(Type.Object({ name: Type.String(), value: Type.String() }), {
			description: "workflow_dispatch input pairs",
		}),
	),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to dispatch; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});
const RUN_RERUN_SCHEMA = Type.Object({
	runId: Type.Number({ description: "Workflow run database id" }),
	failedOnly: Type.Optional(Type.Boolean({ default: false, description: "Rerun only failed jobs" })),
	jobId: Type.Optional(Type.String({ description: "Specific job database id" })),
	debug: Type.Optional(Type.Boolean({ default: false, description: "Enable debug logging" })),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to rerun; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});
const RUN_CANCEL_SCHEMA = Type.Object({
	runId: Type.Number({ description: "Workflow run database id" }),
	force: Type.Optional(Type.Boolean({ default: false, description: "Force cancel" })),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to cancel; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});

const RELEASE_LIST_SCHEMA = Type.Object({
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 30, description: "Max releases to return" })),
	cwd: CWD_PROP,
});
const RELEASE_VIEW_SCHEMA = Type.Object({
	tag: Type.Optional(Type.String({ description: "Release tag (defaults to latest)" })),
	cwd: CWD_PROP,
});
const RELEASE_CREATE_SCHEMA = Type.Object({
	tag: Type.String({ description: "Release tag" }),
	title: Type.Optional(Type.String({ description: "Release title" })),
	notes: Type.Optional(Type.String({ description: "Release notes" })),
	target: Type.Optional(Type.String({ description: "Target branch or SHA" })),
	draft: Type.Optional(Type.Boolean({ default: false, description: "Create as draft" })),
	prerelease: Type.Optional(Type.Boolean({ default: false, description: "Mark as prerelease" })),
	generateNotes: Type.Optional(Type.Boolean({ default: false, description: "Generate release notes" })),
	verifyTag: Type.Optional(Type.Boolean({ default: false, description: "Require tag to exist remotely" })),
	failOnNoCommits: Type.Optional(
		Type.Boolean({ default: false, description: "Fail if no commits since previous release" }),
	),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to create; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});
const RELEASE_UPLOAD_ASSET_SCHEMA = Type.Object({
	tag: Type.String({ description: "Release tag" }),
	path: Type.String({ description: "Asset file path" }),
	label: Type.Optional(Type.String({ description: "Optional display label" })),
	clobber: Type.Optional(Type.Boolean({ default: false, description: "Replace existing asset with same name" })),
	confirm: Type.Optional(
		Type.Boolean({ default: false, description: "Set true to upload; omit or false to preview only" }),
	),
	cwd: CWD_PROP,
});

// =============================================================================
// Tool handlers: auth/repo/branch
// =============================================================================

async function handleAuthStatus(_toolCallId: string, _params: Record<string, never>, cwd: string): Promise<ToolResult> {
	try {
		await gh(["auth", "status"], cwd);
		const { stdout: login } = await gh(["api", "/user", "--jq", ".login"], cwd);
		const username = login.trim();
		return {
			content: [{ type: "text", text: `**gh auth:** OK\n**Logged in as:** @${username}` }],
			details: { username, success: true },
		};
	} catch (error: any) {
		return {
			content: [
				{
					type: "text",
					text: `**gh auth:** FAILED\n\n${error.message}\n\nRun \`gh auth login\` on the host if needed.`,
				},
			],
			details: { success: false, error: error.message },
		};
	}
}

async function handleRepoInfo(_toolCallId: string, params: { cwd?: string }, defaultCwd: string): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const info = await getRepoInfo(cwd);
	const md = [
		`**Owner:** ${info.owner}`,
		`**Repo:** ${info.repo}`,
		`**Default branch:** ${info.defaultBranch}`,
		`**Current branch:** ${info.currentBranch}`,
		`**Visibility:** ${info.visibility ?? (info.isPrivate ? "PRIVATE" : "unknown")}`,
		`**Viewer permission:** ${info.viewerPermission ?? "unknown"}`,
		`**URL:** ${info.repoUrl}`,
		`**Worktree root:** ${info.worktreeRoot}`,
	].join("\n");
	return { content: [{ type: "text", text: md }], details: info };
}

async function handleBranchInfo(
	_toolCallId: string,
	params: { branch?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const info = await getRepoInfo(cwd);
	const branch = params.branch?.trim() || info.currentBranch;
	validateNoNewline(branch, "branch");

	let remoteExists = false;
	try {
		const { stdout } = await git(["ls-remote", "--heads", "origin", branch], cwd);
		remoteExists = stdout.trim().length > 0;
	} catch {
		remoteExists = false;
	}

	let localExists = false;
	try {
		await git(["rev-parse", "--verify", branch], cwd);
		localExists = true;
	} catch {
		localExists = false;
	}

	let branchApi: any = null;
	try {
		branchApi = await ghJson<any>(
			["api", `repos/${info.owner}/${info.repo}/branches/${encodeURIComponent(branch)}`],
			cwd,
		);
	} catch {
		branchApi = null;
	}

	let compare: any = null;
	try {
		compare = await ghJson<any>(
			[
				"api",
				`repos/${info.owner}/${info.repo}/compare/${encodeURIComponent(info.defaultBranch)}...${encodeURIComponent(branch)}`,
			],
			cwd,
		);
	} catch {
		compare = null;
	}

	// OWL-PATCH: upstream used the `branch` key twice, so the API payload overwrote the branch name.
	const details = {
		repo: `${info.owner}/${info.repo}`,
		branch,
		defaultBranch: info.defaultBranch,
		localExists,
		remoteExists,
		branchApi,
		compare,
	};
	const md = [
		`## Branch ${branch}`,
		"",
		`**Repo:** ${info.owner}/${info.repo}`,
		`**Default branch:** ${info.defaultBranch}`,
		`**Local exists:** ${localExists ? "yes" : "no"}`,
		`**Remote exists:** ${remoteExists ? "yes" : "no"}`,
		`**Protected:** ${branchApi?.protected === true ? "yes" : branchApi ? "no" : "unknown"}`,
		compare
			? `**Ahead/behind ${info.defaultBranch}:** ahead ${compare.ahead_by}, behind ${compare.behind_by} (${compare.status})`
			: "**Ahead/behind:** unknown",
	].join("\n");
	return { content: [{ type: "text", text: md }], details };
}

// =============================================================================
// Tool handlers: pull requests
// =============================================================================

async function handlePrList(
	_toolCallId: string,
	params: { state?: string; author?: string; head?: string; limit?: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const state = params.state ?? "open";
	if (!PR_STATES.has(state)) throw new Error(`state must be one of: ${Array.from(PR_STATES).join(", ")}.`);
	const limit = normalizePrListLimit(params.limit);

	const args = [
		"pr",
		"list",
		"--json",
		"number,title,state,isDraft,headRefName,baseRefName,url,author,updatedAt,statusCheckRollup",
		"--state",
		state,
		"--limit",
		limit.toString(),
	];
	if (params.author) args.push("--author", params.author);
	if (params.head) args.push("--head", params.head);

	const prs = await ghJson<any[]>(args, cwd);
	if (prs.length === 0) return { content: [{ type: "text", text: `No ${state} PRs found.` }], details: { prs } };

	const lines = prs.map((pr: any) => {
		const draftTag = pr.isDraft ? " [DRAFT]" : "";
		const checks = summarizeChecks(pr.statusCheckRollup);
		return [
			`### #${pr.number} — ${pr.title}${draftTag}`,
			`- **State:** ${pr.state} | **Base:** \`${pr.baseRefName}\` → **Head:** \`${pr.headRefName}\``,
			`- **Author:** ${formatLogin(pr.author)}`,
			checks ? `- **Checks:** ${checks}` : undefined,
			`- **Updated:** ${pr.updatedAt}`,
			`- **URL:** ${pr.url}`,
		]
			.filter(Boolean)
			.join("\n");
	});
	return { content: [{ type: "text", text: truncate(lines.join("\n\n---\n\n")) }], details: { prs } };
}

async function handlePrView(
	_toolCallId: string,
	params: PrSelector & { cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const jsonFields = [
		"number",
		"title",
		"body",
		"state",
		"isDraft",
		"baseRefName",
		"headRefName",
		"url",
		"reviewDecision",
		"latestReviews",
		"statusCheckRollup",
		"changedFiles",
		"createdAt",
		"author",
		"mergeable",
		"mergeStateStatus",
	].join(",");
	const args = ["pr", "view"];
	appendPrSelector(args, params);
	args.push("--json", jsonFields);
	const pr = await ghJson<Record<string, unknown>>(args, cwd);
	return { content: [{ type: "text", text: truncate(buildPrViewMarkdown(pr)) }], details: { pr } };
}

async function handlePrChecks(
	_toolCallId: string,
	params: PrSelector & { cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["pr", "checks"];
	appendPrSelector(args, params);
	args.push("--json", "bucket,completedAt,description,event,link,name,startedAt,state,workflow");
	const checks = await ghJson<any[]>(args, cwd);
	const lines =
		checks.length === 0
			? ["No checks found."]
			: checks.map(
					(check) =>
						`- **${check.name}** (${check.workflow ?? "workflow"}): ${check.state ?? check.bucket ?? "unknown"}${check.link ? ` — ${check.link}` : ""}${check.description ? `\n  ${check.description}` : ""}`,
				);
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { checks } };
}

async function handlePrFiles(
	_toolCallId: string,
	params: PrSelector & { cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["pr", "view"];
	appendPrSelector(args, params);
	args.push("--json", "number,title,url,files");
	const pr = await ghJson<any>(args, cwd);
	const files = Array.isArray(pr.files) ? pr.files : [];
	const lines = [
		`## #${pr.number} — ${pr.title}`,
		`**URL:** ${pr.url}`,
		"",
		`Changed files: ${files.length}`,
		"",
		...files.map(
			(file: any) =>
				`- ${file.path ?? file.filename ?? "unknown"} (+${file.additions ?? "?"}/-${file.deletions ?? "?"})`,
		),
	];
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { pr } };
}

async function handlePrDiff(
	_toolCallId: string,
	params: PrSelector & { patch?: boolean; maxChars?: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["pr", "diff"];
	appendPrSelector(args, params);
	if (params.patch) args.push("--patch");
	const { stdout } = await gh(args, cwd, { maxBuffer: MAX_BUFFER });
	const maxChars = normalizeLimit(params.maxChars, 12000, 50000);
	return {
		content: [{ type: "text", text: truncate(stdout.trim() || "No diff output.", maxChars) }],
		details: { chars: stdout.length, truncated: stdout.length > maxChars },
	};
}

async function handlePrCreate(
	_toolCallId: string,
	params: { title: string; body: string; base?: string; draft?: boolean; confirm?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	if (!params.title?.trim()) throw new Error("PR title is required.");
	if (!params.body?.trim()) throw new Error("PR body is required.");

	const info = await getRepoInfo(cwd);
	await assertNotDefaultBranch(info);
	await assertCleanWorktree(cwd);

	const base = params.base?.trim() || info.defaultBranch;
	const draft = params.draft ?? false;
	const hasUpstream = await checkUpstream(cwd);

	const pushArgv = hasUpstream ? ["git", "push"] : ["git", "push", "-u", "origin", info.currentBranch];
	const createArgs = ["pr", "create", "--title", params.title, "--body", params.body, "--base", base];
	if (draft) createArgs.push("--draft");
	const createArgvPreview = [
		"gh",
		"pr",
		"create",
		"--title",
		params.title,
		"--body",
		`<${params.body.length} chars>`,
		"--base",
		base,
		...(draft ? ["--draft"] : []),
	];

	if (params.confirm !== true) {
		const plannedArgv = [pushArgv, createArgvPreview];
		const md = [
			"### PR Preview",
			"",
			"No mutation was performed.",
			"",
			`**Repo:** ${info.owner}/${info.repo}`,
			`**Branch:** ${info.currentBranch} → **Base:** ${base}`,
			`**Title:** ${params.title}`,
			`**Draft:** ${draft ? "yes" : "no"}`,
			`**Body length:** ${params.body.length} chars`,
			`**Upstream exists:** ${hasUpstream ? "yes" : "no"}`,
			"",
			"**Planned argv arrays (body redacted):**",
			"```json",
			JSON.stringify(plannedArgv, null, 2),
			"```",
			"",
			"Call again with `confirm: true` to create the PR.",
		].join("\n");
		return {
			content: [{ type: "text", text: md }],
			details: {
				preview: true,
				repo: `${info.owner}/${info.repo}`,
				branch: info.currentBranch,
				base,
				title: params.title,
				bodyLength: params.body.length,
				draft,
				plannedArgv,
			},
		};
	}

	if (!hasUpstream) await git(["push", "-u", "origin", info.currentBranch], cwd);
	else await git(["push"], cwd);
	const { stdout } = await gh(createArgs, cwd);
	const prUrl = stdout.match(/https?:\/\/[^\s]+/)?.[0] ?? "unknown URL";
	return { content: [{ type: "text", text: `PR created: ${prUrl}` }], details: { pr_url: prUrl } };
}

export function buildPrEditArgv(params: { number?: number; url?: string; title?: string; body?: string }): string[] {
	const args: string[] = ["pr", "edit"];
	if (params.number !== undefined) args.push(params.number.toString());
	else if (params.url !== undefined) args.push(params.url);
	if (params.title !== undefined) args.push("--title", params.title);
	if (params.body !== undefined) args.push("--body", params.body);
	return args;
}

async function handlePrEdit(
	_toolCallId: string,
	params: PrSelector & { title?: string; body?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	validatePrSelector(params);
	const titleTrimmed = params.title?.trim();
	const bodyTrimmed = params.body?.trim();
	if (titleTrimmed === "") throw new Error("title must not be empty.");
	if (bodyTrimmed === "") throw new Error("body must not be empty.");
	if (titleTrimmed === undefined && bodyTrimmed === undefined)
		throw new Error("Provide at least one field to update: title or body.");

	const args = buildPrEditArgv({ number: params.number, url: params.url, title: titleTrimmed, body: bodyTrimmed });
	const { stdout } = await gh(args, cwd);
	const prUrl = stdout.match(/https?:\/\/[^\s]+/)?.[0] ?? "unknown URL";
	const changed: string[] = [];
	if (titleTrimmed !== undefined) changed.push("title");
	if (bodyTrimmed !== undefined) changed.push("body");
	const md = [
		`PR updated.`,
		`**URL:** ${prUrl}`,
		`**Changed:** ${changed.join(", ")}`,
		titleTrimmed !== undefined ? `**New title:** ${titleTrimmed}` : "",
		bodyTrimmed !== undefined ? `**New body length:** ${bodyTrimmed.length} chars` : "",
	]
		.filter(Boolean)
		.join("\n");
	return {
		content: [{ type: "text", text: md }],
		details: {
			pr_number: params.number,
			pr_url: prUrl,
			changed,
			title: titleTrimmed,
			bodyLength: bodyTrimmed?.length,
		},
	};
}

async function handlePrComment(
	_toolCallId: string,
	params: PrSelector & { body: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const body = requireNonEmptyString(params.body, "body");
	const args = ["pr", "comment"];
	appendPrSelector(args, params);
	args.push("--body", body);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "PR comment added." }],
		details: { bodyLength: body.length },
	};
}

async function handlePrReview(
	_toolCallId: string,
	params: PrSelector & { event: string; body?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	if (!PR_REVIEW_EVENTS.has(params.event)) throw new Error("event must be approve, comment, or request_changes.");
	const body = params.body?.trim();
	if ((params.event === "comment" || params.event === "request_changes") && !body)
		throw new Error("body is required for comment and request_changes reviews.");
	const args = ["pr", "review"];
	appendPrSelector(args, params);
	args.push(params.event === "approve" ? "--approve" : params.event === "comment" ? "--comment" : "--request-changes");
	if (body) args.push("--body", body);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `PR review submitted: ${params.event}` }],
		details: { event: params.event, bodyLength: body?.length ?? 0 },
	};
}

async function handlePrReady(
	_toolCallId: string,
	params: PrSelector & { cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["pr", "ready"];
	appendPrSelector(args, params);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "PR marked ready for review." }],
		details: { selector: prSelectorArg(params) ?? "current branch" },
	};
}

async function handlePrClose(
	_toolCallId: string,
	params: PrSelector & { comment?: string; deleteBranch?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const selector = requirePrSelectorArg(params);
	const args = ["pr", "close", selector];
	if (params.comment?.trim()) args.push("--comment", params.comment.trim());
	if (params.deleteBranch) args.push("--delete-branch");
	const { stdout } = await gh(args, cwd);
	return { content: [{ type: "text", text: stdout.trim() || "PR closed." }], details: { selector } };
}

async function handlePrReopen(
	_toolCallId: string,
	params: PrSelector & { comment?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const selector = requirePrSelectorArg(params);
	const args = ["pr", "reopen", selector];
	if (params.comment?.trim()) args.push("--comment", params.comment.trim());
	const { stdout } = await gh(args, cwd);
	return { content: [{ type: "text", text: stdout.trim() || "PR reopened." }], details: { selector } };
}

async function handlePrMerge(
	_toolCallId: string,
	params: PrSelector & {
		strategy: string;
		deleteBranch?: boolean;
		subject?: string;
		body?: string;
		matchHeadCommit?: string;
		requirePassingChecks?: boolean;
		confirm?: boolean;
		cwd?: string;
	},
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	if (!PR_MERGE_STRATEGIES.has(params.strategy)) throw new Error("strategy must be merge, squash, or rebase.");
	const selector = prSelectorArg(params);
	const viewArgs = ["pr", "view"];
	if (selector) viewArgs.push(selector);
	viewArgs.push("--json", "number,title,state,isDraft,url,mergeable,mergeStateStatus,statusCheckRollup,headRefOid");
	const pr = await ghJson<any>(viewArgs, cwd);
	const problems = checkProblems(pr.statusCheckRollup);
	const requirePassingChecks = params.requirePassingChecks !== false;
	const plannedArgv = [
		"gh",
		"pr",
		"merge",
		selector ?? String(pr.number),
		`--${params.strategy}`,
		...(params.deleteBranch ? ["--delete-branch"] : []),
		...(params.subject ? ["--subject", params.subject] : []),
		...(params.body ? ["--body", `<${params.body.length} chars>`] : []),
		...(params.matchHeadCommit ? ["--match-head-commit", params.matchHeadCommit] : []),
	];

	const preview = [
		"### PR Merge Preview",
		"",
		params.confirm === true ? "Preparing to merge." : "No mutation was performed.",
		"",
		`**PR:** #${pr.number} — ${pr.title}`,
		`**URL:** ${pr.url}`,
		`**State:** ${pr.state}`,
		`**Draft:** ${pr.isDraft ? "yes" : "no"}`,
		`**Mergeable:** ${pr.mergeable ?? "unknown"}`,
		`**Merge state:** ${pr.mergeStateStatus ?? "unknown"}`,
		`**Strategy:** ${params.strategy}`,
		`**Failing checks:** ${problems.failing.length}`,
		`**Pending checks:** ${problems.pending.length}`,
		"",
		"**Planned argv array:**",
		"```json",
		JSON.stringify(plannedArgv, null, 2),
		"```",
	].join("\n");

	if (params.confirm !== true)
		return {
			content: [{ type: "text", text: `${preview}\n\nCall again with \`confirm: true\` to merge.` }],
			details: { preview: true, pr, problems, plannedArgv },
		};
	if (String(pr.state).toUpperCase() !== "OPEN") throw new Error("Refusing to merge: PR is not open.");
	if (pr.isDraft) throw new Error("Refusing to merge: PR is draft.");
	if (requirePassingChecks && (problems.failing.length > 0 || problems.pending.length > 0)) {
		throw new Error(
			`Refusing to merge: checks are not passing. Failing: ${problems.failing.join(", ") || "none"}. Pending: ${problems.pending.join(", ") || "none"}.`,
		);
	}

	const args = ["pr", "merge", selector ?? String(pr.number), `--${params.strategy}`];
	if (params.deleteBranch) args.push("--delete-branch");
	if (params.subject) args.push("--subject", params.subject);
	if (params.body) args.push("--body", params.body);
	if (params.matchHeadCommit) args.push("--match-head-commit", params.matchHeadCommit);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `PR #${pr.number} merged.` }],
		details: { pr, merged: true },
	};
}

// =============================================================================
// Tool handlers: runs/checks
// =============================================================================

async function handleRunList(
	_toolCallId: string,
	params: {
		branch?: string;
		status?: string;
		event?: string;
		workflow?: string;
		user?: string;
		commit?: string;
		limit?: number;
		cwd?: string;
	},
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	if (params.status && !RUN_STATUSES.has(params.status))
		throw new Error(`status must be one of: ${Array.from(RUN_STATUSES).join(", ")}.`);
	const limit = normalizeRunListLimit(params.limit);
	const args = [
		"run",
		"list",
		"--json",
		"attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
		"--limit",
		limit.toString(),
	];
	if (params.branch) args.push("--branch", params.branch);
	if (params.status) args.push("--status", params.status);
	if (params.event) args.push("--event", params.event);
	if (params.workflow) args.push("--workflow", params.workflow);
	if (params.user) args.push("--user", params.user);
	if (params.commit) args.push("--commit", params.commit);
	const runs = await ghJson<any[]>(args, cwd);
	const lines =
		runs.length === 0
			? ["No workflow runs found."]
			: runs.map(
					(run) =>
						`- **${run.databaseId}** ${run.workflowName ?? run.name}: ${run.status ?? "unknown"}/${run.conclusion ?? "none"} — ${run.headBranch ?? "unknown"} ${run.headSha ? String(run.headSha).slice(0, 7) : ""}\n  ${run.displayTitle ?? ""}\n  ${run.url ?? ""}`,
				);
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { runs } };
}

async function handleRunView(
	_toolCallId: string,
	params: { runId: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	requirePositiveInteger(params.runId, "runId");
	const run = await ghJson<any>(
		[
			"run",
			"view",
			params.runId.toString(),
			"--json",
			"attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
		],
		cwd,
	);
	return { content: [{ type: "text", text: truncate(buildRunMarkdown(run)) }], details: { run } };
}

async function handleRunLogs(
	_toolCallId: string,
	params: { runId: number; jobId?: string; tailLines?: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	requirePositiveInteger(params.runId, "runId");
	const maxLines = normalizeLimit(params.tailLines, 200, 1000);
	const args = ["run", "view", params.runId.toString(), "--log"];
	if (params.jobId) args.push("--job", params.jobId);
	const { stdout } = await gh(args, cwd, { timeout: LOG_EXEC_TIMEOUT, maxBuffer: MAX_BUFFER });
	const output = tailLines(stdout.trim() || "No logs found.", maxLines);
	return {
		content: [{ type: "text", text: truncate(output, MAX_LOG_CHARS) }],
		details: { runId: params.runId, jobId: params.jobId, linesRequested: maxLines, chars: stdout.length },
	};
}

async function handleCommitStatus(
	_toolCallId: string,
	params: { sha?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const info = await getRepoInfo(cwd);
	let sha = params.sha?.trim();
	if (!sha) {
		const { stdout } = await git(["rev-parse", "HEAD"], cwd);
		sha = stdout.trim();
	}
	if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error("sha must be a 7-40 character hexadecimal commit SHA.");
	const status = await ghJson<any>(["api", `repos/${info.owner}/${info.repo}/commits/${sha}/status`], cwd);
	const checks = await ghJson<any>(["api", `repos/${info.owner}/${info.repo}/commits/${sha}/check-runs`], cwd);
	const checkRuns = Array.isArray(checks.check_runs) ? checks.check_runs : [];
	const lines = [
		`## Commit ${sha}`,
		"",
		`**Combined status:** ${status.state ?? "unknown"}`,
		`**Statuses:** ${Array.isArray(status.statuses) ? status.statuses.length : 0}`,
		`**Check runs:** ${checkRuns.length}`,
		"",
		...checkRuns
			.slice(0, 50)
			.map(
				(check: any) =>
					`- ${check.name}: ${check.status ?? "unknown"}/${check.conclusion ?? "none"}${check.html_url ? ` — ${check.html_url}` : ""}`,
			),
	];
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { sha, status, checkRuns } };
}

// =============================================================================
// Tool handlers: issues
// =============================================================================

async function handleIssueList(
	_toolCallId: string,
	params: {
		state?: string;
		author?: string;
		assignee?: string;
		label?: string[];
		search?: string;
		limit?: number;
		cwd?: string;
	},
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const state = params.state ?? "open";
	if (!ISSUE_STATES.has(state)) throw new Error(`state must be one of: ${Array.from(ISSUE_STATES).join(", ")}.`);
	const limit = normalizeIssueListLimit(params.limit);
	const args = [
		"issue",
		"list",
		"--json",
		"number,title,state,stateReason,url,author,labels,comments,updatedAt",
		"--state",
		state,
		"--limit",
		limit.toString(),
	];
	if (params.author) args.push("--author", params.author);
	if (params.assignee) args.push("--assignee", params.assignee);
	for (const label of ensureStringArray(params.label, "label")) args.push("--label", label);
	if (params.search) args.push("--search", params.search);
	const issues = await ghJson<any[]>(args, cwd);
	const lines =
		issues.length === 0
			? [`No ${state} issues found.`]
			: issues.map(
					(issue) =>
						`### #${issue.number} — ${issue.title}\n- **State:** ${issue.state}${issue.stateReason ? ` (${issue.stateReason})` : ""}\n- **Author:** ${formatLogin(issue.author)} | **Comments:** ${issue.comments ?? 0}\n- **Labels:** ${labelsText(issue.labels)}\n- **Updated:** ${issue.updatedAt}\n- **URL:** ${issue.url}`,
				);
	return { content: [{ type: "text", text: truncate(lines.join("\n\n---\n\n")) }], details: { issues } };
}

async function handleIssueView(
	_toolCallId: string,
	params: IssueSelector & { cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["issue", "view"];
	appendIssueSelector(args, params);
	args.push(
		"--json",
		"number,title,body,state,stateReason,url,author,labels,assignees,comments,createdAt,updatedAt,closedAt",
	);
	const issue = await ghJson<any>(args, cwd);
	const lines = [
		`## #${issue.number} — ${issue.title}`,
		"",
		`**State:** ${issue.state}${issue.stateReason ? ` (${issue.stateReason})` : ""}`,
		`**URL:** ${issue.url}`,
		`**Author:** ${formatLogin(issue.author)}`,
		`**Labels:** ${labelsText(issue.labels)}`,
		`**Comments:** ${issue.comments ?? 0}`,
		`**Created:** ${issue.createdAt}`,
		`**Updated:** ${issue.updatedAt}`,
		"",
		"### Body",
		"",
		truncate(issue.body ?? "", 2500),
	];
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { issue } };
}

async function handleIssueCreate(
	_toolCallId: string,
	params: { title: string; body?: string; label?: string[]; assignee?: string[]; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const title = requireNonEmptyString(params.title, "title");
	const args = ["issue", "create", "--title", title, "--body", params.body ?? ""];
	for (const label of ensureStringArray(params.label, "label")) args.push("--label", label);
	for (const assignee of ensureStringArray(params.assignee, "assignee")) args.push("--assignee", assignee);
	const { stdout } = await gh(args, cwd);
	const url = stdout.match(/https?:\/\/[^\s]+/)?.[0] ?? stdout.trim();
	return {
		content: [{ type: "text", text: `Issue created: ${url}` }],
		details: { url, title, bodyLength: params.body?.length ?? 0 },
	};
}

async function handleIssueComment(
	_toolCallId: string,
	params: IssueSelector & { body: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const body = requireNonEmptyString(params.body, "body");
	const args = ["issue", "comment"];
	appendIssueSelector(args, params);
	args.push("--body", body);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "Issue comment added." }],
		details: { bodyLength: body.length },
	};
}

async function handleIssueEdit(
	_toolCallId: string,
	params: IssueSelector & { title?: string; body?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	validateIssueSelector(params);
	const title = params.title?.trim();
	const body = params.body?.trim();
	if (title === "") throw new Error("title must not be empty.");
	if (body === "") throw new Error("body must not be empty.");
	if (title === undefined && body === undefined)
		throw new Error("Provide at least one field to update: title or body.");
	const args = ["issue", "edit"];
	appendIssueSelector(args, params);
	if (title !== undefined) args.push("--title", title);
	if (body !== undefined) args.push("--body", body);
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "Issue updated." }],
		details: { title, bodyLength: body?.length },
	};
}

async function handleIssueClose(
	_toolCallId: string,
	params: IssueSelector & { comment?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["issue", "close"];
	appendIssueSelector(args, params);
	if (params.comment?.trim()) args.push("--comment", params.comment.trim());
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "Issue closed." }],
		details: { selector: issueSelectorArg(params) ?? "current issue" },
	};
}

async function handleIssueReopen(
	_toolCallId: string,
	params: IssueSelector & { comment?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["issue", "reopen"];
	appendIssueSelector(args, params);
	if (params.comment?.trim()) args.push("--comment", params.comment.trim());
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || "Issue reopened." }],
		details: { selector: issueSelectorArg(params) ?? "current issue" },
	};
}

// =============================================================================
// Tool handlers: workflows and releases
// =============================================================================

async function handleWorkflowList(
	_toolCallId: string,
	params: { all?: boolean; limit?: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const limit = normalizeWorkflowListLimit(params.limit);
	const args = ["workflow", "list", "--json", "id,name,path,state", "--limit", limit.toString()];
	if (params.all) args.push("--all");
	const workflows = await ghJson<any[]>(args, cwd);
	const lines =
		workflows.length === 0
			? ["No workflows found."]
			: workflows.map(
					(workflow) => `- **${workflow.name}** (${workflow.id}) — ${workflow.state}\n  ${workflow.path}`,
				);
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { workflows } };
}

async function handleWorkflowView(
	_toolCallId: string,
	params: { workflow: string; ref?: string; yaml?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const workflow = requireNonEmptyString(params.workflow, "workflow");
	validateNoNewline(workflow, "workflow");
	const args = ["workflow", "view", workflow];
	if (params.ref) args.push("--ref", params.ref);
	if (params.yaml) args.push("--yaml");
	const { stdout } = await gh(args, cwd);
	return {
		content: [
			{
				type: "text",
				text: truncate(stdout.trim() || "No workflow output.", params.yaml ? 12000 : MAX_OUTPUT_CHARS),
			},
		],
		details: { workflow, yaml: params.yaml ?? false },
	};
}

async function handleWorkflowDispatch(
	_toolCallId: string,
	params: {
		workflow: string;
		ref?: string;
		inputs?: { name: string; value: string }[];
		confirm?: boolean;
		cwd?: string;
	},
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const workflow = requireNonEmptyString(params.workflow, "workflow");
	validateNoNewline(workflow, "workflow");
	const inputs = validateInputPairs(params.inputs);
	const args = ["workflow", "run", workflow];
	if (params.ref) args.push("--ref", params.ref);
	for (const input of inputs) args.push("--raw-field", `${input.name}=${input.value}`);
	const previewArgv = ["gh", ...args];
	if (params.confirm !== true) {
		return {
			content: [
				{
					type: "text",
					text: [
						"### Workflow Dispatch Preview",
						"",
						"No mutation was performed.",
						"",
						"```json",
						JSON.stringify(previewArgv, null, 2),
						"```",
						"",
						"Call again with `confirm: true` to dispatch.",
					].join("\n"),
				},
			],
			details: { preview: true, workflow, inputs, plannedArgv: previewArgv },
		};
	}
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `Workflow dispatched: ${workflow}` }],
		details: { workflow, inputs },
	};
}

async function handleRunRerun(
	_toolCallId: string,
	params: { runId: number; failedOnly?: boolean; jobId?: string; debug?: boolean; confirm?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	requirePositiveInteger(params.runId, "runId");
	const args = ["run", "rerun", params.runId.toString()];
	if (params.failedOnly) args.push("--failed");
	if (params.jobId) args.push("--job", params.jobId);
	if (params.debug) args.push("--debug");
	if (params.confirm !== true)
		return {
			content: [
				{
					type: "text",
					text: `No mutation was performed. Planned argv:\n\n\`\`\`json\n${JSON.stringify(["gh", ...args], null, 2)}\n\`\`\`\n\nCall again with \`confirm: true\` to rerun.`,
				},
			],
			details: { preview: true, plannedArgv: ["gh", ...args] },
		};
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `Run ${params.runId} rerun requested.` }],
		details: { runId: params.runId },
	};
}

async function handleRunCancel(
	_toolCallId: string,
	params: { runId: number; force?: boolean; confirm?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	requirePositiveInteger(params.runId, "runId");
	const args = ["run", "cancel", params.runId.toString()];
	if (params.force) args.push("--force");
	if (params.confirm !== true)
		return {
			content: [
				{
					type: "text",
					text: `No mutation was performed. Planned argv:\n\n\`\`\`json\n${JSON.stringify(["gh", ...args], null, 2)}\n\`\`\`\n\nCall again with \`confirm: true\` to cancel.`,
				},
			],
			details: { preview: true, plannedArgv: ["gh", ...args] },
		};
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `Run ${params.runId} cancel requested.` }],
		details: { runId: params.runId },
	};
}

async function handleReleaseList(
	_toolCallId: string,
	params: { limit?: number; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const limit = normalizeReleaseListLimit(params.limit);
	const releases = await ghJson<any[]>(
		[
			"release",
			"list",
			"--json",
			"createdAt,isDraft,isImmutable,isLatest,isPrerelease,name,publishedAt,tagName",
			"--limit",
			limit.toString(),
		],
		cwd,
	);
	const lines =
		releases.length === 0
			? ["No releases found."]
			: releases.map(
					(release) =>
						`- **${release.tagName}** — ${release.name ?? ""}${release.isDraft ? " [DRAFT]" : ""}${release.isPrerelease ? " [PRERELEASE]" : ""}${release.isLatest ? " [LATEST]" : ""}\n  published: ${release.publishedAt ?? "none"}`,
				);
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { releases } };
}

async function handleReleaseView(
	_toolCallId: string,
	params: { tag?: string; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const args = ["release", "view"];
	if (params.tag?.trim()) args.push(params.tag.trim());
	args.push(
		"--json",
		"apiUrl,assets,author,body,createdAt,databaseId,id,isDraft,isImmutable,isPrerelease,name,publishedAt,tagName,targetCommitish,url",
	);
	const release = await ghJson<any>(args, cwd);
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const lines = [
		`## ${release.tagName} — ${release.name ?? ""}`,
		"",
		`**URL:** ${release.url}`,
		`**Draft:** ${release.isDraft ? "yes" : "no"}`,
		`**Prerelease:** ${release.isPrerelease ? "yes" : "no"}`,
		`**Immutable:** ${release.isImmutable ? "yes" : "no"}`,
		`**Target:** ${release.targetCommitish ?? "unknown"}`,
		`**Assets:** ${assets.length}`,
		"",
		...assets.map(
			(asset: any) => `- ${asset.name} (${asset.size ?? "?"} bytes)${asset.url ? ` — ${asset.url}` : ""}`,
		),
		"",
		"### Notes",
		"",
		truncate(release.body ?? "", 2500),
	];
	return { content: [{ type: "text", text: truncate(lines.join("\n")) }], details: { release } };
}

async function handleReleaseCreate(
	_toolCallId: string,
	params: {
		tag: string;
		title?: string;
		notes?: string;
		target?: string;
		draft?: boolean;
		prerelease?: boolean;
		generateNotes?: boolean;
		verifyTag?: boolean;
		failOnNoCommits?: boolean;
		confirm?: boolean;
		cwd?: string;
	},
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const tag = requireNonEmptyString(params.tag, "tag");
	validateNoNewline(tag, "tag");
	const args = ["release", "create", tag];
	if (params.title?.trim()) args.push("--title", params.title.trim());
	if (params.notes !== undefined) args.push("--notes", params.notes);
	if (params.target?.trim()) args.push("--target", params.target.trim());
	if (params.draft) args.push("--draft");
	if (params.prerelease) args.push("--prerelease");
	if (params.generateNotes) args.push("--generate-notes");
	if (params.verifyTag) args.push("--verify-tag");
	if (params.failOnNoCommits) args.push("--fail-on-no-commits");
	const previewArgv = [
		"gh",
		...args.map((arg, index, array) => (array[index - 1] === "--notes" ? `<${String(arg).length} chars>` : arg)),
	];
	if (params.confirm !== true)
		return {
			content: [
				{
					type: "text",
					text: `### Release Create Preview\n\nNo mutation was performed.\n\n\`\`\`json\n${JSON.stringify(previewArgv, null, 2)}\n\`\`\`\n\nCall again with \`confirm: true\` to create the release.`,
				},
			],
			details: { preview: true, tag, plannedArgv: previewArgv },
		};
	const { stdout } = await gh(args, cwd);
	const url = stdout.match(/https?:\/\/[^\s]+/)?.[0] ?? stdout.trim();
	return { content: [{ type: "text", text: `Release created: ${url}` }], details: { tag, url } };
}

async function handleReleaseUploadAsset(
	_toolCallId: string,
	params: { tag: string; path: string; label?: string; clobber?: boolean; confirm?: boolean; cwd?: string },
	defaultCwd: string,
): Promise<ToolResult> {
	const cwd = params.cwd ?? defaultCwd;
	const tag = requireNonEmptyString(params.tag, "tag");
	const path = requireNonEmptyString(params.path, "path");
	validateNoNewline(tag, "tag");
	validateNoNewline(path, "path");
	let assetArg = path;
	if (params.label?.trim()) {
		validateNoNewline(params.label, "label");
		assetArg = `${path}#${params.label.trim()}`;
	}
	const args = ["release", "upload", tag, assetArg];
	if (params.clobber) args.push("--clobber");
	const previewArgv = ["gh", ...args];
	if (params.confirm !== true)
		return {
			content: [
				{
					type: "text",
					text: `### Release Asset Upload Preview\n\nNo mutation was performed.\n\n\`\`\`json\n${JSON.stringify(previewArgv, null, 2)}\n\`\`\`\n\nCall again with \`confirm: true\` to upload.`,
				},
			],
			details: { preview: true, tag, path, plannedArgv: previewArgv },
		};
	const { stdout } = await gh(args, cwd);
	return {
		content: [{ type: "text", text: stdout.trim() || `Uploaded asset to release ${tag}.` }],
		details: { tag, path },
	};
}

// =============================================================================
// Extension entry point
// =============================================================================

/**
 * OWL-PATCH: read-only tools. The desktop plan mode allow-list
 * (coding-agent `browser-permissions.ts`) mirrors this set.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"github_auth_status",
	"github_repo_info",
	"github_branch_info",
	"github_pr_list",
	"github_pr_view",
	"github_pr_checks",
	"github_pr_files",
	"github_pr_diff",
	"github_run_list",
	"github_run_view",
	"github_run_logs",
	"github_commit_status",
	"github_issue_list",
	"github_issue_view",
	"github_workflow_list",
	"github_workflow_view",
	"github_release_list",
	"github_release_view",
]);

/** OWL-PATCH: mutations that overwrite, close, merge, or cancel rather than only add. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
	"github_pr_edit",
	"github_pr_close",
	"github_pr_merge",
	"github_issue_edit",
	"github_issue_close",
	"github_run_cancel",
	"github_release_upload_asset",
]);

const GITHUB_NAMESPACE = {
	name: "github",
	description:
		"GitHub via the host gh CLI: pull requests, issues, Actions runs/workflows, releases, repo/branch info for the current repository.",
};

function annotationsFor(name: string): ToolAnnotations {
	if (READ_ONLY_TOOLS.has(name)) return { readOnlyHint: true, openWorldHint: true };
	return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(name), openWorldHint: true };
}

// OWL-PATCH: tools are `deferred` so the 36 schemas stay out of every request until
// tool_search loads the `github` group; annotations let permission extensions tell reads from writes.
function register(
	pi: ExtensionAPI,
	name: string,
	label: string,
	description: string,
	parameters: any,
	handler: (toolCallId: string, params: any, defaultCwd: string) => Promise<ToolResult>,
	promptGuidelines: string[] = [],
) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet: description,
		promptGuidelines,
		parameters,
		exposure: "deferred",
		namespace: GITHUB_NAMESPACE,
		annotations: annotationsFor(name),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return handler(toolCallId, params, ctx.cwd);
		},
	});
}

export default function owlGithub(pi: ExtensionAPI) {
	register(
		pi,
		"github_auth_status",
		"GitHub Auth Status",
		"Verify that gh CLI authentication works from the extension process. Returns the logged-in GitHub username.",
		AUTH_STATUS_SCHEMA,
		handleAuthStatus,
		["Use github_auth_status to verify GitHub auth before other GitHub operations."],
	);
	register(
		pi,
		"github_repo_info",
		"GitHub Repo Info",
		"Show the current GitHub repository identity, branch info, visibility, and viewer permission.",
		REPO_INFO_SCHEMA,
		handleRepoInfo,
		["Use github_repo_info to confirm which repo and branch you are operating on before making changes."],
	);
	register(
		pi,
		"github_branch_info",
		"GitHub Branch Info",
		"Show branch existence, protection, and ahead/behind information.",
		BRANCH_INFO_SCHEMA,
		handleBranchInfo,
	);

	register(
		pi,
		"github_pr_list",
		"GitHub PR List",
		"List GitHub pull requests with optional filters.",
		PR_LIST_SCHEMA,
		handlePrList,
		["Use github_pr_list instead of `gh pr list` to list PRs."],
	);
	register(
		pi,
		"github_pr_view",
		"GitHub PR View",
		"View details for a specific PR by number or URL, or the current branch PR if neither is provided.",
		PR_VIEW_SCHEMA,
		handlePrView,
		["Use github_pr_view instead of `gh pr view` to inspect PRs."],
	);
	register(
		pi,
		"github_pr_checks",
		"GitHub PR Checks",
		"Show detailed check names, states, and links for a PR.",
		PR_CHECKS_SCHEMA,
		handlePrChecks,
	);
	register(pi, "github_pr_files", "GitHub PR Files", "List changed files for a PR.", PR_FILES_SCHEMA, handlePrFiles);
	register(pi, "github_pr_diff", "GitHub PR Diff", "Show a truncated PR diff or patch.", PR_DIFF_SCHEMA, handlePrDiff);
	register(
		pi,
		"github_pr_create",
		"GitHub PR Create",
		"Create a pull request for the current branch when confirm is true; preview otherwise.",
		PR_CREATE_SCHEMA,
		handlePrCreate,
		[
			"Use github_pr_create instead of `gh pr create` to create PRs.",
			"Call github_pr_create with `confirm: true` only when the user explicitly asked to create the PR; Owl's approval prompt (when enabled) is the final gate.",
			"Use `confirm: false` when the user asks for a preview or the request is ambiguous.",
			"Never use raw `gh api`, `gh auth token`, or shell for GitHub operations when the github tools are available.",
		],
	);
	register(
		pi,
		"github_pr_edit",
		"GitHub PR Edit",
		"Edit an existing PR's title and/or body.",
		PR_EDIT_SCHEMA,
		handlePrEdit,
		[
			"Use github_pr_edit instead of `gh pr edit` to edit PR metadata.",
			"Select the PR by number, URL, or current branch.",
			"Never use raw `gh api`, `gh auth token`, or shell for GitHub operations when the github tools are available.",
		],
	);
	register(pi, "github_pr_comment", "GitHub PR Comment", "Add a comment to a PR.", PR_COMMENT_SCHEMA, handlePrComment);
	register(
		pi,
		"github_pr_review",
		"GitHub PR Review",
		"Submit a PR review: approve, comment, or request changes.",
		PR_REVIEW_SCHEMA,
		handlePrReview,
	);
	register(
		pi,
		"github_pr_ready",
		"GitHub PR Ready",
		"Mark a draft PR ready for review.",
		PR_READY_SCHEMA,
		handlePrReady,
	);
	register(pi, "github_pr_close", "GitHub PR Close", "Close a pull request.", PR_CLOSE_SCHEMA, handlePrClose);
	register(pi, "github_pr_reopen", "GitHub PR Reopen", "Reopen a pull request.", PR_REOPEN_SCHEMA, handlePrReopen);
	register(
		pi,
		"github_pr_merge",
		"GitHub PR Merge",
		"Preview or merge a pull request with safeguards.",
		PR_MERGE_SCHEMA,
		handlePrMerge,
		[
			"Use github_pr_merge instead of `gh pr merge`.",
			"Call with `confirm: true` only after the user explicitly asks to merge and the preview/safeguards are acceptable.",
		],
	);

	register(
		pi,
		"github_run_list",
		"GitHub Run List",
		"List recent GitHub Actions workflow runs.",
		RUN_LIST_SCHEMA,
		handleRunList,
	);
	register(
		pi,
		"github_run_view",
		"GitHub Run View",
		"View a workflow run with jobs and failed steps.",
		RUN_VIEW_SCHEMA,
		handleRunView,
	);
	register(
		pi,
		"github_run_logs",
		"GitHub Run Logs",
		"Fetch and tail workflow run or job logs.",
		RUN_LOGS_SCHEMA,
		handleRunLogs,
	);
	register(
		pi,
		"github_commit_status",
		"GitHub Commit Status",
		"Show combined status and check runs for a commit SHA or HEAD.",
		COMMIT_STATUS_SCHEMA,
		handleCommitStatus,
	);

	register(
		pi,
		"github_issue_list",
		"GitHub Issue List",
		"List issues with optional filters.",
		ISSUE_LIST_SCHEMA,
		handleIssueList,
	);
	register(
		pi,
		"github_issue_view",
		"GitHub Issue View",
		"View a single issue by number or URL.",
		ISSUE_VIEW_SCHEMA,
		handleIssueView,
	);
	register(
		pi,
		"github_issue_create",
		"GitHub Issue Create",
		"Create an issue.",
		ISSUE_CREATE_SCHEMA,
		handleIssueCreate,
	);
	register(
		pi,
		"github_issue_comment",
		"GitHub Issue Comment",
		"Add a comment to an issue.",
		ISSUE_COMMENT_SCHEMA,
		handleIssueComment,
	);
	register(
		pi,
		"github_issue_edit",
		"GitHub Issue Edit",
		"Edit an issue title and/or body.",
		ISSUE_EDIT_SCHEMA,
		handleIssueEdit,
	);
	register(pi, "github_issue_close", "GitHub Issue Close", "Close an issue.", ISSUE_CLOSE_SCHEMA, handleIssueClose);
	register(
		pi,
		"github_issue_reopen",
		"GitHub Issue Reopen",
		"Reopen an issue.",
		ISSUE_REOPEN_SCHEMA,
		handleIssueReopen,
	);

	register(
		pi,
		"github_workflow_list",
		"GitHub Workflow List",
		"List GitHub Actions workflows.",
		WORKFLOW_LIST_SCHEMA,
		handleWorkflowList,
	);
	register(
		pi,
		"github_workflow_view",
		"GitHub Workflow View",
		"View a workflow summary or YAML.",
		WORKFLOW_VIEW_SCHEMA,
		handleWorkflowView,
	);
	register(
		pi,
		"github_workflow_dispatch",
		"GitHub Workflow Dispatch",
		"Preview or dispatch a workflow_dispatch workflow run.",
		WORKFLOW_DISPATCH_SCHEMA,
		handleWorkflowDispatch,
	);
	register(
		pi,
		"github_run_rerun",
		"GitHub Run Rerun",
		"Preview or rerun a workflow run/job.",
		RUN_RERUN_SCHEMA,
		handleRunRerun,
	);
	register(
		pi,
		"github_run_cancel",
		"GitHub Run Cancel",
		"Preview or cancel a workflow run.",
		RUN_CANCEL_SCHEMA,
		handleRunCancel,
	);

	register(
		pi,
		"github_release_list",
		"GitHub Release List",
		"List GitHub releases.",
		RELEASE_LIST_SCHEMA,
		handleReleaseList,
	);
	register(
		pi,
		"github_release_view",
		"GitHub Release View",
		"View a GitHub release.",
		RELEASE_VIEW_SCHEMA,
		handleReleaseView,
	);
	register(
		pi,
		"github_release_create",
		"GitHub Release Create",
		"Preview or create a GitHub release.",
		RELEASE_CREATE_SCHEMA,
		handleReleaseCreate,
	);
	register(
		pi,
		"github_release_upload_asset",
		"GitHub Release Upload Asset",
		"Preview or upload one asset file to a release.",
		RELEASE_UPLOAD_ASSET_SCHEMA,
		handleReleaseUploadAsset,
	);
}
