/** Windows 大小写不敏感 + 分隔符统一后的路径规范化（同项目比较与折叠键共用）。 */
export function normPath(p: string | undefined): string {
	return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 默认工作目录：未选择目录时的会话落点（与 App 的 WORKSPACE_KEY 兜底一致）。 */
export const DEFAULT_WORKSPACE_DIR = "D:/owl/Owl-def";
/** 助理目录：「我的助理」面板的数据目录（每天一个 markdown）。 */
export const ASSISTANT_DIR = "D:/owl/owl-myself";
/** 专家目录：「专家顾问」面板的数据目录（人格档案 + 记忆 + 每天一个会话 markdown）。 */
export const EXPERT_DIR = "D:/owl/owl-expert";
/** 八股对练目录：「八股对练」面板的数据目录（面试官人格 + 记忆 + 每天一个对练 markdown）。 */
export const BAGU_DIR = "D:/owl/owl-bagu";

/**
 * 保留目录（默认目录 + 助理目录 + 专家目录 + 八股对练目录）：不算普通项目，退出项目后不在侧栏「项目」
 * 分组与输入框候选列表常驻，仅在作为当前项目时显示；其会话仍进「最近会话」。
 * 数据目录（助理/专家/八股）的子目录同样保留——专家与群各自的数据子目录（owl-expert/<slug>/ 等）
 * 只是内部存储，不应以「项目」身份出现在工作区的项目列表与候选里。
 */
export function isReservedDir(path: string | undefined): boolean {
	const key = normPath(path);
	if (key === "") return false;
	if (key === normPath(DEFAULT_WORKSPACE_DIR)) return true;
	return [ASSISTANT_DIR, EXPERT_DIR, BAGU_DIR].some((dir) => {
		const root = normPath(dir);
		return key === root || key.startsWith(`${root}/`);
	});
}

/** 行内 code 芯片被顺手套上的成对包裹符（开 → 收）。 */
const PATH_CHIP_WRAPPERS: Record<string, string> = {
	'"': '"',
	"'": "'",
	"“": "”",
	"‘": "’",
	"《": "》",
	"（": "）",
	"<": ">",
	"(": ")",
	"[": "]",
	"【": "】",
	"「": "」",
};

/**
 * 聊天行内 code 芯片文本 → 路径/URL 候选：剥掉顺手包上的成对引号/括号、尾随
 * 标点与 `:12:34` 行列后缀。必须含路径分隔符或 file://、盘符前缀才算候选——
 * 工具摘要里的命令与模式名（`todo`、`npm run build`）以及裸域名一律不算，
 * 点击不跳。返回空串表示非路径形态。
 */
export function pathCandidateFromCode(raw: string): string {
	let text = raw.trim();
	for (let guard = 0; guard < 4; guard += 1) {
		const close = PATH_CHIP_WRAPPERS[text[0] ?? ""];
		if (close === undefined || text.length < 2 || !text.endsWith(close)) break;
		text = text.slice(1, -1).trim();
	}
	text = text.replace(/[.,;:!?…、。，！？；：]+$/u, "");
	if (/^https?:\/\//i.test(text)) return text;
	// `path.ts:42` 的行列后缀；URL 先行返回，避免把 `http://host:5188` 的端口剥掉
	text = text.replace(/(?::\d+)+$/, "");
	if (!/[\\/]/.test(text) && !/^(?:file:\/\/|[a-z]:[\\/])/i.test(text)) return "";
	return text;
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
