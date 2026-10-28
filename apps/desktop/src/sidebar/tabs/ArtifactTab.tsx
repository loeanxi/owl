/**
 * 产物页 —— 侧栏工作台里承载一件产物，并能在页内直接追问。
 *
 * 规格来源：Claude Desktop 的产物页（artifact page）
 *   - `cca654f75-B7IqV80J.js`：产物页头部（标题 / 分享 / 新会话 / 打开到新标签）。
 *   - `c3cbaca16-PdxmNS7W.js`：产物视图的双模式切换（`data-artifact-viewer-mode`）：
 *     **Thread**（关于这份产物的对话线程）与 **Browser**（产物本体）。
 *   - `caf9acda5-DZQdrmOl.js`：页底 composer（`artifact-page-composer`），发送时把
 *     产物作为文档上下文带上（`switchDocsOn` + `docArtifact`）；回复以
 *     「Claude's reply」短摘录内联回显，配「Dismiss」与「Open in chat」。
 *
 * owl 的对应：侧栏工作台开一个 `artifact` 页签，页内两段：
 *   - **产物**：文件产物按类型预览（图片 / Markdown / 文本），可视化产物渲染 owl-ui 组件；
 *   - **对话**：一条独立线程（不进主对话），每一轮都带上这份产物。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
	ErrorBoundary,
	GenuiBlock,
	renderGenuiFence,
	resolveGenuiSpec,
} from "../../../../../packages/owl-genui/client/index.ts";
import { InlineSummary, renderMarkdown } from "../../components/ChatStream.tsx";
import { useGenuiSession } from "../../components/Genui.tsx";
import { productKindText } from "../../components/ProductList.tsx";
import { artifactQuestionFrom, trimReplyPreview } from "../../hooks/artifact-thread.ts";
import type { Product } from "../../hooks/products.ts";
import { useArtifactThread } from "../../hooks/use-artifact-thread.ts";
import { useT } from "../../i18n/index.ts";
import { fileUrlOf } from "../api.ts";
import { IconLoader } from "../icons.tsx";
import type { TabComponentProps } from "../registry.ts";
import { isImagePath } from "../registry.ts";
import { MARKDOWN_PATH, MarkdownPreview } from "./MarkdownPreview.tsx";
import "./artifact-page.css";

/** 产物页的两段视图：产物本体 / 关于它的对话。 */
type ArtifactMode = "artifact" | "thread";

export function ArtifactTab(props: TabComponentProps): React.JSX.Element {
	const t = useT();
	const product = props.products?.find((item) => item.id === props.tab.productId);
	if (product === undefined) {
		return (
			<div className="owl-artifact-empty" role="status">
				<p>{t("artifact.unavailable")}</p>
			</div>
		);
	}
	return <ArtifactPage {...props} product={product} />;
}

function ArtifactPage({
	api,
	client,
	cwd,
	tab,
	product,
	onOpenFile,
	onToChat,
}: TabComponentProps & { product: Product }): React.JSX.Element {
	const t = useT();
	const [mode, setMode] = useState<ArtifactMode>("artifact");
	const [draft, setDraft] = useState("");
	const [dismissed, setDismissed] = useState<string | undefined>(undefined);
	const thread = useArtifactThread({ client, cwd, product });
	const scroller = useRef<HTMLDivElement>(null);

	// 贴底跟随（与 ChatStream 同规则）
	const stick = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current && mode === "thread") el.scrollTop = el.scrollHeight;
	}, [thread.entries, mode]);

	// 内联回执：最近一条回答。收起了就等下一条回答再露出来。
	const reply = useMemo(() => {
		for (let index = thread.entries.length - 1; index >= 0; index -= 1) {
			const entry = thread.entries[index]!;
			if (entry.kind === "assistant") return entry.text ?? "";
			if (entry.kind === "user") return "";
		}
		return "";
	}, [thread.entries]);
	const replyVisible = reply.trim() !== "" && dismissed !== reply;

	const send = (): void => {
		const text = draft.trim();
		if (text === "") return;
		setDraft("");
		setDismissed(undefined);
		stick.current = true;
		thread.send(text);
	};

	/** 把这一页的问答带回主对话，接着做。 */
	const openInChat = (): void => {
		if (onToChat === undefined) return;
		const question = [...thread.entries].reverse().find((entry) => entry.kind === "user")?.text ?? "";
		const answer = reply;
		if (question.trim() === "" && answer.trim() === "") return;
		onToChat(
			`${t("artifact.backToChatPrompt", { name: product.title })}\n\n问：${question.trim()}\n\n答：${answer.trim()}`,
		);
	};

	return (
		<div className="owl-artifact">
			{/* 头部：标题 + 视图切换 */}
			<header className="owl-artifact-header">
				<span className="owl-artifact-kind" data-kind={product.kind}>
					{productKindText(product, t)}
				</span>
				<span className="owl-artifact-title" title={product.path ?? product.title}>
					{product.title}
				</span>
				{product.path !== undefined && product.path !== product.title && (
					<span className="owl-artifact-path" title={product.path}>
						{product.path}
					</span>
				)}
				<div className="owl-artifact-modes" role="group" aria-label={t("artifact.modeAria")}>
					<button
						type="button"
						className={`owl-artifact-mode ${mode === "artifact" ? "is-active" : ""}`}
						aria-pressed={mode === "artifact"}
						onClick={() => setMode("artifact")}
					>
						{t("artifact.modeArtifact")}
					</button>
					<button
						type="button"
						className={`owl-artifact-mode ${mode === "thread" ? "is-active" : ""}`}
						aria-pressed={mode === "thread"}
						onClick={() => setMode("thread")}
					>
						{t("artifact.modeThread")}
					</button>
				</div>
			</header>

			{/* 主体 */}
			<div
				ref={scroller}
				className="owl-artifact-body"
				onWheel={(event) => {
					if (event.deltaY < 0) stick.current = false;
				}}
				onScroll={() => {
					const el = scroller.current;
					if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
				}}
			>
				{mode === "artifact" ? (
					<ArtifactPreview api={api} cwd={cwd} product={product} onOpenFile={onOpenFile} />
				) : (
					<ArtifactThread entries={thread.entries} running={thread.running} />
				)}
			</div>

			{/* 内联回执（Claude 的 "Claude's reply"） */}
			{mode === "artifact" && replyVisible && (
				<div className="owl-artifact-reply">
					<span className="owl-artifact-reply-label">{t("artifact.replyTitle")}</span>
					<p className="owl-artifact-reply-text">{trimReplyPreview(reply)}</p>
					<div className="owl-artifact-reply-actions">
						{onToChat !== undefined && (
							<button type="button" className="owl-artifact-reply-action" onClick={openInChat}>
								{t("artifact.openInChat")}
							</button>
						)}
						<button type="button" className="owl-artifact-reply-action" onClick={() => setDismissed(reply)}>
							{t("artifact.dismiss")}
						</button>
					</div>
				</div>
			)}

			{/* 页底 composer */}
			<div className="owl-artifact-composer">
				<textarea
					className="owl-artifact-input"
					rows={1}
					value={draft}
					disabled={!thread.attached}
					placeholder={thread.attached ? t("artifact.askPlaceholder") : t("artifact.restoring")}
					aria-label={t("artifact.askPlaceholder")}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
				/>
				{thread.running ? (
					<button
						type="button"
						className="owl-artifact-send is-running"
						title={t("composer.abort")}
						aria-label={t("composer.abort")}
						onClick={() => {
							const sid = thread.sessionId;
							if (sid === undefined) return;
							void client.request({ type: "session.abort", sessionId: sid });
						}}
					>
						<IconLoader size={12} className="animate-spin" />
					</button>
				) : (
					<button
						type="button"
						className="owl-artifact-send"
						title={t("composer.send")}
						aria-label={t("composer.send")}
						disabled={draft.trim() === "" || !thread.attached}
						onClick={send}
					>
						<svg
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
							className="h-3.5 w-3.5"
						>
							<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
						</svg>
					</button>
				)}
			</div>
		</div>
	);
}

/** 产物本体：可视化产物渲染 owl-ui 组件，文件产物按类型预览。 */
function ArtifactPreview({
	api,
	cwd,
	product,
	onOpenFile,
}: {
	api: TabComponentProps["api"];
	cwd: string;
	product: Product;
	onOpenFile?: (path: string) => void;
}): React.JSX.Element {
	const t = useT();
	if (product.kind !== "file") return <ArtifactVisual product={product} />;
	const path = product.path;
	if (path === undefined) return <p className="owl-artifact-note">{t("artifact.unavailable")}</p>;
	return <ArtifactFile api={api} cwd={cwd} path={path} onOpenFile={onOpenFile} />;
}

/** 可视化产物：把 owl-ui spec 渲染成大块的交互组件。 */
function ArtifactVisual({ product }: { product: Product }): React.JSX.Element {
	const t = useT();
	const { sessionId } = useGenuiSession();
	const rendered = useMemo(() => {
		if (product.spec === undefined) return undefined;
		const raw = JSON.stringify(product.spec);
		const context = { source: { id: product.toolId, order: [0, 0, 0] as const } };
		return { raw, context, spec: resolveGenuiSpec(raw, context) };
	}, [product.spec, product.toolId]);
	if (rendered === undefined) return <p className="owl-artifact-note">{t("artifact.unavailable")}</p>;
	if (rendered.spec === null) return <>{renderGenuiFence(rendered.raw, product.id, rendered.context)}</>;
	return (
		<ErrorBoundary key={sessionId === undefined ? product.id : `${sessionId}:${product.id}`}>
			<GenuiBlock
				spec={rendered.spec}
				stateKey={sessionId === undefined ? undefined : `${sessionId}:${product.id}`}
				animateEntrance={false}
			/>
		</ErrorBoundary>
	);
}

/** 文件产物：图片走二进制，其余走文本；二进制文件交给系统程序。 */
function ArtifactFile({
	api,
	cwd,
	path,
	onOpenFile,
}: {
	api: TabComponentProps["api"];
	cwd: string;
	path: string;
	onOpenFile?: (path: string) => void;
}): React.JSX.Element {
	const t = useT();
	const image = isImagePath(path);
	const markdown = MARKDOWN_PATH.test(path);
	const [text, setText] = useState<string | undefined>(undefined);
	const [binary, setBinary] = useState<{ mediaType: string; base64: string } | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		setText(undefined);
		setBinary(undefined);
		setError(undefined);
		const load = image
			? api.fsReadBin(cwd, path).then((result) => {
					if (!cancelled) setBinary({ mediaType: result.mediaType, base64: result.base64 });
				})
			: api.fsRead(cwd, path).then((result) => {
					if (!cancelled) {
						if (result.kind !== "text") setError(t("artifact.binary"));
						else setText(result.content);
					}
				});
		void load.catch((failure: unknown) => {
			if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
		});
		return () => {
			cancelled = true;
		};
	}, [api, cwd, path, image, t]);

	return (
		<div className="owl-artifact-file">
			{error !== undefined && (
				<p className="owl-artifact-note is-error" role="alert">
					{error}
				</p>
			)}
			{error === undefined && text === undefined && binary === undefined && (
				<p className="owl-artifact-note" role="status">
					{t("artifact.loading")}
				</p>
			)}
			{binary !== undefined && (
				<img className="owl-artifact-image" src={`data:${binary.mediaType};base64,${binary.base64}`} alt={path} />
			)}
			{text !== undefined &&
				(markdown ? (
					<MarkdownPreview content={text} path={path} cwd={cwd} onOpenFile={onOpenFile ?? (() => {})} />
				) : (
					<pre className="owl-artifact-text">{text}</pre>
				))}
			<div className="owl-artifact-file-actions">
				{onOpenFile !== undefined && (
					<button type="button" onClick={() => onOpenFile(path)}>
						{t("artifact.openInWorkbench")}
					</button>
				)}
				<button type="button" onClick={() => void api.openExternal("url", fileUrlOf(cwd, path)).catch(() => {})}>
					{t("artifact.openWithSystem")}
				</button>
			</div>
		</div>
	);
}

/** 对话线程：用户问 + 回答 + 工具行。 */
function ArtifactThread({
	entries,
	running,
}: {
	entries: import("../../hooks/transcript.ts").ChatEntry[];
	running: boolean;
}): React.JSX.Element {
	const t = useT();
	if (entries.length === 0 && !running) {
		return <p className="owl-artifact-note">{t("artifact.threadEmpty")}</p>;
	}
	return (
		<div className="owl-artifact-thread">
			{entries.map((entry, index) => {
				if (entry.kind === "user") {
					return (
						<div key={index} className="owl-artifact-turn is-user">
							<div className="owl-artifact-bubble">{artifactQuestionFrom(entry.text)}</div>
						</div>
					);
				}
				if (entry.kind === "assistant") {
					return (
						<div key={index} className="owl-artifact-turn">
							{entry.tools.map((tool) => (
								<div key={tool.id} className="owl-artifact-tool">
									{tool.status === "running" ? (
										<IconLoader size={9} className="animate-spin text-owl-accent" />
									) : tool.status === "error" ? (
										<span className="owl-artifact-tool-mark is-error">✗</span>
									) : (
										<span className="owl-artifact-tool-mark">✓</span>
									)}
									<span className="min-w-0 truncate">
										<InlineSummary text={tool.summary} />
									</span>
								</div>
							))}
							{entry.text !== undefined && entry.text !== "" && (
								<div
									className="owl-artifact-answer"
									dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }}
								/>
							)}
						</div>
					);
				}
				return (
					<div key={index} className="owl-artifact-turn">
						<span className={entry.ok ? "owl-artifact-tool-mark" : "owl-artifact-tool-mark is-error"}>
							{entry.ok ? "✓" : "✗"}
						</span>{" "}
						<span className="font-mono">{entry.toolName}</span>
					</div>
				);
			})}
			{running && (
				<div className="owl-artifact-tool">
					<IconLoader size={9} className="animate-spin text-owl-accent" />
					{t("artifact.thinking")}
				</div>
			)}
		</div>
	);
}
