/**
 * owl-genui 桌面端集成：把 packages/owl-genui 的浏览器渲染器接进聊天流。
 *
 * - GenuiSessionProvider：App 顶层装配，提供动作回传通道（组件 action → 桥的
 *   owl-ui.action 请求 → 会话消息）与持久化身份（sessionId），并让渲染器语言
 *   跟随设置页的界面语言。
 * - splitGenuiSegments：扫描回答文本里的 ```owl-ui 围栏，把「闭合的 owl-ui
 *   围栏」从 markdown 里切出来单独渲染 GenuiBlock；未闭合的尾部围栏留在
 *   markdown 段里按普通代码块渲染（流式半截 JSON 绝不能看起来像出错）。
 * - GenuiAnswerCard / GenuiToolCardView：分别供 ChatStream 的回答正文与
 *   render_ui 工具行使用。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { ToolCard } from "../hooks/transcript.ts";
import { ErrorBoundary, GenuiActionContext, GenuiBlock, renderGenuiFence, resolveGenuiSpec, setLocale, toolStateKey, type GenuiActionHandler, type GenuiSpec } from "../../../../packages/owl-genui/client/index.ts";
import { getUiLanguage } from "../i18n/index.ts";
import type { BridgeClient } from "../bridge/client.ts";

/** Genui 会话上下文：动作回传 + 持久化身份。 */
type GenuiSessionValue = {
	sessionId: string | undefined;
	sendAction: GenuiActionHandler;
};

const GenuiSessionContext = createContext<GenuiSessionValue>({ sessionId: undefined, sendAction: () => {} });

/** 会话上下文读取：ChatStream 也用它做消息反馈的命名空间（无 Provider 时 sessionId 为 undefined）。 */
export function useGenuiSession(): GenuiSessionValue {
	return useContext(GenuiSessionContext);
}

/** App 顶层装配一次；没有桥/会话时组件自动退化为展示态。 */
export function GenuiSessionProvider({ client, sessionId, children }: {
	client: BridgeClient;
	sessionId: string | undefined;
	children: ReactNode;
}): React.JSX.Element {
	useEffect(() => {
		setLocale(getUiLanguage() === "en" ? "en" : "zh");
	}, []);
	const value = useMemo<GenuiSessionValue>(() => ({
		sessionId,
		sendAction: (action, payload) => {
			if (!sessionId) return;
			void client.request({ type: "owl-ui.action", sessionId, action, payload }).catch(() => {
				// 动作回传失败静默：组件交互不因此打断阅读
			});
		},
	}), [client, sessionId]);
	return (
		<GenuiActionContext.Provider value={value.sendAction}>
			<GenuiSessionContext.Provider value={value}>{children}</GenuiSessionContext.Provider>
		</GenuiActionContext.Provider>
	);
}

/** 回答文本的渲染段：markdown 或已闭合的 owl-ui 围栏。 */
export type GenuiSegment = { kind: "md"; text: string } | { kind: "genui"; raw: string; ordinal: number };

const FENCE_OPEN = /^ {0,3}(`{3,})(.*)$/;

/**
 * 扫描回答文本，把闭合的 ```owl-ui 围栏切成独立段。其他语言的围栏原样留在
 * markdown 里；流式未闭合的尾部 owl-ui 围栏也留在 markdown 段（markdown-it
 * 会把它渲染成普通代码块）。
 */
export function splitGenuiSegments(text: string): GenuiSegment[] {
	const segments: GenuiSegment[] = [];
	let md: string[] = [];
	let fenceLang: "owl-ui" | "other" | null = null;
	let openMarker = "```";
	let genuiBody: string[] = [];
	let ordinal = 0;
	const closeMatch = (line: string): boolean => {
		const match = /^ {0,3}(`{3,})\s*$/.exec(line);
		return match !== null && match[1]!.length >= openMarker.length;
	};
	for (const line of text.split("\n")) {
		if (fenceLang === null) {
			const open = FENCE_OPEN.exec(line);
			if (open) {
				const lang = open[2]!.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
				openMarker = open[1]!;
				if (lang === "owl-ui") {
					fenceLang = "owl-ui";
					genuiBody = [];
					continue;
				}
				fenceLang = "other";
			}
			md.push(line);
		} else if (fenceLang === "owl-ui") {
			if (closeMatch(line)) {
				segments.push({ kind: "md", text: md.join("\n") });
				md = [];
				segments.push({ kind: "genui", raw: genuiBody.join("\n"), ordinal });
				ordinal += 1;
				fenceLang = null;
			} else {
				genuiBody.push(line);
			}
		} else {
			// 其他语言的围栏内部：遇到闭合线就出栏，内容行原样保留
			if (closeMatch(line)) fenceLang = null;
			md.push(line);
		}
	}
	if (fenceLang === "owl-ui") {
		// 未闭合的尾部围栏：还原成原样留在 markdown 段
		md.push(`${openMarker}owl-ui`, ...genuiBody);
	}
	const tail = md.join("\n");
	if (tail.trim() !== "" || segments.length === 0) segments.push({ kind: "md", text: tail });
	return segments;
}

/** 单个围栏段：settled 后带稳定身份（持久化键），流式中无身份。 */
function GenuiAnswerSegment({ raw, ordinal, identity, settled }: {
	raw: string;
	ordinal: number;
	identity: string;
	settled: boolean;
}): React.JSX.Element {
	const { sessionId } = useGenuiSession();
	const source = useMemo(
		() => (settled ? { id: `${identity}:fence${ordinal}`, order: [0, 0, ordinal] as const } : undefined),
		[settled, identity, ordinal],
	);
	const context = useMemo(
		() => (sessionId === undefined ? undefined : { sessionId, source }),
		[sessionId, source],
	);
	return <>{renderGenuiFence(raw, `${identity}:fence${ordinal}`, context)}</>;
}

/** 回答正文：混排 markdown 与 owl-ui 组件。无围栏时保持原有单节点渲染。 */
export function GenuiAnswerCard({ text, identity, settled, renderMarkdown }: {
	text: string;
	identity: string;
	settled: boolean;
	renderMarkdown: (text: string) => string;
}): React.JSX.Element {
	const segments = useMemo(() => splitGenuiSegments(text), [text]);
	if (segments.length === 1 && segments[0]!.kind === "md") {
		return <div className="owl-answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(segments[0]!.text) }} />;
	}
	return (
		<div className="owl-genui-root">
			{segments.map((segment, index) =>
				segment.kind === "md" ? (
					segment.text.trim() === "" ? null : (
						<div key={index} className="owl-answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(segment.text) }} />
					)
				) : (
					<GenuiAnswerSegment key={index} raw={segment.raw} ordinal={segment.ordinal} identity={identity} settled={settled} />
				),
			)}
		</div>
	);
}

/** Revalidate saved tool output before rendering; it can predate the current schema. */
export function GenuiToolCardView({ card }: { card: ToolCard }): React.JSX.Element | null {
	const { sessionId } = useGenuiSession();
	const spec = card.output?.genuiSpec;
	const resolved = useMemo(() => {
		if (!isGenuiSpecShape(spec)) return null;
		const raw = JSON.stringify(spec);
		const context = { source: { id: card.id, order: [0, 0, 0] as const } };
		return { raw, context, spec: resolveGenuiSpec(raw, context) };
	}, [spec, card.id]);
	if (resolved === null) return null;
	const stateKey = sessionId === undefined ? undefined : toolStateKey(sessionId, card.id);
	return (
		<div className="owl-genui-root">
			{resolved.spec === null ? renderGenuiFence(resolved.raw, card.id, resolved.context) : (
				<ErrorBoundary key={stateKey ?? card.id}>
					<GenuiBlock spec={resolved.spec} stateKey={stateKey} animateEntrance={false} />
				</ErrorBoundary>
			)}
		</div>
	);
}

function isGenuiSpecShape(value: unknown): value is GenuiSpec {
	return typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items);
}
