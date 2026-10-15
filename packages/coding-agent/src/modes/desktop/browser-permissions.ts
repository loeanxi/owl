/** Desktop plan mode permits observation and target selection, but no page or evidence mutations. */
const READ_ONLY_TOOLS = new Set([
	"read",
	"ls",
	"find",
	"grep",
	"browser_snapshot",
	"browser_screenshot",
	"browser_wait",
	"computer_observe",
	// Release only cancels this session's work and disposes its own control resources.
	"computer_release",
	"computer_screenshot",
	"univer_status",
	"univer_inspect",
	"univer_api",
	"univer_lint",
	"news_search",
	"news_read",
	"news_hot",
	"news_report",
	"news_open",
	"map_search",
	"map_nearby",
	"map_reverse",
	// owl-github read tools (mirrors READ_ONLY_TOOLS in packages/owl-github).
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
	// Saving research progress only appends state to the conversation's own ledger.
	"research_checkpoint",
	"research_task",
]);

export function isReadOnlyDesktopTool(toolName: string, input: unknown): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	const action = input !== null && typeof input === "object" && "action" in input ? input.action : undefined;
	if (toolName === "research_executable") return action === undefined || action === "inspect";
	if (toolName === "research_model_lab") return action === undefined || action === "plan";
	if (toolName === "research_decompile") return action === "inventory";
	if (toolName === "research_rea") return action === "inventory";
	if (toolName === "browser_tabs") return action === "list" || action === "select";
	if (toolName === "computer_windows") return action === "list";
	if (toolName === "browser_console") return action === undefined || action === "list";
	if (toolName === "browser_network") return action === undefined || action === "list" || action === "detail";
	return false;
}
