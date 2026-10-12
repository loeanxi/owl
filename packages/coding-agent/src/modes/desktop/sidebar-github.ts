/**
 * 历史视图的 GitHub 增强：经宿主上已登录的 gh CLI，一次 GraphQL 查询批量取
 * 提交的检查汇总（statusCheckRollup）。gh 缺失或未登录时抛 SidebarError
 * （gh-missing / gh-error），前端据此静默隐藏 CI 标记。
 */

import { execFile } from "node:child_process";
import type { GitCiState } from "./protocol.ts";
import { messageOf, SidebarError } from "./sidebar-fs.ts";
import { historyGithubRepo } from "./sidebar-git.ts";

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_HASHES = 100;
// 成功/失败是终态，缓存住免得每次刷新都打 API；运行中的不缓存
const FINAL_STATE_TTL_MS = 10 * 60_000;
const finalStates = new Map<string, { state: GitCiState; at: number }>();

async function gh(cwd: string, args: string[]): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		execFile(
			"gh",
			args,
			{
				cwd,
				windowsHide: true,
				timeout: GH_TIMEOUT_MS,
				maxBuffer: GH_MAX_BUFFER,
				env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
			},
			(error, stdout, stderr) => {
				if (error !== null) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(new SidebarError("gh-missing", "找不到 gh 命令（GitHub CLI）"));
						return;
					}
					const detail = (String(stderr ?? "").trim() || messageOf(error))
						.replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[redacted-token]")
						.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted-token]");
					reject(new SidebarError("gh-error", `gh 查询失败：${detail.slice(0, 300)}`));
					return;
				}
				resolvePromise(String(stdout));
			},
		);
	});
}

/** GraphQL rollup 状态 → 历史视图的三态；没有检查返回 undefined。 */
export function rollupState(state: unknown): GitCiState | undefined {
	switch (state) {
		case "SUCCESS":
			return "success";
		case "FAILURE":
		case "ERROR":
			return "failure";
		case "PENDING":
		case "EXPECTED":
			return "pending";
		default:
			return undefined;
	}
}

/** 每个提交一个别名字段（c0、c1…），一次请求查完。hash 须已校验为 40 位十六进制。 */
export function buildChecksQuery(hashes: readonly string[]): string {
	const fields = hashes
		.map((hash, index) => `c${index}: object(oid: "${hash}") { ... on Commit { statusCheckRollup { state } } }`)
		.join(" ");
	return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

/** 查询若干提交的 CI 状态（hash → 状态）。远程不是 GitHub 时返回空对象。 */
export async function githubCommitChecks(
	cwd: string,
	hashes: readonly string[],
	repo?: string,
): Promise<Record<string, GitCiState>> {
	const wanted = [...new Set(hashes.filter((hash) => /^[0-9a-f]{40}$/i.test(hash)))].slice(0, MAX_HASHES);
	if (wanted.length === 0) return {};
	const target = await historyGithubRepo(cwd, repo);
	if (target === undefined) return {};

	const result: Record<string, GitCiState> = {};
	const missing: string[] = [];
	const now = Date.now();
	for (const hash of wanted) {
		const cached = finalStates.get(`${target.owner}/${target.repo}@${hash}`);
		if (cached !== undefined && now - cached.at < FINAL_STATE_TTL_MS) result[hash] = cached.state;
		else missing.push(hash);
	}
	if (missing.length === 0) return result;

	const out = await gh(target.root, [
		"api",
		"graphql",
		"-f",
		`owner=${target.owner}`,
		"-f",
		`name=${target.repo}`,
		"-f",
		`query=${buildChecksQuery(missing)}`,
	]);
	const repository = (JSON.parse(out) as { data?: { repository?: Record<string, unknown> } }).data?.repository ?? {};
	missing.forEach((hash, index) => {
		const node = repository[`c${index}`] as { statusCheckRollup?: { state?: unknown } | null } | null | undefined;
		const state = rollupState(node?.statusCheckRollup?.state);
		if (state === undefined) return;
		result[hash] = state;
		if (state !== "pending") finalStates.set(`${target.owner}/${target.repo}@${hash}`, { state, at: now });
	});
	if (finalStates.size > 2000) finalStates.clear();
	return result;
}
