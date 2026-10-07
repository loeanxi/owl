import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../../bridge/client.ts";
import type { SettingsInitialTab } from "../../components/SettingsPage.tsx";
import type { ApprovalMode, CommandsListResult, FsSearchHit, ProviderModelsMessage, SlashCommandEntry } from "../../bridge/protocol.ts";
import { ChatStream } from "../../components/ChatStream.tsx";
import { Composer, type ComposerImage } from "../../components/Composer.tsx";
import { ContextView } from "../../components/ContextView.tsx";
import type { ConversationView } from "../../components/ConversationHeader.tsx";
import { GenuiSessionProvider } from "../../components/Genui.tsx";
import { RetryPin } from "../../components/RetryPin.tsx";
import { TrajectoryView } from "../trajectory/TrajectoryView.tsx";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { MyselfChatController, type MyselfChatState } from "../myself/myself-chat-controller.ts";
import {
	createCustomExpert,
	createExpertGroup,
	divisionLabel,
	ensureExpertDir,
	ensureGroupDir,
	expertBySlug,
	expertDir,
	expertFileStatus,
	expertGroupDir,
	expertGroupPrimer,
	expertPrimer,
	exportAgentfile,
	DIVISION_LABELS,
	DIVISION_ORDER,
	EXPERT_DIVISIONS,
	EXPERT_ROSTER,
	EXPERT_SCENARIOS,
	EXPERT_TEAMS,
	getExpertScope,
	importAgentfile,
	listCatalogExperts,
	listCustomExperts,
	listExpertGroups,
	logExpertChatLine,
	type ExpertFileStatus,
	type ExpertGroup,
	type ExpertPersona,
	type ExpertScope,
	readExpertMemory,
	readGroupMemory,
	setExpertScope,
	updateExpertGroup,
} from "./expert-data.ts";
import "./expert.css";

type ChatTarget = { kind: "expert"; slug: string } | { kind: "group"; id: string; name: string; memberSlugs?: string[]; memory?: "shared" | "own" };

const EMPTY_CHAT: MyselfChatState = { model: "", thinkingLevel: "", approvalMode: "confirm", entries: [], running: false, busy: false, ready: false, connected: false, retryStatus: null };
const noopSubscribe = (): (() => void) => () => {};

function hhmm(): string {
	const at = new Date();
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 头像：姓氏首字 + 部门渐变（与原型一致；无图片资源依赖）。 */
function ExpertAvatar({ expert, size = 34 }: { expert: ExpertPersona; size?: number }): React.JSX.Element {
	return (
		<span
			className="owl-expert-avatar"
			style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: `linear-gradient(135deg, ${expert.color[0]}, ${expert.color[1]})` }}
			aria-hidden="true"
		>
			{expert.name.slice(0, 1)}
		</span>
	);
}

function GroupAvatar({ size = 34 }: { size?: number }): React.JSX.Element {
	return (
		<span className="owl-expert-avatar is-group" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
			</svg>
		</span>
	);
}

function memoryLineCount(memory: string): number {
	return memory.split(/\r?\n/).filter((line) => {
		const text = line.trim();
		return text !== "" && !text.startsWith("#") && !text.startsWith(">");
	}).length;
}

/**
 * 「专家顾问」面板：数据落 owl-expert/（人格档案 + 记忆 + 每天一个会话 markdown，
 * 模式与助理 owl-myself 一致）。三个 tab：
 * 「专家」= 目录/市场（精选场景 + 部门筛选 + 卡墙 + 人格档案抽屉 + 创建专家）；
 * 「专家团」= 预设团卡片（开群聊 / 开始会诊）+ 我的群；
 * 「会话」= 复用 owl 对话区全套（ChatStream/Composer/上下文/轨迹），1:1 与群聊；
 * 「管理」= 启用范围 + 档案状态 + Agentfile 导入导出。
 */
export function ExpertPanel({ active, client, connected, providers, defaultModel, defaultThinkingLevel, defaultApprovalMode, onOpenSettings }: {
	active: boolean;
	client: BridgeClient;
	connected: boolean;
	providers: ProviderModelsMessage[];
	defaultModel: string;
	defaultThinkingLevel: string;
	defaultApprovalMode: ApprovalMode;
	onOpenSettings?: (tab: SettingsInitialTab) => void;
}): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [tab, setTab] = useState<"market" | "teams" | "chat" | "manage">("market");
	const [division, setDivision] = useState<string>("all");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<"feat" | "name">("feat");
	const [drawerSlug, setDrawerSlug] = useState<string>();
	const [target, setTarget] = useState<ChatTarget>();
	/** 专家目录就绪载荷（persona.md 落盘结果 + memory.md 内容），控制器等它好了再建。 */
	const [expertLoad, setExpertLoad] = useState<{ seeded: boolean; memory: string }>();
	const [memoryView, setMemoryView] = useState<{ title: string; lines: string[]; file: string }>();
	const [groups, setGroups] = useState<ExpertGroup[]>([]);
	const [customs, setCustoms] = useState<ExpertPersona[]>([]);
	const [catalogList, setCatalogList] = useState<ExpertPersona[]>([]);
	const [statuses, setStatuses] = useState<Record<string, ExpertFileStatus>>({});
	const [scopeRev, setScopeRev] = useState(0);
	const [groupModal, setGroupModal] = useState<{ mode: "create" | "manage"; group?: ExpertGroup; pre?: string[] }>();
	const [groupPick, setGroupPick] = useState<string[]>([]);
	const [groupName, setGroupName] = useState("");
	const [groupMemory, setGroupMemory] = useState<"shared" | "own">("shared");
	const [joinPick, setJoinPick] = useState<string>();
	const [createModal, setCreateModal] = useState(false);
	const [chatView, setChatView] = useState<ConversationView>("chat");
	const [commands, setCommands] = useState<SlashCommandEntry[]>([]);
	const [draftRequest, setDraftRequest] = useState<{ id: number; text: string; replace?: boolean }>();
	const [composerKey, setComposerKey] = useState(0);
	const [atPop, setAtPop] = useState(false);
	const startedRef = useRef(false);

	const catalog = useMemo(() => [...EXPERT_ROSTER, ...catalogList, ...customs], [catalogList, customs]);
	const bySlug = useCallback((slug: string) => catalog.find((expert) => expert.slug === slug), [catalog]);

	// -- 目录：激活时拉一次专家群 + 自定义专家清单 --------------------------------
	const refreshGroups = useCallback(async (): Promise<void> => {
		try { setGroups(await listExpertGroups(client)); } catch { /* 桥未连或目录未建。 */ }
	}, [client]);
	useEffect(() => {
		if (!active || !connected || startedRef.current) return;
		startedRef.current = true;
		void refreshGroups();
		void listCatalogExperts(client).then(setCatalogList).catch(() => {});
		void listCustomExperts(client).then(setCustoms).catch(() => {});
	}, [active, connected, client, refreshGroups]);

	// -- 目标切换：专家 → ensure 目录（persona/memory 落盘）后建控制器；群 → 读共享记忆 ----
	const persona = target?.kind === "expert" ? bySlug(target.slug) : undefined;
	const groupMeta = useMemo(() => {
		if (target?.kind !== "group") return undefined;
		return groups.find((item) => item.id === target.id)
			?? { id: target.id, name: target.name, memberSlugs: target.memberSlugs ?? [], memory: target.memory ?? "shared" as const };
	}, [target, groups]);
	const cwd = !target ? undefined : target.kind === "expert" ? expertDir(target.slug) : expertGroupDir(target.id);

	const langRef = useRef(lang);
	langRef.current = lang;
	const [primerText, setPrimerText] = useState<string>();
	useEffect(() => {
		if (!target || !connected) return;
		let cancelled = false;
		setExpertLoad(undefined);
		setPrimerText(undefined);
		if (target.kind === "expert") {
			const p = bySlug(target.slug);
			if (!p) return;
			void ensureExpertDir(client, p).then(async (load) => {
				if (cancelled) return;
				setExpertLoad(load);
				setPrimerText(await expertPrimer(client, p));
			}).catch(() => {});
		} else {
			const members = (groupMeta?.memberSlugs ?? []).map(bySlug).filter((p): p is ExpertPersona => Boolean(p));
			setExpertLoad({ seeded: false, memory: "" });
			setPrimerText(expertGroupPrimer(groupMeta ?? { id: target.id, name: target.name, memberSlugs: members.map((m) => m.slug), memory: "shared" }, members));
			// 群目录必须先落盘（会话 cwd 指向它），临时团也走这里。
			void ensureGroupDir(client, target.id, groupMeta?.memory ?? "shared").catch(() => {});
			void readGroupMemory(client, groupMeta ?? { id: target.id, name: target.name, memberSlugs: [], memory: "shared" }).then((memory) => { if (!cancelled) setExpertLoad({ seeded: false, memory }); }).catch(() => {});
		}
		return () => { cancelled = true; };
	}, [target, connected, groupMeta, client, bySlug]);

	const chatController = useMemo(() => {
		if (!cwd || !target || primerText === undefined) return undefined;
		const who = target.kind === "expert" ? bySlug(target.slug)?.name ?? "专家" : target.name;
		return new MyselfChatController(
			client,
			localStorage,
			cwd,
			{ model: defaultModel, thinkingLevel: defaultThinkingLevel, approvalMode: defaultApprovalMode },
			() => primerText,
			{
				keyPrefix: "owl.expert.chat",
				// 一轮结束：把回答落进当天 md（群聊以群名落，1:1 以专家名落）。
				onSettled: (entries) => {
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i]!;
						if (entry.kind === "user") break;
						if (entry.kind === "assistant") {
							if (!entry.aborted && entry.text.trim()) void logExpertChatLine(client, cwd, who, entry.text).catch(() => {});
							break;
						}
					}
				},
			},
		);
	}, [client, cwd, target, primerText, defaultModel, defaultThinkingLevel, defaultApprovalMode, bySlug]);
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

	useEffect(() => {
		if (!connected || !active || !cwd) return;
		let cancelled = false;
		void client.request<CommandsListResult>({ type: "commands.list", cwd })
			.then((response) => { if (!cancelled && response.ok) setCommands(response.result?.commands ?? []); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [client, cwd, chat.sessionId, connected, active]);

	// -- 管理台：档案状态（有修改 = 盘上 persona.md 与内置档案不同）；目录专家即目录本身，默认正常 --
	useEffect(() => {
		if (tab !== "manage" || !connected) return;
		let cancelled = false;
		const checkable = [...EXPERT_ROSTER, ...customs];
		void Promise.all(checkable.map(async (expert) => [expert.slug, await expertFileStatus(client, expert)] as const))
			.then((pairs) => { if (!cancelled) setStatuses(Object.fromEntries(pairs)); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [tab, connected, client, customs]);

	// -- 动作 ------------------------------------------------------------------

	const fillDraft = (text: string): void => setDraftRequest({ id: Date.now(), text });

	const openExpert = (slug: string): void => {
		const p = bySlug(slug);
		if (!p) return;
		// 已是当前专家就只切回去，不重建控制器/清草稿（会话进行中浏览目录再回来不打断）。
		if (target?.kind === "expert" && target.slug === slug) { setTab("chat"); return; }
		setTarget({ kind: "expert", slug });
		setTab("chat");
		setChatView("chat");
		setComposerKey((key) => key + 1);
	};
	const openGroup = (groupItem: { id: string; name: string; memberSlugs?: string[]; memory?: "shared" | "own" }): void => {
		if (target?.kind === "group" && target.id === groupItem.id) { setTab("chat"); return; }
		setTarget({ kind: "group", ...groupItem });
		setTab("chat");
		setChatView("chat");
		setComposerKey((key) => key + 1);
	};
	/** 回专家目录：保留 target —— 再点「会话」直接回到上一位专家/群，不要求重挑。 */
	const backToMarket = (): void => {
		setDrawerSlug(undefined);
		setTab("market");
		void refreshGroups();
	};

	const sendChat = async (value: string, images?: ComposerImage[], attachedPaths?: string[]): Promise<void> => {
		if (!chatController || !cwd) return;
		const match = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
		const matched = match && commands.find((command) => command.name === match[1]);
		if (match && (matched?.kind === "builtin" || (!matched && ["new", "settings", "model", "thinking", "compact"].includes(match[1])))) {
			if (match[1] === "settings") { onOpenSettings?.("general"); return; }
			if (match[1] === "new") { newThread(); return; }
			await chatController.executeBuiltin(match[1], match[2] ?? "");
			return;
		}
		const sent = await chatController.send(value, images, attachedPaths);
		if (sent) void logExpertChatLine(client, cwd, lang === "en" ? "Me" : "我", value).catch(() => {});
	};

	const newThread = (): void => {
		if (chatController?.newThread()) setComposerKey((key) => key + 1);
	};

	/** 场景/团队 → 免建群直接开一场顾问团（无 members.json，不进「我的群」清单）。 */
	const openAdhoc = (name: string, members: string[], firstQuestion?: string): void => {
		const id = `adhoc-${Date.now().toString(36)}`;
		openGroup({ id, name, memberSlugs: members, memory: "shared" });
		if (firstQuestion) fillDraft(firstQuestion);
	};

	const submitGroup = async (): Promise<void> => {
		if (groupPick.length < 2) return;
		const name = groupName.trim() || `${groupPick.slice(0, 2).map((slug) => bySlug(slug)?.name ?? slug).join("、")}等${groupPick.length}人会诊群`;
		try {
			if (groupModal?.mode === "manage" && groupModal.group) {
				const updated = await updateExpertGroup(client, groupModal.group, { name, memberSlugs: groupPick, memory: groupMemory });
				setGroups((current) => current.map((item) => (item.id === updated.id ? updated : item)));
				setTarget((current) => (current?.kind === "group" && current.id === updated.id ? { kind: "group", ...updated } : current));
			} else {
				const created = await createExpertGroup(client, name, groupPick, groupMemory);
				setGroups((current) => [created, ...current.filter((item) => item.id !== created.id)]);
				openGroup(created);
			}
			setGroupModal(undefined);
			setGroupPick([]);
			setGroupName("");
		} catch (error) {
			(window as unknown as { __groupErr?: string }).__groupErr = error instanceof Error ? error.stack ?? error.message : String(error);
		}
	};

	const submitCreate = async (draft: { name: string; title: string; division: string; tags: string; desc: string; mission: string; rules: string }): Promise<void> => {
		try {
			const created = await createCustomExpert(client, {
				name: draft.name.trim(),
				title: draft.title.trim() || "自定义专家",
				division: draft.division,
				tags: draft.tags.split(/[、,，]/).map((tag) => tag.trim()).filter(Boolean),
				desc: draft.desc.trim(),
				mission: draft.mission.trim(),
				rules: draft.rules.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
			});
			setCustoms((current) => [...current, created]);
			setCreateModal(false);
			openExpert(created.slug);
		} catch {
			// 落盘失败保持弹窗。
		}
	};

	const submitJoin = async (slug: string, groupId: string): Promise<void> => {
		const group = groups.find((item) => item.id === groupId);
		if (!group || group.memberSlugs.includes(slug)) return;
		const updated = await updateExpertGroup(client, group, { memberSlugs: [...group.memberSlugs, slug] });
		setGroups((current) => current.map((item) => (item.id === updated.id ? updated : item)));
		setJoinPick(undefined);
	};

	const resyncAll = async (): Promise<void> => {
		for (const expert of EXPERT_ROSTER) await ensureExpertDir(client, expert);
		void listCustomExperts(client).then(setCustoms).catch(() => {});
		void refreshGroups();
		setStatuses({});
	};

	// -- 市场过滤 / 排序 ----------------------------------------------------------
	/** 卡片文案跟随界面语言：中文界面优先用 nameZh 等转述字段（无则回退原文）。 */
	const nm = useCallback((expert: ExpertPersona): string => (lang === "zh" && expert.nameZh) || expert.name, [lang]);
	const ttl = useCallback((expert: ExpertPersona): string => (lang === "zh" && expert.titleZh) || expert.title, [lang]);
	const ds = useCallback((expert: ExpertPersona): string => (lang === "zh" && expert.descZh) || expert.desc, [lang]);
	const tgs = useCallback((expert: ExpertPersona): string[] => (lang === "zh" && expert.tagsZh?.length ? expert.tagsZh : expert.tags), [lang]);

	/** 部门 chips：内置顺序在前，目录里出现的其他部门按需追加。 */
	const chipDivisions = useMemo(() => {
		const present = new Set(catalog.map((expert) => expert.division));
		return [...DIVISION_ORDER.filter((key) => present.has(key)), ...[...present].filter((key) => !DIVISION_ORDER.includes(key))];
	}, [catalog]);
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const haystack = (expert: ExpertPersona): string =>
			`${expert.name}${expert.nameZh ?? ""}${expert.title}${expert.titleZh ?? ""}${expert.desc}${expert.descZh ?? ""}${expert.tags.join()}${expert.tagsZh?.join() ?? ""}`;
		const list = catalog.filter((expert) =>
			(division === "all" || expert.division === division) &&
			(q === "" || haystack(expert).toLowerCase().includes(q)));
		return sort === "name"
			? [...list].sort((a, b) => nm(a).localeCompare(nm(b), "zh"))
			: [...list].sort((a, b) => Number(b.feat ?? false) - Number(a.feat ?? false));
	}, [catalog, division, query, sort, nm]);

	const drawer = drawerSlug ? bySlug(drawerSlug) : undefined;
	const drawerScope = drawer ? getExpertScope(drawer.slug) : "space";
	const targetPersona = target?.kind === "expert" ? bySlug(target.slug) : undefined;
	const chatActivity = !connected ? "disconnected" : chat.running ? "working" : "idle";
	const enabledCount = catalog.length;
	const globalCount = catalog.filter((expert) => getExpertScope(expert.slug) === "global").length;
	const modCount = catalog.filter((expert) => (statuses[expert.slug] ?? "ok") !== "ok").length;

	/** 打开记忆查看：1:1 用已载入的记忆，群聊现读共享记忆。 */
	const openMemoryView = async (): Promise<void> => {
		if (!target) return;
		if (target.kind === "expert") {
			const p = bySlug(target.slug);
			const memory = expertLoad?.memory ?? await readExpertMemory(client, target.slug);
			setMemoryView({ title: `${p?.name ?? ""} · ${t("expert.memoryTitle")}`, lines: memory.split(/\r?\n/), file: `owl-expert/${target.slug}/memory.md` });
		} else if (groupMeta) {
			const memory = await readGroupMemory(client, groupMeta);
			setMemoryView({ title: `${groupMeta.name} · ${t("expert.sharedMemoryTitle")}`, lines: memory.split(/\r?\n/), file: `owl-expert/groups/${groupMeta.id}/memory.md` });
		}
	};

	return (
		<div className={`owl-expert${active ? " is-active" : ""}`}>
			<div className="owl-expert-head">
				<span className="owl-expert-mark" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9.5" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>
				</span>
				<h1>{t("rail.expert")}</h1>
				<span className="owl-expert-dir" title={tab === "chat" ? cwd : undefined}>{tab === "chat" && cwd ? cwd : `owl-expert · ${catalog.length}`}</span>
				{/* tab 常驻：选过专家时「会话」直接回到上一位；从没选过才在会话页提醒先挑人。 */}
				<div className="owl-expert-tabs" role="tablist">
					<button type="button" role="tab" aria-selected={tab !== "chat"} className={tab !== "chat" ? "on" : ""} onClick={backToMarket}>{t("expert.tabMarket")}</button>
					<button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>{t("expert.tabChat")}</button>
				</div>
				<span className="owl-expert-sync" data-ready={connected}>
					{connected ? t("expert.statusRoster", { n: catalog.length }) : t("expert.offline")}
				</span>
			</div>

			{tab === "chat" && target && cwd ? (
				// ---- 会话 tab：复用 owl 对话区（会话头 + 对话/上下文/轨迹 + 完整 Composer）----
				<div className="owl-expert-chatpage">
					<header className="owl-chat-header flex shrink-0 select-none items-center">
						<button type="button" className="owl-expert-back" onClick={backToMarket} aria-label={t("expert.back")}>
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
						</button>
						{targetPersona ? <ExpertAvatar expert={targetPersona} size={28} /> : <GroupAvatar size={28} />}
						<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text">
							{target.kind === "expert" && targetPersona ? `${nm(targetPersona)} · ${ttl(targetPersona)}` : target?.kind === "group" ? target.name : ""}
						</h1>
						<span className="owl-expert-file" title={cwd}>{target.kind === "expert" ? `owl-expert/${target.slug}/` : `owl-expert/groups/${target.id}/`}</span>
						{target.kind === "expert" && expertLoad && (
							<button type="button" className="owl-expert-mem" title={t("expert.memTitle")} onClick={() => void openMemoryView()}>{t("expert.memory", { n: memoryLineCount(expertLoad.memory) })}</button>
						)}
						{target.kind === "group" && groupMeta && (
							<>
								{groupMeta.memory === "shared" && (
									<button type="button" className="owl-expert-mem" title={t("expert.sharedMemTitle")} onClick={() => void openMemoryView()}>{t("expert.sharedMemory", { n: memoryLineCount(expertLoad?.memory ?? "") })}</button>
								)}
								<span className="owl-expert-members">{groupMeta.memberSlugs.map((slug) => bySlug(slug)?.name ?? slug).join(" / ")}</span>
								<button type="button" className="owl-chrome-button" onClick={() => { setGroupPick(groupMeta.memberSlugs); setGroupName(groupMeta.name); setGroupMemory(groupMeta.memory); setGroupModal({ mode: "manage", group: groupMeta }); }}>{t("expert.invite")}</button>
							</>
						)}
						<div className="owl-view-tabs" role="tablist" aria-label={t("app.viewTabsAria")}>
							<button type="button" role="tab" aria-selected={chatView === "chat"} onClick={() => setChatView("chat")}>{t("app.viewChat")}</button>
							<button type="button" role="tab" aria-selected={chatView === "context"} onClick={() => setChatView("context")}>{t("composer.context")}</button>
							<button type="button" role="tab" aria-selected={chatView === "trajectory"} onClick={() => setChatView("trajectory")}>{t("app.viewTrajectory")}</button>
						</div>
						<div className="owl-shell-header-actions">
							<button type="button" className="owl-chrome-button" disabled={chat.running || chat.busy} onClick={newThread}>{t("expert.chatNew")}</button>
						</div>
					</header>
					<div className="owl-expert-chatstream">
						{chatView === "trajectory" ? (
							<TrajectoryView entries={chat.entries} active={active} />
						) : chatView === "context" ? (
							<ContextView key={`expert-context:${cwd}:${chat.sessionId ?? ""}`} client={client} cwd={cwd} sessionId={chat.sessionId} requireSession active={active && connected} />
						) : chat.entries.length ? (
							<GenuiSessionProvider client={client} sessionId={chat.sessionId}>
								<ChatStream entries={chat.entries} activity={chatActivity} client={client} cwd={cwd} />
							</GenuiSessionProvider>
						) : (
							<div className="owl-expert-chathint">
								{target.kind === "expert" && targetPersona ? <ExpertAvatar expert={targetPersona} size={44} /> : <GroupAvatar size={44} />}
								<p className="big">{target.kind === "expert" ? t("expert.chatEmptyTitle", { name: targetPersona ? nm(targetPersona) : "" }) : t("expert.groupEmptyTitle")}</p>
								<p>{t("expert.chatEmptyHint")}</p>
							</div>
						)}
						{(!connected || !chat.ready || chat.error) && (
							<div className="owl-expert-chatnotice" role={chat.error ? "alert" : "status"}>
								{chat.error ? chat.error : !connected ? t("expert.offline") : primerText === undefined ? t("expert.preparing") : t("expert.restore")}
							</div>
						)}
						<RetryPin status={chat.retryStatus} onDismiss={() => chatController?.dismissRetry()} />
					</div>
					{target.kind === "expert" ? (
						<div className="owl-expert-cctools">
							<button type="button" className="owl-expert-ccchip" onClick={() => setAtPop((open) => !open)}>＠ {t("expert.chipAt")}</button>
							{atPop && (
								<span className="owl-expert-atpop">
									{catalog.slice(0, 8).map((expert) => (
										<button key={expert.slug} type="button" onClick={() => { fillDraft(`@${nm(expert)} `); setAtPop(false); }}>{nm(expert)}</button>
									))}
								</span>
							)}
							<span className="tip">{t("expert.chipAtTip")}</span>
						</div>
					) : (
						<div className="owl-expert-cctools">
							<button type="button" className="owl-expert-ccchip" onClick={() => setAtPop((open) => !open)}>＠ {t("expert.chipAtTarget")}</button>
							{atPop && (
								<span className="owl-expert-atpop">
									{(groupMeta?.memberSlugs ?? []).map((slug) => (
										<button key={slug} type="button" onClick={() => { fillDraft(`@${bySlug(slug)?.name ?? slug} `); setAtPop(false); }}>{bySlug(slug)?.name ?? slug}</button>
									))}
								</span>
							)}
							<button type="button" className="owl-expert-ccchip" onClick={() => fillDraft(t("expert.chipSynthPrompt"))}>✦ {t("expert.chipSynth")}</button>
						</div>
					)}
					<Composer
						key={`${cwd}:${composerKey}`}
						client={client}
						connected={connected}
						disabled={!connected || !chat.ready || chat.running || chat.busy}
						running={chat.running}
						onSend={(value, images, attachedPaths) => { void sendChat(value, images, attachedPaths); }}
						onAbort={() => void chatController?.abort()}
						providers={providers}
						model={chat.model}
						onModel={(value) => { void chatController?.setModel(value); }}
						thinkingLevel={chat.thinkingLevel}
						onThinkingLevel={(value) => { void chatController?.setThinkingLevel(value); }}
						approvalMode={chat.approvalMode}
						onApprovalMode={(mode) => { void chatController?.setApprovalMode(mode); }}
						sessionInfo={chat.stats}
						workspaceDir={cwd}
						projects={[cwd]}
						onSwitchProject={() => undefined}
						commands={commands}
						searchFiles={(searchCwd, q) => client.request<FsSearchHit[]>({ type: "fs.search", cwd: searchCwd, query: q }).then((r) => (r.ok ? r.result ?? [] : []))}
						draftRequest={draftRequest}
					/>
					<footer className="owl-expert-foot">
						<span>{t("expert.footSource", { dir: cwd })}</span>
						<span className="right">{hhmm()} · {t("expert.saved")}</span>
					</footer>
				</div>
			) : tab === "chat" ? (
				// ---- 会话 tab 但还没选专家：提醒先挑人（去「专家」页选，或用场景/专家团开局）----
				<div className="owl-expert-chathint">
					<GroupAvatar size={44} />
					<p className="big">{t("expert.pickTitle")}</p>
					<p>{t("expert.pickHint")}</p>
					<button type="button" className="owl-expert-newgroup" style={{ marginTop: 8 }} onClick={() => setTab("market")}>{t("expert.pickGo")}</button>
				</div>
			) : tab === "manage" ? (
				// ---- 管理 tab：启用范围 + 档案状态 + Agentfile ----------------------------
				<div className="owl-expert-main">
					<div className="owl-expert-stats">
						<div className="stat"><b className="num">{enabledCount}</b><span>{t("expert.statEnabled")}</span></div>
						<div className="stat"><b className="num">{globalCount}</b><span>{t("expert.statGlobal")}</span></div>
						<div className="stat warn"><b className="num">{modCount}</b><span>{t("expert.statPending")}</span></div>
						<div className="stat"><b className="num">{groups.length}</b><span>{t("expert.statGroups")}</span></div>
					</div>
					<div className="owl-expert-mlist">
						<div className="mhead">
							<span style={{ width: 190, flex: "none" }}>{t("expert.colExpert")}</span>
							<span style={{ width: 128, flex: "none" }}>{t("expert.colScope")}</span>
							<span style={{ width: 96, flex: "none" }}>{t("expert.colStatus")}</span>
							<span>{t("expert.colSource")}</span>
							<span style={{ flex: "none" }}>{t("expert.colOps")}</span>
						</div>
						{catalog.map((expert) => {
							const status = statuses[expert.slug] ?? "ok";
							return (
								<div key={expert.slug} className="mrow">
									<ExpertAvatar expert={expert} size={26} />
									<span className="nm" style={{ width: 164, flex: "none" }}>
										<b>{nm(expert)} · {ttl(expert)}</b>
										<span>{divisionLabel(expert.division)}</span>
									</span>
									<select
										className="owl-expert-scope"
										value={drawerScopeOf(expert.slug)}
										onChange={(event) => { setExpertScope(expert.slug, event.target.value as ExpertScope); setScopeRev((rev) => rev + 1); }}
									>
										<option value="global">{t("expert.scopeGlobal")}</option>
										<option value="space">{t("expert.scopeSpace")}</option>
										<option value="session">{t("expert.scopeSession")}</option>
									</select>
									<span className={`st is-${status}`}>{t(status === "ok" ? "expert.stOk" : status === "mod" ? "expert.stMod" : "expert.stCustom")}</span>
									<span className="src">{`owl-expert/${expert.slug}/persona.md`}</span>
									<span className="ops">
										<button type="button" onClick={() => setDrawerSlug(expert.slug)}>{t("expert.view")}</button>
									</span>
								</div>
							);
						})}
					</div>
					<div className="owl-expert-mfoot" data-rev={scopeRev}>
						<button type="button" className="owl-expert-newgroup" onClick={() => { void exportAgentfile(client, catalog.map((expert) => expert.slug)).then((n) => window.alert(t("expert.agentfileExported", { n }))); }}>{t("expert.agentfileExport")}</button>
						<button type="button" className="owl-expert-newgroup" onClick={() => { void importAgentfile(client).then((n) => { setScopeRev((rev) => rev + 1); window.alert(t("expert.agentfileImported", { n })); }); }}>{t("expert.agentfileImport")}</button>
						<button type="button" className="owl-expert-newgroup" onClick={() => { void resyncAll().then(() => window.alert(t("expert.resynced"))); }}>{t("expert.resync")}</button>
						<span className="hint">{t("expert.manageHint")}</span>
					</div>
				</div>
			) : (
				// ---- 专家 / 专家团 tab --------------------------------------------------
				<div className="owl-expert-main">
					{tab === "market" && (
						<>
							<div className="sec-h"><b>{t("expert.scenarios")}</b><span>{t("expert.scenariosHint")}</span></div>
							<div className="owl-expert-scenrow">
								{EXPERT_SCENARIOS.map((scenario) => (
									<button key={scenario.name} type="button" className="owl-expert-scen" style={{ background: `linear-gradient(135deg, ${scenario.color[0]}, ${scenario.color[1]})` }} onClick={() => openAdhoc(`${scenario.name} · 顾问团`, [...scenario.members], scenario.question)}>
										<span className="emo" aria-hidden="true">{scenario.emoji}</span>
										<b>{scenario.name}</b>
										<em>{scenario.members.slice(0, 2).map((slug) => bySlug(slug)?.name ?? slug).join("、")} {t("expert.scenMore", { n: scenario.members.length })}</em>
									</button>
								))}
							</div>
						</>
					)}
					<div className="owl-expert-toolbar">
						<div className="owl-expert-tabs2" role="tablist">
							<button type="button" className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>{t("expert.tabMarket")} <span>{catalog.length}</span></button>
							<button type="button" className={tab === "teams" ? "on" : ""} onClick={() => setTab("teams")}>{t("expert.tabTeams")} <span>{EXPERT_TEAMS.length + groups.length}</span></button>
							{/* 本分支 tab 已被外层三元收窄为 market|teams，管理态不在此渲染；按钮只负责跳转。 */}
							<button type="button" className="" onClick={() => setTab("manage")}>{t("expert.tabManage")}</button>
						</div>
						<div className="spacer" />
						{tab === "market" && (
							<>
								<select className="owl-expert-sort" value={sort} onChange={(event) => setSort(event.target.value as "feat" | "name")} aria-label={t("expert.sort")}>
									<option value="feat">{t("expert.sortFeat")}</option>
									<option value="name">{t("expert.sortName")}</option>
								</select>
								<button type="button" className="owl-expert-newgroup" onClick={() => setCreateModal(true)}>{t("expert.createExpert")}</button>
							</>
						)}
						{tab === "teams" && (
							<button type="button" className="owl-expert-newgroup" onClick={() => { setGroupPick([]); setGroupName(""); setGroupModal({ mode: "create" }); }}>{t("expert.makeGroup")}</button>
						)}
					</div>
					{tab === "market" && (
						<div className="owl-expert-chips" role="tablist" aria-label={t("expert.divisions")}>
							<button type="button" className={division === "all" ? "on" : ""} onClick={() => setDivision("all")}>{t("expert.divAll")}</button>
							{chipDivisions.map((key) => (
								<button key={key} type="button" className={division === key ? "on" : ""} onClick={() => setDivision(key)}>{divisionLabel(key)}</button>
							))}
						</div>
					)}
					{tab === "teams" ? (
						<>
							{EXPERT_TEAMS.map((team) => (
								<div key={team.id} className="owl-expert-team">
									<span className="tn">👥 {team.name}</span>
									<span className="td">{team.desc}</span>
									<span className="mem">
										{team.members.map((slug) => {
											const expert = bySlug(slug);
											return expert ? <span key={slug} className="m"><ExpertAvatar expert={expert} size={18} />{nm(expert)}</span> : null;
										})}
									</span>
									<span className="tf">
										<button type="button" className="ghost" onClick={() => { setGroupPick([...team.members]); setGroupName(team.name); setGroupModal({ mode: "create", pre: [...team.members] }); }}>{t("expert.makeGroup")}</button>
										<button type="button" className="primary" onClick={() => openAdhoc(team.name, [...team.members], t("expert.teamKickoff"))}>{t("expert.teamConsult")}</button>
									</span>
								</div>
							))}
							{groups.map((groupItem) => (
								<div key={groupItem.id} className="owl-expert-team">
									<span className="tn">👥 {groupItem.name}</span>
									<span className="td">{t("expert.myGroupHint")}</span>
									<span className="mem">
										{groupItem.memberSlugs.map((slug) => {
											const expert = bySlug(slug);
											return expert ? <span key={slug} className="m"><ExpertAvatar expert={expert} size={18} />{nm(expert)}</span> : null;
										})}
									</span>
									<span className="tf">
										<button type="button" className="ghost" onClick={() => { setGroupPick(groupItem.memberSlugs); setGroupName(groupItem.name); setGroupMemory(groupItem.memory); setGroupModal({ mode: "manage", group: groupItem }); }}>{t("expert.groupSettings")}</button>
										<button type="button" className="primary" onClick={() => openGroup(groupItem)}>{t("expert.openGroup")}</button>
									</span>
								</div>
							))}
						</>
					) : (
						<div className="owl-expert-grid">
							{filtered.map((expert) => (
								<button key={expert.slug} type="button" className="owl-expert-card" onClick={() => setDrawerSlug(expert.slug)}>
									<span className="top">
										<ExpertAvatar expert={expert} />
										<span className="id">
											<b>{nm(expert)} · {ttl(expert)}{expert.feat ? <i className="star">★</i> : null}</b>
											<span>{divisionLabel(expert.division)} · {tgs(expert).slice(0, 3).join(" / ")}</span>
										</span>
									</span>
									<span className="desc">{ds(expert)}</span>
									<span className="foot">
										<span className="meta">{expert.custom ? t("expert.customTag") : expert.feat ? t("expert.featTag") : t("expert.officialTag")}</span>
										<span className="go" onClick={(event) => { event.stopPropagation(); openExpert(expert.slug); }}>{t("expert.consult")}</span>
									</span>
								</button>
							))}
							{filtered.length === 0 && <p className="owl-expert-empty">{t("expert.none")}</p>}
						</div>
					)}

					{drawer && (
						<>
							<div className="owl-expert-mask" onClick={() => setDrawerSlug(undefined)} />
							<aside className="owl-expert-drawer" role="dialog" aria-label={`${nm(drawer)} · ${ttl(drawer)}`}>
								<header>
									<ExpertAvatar expert={drawer} size={44} />
									<div className="id">
										<b>{nm(drawer)} · {ttl(drawer)}</b>
										<span>{divisionLabel(drawer.division)} · {tgs(drawer).join(" / ")}</span>
									</div>
									<button type="button" className="x" onClick={() => setDrawerSlug(undefined)} aria-label={t("expert.close")}>
										<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
									</button>
								</header>
								<div className="body">
									<h4>{t("expert.secDesc")}</h4><p>{drawer.desc}</p>
									<h4>{t("expert.secMission")}</h4><p>{drawer.mission}</p>
									<h4>{t("expert.secRules")}</h4>
									<ul>{drawer.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul>
									<h4>{t("expert.secDeliv")}</h4>
									<ul>{drawer.deliv.map((item, index) => <li key={index}>{item}</li>)}</ul>
									<h4>{t("expert.secFlow")}</h4>
									<ol>{drawer.flow.map(([name, detail], index) => <li key={index}><b>{name}</b> — {detail}</li>)}</ol>
									<h4>{t("expert.secMetrics")}</h4>
									<ul>{drawer.metrics.map((metric, index) => <li key={index}>{metric}</li>)}</ul>
								</div>
								<footer>
									<select
										className="owl-expert-scope"
										value={drawerScope}
										onChange={(event) => { setExpertScope(drawer.slug, event.target.value as ExpertScope); setScopeRev((rev) => rev + 1); }}
										title={t("expert.scopeTitle")}
									>
										<option value="global">{t("expert.scopeGlobal")}</option>
										<option value="space">{t("expert.scopeSpace")}</option>
										<option value="session">{t("expert.scopeSession")}</option>
									</select>
									<button type="button" className="ghost" onClick={() => { setJoinPick(drawer.slug); }}>{t("expert.joinTeam")}</button>
									<button type="button" className="ghost" onClick={() => { setGroupPick([drawer.slug]); setGroupName(""); setGroupModal({ mode: "create", pre: [drawer.slug] }); }}>{t("expert.makeGroup")}</button>
									<button type="button" className="primary" onClick={() => openExpert(drawer.slug)}>{t("expert.startChat")}</button>
								</footer>
							</aside>
						</>
					)}
				</div>
			)}

			{/* 记忆查看抽屉 */}
			{memoryView && (
				<>
					<div className="owl-expert-mask" onClick={() => setMemoryView(undefined)} />
					<aside className="owl-expert-drawer" role="dialog" aria-label={memoryView.title}>
						<header>
							<div className="id"><b>{memoryView.title}</b><span className="owl-expert-file">{memoryView.file}</span></div>
							<button type="button" className="x" onClick={() => setMemoryView(undefined)} aria-label={t("expert.close")}>
								<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
							</button>
						</header>
						<div className="body">
							<p className="hint">{t("expert.memoryHint")}</p>
							{memoryView.lines.filter((line) => line.trim() && !line.trim().startsWith("#") && !line.trim().startsWith(">")).map((line, index) => (
								<p key={index} className="memline">{line}</p>
							))}
						</div>
					</aside>
				</>
			)}

			{/* 加入已有群 */}
			{joinPick && (
				<>
					<div className="owl-expert-mask" onClick={() => setJoinPick(undefined)} />
					<div className="owl-expert-modal" role="dialog" aria-label={t("expert.joinTeam")}>
						<h3>{t("expert.joinTeam")}</h3>
						<p className="hint">{t("expert.joinHint", { name: bySlug(joinPick)?.name ?? "" })}</p>
						{groups.length === 0 && <p className="hint">{t("expert.joinNone")}</p>}
						{groups.map((groupItem) => (
							<button key={groupItem.id} type="button" className="owl-expert-group" style={{ width: "100%", marginBottom: 6 }} onClick={() => void submitJoin(joinPick, groupItem.id)}>
								<span className="n">{groupItem.name}</span>
								<span className="m">{groupItem.memberSlugs.length} {t("expert.memberUnit")}{groupItem.memberSlugs.includes(joinPick) ? ` · ${t("expert.alreadyIn")}` : ""}</span>
							</button>
						))}
						<footer style={{ display: "flex", justifyContent: "flex-end" }}>
							<button type="button" className="ghost" onClick={() => setJoinPick(undefined)}>{t("expert.cancel")}</button>
						</footer>
					</div>
				</>
			)}

			{/* 拉群 / 群设置 */}
			{groupModal && (
				<>
					<div className="owl-expert-mask" onClick={() => setGroupModal(undefined)} />
					<div className="owl-expert-modal" role="dialog" aria-label={t("expert.makeGroup")}>
						<h3>{groupModal.mode === "manage" ? t("expert.groupSettings") : t("expert.makeGroup")}</h3>
						<p className="hint">{t("expert.groupHint")}</p>
						<div className="gm-grid" id="gmGrid">
							{catalog.map((expert) => (
								<button
									key={expert.slug}
									type="button"
									className={`gm-pick${groupPick.includes(expert.slug) ? " on" : ""}`}
									onClick={() => setGroupPick((current) => current.includes(expert.slug) ? current.filter((slug) => slug !== expert.slug) : [...current, expert.slug])}
								>
									<ExpertAvatar expert={expert} size={28} />
									<span className="gn">{nm(expert)}</span>
								</button>
							))}
						</div>
						<div className="name">
							<span>{t("expert.groupNameLabel")}</span>
							<input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("expert.groupNamePlaceholder")} />
						</div>
						<div className="owl-expert-gmmem" role="radiogroup" aria-label={t("expert.memoryMode")}>
							<label><input type="radio" name="gmmem" checked={groupMemory === "shared"} onChange={() => setGroupMemory("shared")} />{t("expert.memShared")}</label>
							<label><input type="radio" name="gmmem" checked={groupMemory === "own"} onChange={() => setGroupMemory("own")} />{t("expert.memOwn")}</label>
						</div>
						<footer>
							<button type="button" className="ghost" onClick={() => setGroupModal(undefined)}>{t("expert.cancel")}</button>
							<button type="button" className="primary" disabled={groupPick.length < 2} onClick={() => void submitGroup()}>
								{groupPick.length < 2 ? t("expert.needTwo") : groupModal.mode === "manage" ? t("expert.saveGroup") : t("expert.createGroup")}
							</button>
						</footer>
					</div>
				</>
			)}

			{/* 创建自定义专家 */}
			{createModal && <CreateExpertModal onCancel={() => setCreateModal(false)} onSubmit={(draft) => void submitCreate(draft)} />}
		</div>
	);

	function drawerScopeOf(slug: string): ExpertScope {
		return getExpertScope(slug);
	}
}

/** 创建自定义专家（六段式简表）：落 owl-expert/custom/<slug>/persona.md。 */
function CreateExpertModal({ onCancel, onSubmit }: {
	onCancel: () => void;
	onSubmit: (draft: { name: string; title: string; division: string; tags: string; desc: string; mission: string; rules: string }) => void;
}): React.JSX.Element {
	const t = useT();
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	const [division, setDivision] = useState<string>("eng");
	const [tags, setTags] = useState("");
	const [desc, setDesc] = useState("");
	const [mission, setMission] = useState("");
	const [rules, setRules] = useState("");
	const ok = name.trim() !== "" && desc.trim() !== "";
	return (
		<>
			<div className="owl-expert-mask" onClick={onCancel} />
			<div className="owl-expert-modal" role="dialog" aria-label={t("expert.createExpert")}>
				<h3>{t("expert.createExpert")}</h3>
				<p className="hint">{t("expert.createHint")}</p>
				<div className="owl-expert-form">
					<label>{t("expert.fName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder="如：王工" /></label>
					<label>{t("expert.fTitle")}<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("expert.fTitlePh")} /></label>
					<label>{t("expert.fDivision")}
						<select value={division} onChange={(event) => setDivision(event.target.value)}>
							{DIVISION_ORDER.map((key) => <option key={key} value={key}>{DIVISION_LABELS[key] ?? key}</option>)}
						</select>
					</label>
					<label>{t("expert.fTags")}<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t("expert.fTagsPh")} /></label>
					<label>{t("expert.fDesc")}<textarea value={desc} onChange={(event) => setDesc(event.target.value)} rows={2} /></label>
					<label>{t("expert.fMission")}<textarea value={mission} onChange={(event) => setMission(event.target.value)} rows={2} /></label>
					<label>{t("expert.fRules")}<textarea value={rules} onChange={(event) => setRules(event.target.value)} rows={3} placeholder={t("expert.fRulesPh")} /></label>
				</div>
				<footer style={{ display: "flex", gap: 7, justifyContent: "flex-end" }}>
					<button type="button" className="ghost" onClick={onCancel}>{t("expert.cancel")}</button>
					<button type="button" className="primary" disabled={!ok} onClick={() => onSubmit({ name, title, division, tags, desc, mission, rules })}>{t("expert.createOk")}</button>
				</footer>
			</div>
		</>
	);
}
