/** Deterministic intent hints and evidence checks; neither function claims semantic understanding. */
export interface ToolIntentStep {
	capability: string;
	action: string;
	target?: string;
	constraints?: string[];
	query?: string;
}

export interface IntentToolMetadata {
	name: string;
	description: string;
	parameters?: unknown;
}

export interface ToolIntentAssessment {
	status: "supported" | "refine" | "rejected";
	evidence: string[];
	missing: string[];
	reason: string;
}

interface Concept {
	key: string;
	pattern: RegExp;
	terms: string;
}

const CAPABILITIES: readonly Concept[] = [
	{
		key: "spreadsheet",
		pattern: /表格|电子表|電子表|\b(excel|xlsx|spreadsheet|sheets?)\b/i,
		terms: "spreadsheet sheet excel xlsx",
	},
	{ key: "document", pattern: /文档|文檔|\b(document|docx|word)\b/i, terms: "document word docx" },
	{
		key: "presentation",
		pattern: /幻灯|幻燈|演示|简报|簡報|\b(presentation|slides?|pptx?)\b/i,
		terms: "presentation slide pptx",
	},
	{
		key: "media",
		pattern: /音乐|音樂|歌曲|听歌|聽歌|把歌|播放器|\b(music|media|song|player|playback)\b/i,
		terms: "music media player playback",
	},
	{
		key: "image",
		pattern: /图片|圖片|图像|圖像|抠图|摳圖|背景.*透明|透明.*背景|\b(images?|photos?|pictures?)\b/i,
		terms: "image photo picture",
	},
	{
		key: "code",
		pattern: /代码|代碼|函数|函數|方法|引用|调用|調用|\b(code|source|lsp|function|symbol)\b/i,
		terms: "code source lsp symbol",
	},
	{
		key: "news",
		pattern: /新闻|新聞|资讯|資訊|行业动态|行業動態|时事|時事|\b(news|headlines?)\b/i,
		terms: "news search",
	},
	{ key: "browser", pattern: /浏览器|瀏覽器|\b(browser|playwright)\b/i, terms: "browser playwright" },
	{
		key: "web",
		pattern: /网页|網頁|网站|網站|查资料|查資料|\b(web|website|research|url)\b/i,
		terms: "web search page url",
	},
	{ key: "map", pattern: /地图|地圖|附近|地点|地點|\b(map|nearby|location)\b/i, terms: "map nearby location" },
	{ key: "subagent", pattern: /子代理|子智能体|委派|\b(subagent|delegate)\b/i, terms: "subagent delegate" },
	{
		key: "memory",
		pattern: /记住|記住|记忆|記憶|偏好|用户印象|\b(memory|remember|preferences?)\b/i,
		terms: "memory remember preference",
	},
	{
		key: "background",
		pattern: /后台|背景运行|背景執行|定时|定時|排程|\b(schedule|background)\b/i,
		terms: "background task schedule",
	},
	{
		key: "computer",
		pattern:
			/桌面|屏幕|鼠标|鼠標|键盘|鍵盤|快捷键|快捷鍵|热键|熱鍵|窗口|输入框|輸入框|文本框|弹窗|彈窗|\b(desktop|computer|windows?|mouse|keyboard|screen)\b/i,
		terms: "computer desktop window mouse keyboard screen click type scroll",
	},
];

const ACTIONS: readonly Concept[] = [
	{ key: "pause", pattern: /暂停|暫停|\bpause\b/i, terms: "pause play-pause" },
	{
		key: "references",
		pattern: /谁.*调用|誰.*調用|调用.*哪|調用.*哪|调用者|調用者|引用|\b(references?|callers?)\b|incoming\s*calls/i,
		terms: "references incomingCalls callers",
	},
	{ key: "screenshot", pattern: /截图|截圖|截屏|\bscreenshot\b|capture.*screen/i, terms: "screenshot capture" },
	{
		key: "edit",
		pattern:
			/编辑|編輯|修改|改成|去.*背景|背景.*透明|透明.*背景|抠图|摳圖|\b(edit|modify|restyle|combine)\b|remove.*background/i,
		terms: "edit modify restyle",
	},
	{
		key: "create",
		pattern: /创建|建立|新建|生成|做成|整理.*(?:表格|excel)|\b(create|new|generate|draw)\b/i,
		terms: "create new generate",
	},
	{
		key: "search",
		pattern: /查找|查询|查詢|查资料|查資料|查一下|搜|查.*(?:动态|動態|新闻|新聞)|\b(search|find|query|research)\b/i,
		terms: "search find query",
	},
	{ key: "read", pattern: /读取|讀取|阅读|閱讀|正文|\b(read|fetch|extract|get)\b/i, terms: "read fetch extract get" },
	{ key: "play", pattern: /播放|\bplay\b/i, terms: "play play-pause" },
	{ key: "volume", pattern: /音量|\bvolume\b/i, terms: "set-volume fade-volume volume" },
	{
		key: "navigate",
		pattern: /打开|打開|访问|訪問|导航|導航|\b(navigate|open|visit)\b/i,
		terms: "navigate open visit",
	},
	{ key: "export", pattern: /导出|匯出|\bexport\b/i, terms: "export" },
	{ key: "delete", pattern: /删除|刪除|\b(delete|remove)\b/i, terms: "delete remove" },
	{ key: "send", pattern: /发送|發送|\b(send|post)\b/i, terms: "send post" },
	{ key: "list", pattern: /列出|列表|\blist\b/i, terms: "list" },
	{ key: "status", pattern: /状态|狀態|\bstatus\b/i, terms: "status" },
	{ key: "delegate", pattern: /委派|子代理|\b(delegate|subagent)\b/i, terms: "delegate subagent" },
	{ key: "schedule", pattern: /定时|定時|排程|\bschedule\b/i, terms: "schedule" },
	{ key: "remember", pattern: /记住|記住|\bremember\b/i, terms: "remember save" },
	{ key: "click", pattern: /点击|點擊|单击|單擊|\bclick(?:s|ed|ing)?\b/i, terms: "click double-click" },
	{ key: "type", pattern: /键入|打字|输入文本|輸入文本|\btype\b/i, terms: "type keystroke enter text" },
	{ key: "focus", pattern: /聚焦|切到前台|置前台|置前|\bfocus(?:s|ed|ing)?\b/i, terms: "focus foreground" },
	{ key: "scroll", pattern: /滚动|滾動|\bscroll(?:s|ed|ing)?\b/i, terms: "scroll wheel" },
	{
		key: "press",
		pattern: /按键|按鍵|快捷键|快捷鍵|热键|熱鍵|\b(?:press(?:es|ing)?|keystrokes?|shortcuts?|hotkeys?)\b/i,
		terms: "press key keystroke shortcut hotkey combo",
	},
];

/** Retrieval aliases may be broad; domain evidence must describe the actual tool or an input kind. */
const CAPABILITY_EVIDENCE: Readonly<Record<string, RegExp>> = {
	spreadsheet: /表格|电子表|電子表|\b(excel|xlsx|spreadsheet|sheets?)\b/i,
	document: /文档|文檔|\b(documents?|docx|word)\b/i,
	presentation: /幻灯|幻燈|演示|简报|簡報|\b(presentation|slides?|pptx?)\b/i,
	media: /音乐|音樂|歌曲|播放器|\b(music|media|songs?|player|playback)\b/i,
	image: /图片|圖片|图像|圖像|\b(images?|photos?|pictures?)\b/i,
	code: /代码|代碼|源码|源碼|函数|函數|\b(code|lsp|symbols?|functions?)\b|source\s+(?:code|files?)/i,
	news: /新闻|新聞|资讯|資訊|\b(news|headlines?)\b/i,
	browser: /浏览器|瀏覽器|\b(browser|playwright)\b/i,
	web: /网页|網頁|网站|網站|\b(web|websites?|webpages?|urls?|https?)\b/i,
	map: /地图|地圖|地理|\b(map|geographic|geocode|latitude|longitude)\b|nearby\s+(?:places?|locations?|restaurants?|cafes?)/i,
	subagent: /子代理|子智能体|委派|\b(subagents?|delegate)\b/i,
	memory: /记忆|記憶|偏好|用户印象|\b(memory|remember|preferences?)\b/i,
	background: /后台|背景运行|背景執行|定时|定時|排程|\b(schedule|background)\b/i,
	computer: /桌面|屏幕|鼠标|鼠標|键盘|鍵盤|窗口|\b(desktop|computer|windows?|mouse|keyboard|screen)\b/i,
};

function normalize(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.toLowerCase();
}

function conceptFor(value: string, concepts: readonly Concept[]): Concept | undefined {
	return (
		concepts.find((concept) => concept.key === value) ??
		concepts.find((concept) => concept.pattern.test(normalize(value)))
	);
}

interface Span {
	start: number;
	end: number;
}

function matchSpans(text: string, pattern: RegExp): Span[] {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	const expression = new RegExp(pattern.source, flags);
	const spans: Span[] = [];
	for (const match of text.matchAll(expression)) {
		if (match.index === undefined || match[0].length === 0) continue;
		spans.push({ start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

function overlaps(left: Span, right: Span): boolean {
	return left.start < right.end && right.start < left.end;
}

/** First listed capability and every span it occupies, so an action can be required to fall outside those words. */
function capabilityHit(text: string): { key: string; spans: Span[] } | undefined {
	for (const concept of CAPABILITIES) {
		const spans = matchSpans(text, concept.pattern);
		if (spans.length > 0) return { key: concept.key, spans };
	}
	return undefined;
}

/** First listed action with at least one match that does not sit inside a capability word. */
function actionOutside(text: string, blocked: readonly Span[]): string | undefined {
	for (const concept of ACTIONS) {
		const spans = matchSpans(text, concept.pattern);
		if (spans.some((span) => blocked.every((block) => !overlaps(span, block)))) return concept.key;
	}
	return undefined;
}

function deriveSteps(query: string, actionOf: (normalized: string) => string): ToolIntentStep[] {
	const clauses = query
		.trim()
		.split(
			/(?:并且|並且|然后|然後|接着|接著|随后|隨後|并(?=整理|创建|生成|导出|制作)|再(?=整理|创建|生成|导出|制作)|[；;]|\s+and\s+then\s+|\s+then\s+|\s+and\s+(?=create|export|generate|read|fetch|send))/i,
		)
		.filter(Boolean);
	const steps: ToolIntentStep[] = [];
	for (const clause of clauses) {
		const normalized = normalize(clause);
		const capability = conceptFor(normalized, CAPABILITIES)?.key ?? "unknown";
		let action = actionOf(normalized);
		if (capability === "spreadsheet" && /整理|制作|製作/.test(normalized)) action = "create";
		if (capability === "news" && action === "unknown") action = "search";
		if (capability === "map" && action === "unknown" && /找|查|搜|附近|\bnearby\b/i.test(normalized))
			action = "search";
		const constraints =
			/背景.*透明|透明.*背景|去.*背景|抠图|摳圖|transparent.*background|background.*transparent|remove.*background/.test(
				normalized,
			)
				? ["transparent background"]
				: undefined;
		const step: ToolIntentStep = {
			capability,
			action,
			target: clause.trim(),
			query: clause.trim(),
			...(constraints ? { constraints } : {}),
		};
		steps.push(step);
		// Research needs a content-reading step before material can be summarized into another artifact.
		if (capability === "web" && action === "search" && clauses.length > 1) {
			steps.push({
				capability: "web",
				action: "read",
				target: "content of the discovered source pages",
				query: "web read fetch page content",
			});
		}
	}
	return steps.length > 0 ? steps : [{ capability: "unknown", action: "unknown", query }];
}

/** Recognizes a small vocabulary. Unknown requests stay unknown for the model to decompose explicitly. */
export function deriveIntentSteps(query: string): ToolIntentStep[] {
	return deriveSteps(query, (normalized) => conceptFor(normalized, ACTIONS)?.key ?? "unknown");
}

/**
 * Preload vocabulary. An action that only matches inside a capability word (播放 inside 播放器)
 * does not count; the model can still recover it through tool_search.
 */
export function derivePreloadSteps(query: string): ToolIntentStep[] {
	return deriveSteps(
		query,
		(normalized) => actionOutside(normalized, capabilityHit(normalized)?.spans ?? []) ?? "unknown",
	);
}

export function intentSearchQuery(step: ToolIntentStep): string {
	return [
		step.query,
		step.capability,
		step.action,
		step.target,
		...(step.constraints ?? []),
		conceptFor(step.capability, CAPABILITIES)?.terms,
		conceptFor(step.action, ACTIONS)?.terms,
	]
		.filter((part): part is string => Boolean(part && part !== "unknown"))
		.join(" ");
}

interface MetadataEvidence {
	path: string;
	text: string;
	actionValue?: boolean;
}

function collectSchemaEvidence(schema: unknown, path: string, entries: MetadataEvidence[], actionValue = false): void {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
	const record = schema as Record<string, unknown>;
	if (typeof record.description === "string") entries.push({ path: `${path}.description`, text: record.description });
	if (typeof record.const === "string") entries.push({ path: `${path}.const`, text: record.const, actionValue });
	if (Array.isArray(record.enum))
		for (const value of record.enum) {
			if (typeof value === "string") entries.push({ path: `${path}.enum`, text: value, actionValue });
		}
	if (typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)) {
		for (const [name, value] of Object.entries(record.properties)) {
			const propertyPath = `${path}.${name}`;
			entries.push({ path: propertyPath, text: name });
			collectSchemaEvidence(value, propertyPath, entries, /^(action|operation|command|method)$/i.test(name));
		}
	}
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = record[key];
		if (Array.isArray(variants))
			variants.forEach((variant, index) => {
				collectSchemaEvidence(variant, `${path}.${key}[${index}]`, entries, actionValue);
			});
	}
	collectSchemaEvidence(record.items, `${path}.items`, entries, actionValue);
}

function matchesConcept(text: string, value: string, concepts: readonly Concept[]): boolean {
	const normalized = normalize(text);
	const concept = conceptFor(value, concepts);
	if (concept)
		return concept.pattern.test(normalized) || concept.terms.split(" ").some((term) => hasTerm(normalized, term));
	return value.trim().length > 0 && value !== "unknown" && hasTerm(normalized, value);
}

function hasTerm(text: string, term: string): boolean {
	const normalized = normalize(term).trim();
	if (/\p{Script=Han}/u.test(normalized)) return text.includes(normalized);
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return escaped.length > 0 && new RegExp(`(?:^|[^a-z0-9])${escaped}s?(?:$|[^a-z0-9])`, "i").test(text);
}

function positiveText(entry: MetadataEvidence, action?: string): string {
	const readOnlyAction = /^(read|search|status|list|references|screenshot)$/.test(action ?? "");
	if (action && !readOnlyAction && /\bread.only\b|只读|只讀/i.test(entry.text)) return "";
	// Retain affirmative prefixes such as "Read status" before "but never controls playback".
	return entry.text.split(
		/\b(?:never|cannot|can't|does not|do not|not support|unsupported|better than|rather than|instead of)\b|不(?:会|會|能|支持|提供|触发|觸發|执行|執行)|\buse\s+\w+_\w+\s+(?:instead|first)/i,
	)[0];
}

/** Check concrete capability/action evidence, independently of ranking score or namespace marketing. */
export function assessToolForIntent(step: ToolIntentStep, tool: IntentToolMetadata): ToolIntentAssessment {
	const entries: MetadataEvidence[] = [{ path: "name", text: tool.name }];
	tool.description
		.split(/(?:[.!?。；;\n]+)(?:\s+|$)|。|；/)
		.filter(Boolean)
		.forEach((text, index) => {
			entries.push({ path: `description[${index}]`, text });
		});
	collectSchemaEvidence(tool.parameters, "parameters", entries);
	const evidence: string[] = [];
	const missing: string[] = [];
	const exactName = normalize(step.query ?? "").trim() === normalize(tool.name);
	const render = (entry: MetadataEvidence) => `${entry.path}: ${entry.text.trim().slice(0, 180)}`;
	const canonicalCapability = conceptFor(step.capability, CAPABILITIES)?.key ?? step.capability;
	const capabilityPattern = CAPABILITY_EVIDENCE[canonicalCapability];
	const capabilityEvidence = entries.find((entry) => {
		if (!(entry.path === "name" || entry.path.startsWith("description[") || /\.(?:const|enum)$/.test(entry.path)))
			return false;
		const text = normalize(positiveText(entry));
		return capabilityPattern ? capabilityPattern.test(text) : matchesConcept(text, step.capability, []);
	});
	if (capabilityEvidence) evidence.push(render(capabilityEvidence));
	else if (step.capability !== "unknown") missing.push(`capability: ${step.capability}`);
	const enumeratedActions = entries.filter((entry) => entry.actionValue);
	// An explicit operation enum is authoritative: incidental prose cannot add an unsupported operation.
	const actionEntries =
		enumeratedActions.length > 0
			? enumeratedActions
			: entries.filter((entry) => entry.path === "name" || entry.path.startsWith("description["));
	const canonicalAction = conceptFor(step.action, ACTIONS)?.key ?? step.action;
	const actionEvidence = actionEntries.find((entry) => {
		const text = positiveText(entry, canonicalAction);
		if (canonicalAction === "screenshot") {
			// "Capture an accessibility snapshot, better than screenshot" describes text capture.
			// Broad retrieval aliases are not sufficient evidence of a pixel-producing operation.
			return /\bscreen\s*shots?\b|截图|截圖|截屏|截取.*(?:视口|視口|画面|畫面)/i.test(normalize(text));
		}
		if (canonicalAction === "search" && !entry.actionValue) {
			// In get_search_content, "search" names the stored object; the operation is retrieval.
			// Preserve explicit search operations in a tool's action enum, but do not infer them
			// from a retrieval tool's references to earlier searches or passage matching.
			if (/(?:^|_)(?:get|read|retrieve|fetch)_(?:.*_)?(?:search|results?|content)(?:_|$)/i.test(tool.name))
				return false;
			if (/^(?:\[[^\]]+\]\s*)?(?:read|retrieve|get|fetch)\b.*\b(?:stored|previous|existing)\b/i.test(text))
				return false;
		}
		return matchesConcept(text, step.action, ACTIONS);
	});
	if (actionEvidence) evidence.push(render(actionEvidence));
	else if (step.action !== "unknown") missing.push(`action: ${step.action}`);
	if (step.capability === "unknown" && !exactName) {
		const words = normalize(step.target ?? step.query ?? "").match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? [];
		const specific = words.filter(
			(word) =>
				word.length > 1 &&
				!/^(a|an|the|my|me|this|that|please|for|to|of|with|tool|tools|in|on|and)$/.test(word) &&
				!ACTIONS.some((action) => matchesConcept(word, action.key, ACTIONS)),
		);
		const targetEvidence = entries.find(
			(entry) => specific.length > 0 && specific.every((word) => hasTerm(normalize(entry.text), word)),
		);
		if (targetEvidence) evidence.push(render(targetEvidence));
		else missing.push("specific capability or target");
	}
	if (step.action === "unknown" && !exactName) missing.push("explicit action");
	for (const constraint of step.constraints ?? []) {
		const constraintEvidence = entries.find((entry) =>
			constraint === "transparent background"
				? /transparent|transparency|去.*背景|背景.*透明|抠图|摳圖|remove.*background/i.test(positiveText(entry))
				: hasTerm(normalize(positiveText(entry)), constraint),
		);
		if (constraintEvidence) evidence.push(render(constraintEvidence));
		else missing.push(`constraint (verify before execution): ${constraint}`);
	}
	if (exactName) evidence.unshift(`exact tool name: ${tool.name}`);
	const rejected = !exactName && !capabilityEvidence && step.capability !== "unknown";
	const status = rejected ? "rejected" : missing.length > 0 ? "refine" : "supported";
	return {
		status,
		evidence: [...new Set(evidence)],
		missing,
		reason:
			status === "supported"
				? "Tool metadata supports this action; runtime permissions, inputs and provider conditions still apply."
				: status === "rejected"
					? "No evidence for the requested capability."
					: "Metadata does not establish all requirements; refine the intent or inspect a candidate before loading.",
	};
}
