/** Windows 大小写不敏感 + 分隔符统一后的路径规范化（同项目比较与折叠键共用）。 */
export function normPath(p: string | undefined): string {
	return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Windows 大小写不敏感 + 分隔符统一后比较两个路径是否同一项目。 */
export function samePath(a: string | undefined, b: string | undefined): boolean {
	return normPath(a) !== "" && normPath(a) === normPath(b);
}

/** 项目显示名：取路径末段（如 D:\work\owl → owl）。 */
export function projectLabel(cwd: string): string {
	const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || cwd;
}

/** 到访过的项目（localStorage key）：没有会话的项目也能常驻项目列表。 */
export const KNOWN_PROJECTS_KEY = "owl.projects";

/** 到访过的项目（localStorage）：没有会话的项目也能常驻项目列表。 */
export function loadKnownProjects(): string[] {
	try {
		const raw = localStorage.getItem(KNOWN_PROJECTS_KEY);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}
