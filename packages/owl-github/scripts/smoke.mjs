// Host-free smoke test for owl-github: drives the extension factory with a mock
// extension API. Live checks only run read-only gh calls and preview-only
// mutations (no `confirm: true`), so nothing on GitHub changes.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(here, "..", "dist", "index.js");
const mod = await import(`file://${distPath.replaceAll("\\", "/")}`);
const { default: createGithubExtension, parseGitHubRemote, READ_ONLY_TOOLS } = mod;

const tools = new Map();
createGithubExtension({ registerTool: (tool) => tools.set(tool.name, tool) });

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

check("registers 36 tools", tools.size, 36);
check("all tools deferred", [...tools.values()].every((tool) => tool.exposure === "deferred"), true);
check("all tools in github namespace", [...tools.values()].every((tool) => tool.namespace?.name === "github"), true);
check(
	"read-only set matches annotations",
	[...tools.values()].every((tool) => tool.annotations?.readOnlyHint === READ_ONLY_TOOLS.has(tool.name)),
	true,
);
check("read-only names all registered", [...READ_ONLY_TOOLS].every((name) => tools.has(name)), true);
check("merge is destructive", tools.get("github_pr_merge")?.annotations?.destructiveHint, true);
check("comment is not destructive", tools.get("github_pr_comment")?.annotations?.destructiveHint, false);

const remotes = [
	["https://github.com/loeanxi/owl.git", { owner: "loeanxi", repo: "owl" }],
	["https://github.com/loeanxi/owl", { owner: "loeanxi", repo: "owl" }],
	["https://github.com/loeanxi/owl/", { owner: "loeanxi", repo: "owl" }],
	["https://someone@github.com/loeanxi/owl.git", { owner: "loeanxi", repo: "owl" }],
	["git@github.com:loeanxi/owl.git", { owner: "loeanxi", repo: "owl" }],
	["ssh://git@github.com/loeanxi/owl.git", { owner: "loeanxi", repo: "owl" }],
	["https://gitlab.com/loeanxi/owl.git", null],
];
for (const [url, expected] of remotes) check(`parse remote ${url}`, parseGitHubRemote(url), expected);

let ghReady = false;
try {
	execFileSync("gh", ["auth", "status"], { stdio: "ignore", windowsHide: true });
	ghReady = true;
} catch {
	console.log("SKIP  live checks: gh missing or not logged in");
}

if (ghReady) {
	const repoRoot = path.resolve(here, "..", "..", "..");
	const call = (name, params = {}) => tools.get(name).execute("smoke", params, undefined, undefined, { cwd: repoRoot });

	const auth = await call("github_auth_status");
	check("live auth status ok", auth.details?.success, true);

	const list = await call("github_pr_list", { state: "all", limit: 1 }).catch(() => undefined);
	const prNumber = list?.details?.prs?.[0]?.number;
	if (prNumber === undefined) {
		console.log("SKIP  merge preview: repository has no pull requests");
	} else {
		const merge = await call("github_pr_merge", { number: prNumber, strategy: "squash" });
		check(`merge #${prNumber} without confirm is preview only`, merge.details?.preview, true);
	}

	const dispatch = await call("github_workflow_dispatch", { workflow: "ci.yml" });
	check("dispatch without confirm is preview only", dispatch.details?.preview, true);

	const repo = await call("github_repo_info").catch((error) => ({ error: String(error) }));
	if (repo.error) console.log(`INFO  repo info unavailable here: ${repo.error.slice(0, 160)}`);
	else check("live repo info resolves owner", typeof repo.details?.owner, "string");
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll owl-github smoke checks passed");
