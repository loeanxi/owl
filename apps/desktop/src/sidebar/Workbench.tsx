/**
 * 工作台外壳：右列面板（TabBar + 内容区 + 左缘拖拽调宽）。
 *
 * 对应 dsh-better-sidebar 的双工作台布局里"自绘侧栏"那一半：所有 tab 保持
 * 挂载、非激活的隐藏（编辑器草稿不丢）；fs_changed 事件在这里统一接桥并
 * 分发（store.onFsChanged）+ 防抖刷新 Git 状态快照。
 */
import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { GitStatusResult } from "../bridge/protocol.ts";
import { createSidebarApi } from "./api.ts";
import { registerBuiltins } from "./builtins.tsx";
import { IconFolder, IconGitBranch, IconLoader, IconX } from "./icons.tsx";
import { normProjectKey, SidebarStore, useSidebarState } from "./store.ts";
import { useTabRegistry, viewerKindFor, type TabComponentProps } from "./registry.ts";
import { isImagePath } from "./registry.ts";

const WIDTH_KEY = "owl.workbench.width";

export interface WorkbenchProps {
	client: BridgeClient;
	/** 项目目录（App 显式跟踪的工作区）。 */
	cwd: string;
	open: boolean;
	onSetOpen: (open: boolean) => void;
}

export function Workbench({ client, cwd, open, onSetOpen }: WorkbenchProps): React.JSX.Element {
	// 每个项目一个 store（key 变化即重建，布局按项目持久化）。
	const projectKey = normProjectKey(cwd);
	const store = useMemo(() => new SidebarStore(cwd), [projectKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const api = useMemo(() => createSidebarApi(client), [client]);
	const registry = useTabRegistry();
	const state = useSidebarState(store);
	const [gitStatus, setGitStatus] = useState<GitStatusResult | undefined>(undefined);
	const [width, setWidth] = useState(() => {
		const saved = Number(localStorage.getItem(WIDTH_KEY));
		return saved >= 280 ? saved : 380;
	});
	const gitTimer = useRef<number | undefined>(undefined);

	registerBuiltins();

	// -- Git 状态快照：项目切换 / fs_changed（防抖）/ 主动刷新 ----------------
	const refreshGit = useCallback(() => {
		void api
			.gitStatus(cwd)
			.then((result) => setGitStatus(result))
			.catch(() => setGitStatus({ repo: false, entries: [] }));
	}, [api, cwd]);

	useEffect(() => {
		refreshGit();
	}, [refreshGit]);

	useEffect(() => {
		return store.onFsChanged(() => {
			if (gitTimer.current !== undefined) window.clearTimeout(gitTimer.current);
			gitTimer.current = window.setTimeout(refreshGit, 400);
		});
	}, [store, refreshGit]);

	// -- 桥事件 → store 总线 ---------------------------------------------------
	useEffect(() => {
		return client.onSessionEvent((message) => {
			const event = message.event as { type?: string; cwd?: string; dirs?: unknown };
			if (event.type !== "fs_changed") return;
			if (event.cwd !== undefined && normProjectKey(String(event.cwd)) !== projectKey) return;
			const dirs = Array.isArray(event.dirs) ? event.dirs.map(String) : [];
			store.fsChanged(dirs);
		});
	}, [client, store, projectKey]);

	// -- 打开文件（viewer 匹配） ----------------------------------------------
	const openFile = useCallback(
		(path: string) => {
			const kind = isImagePath(path) ? "image" : viewerKindFor(path);
			const title = path.split("/").pop() ?? path;
			store.openFileTab(kind, path, title);
			if (!open) onSetOpen(true);
		},
		[store, open, onSetOpen],
	);

	const openSingleton = useCallback(
		(kind: string) => {
			store.openSingleton(kind);
			if (!open) onSetOpen(true);
		},
		[store, open, onSetOpen],
	);

	// -- 拖拽调宽 --------------------------------------------------------------
	// 拖拽期间走 ref 更新（setState 闭包会拿到旧值），mouseup 时持久化。
	const widthRef = useRef(width);
	widthRef.current = width;
	const startResize = (e: React.MouseEvent): void => {
		e.preventDefault();
		const onMove = (move: MouseEvent): void => {
			const next = Math.min(Math.max(window.innerWidth - move.clientX, 280), Math.max(window.innerWidth * 0.6, 420));
			widthRef.current = next;
			setWidth(next);
		};
		const onUp = (): void => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			localStorage.setItem(WIDTH_KEY, String(widthRef.current));
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const activeTab = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs.at(-1);

	// 激活非最前 tab 时的内容渲染集合（全部挂载，非激活隐藏）。
	const tabPropsOf = (tabId: string): TabComponentProps => ({
		api,
		store,
		cwd,
		tab: state.tabs.find((tab) => tab.id === tabId)!,
		onOpenFile: openFile,
		gitStatus,
		onGitRefresh: refreshGit,
	});

	return (
		<aside
			className={`${open ? "" : "hidden"} relative flex shrink-0 flex-col border-l border-owl-border/60 bg-owl-sidebar`}
			style={{ width }}
		>
			{/* 左缘拖拽条 */}
			<div className="absolute top-0 left-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-owl-accent/40" onMouseDown={startResize} />

			{/* 工具行：固定入口（文件/变动）+ 占位 */}
			<div className="flex select-none items-center gap-1 border-b border-owl-border/60 px-2 py-1.5" data-tauri-drag-region="deep">
				<button
					type="button"
					title="文件"
					className={`rounded-md p-1.5 transition-colors ${state.tabs.some((tab) => tab.kind === "files") ? "bg-owl-hover text-owl-text" : "text-owl-muted hover:bg-owl-hover hover:text-owl-text"}`}
					onClick={() => openSingleton("files")}
				>
					<IconFolder size={14} />
				</button>
				<button
					type="button"
					title="文件变动"
					className={`rounded-md p-1.5 transition-colors ${state.tabs.some((tab) => tab.kind === "changes") ? "bg-owl-hover text-owl-text" : "text-owl-muted hover:bg-owl-hover hover:text-owl-text"}`}
					onClick={() => openSingleton("changes")}
				>
					<IconGitBranch size={14} />
				</button>
				{state.tabs.filter((tab) => tab.kind !== "files" && tab.kind !== "changes").length > 4 && (
					<span className="ml-1 text-[10px] text-owl-faint">{state.tabs.length} 个标签</span>
				)}
				<div className="flex-1" data-tauri-drag-region="deep" />
				<button
					type="button"
					title="关闭工作台"
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
					onClick={() => onSetOpen(false)}
				>
					<IconX size={14} />
				</button>
			</div>

			{/* TabBar（文件 tab：按路径去重的编辑器/图片页） */}
			{state.tabs.filter((tab) => tab.kind !== "files" && tab.kind !== "changes").length > 0 && (
				<div className="flex select-none items-stretch overflow-x-auto border-b border-owl-border/40 bg-owl-rail/60">
					{state.tabs
						.filter((tab) => tab.kind !== "files" && tab.kind !== "changes")
						.map((tab) => {
							const def = registry.byKind.get(tab.kind);
							const isActive = tab.id === activeTab?.id;
							return (
								<div
									key={tab.id}
									role="button"
									tabIndex={0}
									title={tab.path}
									onClick={() => store.activate(tab.id)}
									onAuxClick={(e) => {
										if (e.button === 1) store.closeTab(tab.id);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") store.activate(tab.id);
									}}
									className={`group flex max-w-44 shrink-0 cursor-pointer items-center gap-1.5 border-r border-owl-border/30 px-2.5 py-1.5 text-xs ${
										isActive ? "bg-owl-sidebar text-owl-text" : "text-owl-muted hover:text-owl-text"
									}`}
								>
									{def?.icon(12)}
									<span className="min-w-0 truncate">{tab.title}</span>
									{state.dirty[tab.id] === true && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-owl-accent" title="未保存" />}
									<button
										type="button"
										className="ml-0.5 shrink-0 rounded p-0.5 text-owl-faint opacity-0 group-hover:opacity-100 hover:bg-owl-hover hover:text-owl-text"
										onClick={(e) => {
											e.stopPropagation();
											store.closeTab(tab.id);
										}}
									>
										<IconX size={10} />
									</button>
								</div>
							);
						})}
				</div>
			)}

			{/* 内容区：所有 tab 常挂载、非激活隐藏（编辑器草稿不丢） */}
			<div className="min-h-0 flex-1 overflow-hidden">
				{state.tabs.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
						<div className="text-sm font-medium text-owl-muted">工作台</div>
						<div className="text-xs leading-relaxed text-owl-faint">
							浏览与编辑项目文件、查看 Git 变动。
							<br />
							聊天中生成的文件也会出现在这里。
						</div>
						<div className="mt-1 flex gap-2">
							<button type="button" className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-text hover:bg-owl-hover" onClick={() => openSingleton("files")}>
								打开文件树
							</button>
							<button type="button" className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-text hover:bg-owl-hover" onClick={() => openSingleton("changes")}>
								文件变动
							</button>
						</div>
					</div>
				) : (
					state.tabs.map((tab) => {
						const def = registry.byKind.get(tab.kind);
						if (def === undefined) return null;
						const Component = def.component;
						const isActive = tab.id === activeTab?.id;
						return (
							<div key={tab.id} className={`h-full ${isActive ? "" : "hidden"}`}>
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center">
											<IconLoader size={18} className="animate-spin text-owl-faint" />
										</div>
									}
								>
									<Component {...tabPropsOf(tab.id)} />
								</Suspense>
							</div>
						);
					})
				)}
			</div>

			{/* 状态条：git 分支 + 桥状态占位 */}
			<div className="flex shrink-0 items-center gap-2 border-t border-owl-border/40 px-2.5 py-1 text-[10px] text-owl-faint">
				{gitStatus === undefined ? (
					<IconLoader size={10} className="animate-spin" />
				) : gitStatus.repo ? (
					<>
						<IconGitBranch size={10} />
						<span className="truncate">{gitStatus.branch ?? "HEAD"}</span>
						<span className="ml-auto shrink-0">{gitStatus.entries.length} 个变更</span>
					</>
				) : (
					<span>非 Git 仓库</span>
				)}
			</div>
		</aside>
	);
}
