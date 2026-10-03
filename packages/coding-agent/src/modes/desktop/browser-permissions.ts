/** Desktop plan mode permits observation and target selection, but no page or evidence mutations. */
const READ_ONLY_TOOLS = new Set([
	"read",
	"ls",
	"find",
	"grep",
	"browser_snapshot",
	"browser_screenshot",
	"browser_wait",
	"univer_status",
	"univer_inspect",
	"univer_api",
	"univer_lint",
	"news_search",
	"news_read",
	"news_hot",
	"news_report",
	"news_open",
]);

export function isReadOnlyDesktopTool(toolName: string, input: unknown): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	const action = input !== null && typeof input === "object" && "action" in input ? input.action : undefined;
	if (toolName === "browser_tabs") return action === "list" || action === "select";
	if (toolName === "browser_console") return action === undefined || action === "list";
	if (toolName === "browser_network") return action === undefined || action === "list" || action === "detail";
	return false;
}
