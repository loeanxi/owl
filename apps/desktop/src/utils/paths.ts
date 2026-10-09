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
 * 保留目录（默认目录 + 助理目录 + 专家目录 + 八股对练目录）：不算普通项目，一律不以「项目」身份
 * 出现在侧栏「项目」分组、项目页与输入框候选列表（即使是当前项目——当前位置由顶栏与输入框 chip
 * 标识）；其会话仍正常记录并进「最近会话」。
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

/**
 * 评测/验收产物目录（路径中含 `.validation` 段）：评测每轮都会生成大批临时 workspace，
 * 打开过也不自动登记进「到访过的项目」，否则侧栏会堆满同名的 workspace。
 */
export function isValidationDir(path: string | undefined): boolean {
	const key = normPath(path);
	return key.includes("/.validation/") || key.endsWith("/.validation");
}

/** 从路径列表里去掉评测目录；不改动原数组。 */
export function withoutValidationDirs(paths: readonly string[]): string[] {
	return paths.filter((path) => !isValidationDir(path));
}

/**
 * 读出 localStorage 里的项目路径列表，顺带清掉已落库的评测目录（写回）。
 * 侧栏 / 项目页 / 输入框候选共用，避免旧评测 workspace 一直占着列表。
 */
export function loadAndScrubProjects(storage: Pick<Storage, "getItem" | "setItem">, key: string): string[] {
	let list: string[] = [];
	try {
		const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
		list = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
	const next = withoutValidationDirs(list);
	if (next.length !== list.length) {
		try {
			storage.setItem(key, JSON.stringify(next));
		} catch {
			/* localStorage 满或不可用时仍返回清洗后的内存列表 */
		}
	}
	return next;
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

/** 到访过的项目（localStorage）：没有会话的项目也能常驻项目列表；评测目录会顺带清掉。 */
export function loadKnownProjects(): string[] {
	return loadAndScrubProjects(localStorage, KNOWN_PROJECTS_KEY);
}
