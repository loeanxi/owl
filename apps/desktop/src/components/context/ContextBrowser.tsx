/**
 * 上下文浏览器：选「当前（下一次请求）」或任一步，按七类展开这次请求到底由
 * 什么组成，每个条目再展开为原文（系统提示、工具 schema、消息、思考、工具
 * 参数与结果）。悬停趋势柱时预览那一步，离开回到自己的选择。
 * 结构与交互对齐 dsh-context 的 Context Browser 卡片。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type {
	ContextCategory,
	ContextDetailItem,
	ContextDetailResult,
	ContextItemContent,
	ContextRequestRow,
} from "../../bridge/protocol.ts";
import { renderMarkdown } from "../ChatStream.tsx";
import { StackedBar } from "./ContextCharts.tsx";
import { CAT_COLOR, CAT_LABEL, CATS, fmtPct, fmtSigned, fmtTime, fmtTokens, measuredOf, promptTokensOf, stamp } from "./context-model.ts";
import type { LocateTarget } from "./ContextTrend.tsx";

type BrowserPick = number | "live";
type AssistantKind = "think" | "tool" | "answer";

const ITEM_RENDER_CAP = 300;

const SEARCH_HINT: Partial<Record<ContextCategory, string>> = {
	toolSchemas: "按名称或来源过滤…",
	user: "按消息内容过滤…",
	inject: "按注入内容过滤…",
	assistant: "按回复、调用或思考过滤…",
	toolResult: "按工具或参数过滤…",
	other: "按内容过滤…",
};

const KIND_LABEL: Record<AssistantKind, string> = { think: "思考", tool: "工具", answer: "回答" };

export interface BrowserFocus extends LocateTarget {
	nonce: number;
}

function pickKey(pick: BrowserPick, liveVersion: string): string {
	return pick === "live" ? `live:${liveVersion}` : `s:${pick}`;
}

export function BrowserCard({
	client,
	cwd,
	sessionId,
	requests,
	liveVersion,
	previewSeq,
	pinSeq,
	hoverCat,
	onHoverCat,
	focus,
}: {
	client: BridgeClient;
	cwd: string;
	sessionId?: string;
	requests: ContextRequestRow[];
	liveVersion: string;
	previewSeq: number | null;
	pinSeq: number | null;
	hoverCat: string | null;
	onHoverCat: (key: string | null) => void;
	focus: BrowserFocus | null;
}): React.JSX.Element {
	const [pick, setPick] = useState<BrowserPick>("live");
	const [details, setDetails] = useState<Map<string, ContextDetailResult>>(() => new Map());
	const [failed, setFailed] = useState<string | null>(null);
	const [open, setOpen] = useState<Set<ContextCategory>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [filters, setFilters] = useState<Partial<Record<ContextCategory, string>>>({});
	const [kinds, setKinds] = useState<Set<AssistantKind>>(() => new Set());
	const [toolSort, setToolSort] = useState<"hits" | "size" | "name">("hits");
	const pendingFocus = useRef<BrowserFocus | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const inflight = useRef(new Set<string>());

	useEffect(() => {
		if (pinSeq !== null) setPick(pinSeq);
	}, [pinSeq]);

	useEffect(() => {
		if (!focus) return;
		pendingFocus.current = focus;
		setPick(focus.seq ?? "live");
		setOpen((current) => new Set(current).add(focus.cat));
	}, [focus]);

	const shown: BrowserPick = previewSeq ?? pick;
	const shownKey = pickKey(shown, liveVersion);
	const pickedKey = pickKey(pick, liveVersion);

	useEffect(() => {
		for (const [target, key] of [
			[shown, shownKey],
			[pick, pickedKey],
		] as Array<[BrowserPick, string]>) {
			if (details.has(key) || inflight.current.has(key)) continue;
			inflight.current.add(key);
			void client
				.request<ContextDetailResult>({
					type: "context.detail",
					cwd,
					...(sessionId ? { sessionId } : {}),
					...(target === "live" ? {} : { seq: target }),
				})
				.then((response) => {
					inflight.current.delete(key);
					if (response.ok && response.result) {
						const result = response.result;
						setDetails((current) => {
							const next = new Map(current);
							// 「当前」只留最新一版
							if (key.startsWith("live:")) for (const stale of next.keys()) if (stale.startsWith("live:")) next.delete(stale);
							next.set(key, result);
							return next;
						});
						setFailed(null);
					} else {
						setFailed(response.error ?? "context.detail 失败");
					}
				})
				.catch((error: unknown) => {
					inflight.current.delete(key);
					setFailed(error instanceof Error ? error.message : String(error));
				});
		}
	}, [client, cwd, sessionId, shown, shownKey, pick, pickedKey, details]);

	// 悬停预览还没到时继续显示自己的选择，避免闪空
	let detail = details.get(shownKey) ?? details.get(pickedKey);
	if (!detail && shown === "live") {
		for (const [key, value] of details) if (key.startsWith("live:")) detail = value;
	}
	const detailIsShown = details.has(shownKey);
	const shownRow = shown === "live" ? undefined : requests.find((row) => row.seq === shown);
	const latest = requests[requests.length - 1];

	useEffect(() => {
		const target = pendingFocus.current;
		if (!target || !detail || !detailIsShown) return;
		if ((target.seq ?? "live") !== shown) return;
		pendingFocus.current = null;
		const category = detail.categories.find((candidate) => candidate.key === target.cat);
		const item = category?.items.find(
			(candidate) => (target.key && candidate.key === target.key) || (target.callId && candidate.callId === target.callId),
		);
		const expandKey = item ? `${shownKey}|${item.key}` : undefined;
		if (expandKey) setExpanded((current) => new Set(current).add(expandKey));
		requestAnimationFrame(() => {
			const anchor =
				(expandKey && rootRef.current?.querySelector(`[data-elem="${CSS.escape(expandKey)}"]`)) ||
				rootRef.current?.querySelector(`[data-cat="${target.cat}"]`);
			anchor?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	}, [detail, detailIsShown, shown, shownKey]);

	const estimated = detail?.categories.reduce((sum, category) => sum + category.tokens, 0) ?? 0;
	const actual = shownRow?.usage
		? promptTokensOf(shownRow.usage)
		: shown === "live" && latest?.usage
			? measuredOf(latest.usage)
			: undefined;
	const parts = useMemo(
		() =>
			(detail?.categories ?? []).map((category) => ({
				key: category.key,
				label: CAT_LABEL[category.key],
				color: CAT_COLOR[category.key],
				value: category.tokens,
			})),
		[detail],
	);

	const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
		const next = new Set(set);
		if (next.has(value)) next.delete(value);
		else next.add(value);
		return next;
	};

	const heading =
		shown === "live"
			? "当前 · 下一次请求"
			: shownRow
				? `第 ${shownRow.turn} 轮 · 第 ${shownRow.step} 步`
				: `#${shown}`;

	return (
		<div className="ctx-card ctx-browser" ref={rootRef}>
			<div className="ctx-card-title">
				<span className="ctx-card-title-text">上下文浏览器</span>
				<span className="ctx-br-base" title="变动对比的基线：与上一步（上一次模型请求）对比">
					比前步
				</span>
				<select
					className="ctx-br-pick"
					value={pick === "live" ? "live" : String(pick)}
					onChange={(event) => setPick(event.target.value === "live" ? "live" : Number(event.target.value))}
				>
					<option value="live">当前（下一次请求）</option>
					{[...requests].reverse().map((row) => (
						<option key={row.seq} value={String(row.seq)}>
							{`${stamp(row.turn, row.step)} · ${fmtTime(row.ts)} · ≈${fmtTokens(row.totalTokens)}`}
						</option>
					))}
				</select>
			</div>

			<div className="ctx-br-meta">
				<b>{heading}</b>
				{previewSeq !== null && <span className="ctx-br-dim">（悬停预览）</span>}
				<span className="ctx-est">估算 ≈ {fmtTokens(estimated)}</span>
				{actual !== undefined && <span>实际 {fmtTokens(actual)}</span>}
			</div>
			<StackedBar parts={parts} hoverKey={hoverCat} onHoverKey={onHoverCat} />

			{failed && !detail && <div className="ctx-br-note ctx-br-err">{failed}</div>}
			{!detail && !failed && <div className="ctx-br-note">正在读取上下文明细…</div>}
			{detail && !detail.available && (
				<div className="ctx-br-note">该步骤的转录快照不在保留范围内（早于本进程的记录或已被淘汰），只有趋势图里的 token 估算。</div>
			)}
			{detail?.approximate && <div className="ctx-br-note">该步骤之后上下文被改写，以下为近似构成。</div>}

			{detail?.available && (
				<div className="ctx-br-cats">
					{CATS.map((cat) => {
						const category = detail.categories.find((candidate) => candidate.key === cat.key);
						if (!category) return null;
						const base = detail.baseline?.[cat.key];
						const countDelta = base ? category.items.length - base.count : 0;
						const tokenDelta = base ? category.tokens - base.tokens : 0;
						const isOpen = open.has(cat.key);
						return (
							<div
								key={cat.key}
								data-cat={cat.key}
								className={`ctx-br-cat${category.items.length === 0 ? " ctx-br-cat-empty" : ""}`}
							>
								<button
									type="button"
									className={`ctx-br-cat-row${hoverCat === cat.key ? " ctx-br-cat-on" : ""}${isOpen ? " ctx-br-cat-open" : ""}`}
									onClick={() => setOpen((current) => toggle(current, cat.key))}
									onMouseEnter={() => onHoverCat(cat.key)}
									onMouseLeave={() => onHoverCat(null)}
								>
									<span className={`ctx-br-chev${isOpen ? " ctx-br-chev-on" : ""}`} />
									<i style={{ background: cat.color }} />
									<span className="ctx-br-count-grp">
										<span className="ctx-br-cat-label">{cat.label}</span>
										<span className="ctx-br-cat-count">{category.items.length} 项</span>
										{countDelta !== 0 && (
											<span className={`ctx-br-delta ${countDelta > 0 ? "ctx-br-delta-up" : "ctx-br-delta-down"}`}>
												{countDelta > 0 ? `+${countDelta}` : `−${-countDelta}`}
											</span>
										)}
									</span>
									<span className="ctx-br-tokens-grp">
										{tokenDelta !== 0 && (
											<span className={`ctx-br-delta ${tokenDelta > 0 ? "ctx-br-delta-up" : "ctx-br-delta-down"}`}>
												{fmtSigned(tokenDelta)}
											</span>
										)}
										<span className="ctx-br-tokens">≈{fmtTokens(category.tokens)}</span>
									</span>
									<span className="ctx-br-pct">{fmtPct(category.tokens / Math.max(estimated, 1))}</span>
								</button>
								{isOpen && (
									<CategoryBody
										client={client}
										cwd={cwd}
										sessionId={sessionId}
										seq={shown === "live" ? undefined : shown}
										scopeKey={shownKey}
										category={cat.key}
										items={category.items}
										filter={filters[cat.key] ?? ""}
										onFilter={(value) => setFilters((current) => ({ ...current, [cat.key]: value }))}
										kinds={kinds}
										onToggleKind={(kind) => setKinds((current) => toggle(current, kind))}
										toolSort={toolSort}
										onToolSort={setToolSort}
										expanded={expanded}
										onToggleItem={(key) => setExpanded((current) => toggle(current, key))}
									/>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

function CategoryBody({
	client,
	cwd,
	sessionId,
	seq,
	scopeKey,
	category,
	items,
	filter,
	onFilter,
	kinds,
	onToggleKind,
	toolSort,
	onToolSort,
	expanded,
	onToggleItem,
}: {
	client: BridgeClient;
	cwd: string;
	sessionId?: string;
	seq?: number;
	scopeKey: string;
	category: ContextCategory;
	items: ContextDetailItem[];
	filter: string;
	onFilter: (value: string) => void;
	kinds: Set<AssistantKind>;
	onToggleKind: (kind: AssistantKind) => void;
	toolSort: "hits" | "size" | "name";
	onToolSort: (value: "hits" | "size" | "name") => void;
	expanded: Set<string>;
	onToggleItem: (key: string) => void;
}): React.JSX.Element {
	const query = filter.trim().toLowerCase();
	const kindCounts = useMemo(() => {
		const counts: Record<AssistantKind, number> = { think: 0, tool: 0, answer: 0 };
		if (category === "assistant") for (const item of items) for (const kind of item.kinds ?? []) counts[kind] += 1;
		return counts;
	}, [category, items]);
	const visible = useMemo(() => {
		let list = items.filter(
			(item) =>
				!query || item.label.toLowerCase().includes(query) || (item.chip ?? "").toLowerCase().includes(query),
		);
		if (category === "assistant" && kinds.size > 0) list = list.filter((item) => item.kinds?.some((kind) => kinds.has(kind)));
		if (category === "toolSchemas") {
			list = [...list].sort((a, b) =>
				toolSort === "name"
					? a.label.localeCompare(b.label)
					: toolSort === "size"
						? b.tokens - a.tokens
						: (b.hits ?? 0) - (a.hits ?? 0) || b.tokens - a.tokens,
			);
		}
		return list;
	}, [items, query, category, kinds, toolSort]);
	const hasSearch = items.length > 0 && category !== "system";
	return (
		<div className="ctx-br-body">
			{hasSearch && (
				<div className="ctx-br-toolctl">
					<input
						className="ctx-search"
						value={filter}
						placeholder={SEARCH_HINT[category] ?? "过滤…"}
						onChange={(event) => onFilter(event.target.value)}
					/>
					{category === "assistant" && (
						<div className="ctx-gran" title="按内容种类过滤回复：思考、工具调用、回答文本">
							{(Object.keys(KIND_LABEL) as AssistantKind[]).map((kind) => (
								<button
									key={kind}
									type="button"
									className={`ctx-gran-btn${kinds.has(kind) ? " ctx-gran-on" : ""}`}
									onClick={() => onToggleKind(kind)}
								>
									{KIND_LABEL[kind]}
									<span className="ctx-kind-n">{kindCounts[kind]}</span>
								</button>
							))}
						</div>
					)}
					{category === "toolSchemas" && (
						<div className="ctx-gran" title="工具排序：按当前步骤中的调用次数（默认）、token 大小或名称">
							{(
								[
									["hits", "按次数"],
									["size", "按大小"],
									["name", "按名称"],
								] as const
							).map(([key, label]) => (
								<button
									key={key}
									type="button"
									className={`ctx-gran-btn${toolSort === key ? " ctx-gran-on" : ""}`}
									onClick={() => onToolSort(key)}
								>
									{label}
								</button>
							))}
						</div>
					)}
				</div>
			)}
			{visible.length === 0 && items.length > 0 && <div className="ctx-br-note">没有匹配当前过滤条件的行</div>}
			{visible.slice(0, ITEM_RENDER_CAP).map((item) => {
				const expandKey = `${scopeKey}|${item.key}`;
				const isOpen = expanded.has(expandKey);
				return (
					<div key={item.key} className={`ctx-br-elem${isOpen ? " ctx-br-elem-on" : ""}`} data-elem={expandKey}>
						<button type="button" className="ctx-br-elem-row" onClick={() => onToggleItem(expandKey)}>
							<span className={`ctx-br-chev${isOpen ? " ctx-br-chev-on" : ""}`} />
							{item.error && <i className="ctx-err-dot" title="工具执行失败" />}
							{category === "toolSchemas" ? (
								<>
									<span className="ctx-br-preview ctx-br-mono">{item.label}</span>
									{item.chip && (
										<span className="ctx-br-tag ctx-br-tool-plugin" title="该工具的注册来源（仅供参考）">
											{item.chip}
										</span>
									)}
									<span className="ctx-br-hits" title="当前展示步骤的上下文中，该工具被调用并返回结果的次数">
										{item.hits ? `${item.hits} 次` : ""}
									</span>
								</>
							) : (
								<>
									{item.chip && <span className="ctx-br-tag">{item.chip}</span>}
									<span className="ctx-br-preview">{item.label}</span>
									{item.images ? <span className="ctx-br-hits">🖼 ×{item.images}</span> : null}
								</>
							)}
							{item.at && (
								<span
									className={`ctx-br-time${item.at.pending ? " ctx-br-time-pending" : ""}`}
									title={
										item.at.pending
											? `预计随第 ${item.at.turn} 轮 · 第 ${item.at.step} 步的请求进入上下文（尚未发送）`
											: `首次随第 ${item.at.turn} 轮 · 第 ${item.at.step} 步的请求进入上下文`
									}
								>
									{stamp(item.at.turn, item.at.step)}
								</span>
							)}
							{item.ts !== undefined && <span className="ctx-br-time">{fmtTime(item.ts)}</span>}
							<span className="ctx-br-tokens">≈{fmtTokens(item.tokens)}</span>
						</button>
						{isOpen && (
							<div className="ctx-br-content">
								<ItemContent client={client} cwd={cwd} sessionId={sessionId} seq={seq} itemKey={item.key} />
							</div>
						)}
					</div>
				);
			})}
			{visible.length > ITEM_RENDER_CAP && (
				<div className="ctx-br-note">另有 {visible.length - ITEM_RENDER_CAP} 项未展示，可用上方过滤缩小范围</div>
			)}
		</div>
	);
}

const contentCache = new Map<string, ContextItemContent | null>();

function ItemContent({
	client,
	cwd,
	sessionId,
	seq,
	itemKey,
}: {
	client: BridgeClient;
	cwd: string;
	sessionId?: string;
	seq?: number;
	itemKey: string;
}): React.JSX.Element {
	// 步骤的前缀不可变，可按会话缓存；「当前」随时在长，每次展开都重新取
	const cacheKey = seq === undefined ? undefined : `${sessionId ?? cwd}|${seq}|${itemKey}`;
	const [state, setState] = useState<{ content?: ContextItemContent | null; error?: string; loading: boolean }>(() =>
		cacheKey && contentCache.has(cacheKey) ? { content: contentCache.get(cacheKey), loading: false } : { loading: true },
	);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (cacheKey && contentCache.has(cacheKey) && attempt === 0) return;
		let alive = true;
		setState({ loading: true });
		void client
			.request<ContextItemContent | null>({
				type: "context.item",
				cwd,
				key: itemKey,
				...(sessionId ? { sessionId } : {}),
				...(seq !== undefined ? { seq } : {}),
			})
			.then((response) => {
				if (!alive) return;
				if (response.ok) {
					const content = response.result ?? null;
					if (cacheKey) contentCache.set(cacheKey, content);
					setState({ content, loading: false });
				} else {
					setState({ error: response.error ?? "内容加载失败", loading: false });
				}
			})
			.catch((error: unknown) => {
				if (alive) setState({ error: error instanceof Error ? error.message : String(error), loading: false });
			});
		return () => {
			alive = false;
		};
	}, [client, cwd, sessionId, seq, itemKey, cacheKey, attempt]);

	if (state.loading) return <div className="ctx-br-dim">正在加载…</div>;
	if (state.error) {
		return (
			<button type="button" className="ctx-br-retry" onClick={() => setAttempt((value) => value + 1)}>
				内容加载失败，点击重试（{state.error}）
			</button>
		);
	}
	const content = state.content;
	if (!content) return <div className="ctx-br-dim">该条目已不在上下文中（可能已被压缩或清理）</div>;

	return (
		<>
			{content.tool && <ToolSchemaView tool={content.tool} />}
			{content.call && <CallCard direction="←" name={content.call.name} args={content.call.args} ok={content.call.ok} />}
			{content.thinking && <RichBlock title="思考" text={content.thinking} defaultMarkdown={false} />}
			{content.text !== undefined && content.text !== "" && (
				<RichBlock
					title={content.call ? "结果" : content.calls || content.thinking ? "回答" : "内容"}
					text={content.text}
					defaultMarkdown={!content.call}
				/>
			)}
			{content.calls?.map((call, index) => (
				<CallCard key={index} direction="→" name={call.name} args={call.args} />
			))}
			{!content.tool && !content.text && !content.thinking && !content.calls?.length && !content.call && (
				<div className="ctx-br-dim">（空）</div>
			)}
			{content.images ? <div className="ctx-br-dim">含 {content.images} 张图片（未展示）</div> : null}
			{content.truncated && <div className="ctx-br-dim">内容过长，已截断显示</div>}
		</>
	);
}

function argText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function CallCard({ direction, name, args, ok }: { direction: string; name: string; args: unknown; ok?: boolean }): React.JSX.Element {
	const entries = args && typeof args === "object" && !Array.isArray(args) ? Object.entries(args as Record<string, unknown>) : [];
	return (
		<div className="ctx-ts-card">
			<div className="ctx-ts-card-head">
				<span className="ctx-ts-call-name">
					{direction} {name}
				</span>
				{ok !== undefined && (
					<span className={`ctx-ts-call-state ${ok ? "ctx-ts-call-ok" : "ctx-ts-call-err"}`}>
						<i />
						{ok ? "正常" : "失败"}
					</span>
				)}
			</div>
			{entries.length > 0 ? (
				entries.map(([key, value]) => (
					<div key={key} className="ctx-ts-arg-row">
						<span className="ctx-ts-param-name">{key}</span>
						<span className="ctx-ts-arg-val">{argText(value)}</span>
					</div>
				))
			) : (
				<div className="ctx-ts-params-empty">{entries.length === 0 && args !== undefined && typeof args !== "object" ? argText(args) : "（无参数）"}</div>
			)}
		</div>
	);
}

function RichBlock({ title, text, defaultMarkdown }: { title: string; text: string; defaultMarkdown: boolean }): React.JSX.Element {
	const [markdown, setMarkdown] = useState(defaultMarkdown);
	const [copied, setCopied] = useState(false);
	const lines = text.split("\n").length;
	return (
		<div className="ctx-ts-card">
			<div className="ctx-ts-card-head">
				<b>{title}</b>
				<span className="ctx-ts-card-right">
					<span className="ctx-ts-card-meta">{lines} 行</span>
					<button
						type="button"
						className={`ctx-rich-copy${copied ? " ctx-rich-copy-on" : ""}`}
						onClick={() => {
							void navigator.clipboard?.writeText(text).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1200);
							});
						}}
					>
						{copied ? "已复制" : "复制"}
					</button>
					<span className="ctx-gran">
						<button type="button" className={`ctx-gran-btn${!markdown ? " ctx-gran-on" : ""}`} onClick={() => setMarkdown(false)}>
							原文
						</button>
						<button type="button" className={`ctx-gran-btn${markdown ? " ctx-gran-on" : ""}`} onClick={() => setMarkdown(true)}>
							Markdown
						</button>
					</span>
				</span>
			</div>
			{markdown ? (
				<div className="ctx-ts-desc-md">
					<div className="owl-answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
				</div>
			) : (
				<pre className="ctx-ts-desc-body">{text}</pre>
			)}
		</div>
	);
}

interface SchemaNode {
	type?: string | string[];
	description?: string;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	anyOf?: SchemaNode[];
	enum?: unknown[];
	items?: SchemaNode;
}

function typeOf(node: SchemaNode | undefined): string {
	if (!node) return "";
	if (node.enum) return "enum";
	if (Array.isArray(node.type)) return node.type.join(" | ");
	if (node.type === "array") return `${typeOf(node.items) || "any"}[]`;
	if (node.type) return node.type;
	if (node.anyOf) return node.anyOf.map(typeOf).filter(Boolean).join(" | ");
	return "";
}

function ToolSchemaView({ tool }: { tool: NonNullable<ContextItemContent["tool"]> }): React.JSX.Element {
	const [raw, setRaw] = useState(false);
	const schema = (tool.parameters ?? {}) as SchemaNode;
	const properties = Object.entries(schema.properties ?? {});
	const required = new Set(schema.required ?? []);
	return (
		<>
			<div className="ctx-ts-card">
				<div className="ctx-ts-card-head">
					<b>描述</b>
					{tool.source && <span className="ctx-ts-card-right ctx-ts-card-meta">来源 {tool.source}</span>}
				</div>
				<pre className="ctx-ts-desc-body">{tool.description || "（无描述）"}</pre>
			</div>
			<div className="ctx-ts-card">
				<div className="ctx-ts-card-head">
					<b>参数</b>
					<span className="ctx-ts-card-right ctx-ts-card-meta">{properties.length} 个</span>
				</div>
				{properties.length === 0 ? (
					<div className="ctx-ts-params-empty">（无参数）</div>
				) : (
					properties.map(([name, node]) => (
						<div key={name} className="ctx-ts-param-row">
							<span className="ctx-ts-param-name">{name}</span>
							<span className="ctx-ts-param-type">{typeOf(node)}</span>
							<span className={required.has(name) ? "ctx-ts-param-req" : "ctx-ts-param-req-off"}>
								{required.has(name) ? "必填" : "可选"}
							</span>
							<span />
							{node.description && <span className="ctx-ts-param-desc">{node.description}</span>}
						</div>
					))
				)}
			</div>
			<div className="ctx-ts-json">
				<button type="button" className="ctx-ts-json-toggle" onClick={() => setRaw((value) => !value)}>
					{raw ? "收起" : "查看原始 JSON"}
				</button>
				{raw && <pre className="ctx-ts-desc-body ctx-ts-raw">{JSON.stringify(tool.parameters, null, 2)}</pre>}
			</div>
		</>
	);
}
