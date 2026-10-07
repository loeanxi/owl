import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { ApprovalMode } from "../../bridge/protocol.ts";
import { MyselfChatController, type MyselfChatState } from "../myself/myself-chat-controller.ts";
import {
	baguScorePrompt,
	evaluateBagu,
	extractScore,
	fetchBaguAnswer,
	fetchBaguCategories,
	fetchBaguQuestions,
	seedCategories,
	seedQuestions,
	stripScoreLine,
	type BaguCategory,
	type BaguFeedback,
	type BaguQuestion,
} from "./bagu-api.ts";
import { baguPrimer, baguWorkspaceDir, ensureBaguDir, logBaguChatLine } from "./bagu-data.ts";
import { useT, type TextKey } from "../../i18n/index.ts";
import "./bagu.css";

type Scene = "campus" | "social" | "topic";
const SCENE_KEY: Record<Scene, TextKey> = { campus: "bagu.scene.campus", social: "bagu.scene.social", topic: "bagu.scene.topic" };
/** 评分/人设提示词里用的场景词（提示词固定中文，不随界面语言走）。 */
const SCENE_LABEL_ZH: Record<Scene, string> = { campus: "校招一面", social: "社招二面", topic: "专题突破" };

/** 面试线程的一条内容：本地拼装，与 agent 转录分开存。 */
type ThreadItem =
	| { kind: "note"; text: string }
	| { kind: "ask"; no: number; question: BaguQuestion }
	| { kind: "answer"; text: string }
	| { kind: "feedback"; fb: BaguFeedback }
	| { kind: "userAsk"; text: string }
	| { kind: "agentReply"; id: number; text: string };

const noopSubscribe = (): (() => void) => () => {};
const EMPTY_CHAT: MyselfChatState = { model: "", thinkingLevel: "", approvalMode: "confirm", entries: [], running: false, busy: false, ready: false, connected: false, retryStatus: null };

/** 最近一条 assistant 文案（user 之后的；没有就是空串）。 */
function lastAssistantText(entries: MyselfChatState["entries"]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.kind === "user") break;
		if (entry.kind === "assistant" && entry.text.trim()) return entry.text;
	}
	return "";
}

/** 面试官头像（AGENTS.md：代码里不使用 emoji，头像一律 SVG）。 */
const OWL_AVATAR = (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M12 21c-4.4 0-7-2.7-7-6.5C5 10 8 7 12 7s7 3 7 7.5c0 3.8-2.6 6.5-7 6.5Z" />
		<circle cx="9.3" cy="13" r="1.15" fill="currentColor" stroke="none" />
		<circle cx="14.7" cy="13" r="1.15" fill="currentColor" stroke="none" />
		<path d="M9.8 16.6c1.4 1 3 1 4.4 0" />
		<path d="m7.5 3.5 2.3 2.4M16.5 3.5l-2.3 2.4" />
	</svg>
);
const ME_AVATAR = (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<circle cx="12" cy="8" r="3.6" />
		<path d="M5 20.5c1.3-3.8 4-5.7 7-5.7s5.7 1.9 7 5.7" />
	</svg>
);

function Stars({ value }: { value?: number }): React.JSX.Element | null {
	if (value === undefined || value === null) return null;
	const level = Math.max(0, Math.min(value, 5));
	return <span className="owl-bagu-stars">{"★".repeat(level)}{"☆".repeat(5 - level)}</span>;
}

/**
 * 「八股对练」：左侧 bagu 题库范围/场景/队列，右侧 AI 面试官对话流。
 * 出题走 bagu（未启动时用内置种子题），在线评分走 bagu /api/quiz/evaluate，
 * 离线评分与「反问面试官」走面试官 agent 会话。
 *
 * 会话与「我的助理」「专家顾问」同一套存储方式（MyselfChatController）：
 * cwd 绑定 owl-bagu 数据目录（interviewer.md 人格 + memory.md 薄弱本 + 每天一个
 * 对练 md，见 bagu-data.ts），sessionId 按目录持久化、重开应用 session.resume 回放；
 * 评分与反问共用这一条会话——面试官本来就该记得本场问过什么。
 */
export function BaguPage({ active, client, connected, defaultModel, defaultThinkingLevel, defaultApprovalMode }: {
	active: boolean;
	client: BridgeClient;
	/** 桥连接状态：目录落盘、反问与离线评分的可用地。 */
	connected: boolean;
	/** 主对话当前默认值：会话新开时从这里起步。 */
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
}): React.JSX.Element {
	const t = useT();
	const [categories, setCategories] = useState<BaguCategory[]>(() => seedCategories());
	const [scope, setScope] = useState("all");
	const [queue, setQueue] = useState<BaguQuestion[]>([]);
	const [scores, setScores] = useState<Record<number, number>>({});
	const [cursor, setCursor] = useState(-1);
	const [thread, setThread] = useState<ThreadItem[]>([]);
	const [mode, setMode] = useState<"answer" | "ask">("answer");
	const [scene, setScene] = useState<Scene>("campus");
	const [baguOnline, setBaguOnline] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);
	const [draft, setDraft] = useState("");
	const [evaluating, setEvaluating] = useState(false);
	const [retroOpen, setRetroOpen] = useState(false);
	// 数据目录：连接后 ensure（写会递归建目录），就绪后才建会话控制器（专家面板同款）。
	const [dirState, setDirState] = useState<{ status: "preparing" } | { status: "ready"; dir: string }>({ status: "preparing" });
	const [primerText, setPrimerText] = useState<string>();
	const threadRef = useRef<HTMLDivElement>(null);
	const startedRef = useRef(false);
	const askSeq = useRef(0);
	const scoresRef = useRef(scores);
	scoresRef.current = scores;
	const queueRef = useRef(queue);
	queueRef.current = queue;
	const sceneRef = useRef(scene);
	sceneRef.current = scene;
	const defaultsRef = useRef({ model: defaultModel, thinkingLevel: defaultThinkingLevel, approvalMode: defaultApprovalMode });
	defaultsRef.current = { model: defaultModel, thinkingLevel: defaultThinkingLevel, approvalMode: defaultApprovalMode };
	/** 等本轮 agent_settled 的取件人：反问/评分共用一条会话，靠它拿最终文案。 */
	const settledWaiter = useRef<{ resolve: (text: string | null) => void } | null>(null);

	// -- 数据目录 + primer：连接后准备一次（ensureExpertDir 同款） ------------------
	useEffect(() => {
		if (!connected || dirState.status !== "preparing") return;
		let cancelled = false;
		void (async () => {
			const dir = baguWorkspaceDir();
			try {
				const { interviewer, memory } = await ensureBaguDir(client, dir);
				if (cancelled) return;
				setPrimerText(baguPrimer(interviewer, memory, SCENE_LABEL_ZH[sceneRef.current], dir));
				setDirState({ status: "ready", dir });
			} catch {
				// 目录落盘失败（桥抖动等）：先用内置人格开局，重连后会再补一次 ensure。
				if (!cancelled) setPrimerText(baguPrimer(EMPTY_INTERVIEWER, "", SCENE_LABEL_ZH[sceneRef.current], dir));
			}
		})();
		return () => { cancelled = true; };
	}, [connected, dirState.status]);

	// -- 面试官会话：与助理/专家同一个控制器，cwd 绑 owl-bagu 目录 ------------------
	const dir = dirState.status === "ready" ? dirState.dir : undefined;
	const chatController = useMemo(() => {
		if (!dir || primerText === undefined) return undefined;
		return new MyselfChatController(
			client,
			localStorage,
			dir,
			{ model: defaultsRef.current.model, thinkingLevel: defaultsRef.current.thinkingLevel, approvalMode: defaultsRef.current.approvalMode },
			() => primerText,
			{
				// 每轮 settled：反问/评分正在等最终文案就交给它（不落盘——落盘在各自流程里做）。
				onSettled: (entries) => {
					const waiter = settledWaiter.current;
					if (waiter) {
						settledWaiter.current = null;
						waiter.resolve(lastAssistantText(entries));
					}
				},
			},
		);
	}, [client, dir, primerText]);
	const chat = useSyncExternalStore(chatController?.subscribe ?? noopSubscribe, chatController?.getSnapshot ?? (() => EMPTY_CHAT));

	useEffect(() => {
		if (!chatController) return;
		chatController.start();
		return () => chatController.dispose();
	}, [chatController]);
	useEffect(() => {
		chatController?.setConnected(connected);
		if (active && connected) void chatController?.attach();
	}, [chatController, connected, active]);

	// -- 题库载入：bagu 在线用远端（空分类就如实显示为空），未启动才落种子题 --------
	const loadBank = useCallback(async (): Promise<void> => {
		setLoading(true);
		let cats = seedCategories();
		let online = false;
		try {
			const remote = await fetchBaguCategories();
			if (remote.length > 0) {
				cats = remote;
				online = true;
			}
		} catch { /* bagu 未启动：走内置题库 */ }
		setBaguOnline(online);
		let list: BaguQuestion[] = [];
		if (online) {
			const scoped = scope === "all" ? cats : cats.filter((category) => category.key === scope);
			try {
				const groups = await Promise.all(
					scoped.filter((category) => category.baguId !== undefined).map((category) => fetchBaguQuestions(category.baguId!)),
				);
				list = groups.flat();
			} catch {
				setBaguOnline(false);
				online = false;
			}
		}
		if (!online) list = seedQuestions().filter((question) => scope === "all" || question.categoryKey === scope);
		setCategories(online ? cats : seedCategories());
		setQueue(list);
		const empty: Record<number, number> = {};
		setScores(empty);
		scoresRef.current = empty;
		setLoading(false);
	}, [scope]);
	useEffect(() => { void loadBank(); }, [loadBank]);

	const askQuestion = useCallback((index: number): void => {
		const question = queueRef.current[index];
		if (!question) return;
		setCursor(index);
		setThread((current) => [...current, { kind: "ask", no: index + 1, question }]);
	}, []);

	const applyScore = useCallback((index: number, score: number): void => {
		const next = { ...scoresRef.current, [index]: score };
		scoresRef.current = next;
		setScores(next);
	}, []);

	/** from 起第一道未作答的题；刷完返回队列长度。 */
	const nextUnanswered = useCallback((from: number): number => {
		let index = from;
		while (index < queueRef.current.length && scoresRef.current[index] !== undefined) index++;
		return index;
	}, []);

	// 队列就绪（首次 / 换范围 / 重新同步）后从第一题开讲。
	useEffect(() => {
		if (loading || queue.length === 0) return;
		const first = !startedRef.current;
		startedRef.current = true;
		if (first) setThread((current) => [...current, { kind: "note", text: t("bagu.intro") }]);
		askQuestion(0);
	}, [queue, loading, askQuestion, t]);

	/**
	 * 发一条提示词并等本轮 agent_settled，返回面试官最终文案；发不出去（桥离线/
	 * 上一轮还在跑）或超时返回 null。评分与反问共用，靠 settledWaiter 取件。
	 */
	const sendAwait = useCallback((text: string): Promise<string | null> => {
		return new Promise((resolve) => {
			if (!chatController || chatController.getSnapshot().busy || chatController.getSnapshot().running) {
				resolve(null);
				return;
			}
			const timer = window.setTimeout(() => {
				if (settledWaiter.current?.resolve === resolve) settledWaiter.current = null;
				resolve(null);
			}, 180_000);
			settledWaiter.current = {
				resolve: (value) => {
					window.clearTimeout(timer);
					resolve(value);
				},
			};
			void chatController.send(text).then((sent) => {
				if (!sent && settledWaiter.current?.resolve === resolve) {
					window.clearTimeout(timer);
					settledWaiter.current = null;
					resolve(null);
				}
			});
		});
	}, [chatController]);

	// -- 评分：bagu 在线走 /api/quiz/evaluate，否则面试官会话兜底；失败不记分 --------
	const scoreAnswer = useCallback(async (question: BaguQuestion, text: string): Promise<BaguFeedback | null> => {
		if (baguOnline && question.baguId !== undefined) {
			try {
				const result = await evaluateBagu(question.baguId, text);
				const prose = stripScoreLine(result.feedback);
				return {
					score: result.score ?? extractScore(result.feedback) ?? 0,
					prose: prose || result.standardAnswer || "—",
					source: "bagu",
				};
			} catch {
				setBaguOnline(false); // 评分途中 bagu 掉线：本题落到面试官会话
			}
		}
		const reply = await sendAwait(baguScorePrompt(SCENE_LABEL_ZH[sceneRef.current], question, text));
		return reply?.trim()
			? { score: extractScore(reply) ?? 0, prose: stripScoreLine(reply), source: "agent" }
			: null;
	}, [baguOnline, sendAwait]);

	const submitAnswer = useCallback(async (): Promise<void> => {
		const index = cursor;
		const question = queueRef.current[index];
		const text = draft.trim();
		if (!question || !text || evaluating || chat.running || chat.busy) return;
		setDraft("");
		setEvaluating(true);
		setThread((current) => [...current, { kind: "answer", text }]);
		const feedback = await scoreAnswer(question, text);
		if (feedback) {
			setThread((current) => [...current, { kind: "feedback", fb: feedback }]);
			applyScore(index, feedback.score);
			if (dir) void logBaguChatLine(client, dir, "老周", `第 ${index + 1} 题「${question.title}」评分 ${feedback.score} —— ${feedback.prose}`).catch(() => {});
		} else {
			setThread((current) => [...current, {
				kind: "feedback",
				fb: { score: -1, prose: t("bagu.evalFailed", { message: chatController?.getSnapshot().error ?? "offline" }), source: "agent" },
			}]);
		}
		setEvaluating(false);
		const next = nextUnanswered(index + 1);
		if (next < queueRef.current.length) window.setTimeout(() => askQuestion(next), 500);
		else setThread((current) => [...current, { kind: "note", text: t("bagu.done") }]);
	}, [cursor, draft, evaluating, chat.running, chat.busy, scoreAnswer, applyScore, nextUnanswered, askQuestion, t, dir, client, chatController]);

	const skipCurrent = useCallback((): void => {
		if (cursor < 0 || evaluating) return;
		setThread((current) => [...current, { kind: "note", text: t("bagu.skipped") }]);
		const next = nextUnanswered(cursor + 1);
		if (next < queueRef.current.length) askQuestion(next);
		else setThread((current) => [...current, { kind: "note", text: t("bagu.done") }]);
	}, [cursor, evaluating, nextUnanswered, askQuestion, t]);

	// -- 反问面试官：一条 agentReply 气泡，settled 后回填最终文案并落盘 --------------
	const askAgent = useCallback(async (question: string): Promise<void> => {
		if (!connected || !dir || !chatController) {
			// 桥未连接：被拒的提问不上屏（不计入反问次数），只给提示。
			setThread((current) => [...current, { kind: "note", text: t("bagu.agentOffline") }]);
			return;
		}
		const id = ++askSeq.current;
		setThread((current) => [...current, { kind: "userAsk", text: question }, { kind: "agentReply", id, text: "" }]);
		void logBaguChatLine(client, dir, "我", question).catch(() => {});
		const reply = await sendAwait(question);
		const finalText = reply?.trim() || t("bagu.askFailed", { message: chatController.getSnapshot().error ?? "unknown" });
		setThread((current) => current.map((item) => (
			item.kind === "agentReply" && item.id === id ? { ...item, text: finalText } : item
		)));
		if (reply?.trim()) void logBaguChatLine(client, dir, "老周", reply.trim()).catch(() => {});
	}, [connected, dir, chatController, sendAwait, t, client]);

	const send = (): void => {
		const text = draft.trim();
		if (!text || evaluating || chat.running || chat.busy) return;
		if (mode === "answer") void submitAnswer();
		else {
			setDraft("");
			void askAgent(text);
		}
	};

	// 线程有动静就贴底（新消息、agent 流式更新都算）。
	useEffect(() => {
		const element = threadRef.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [thread, chat.entries, chat.running]);

	// -- 复盘统计（纯内存，基于本场成功评分的作答） --------------------------------
	const done = Object.keys(scores).length;
	const answered = Object.entries(scores).map(([index, score]) => ({ no: Number(index) + 1, score, title: queue[Number(index)]?.title ?? "" }));
	const avg = answered.length > 0 ? Math.round(answered.reduce((sum, item) => sum + item.score, 0) / answered.length) : 0;
	const asks = thread.filter((item) => item.kind === "userAsk").length;
	const weak = answered.filter((item) => item.score < 80);
	const busy = evaluating || chat.running || chat.busy;
	const lastThreadId = thread.length > 0 ? thread.length - 1 : -1;
	const liveText = chat.running ? lastAssistantText(chat.entries) : "";

	const dirReady = dirState.status === "ready";
	const status = !dirReady || loading ? "loading" : baguOnline ? "online" : "offline";

	const openRetro = (): void => {
		setRetroOpen(true);
		if (answered.length > 0 && dir) {
			void logBaguChatLine(client, dir, "复盘", `完成 ${answered.length} 题 · 均分 ${avg} · 反问 ${asks} 次${weak.length > 0 ? ` · 薄弱:${weak.map((item) => item.title).join("、")}` : ""}`).catch(() => {});
		}
	};

	return (
		<div className="owl-bagu">
			<header className="owl-bagu-head">
				<span className="owl-bagu-avatar" aria-hidden="true">{OWL_AVATAR}</span>
				<h1>{t("bagu.title")}</h1>
				<span className="owl-bagu-dir">{t("bagu.subtitle")} · {t("bagu.apiLabel")}</span>
				<span className="owl-bagu-sync" data-status={status}>
					{!dirReady ? t("bagu.preparing") : loading ? t("bagu.loading") : baguOnline ? t("bagu.online") : t("bagu.offline")}
					<button type="button" disabled={loading || !dirReady} onClick={() => { void loadBank(); }}>{t("bagu.resync")}</button>
					<button type="button" onClick={openRetro}>{t("bagu.finish")}</button>
				</span>
			</header>
			<div className="owl-bagu-body">
				<aside className="owl-bagu-side">
					<section className="owl-bagu-panel">
						<h4>{t("bagu.scope")}</h4>
						<div className="owl-bagu-chips">
							<button type="button" className={`owl-bagu-chip${scope === "all" ? " is-on" : ""}`} onClick={() => setScope("all")}>{t("bagu.all")}</button>
							{categories.map((category) => (
								<button key={category.key} type="button" className={`owl-bagu-chip${scope === category.key ? " is-on" : ""}`} onClick={() => setScope(category.key)}>{category.name}</button>
							))}
						</div>
					</section>
					<section className="owl-bagu-panel">
						<h4>{t("bagu.scene")}</h4>
						<div className="owl-bagu-chips">
							{(Object.keys(SCENE_KEY) as Scene[]).map((key) => (
								<button key={key} type="button" className={`owl-bagu-chip${scene === key ? " is-on" : ""}`} onClick={() => setScene(key)}>{t(SCENE_KEY[key])}</button>
							))}
						</div>
					</section>
					<section className="owl-bagu-panel">
						<h4>{t("bagu.queue")}<b>{t("bagu.queueCount", { done, total: queue.length })}</b></h4>
						{queue.length === 0
							? <p className="owl-bagu-empty">{t("bagu.queueEmpty")}</p>
							: (
								<ol className="owl-bagu-queue">
									{queue.map((question, index) => {
										const score = scores[index];
										return (
											<li key={question.baguId ?? `${question.categoryKey}-${index}`}>
												<button type="button" className={`owl-bagu-queue-item${index === cursor ? " is-current" : ""}${score !== undefined ? " is-done" : ""}`} onClick={() => askQuestion(index)}>
													<span className="owl-bagu-queue-no">{score !== undefined ? "✓" : index + 1}</span>
													<span className="owl-bagu-queue-title">{question.title}</span>
													{score !== undefined && <span className="owl-bagu-queue-score">{t("bagu.scoreShort", { score })}</span>}
												</button>
											</li>
										);
									})}
								</ol>
							)}
					</section>
					<section className="owl-bagu-panel">
						<p className="owl-bagu-linknote">{t("bagu.linkNote")}</p>
					</section>
				</aside>
				<section className="owl-bagu-chat">
					<div className="owl-bagu-chat-head">
						<span className="owl-bagu-tag">AI</span>
						<div>
							<div className="owl-bagu-chat-title">{t("bagu.interviewer")}</div>
							<div className="owl-bagu-chat-sub">{cursor >= 0 ? t("bagu.round", { n: cursor + 1 }) : ""}</div>
						</div>
					</div>
					<div className="owl-bagu-thread" ref={threadRef}>
						{thread.map((item, index) => {
							if (item.kind === "note") return <div key={index} className="owl-bagu-note">{item.text}</div>;
							if (item.kind === "ask") {
								const categoryName = item.question.category ?? categories.find((category) => category.key === item.question.categoryKey)?.name;
								return (
									<div key={index} className="owl-bagu-row">
										<span className="owl-bagu-row-avatar" aria-hidden="true">{OWL_AVATAR}</span>
										<div className="owl-bagu-qcard">
											<div className="owl-bagu-qcard-tags">
												<span className="owl-bagu-qcard-no">{t("bagu.round", { n: item.no })}</span>
												{categoryName && <span className="owl-bagu-tag">{categoryName}</span>}
												<Stars value={item.question.difficulty} />
											</div>
											<div className="owl-bagu-qcard-title">{item.question.title}</div>
											<PeekAnswer
												question={item.question}
												showLabel={t("bagu.peekShow")}
												hideLabel={t("bagu.peekHide")}
												emptyLabel="—"
											/>
										</div>
									</div>
								);
							}
							if (item.kind === "answer" || item.kind === "userAsk") {
								return (
									<div key={index} className="owl-bagu-row is-me">
										<span className="owl-bagu-row-avatar" aria-hidden="true">{ME_AVATAR}</span>
										<div className="owl-bagu-row-body">
											<div className="owl-bagu-row-meta">{item.kind === "answer" ? t("bagu.answerMode") : t("bagu.askMode")}</div>
											<div className="owl-bagu-bubble">{item.text}</div>
										</div>
									</div>
								);
							}
							if (item.kind === "feedback") {
								return (
									<div key={index} className="owl-bagu-row">
										<span className="owl-bagu-row-avatar" aria-hidden="true">{OWL_AVATAR}</span>
										<div className="owl-bagu-fcard">
											<div className="owl-bagu-fcard-head">
												<span className="owl-bagu-score-pill">{item.fb.score >= 0 ? item.fb.score : "—"}</span>
												<span className="owl-bagu-tag">{t("bagu.feedbackTag")}</span>
												<span className="owl-bagu-fcard-src">{t(item.fb.source === "bagu" ? "bagu.source.bagu" : "bagu.source.agent")}</span>
											</div>
											<div className="owl-bagu-fcard-prose">{item.fb.prose}</div>
										</div>
									</div>
								);
							}
							// agentReply：空文案时显示打字指示 / 流式实时文案
							const isLive = index === lastThreadId && chat.running;
							return (
								<div key={index} className="owl-bagu-row">
									<span className="owl-bagu-row-avatar" aria-hidden="true">{OWL_AVATAR}</span>
									<div className="owl-bagu-bubble">
										{item.text
											? item.text
											: isLive
												? (liveText || (
													<span className="owl-bagu-typing"><i /><i /><i />{t("bagu.thinking")}</span>
												))
												: "…"}
									</div>
								</div>
							);
						})}
					</div>
					<div className="owl-bagu-composer">
						<div className="owl-bagu-modes">
							<button type="button" className={`owl-bagu-mode-btn${mode === "answer" ? " is-on" : ""}`} onClick={() => setMode("answer")}>{t("bagu.answerMode")}</button>
							<button type="button" className={`owl-bagu-mode-btn${mode === "ask" ? " is-on" : ""}`} onClick={() => setMode("ask")}>{t("bagu.askMode")}</button>
							<span className="owl-bagu-mode-hint">{t(mode === "answer" ? "bagu.hintEnterShift" : "bagu.hintEnter")}</span>
						</div>
						<div className="owl-bagu-inputrow">
							<textarea
								className="owl-bagu-input"
								value={draft}
								placeholder={t(mode === "answer" ? "bagu.answerPlaceholder" : "bagu.askPlaceholder")}
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										send();
									}
								}}
							/>
							{mode === "answer" && <button type="button" className="owl-bagu-btn" disabled={busy || cursor < 0} onClick={skipCurrent}>{t("bagu.skip")}</button>}
							<button type="button" className="owl-bagu-btn is-primary" disabled={!draft.trim() || busy} onClick={send}>{t("bagu.send")}</button>
						</div>
					</div>
				</section>
			</div>
			{retroOpen && (
				<div className="owl-bagu-overlay" onClick={(event) => { if (event.target === event.currentTarget) setRetroOpen(false); }}>
					<div className="owl-bagu-retro" role="dialog" aria-label={t("bagu.retro.title")}>
						<h2>{t("bagu.retro.title")}</h2>
						<div className="owl-bagu-retro-sub">{t("bagu.interviewer")} · {t(SCENE_KEY[scene])}</div>
						<div className="owl-bagu-retro-stats">
							<div className="owl-bagu-retro-stat"><b>{answered.length}</b><span>{t("bagu.retro.answered")}</span></div>
							<div className="owl-bagu-retro-stat"><b>{avg}</b><span>{t("bagu.retro.avg")}</span></div>
							<div className="owl-bagu-retro-stat"><b>{asks}</b><span>{t("bagu.retro.asks")}</span></div>
						</div>
						{weak.length > 0
							? (
								<div className="owl-bagu-retro-weak">
									<b>{t("bagu.retro.weak")}</b><br />
									{weak.map((item) => t("bagu.retro.weakItem", { no: item.no, score: item.score, title: item.title })).join("；")}
								</div>
							)
							: <div className="owl-bagu-retro-weak">{t("bagu.retro.clean")}</div>}
						<div className="owl-bagu-retro-actions">
							<button type="button" className="owl-bagu-btn" onClick={() => setRetroOpen(false)}>{t("bagu.close")}</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

/** 参考答案折叠块：面试场景默认收起；bagu 在线题没有现成答案，展开时按需拉取。 */
function PeekAnswer({ question, showLabel, hideLabel, emptyLabel }: {
	question: BaguQuestion;
	showLabel: string;
	hideLabel: string;
	emptyLabel: string;
}): React.JSX.Element | null {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState<string | undefined>(question.answer);
	const [loading, setLoading] = useState(false);
	if (!question.answer && question.baguId === undefined) return null;
	const toggle = (): void => {
		if (!open && text === undefined && question.baguId !== undefined && !loading) {
			setLoading(true);
			void fetchBaguAnswer(question.baguId)
				.then((result) => setText(result.standardAnswer?.trim() || emptyLabel))
				.catch(() => setText(emptyLabel))
				.finally(() => setLoading(false));
		}
		setOpen((current) => !current);
	};
	return (
		<>
			<button type="button" className="owl-bagu-peek" onClick={toggle}>{open ? hideLabel : showLabel}</button>
			{open && <div className="owl-bagu-standard">{loading && text === undefined ? "…" : text ?? emptyLabel}</div>}
		</>
	);
}

/** 目录还没就绪时的占位人格（正常流程 ensureBaguDir 会先落盘真实文件）。 */
const EMPTY_INTERVIEWER = "# 老周 · Java 后端面试官\n\n十年 Java 后端研发与面试经验,像同事聊天一样面试,但眼里不揉沙子。\n";
