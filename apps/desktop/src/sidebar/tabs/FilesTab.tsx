/**
 * 文件 tab：懒加载目录树 + 全局搜索 + 右键操作 + watch 实时刷新。
 *
 * 结构与 dsh-better-sidebar 的 FileTree 同构：展开哪层列哪层（服务端 TTL
 * 缓存吸收重列）；展开目录集同步给宿主 watch（fs_changed 事件只增量重列
 * 被改的层）；Git 状态着色来自 Workbench 下发的 gitStatus 快照。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsEntry, FsListing, FsSearchHit } from "../../bridge/protocol.ts";
import type { TabComponentProps } from "../registry.ts";
import { useSidebarState } from "../store.ts";
import {
	IconChevronDown,
	IconChevronRight,
	IconCopy,
	IconExternal,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconImage,
	IconLoader,
	IconPencil,
	IconRefresh,
	IconSearch,
	IconTrash,
	IconX,
} from "../icons.tsx";

interface TreeRow {
	entry: FsEntry;
	depth: number;
}

interface MenuState {
	x: number;
	y: number;
	entry: FsEntry;
}

/** 目录行在"压缩一层"语义下的树行展开（展开的目录才带子行）。 */
function flatten(
	listing: FsListing | undefined,
	depth: number,
	expanded: ReadonlySet<string>,
	listings: ReadonlyMap<string, FsListing>,
	out: TreeRow[],
): void {
	if (listing === undefined) return;
	for (const entry of listing.entries) {
		out.push({ entry, depth });
		if (entry.isDir && expanded.has(entry.path)) {
			flatten(listings.get(entry.path), depth + 1, expanded, listings, out);
		}
	}
}

/** 扩展名 → 图标色（简单的开发文件着色，够用即可）。 */
function fileColor(path: string): string {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "text-sky-300";
	if (["json", "yaml", "yml", "toml"].includes(ext)) return "text-amber-300";
	if (["md", "txt"].includes(ext)) return "text-owl-muted";
	if (["rs"].includes(ext)) return "text-orange-300";
	if (["py"].includes(ext)) return "text-emerald-300";
	if (["css", "scss", "html"].includes(ext)) return "text-fuchsia-300";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext)) return "text-violet-300";
	if (["gitignore", "lock"].includes(ext) || name === ".gitignore" || name.endsWith(".lock")) return "text-owl-faint";
	return "text-owl-muted";
}

/** Git 状态 → 行色与状态字母（VS Code 同款映射）。 */
function gitDecoration(path: string, git: TabComponentProps["gitStatus"]): { color: string; letter: string } | undefined {
	if (git === undefined || !git.repo) return undefined;
	for (const entry of git.entries) {
		const entryPath = entry.path.split("\\").join("/");
		if (entryPath !== path && !path.startsWith(`${entryPath}/`)) continue;
		const x = entry.x;
		const y = entry.y;
		const letter = x !== " " && x !== "?" ? x : y;
		if (y === "?") return { color: "text-emerald-300/80", letter: "U" };
		if (letter === "A") return { color: "text-emerald-300", letter: "A" };
		if (letter === "D") return { color: "text-red-400", letter: "D" };
		if (letter === "R" || letter === "C") return { color: "text-sky-300", letter: "R" };
		if (letter === "M" || letter === "T") return { color: "text-amber-300", letter: "M" };
		return { color: "text-owl-muted", letter };
	}
	return undefined;
}

export function FilesTab({ api, store, cwd, onOpenFile, gitStatus }: TabComponentProps): React.JSX.Element {
	const state = useSidebarState(store);
	const expanded = useMemo(() => new Set<string>(state.expanded), [state.expanded]);
	// 列表缓存 + 版本号：缓存变更用 version 触发重渲染（Map 本身引用稳定）。
	const cacheRef = useRef(new Map<string, FsListing>());
	const [version, setVersion] = useState(0);
	const bump = useCallback(() => setVersion((v) => v + 1), []);
	const [loading, setLoading] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | undefined>(undefined);
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [hits, setHits] = useState<FsSearchHit[] | undefined>(undefined);
	const [menu, setMenu] = useState<MenuState | undefined>(undefined);
	const [renaming, setRenaming] = useState<{ path: string; name: string } | undefined>(undefined);
	const [creating, setCreating] = useState<{ parent: string; name: string } | undefined>(undefined);
	const [confirming, setConfirming] = useState<FsEntry | undefined>(undefined);
	const searchSeq = useRef(0);

	const markLoading = useCallback((dir: string, on: boolean): void => {
		setLoading((current) => {
			const next = new Set(current);
			if (on) next.add(dir);
			else next.delete(dir);
			return next;
		});
	}, []);

	/** 列一层目录并进缓存（force=true 跳过"缓存命中"判断直接重取）。 */
	const reload = useCallback(
		async (dir: string, force = true): Promise<void> => {
			if (!force && cacheRef.current.has(dir)) return;
			markLoading(dir, true);
			try {
				const listing = await api.fsTree(cwd, dir);
				cacheRef.current.set(dir, listing);
				setError(undefined);
			} catch (err) {
				cacheRef.current.delete(dir);
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				markLoading(dir, false);
				bump();
			}
		},
		[api, cwd, markLoading, bump],
	);

	// 首次 + 展开目录变化：确保已展开层的列表在缓存里。
	useEffect(() => {
		const dirs = ["", ...state.expanded];
		let cancelled = false;
		void (async () => {
			for (const dir of dirs) {
				if (cancelled) return;
				if (cacheRef.current.has(dir) || loading.has(dir)) continue;
				await reload(dir, false);
			}
		})();
		return () => {
			cancelled = true;
		};
		// loading 不进依赖：只作为跳过条件读取当次值
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state.expanded, reload]);

	// fs_changed：被改的目录若在缓存中则重列（未展开/未缓存的层等展开时再取）。
	useEffect(() => {
		return store.onFsChanged((dirs) => {
			for (const dir of dirs) {
				if (cacheRef.current.has(dir)) void reload(dir);
			}
		});
	}, [store, reload]);

	// 展开目录集同步给宿主 watch（根目录常驻）。
	useEffect(() => {
		void api.watchSet(cwd, ["", ...state.expanded]).catch(() => {});
	}, [api, cwd, state.expanded]);

	// 搜索（300ms 防抖；清空即回树）。
	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed === "") {
			setHits(undefined);
			setSearching(false);
			return;
		}
		setSearching(true);
		const seq = ++searchSeq.current;
		const timer = setTimeout(() => {
			void api
				.fsSearch(cwd, trimmed)
				.then((result) => {
					if (searchSeq.current === seq) setHits(result);
				})
				.catch(() => {
					if (searchSeq.current === seq) setHits([]);
				});
		}, 300);
		return () => clearTimeout(timer);
	}, [api, cwd, query]);

	const onRowClick = (entry: FsEntry): void => {
		if (entry.isDir) {
			store.toggleExpanded(entry.path);
			return;
		}
		onOpenFile(entry.path);
	};

	const rows = useMemo(() => {
		void version; // 缓存刷新靠 version 触发
		const out: TreeRow[] = [];
		flatten(cacheRef.current.get(""), 0, expanded, cacheRef.current, out);
		return out;
	}, [version, expanded]);

	const doRename = async (): Promise<void> => {
		if (renaming === undefined) return;
		const { path, name } = renaming;
		setRenaming(undefined);
		if (name === "" || name === path.split("/").pop()) return;
		try {
			const result = await api.fsRename(cwd, path, name);
			const parent = path.split("/").slice(0, -1).join("/");
			store.remapPath(path, result.path);
			await reload(parent);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const doCreate = async (): Promise<void> => {
		if (creating === undefined) return;
		const { parent, name } = creating;
		setCreating(undefined);
		if (name === "") return;
		try {
			await api.fsMkdir(cwd, parent, name);
			if (parent !== "") store.expandTo(`${parent}/${name}`);
			await reload(parent);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const doDelete = async (): Promise<void> => {
		if (confirming === undefined) return;
		const entry = confirming;
		setConfirming(undefined);
		try {
			await api.fsRemove(cwd, entry.path);
			store.dropPath(entry.path);
			const parent = entry.path.split("/").slice(0, -1).join("/");
			await reload(parent);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const absoluteOf = (rel: string): string => `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}`;

	const menuItems = (entry: FsEntry): { label: string; icon: React.ReactNode; action: () => void; danger?: boolean }[] => {
		const items: { label: string; icon: React.ReactNode; action: () => void; danger?: boolean }[] = [
			{
				label: entry.isDir ? "展开/收起" : "打开",
				icon: <IconFile size={14} />,
				action: () => onRowClick(entry),
			},
		];
		if (!entry.isDir) {
			items.push({
				label: "用 VS Code 打开",
				icon: <IconExternal size={14} />,
				action: () => void api.openExternal("url", `vscode://file/${absoluteOf(entry.path)}`).catch(() => {}),
			});
		}
		items.push(
			{
				label: "在资源管理器中显示",
				icon: <IconExternal size={14} />,
				action: () => void api.openExternal("reveal", entry.path, cwd).catch(() => {}),
			},
			{
				label: "新建文件夹",
				icon: <IconFolderPlus size={14} />,
				action: () => {
					const parent = entry.isDir ? entry.path : entry.path.split("/").slice(0, -1).join("/");
					if (!entry.isDir) store.expandTo(parent);
					setCreating({ parent, name: "" });
				},
			},
			{
				label: "重命名",
				icon: <IconPencil size={14} />,
				action: () => setRenaming({ path: entry.path, name: entry.name }),
			},
			{
				label: "复制相对路径",
				icon: <IconCopy size={14} />,
				action: () => void navigator.clipboard.writeText(entry.path).catch(() => {}),
			},
			{
				label: "复制完整路径",
				icon: <IconCopy size={14} />,
				action: () => void navigator.clipboard.writeText(absoluteOf(entry.path)).catch(() => {}),
			},
			{
				label: "删除",
				icon: <IconTrash size={14} />,
				danger: true,
				action: () => setConfirming(entry),
			},
		);
		return items;
	};

	const rowIcon = (entry: FsEntry, isOpen: boolean): React.ReactNode => {
		if (entry.isSymlink && entry.broken) return <IconFile size={14} className="text-red-400" />;
		if (entry.isDir) return isOpen ? <IconFolderOpen size={14} className="text-owl-accent" /> : <IconFolder size={14} className="text-owl-accent" />;
		if (!entry.isDir && /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|avif)$/i.test(entry.name)) {
			return <IconImage size={14} className={fileColor(entry.path)} />;
		}
		return <IconFile size={14} className={fileColor(entry.path)} />;
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* 工具条 */}
			<div className="flex items-center gap-1 border-b border-owl-border/40 px-2 py-1.5">
				<div className="relative flex-1">
					<IconSearch size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-owl-faint" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="搜索文件名…"
						spellCheck={false}
						className="w-full rounded-md border border-owl-border/50 bg-owl-panel py-1 pr-6 pl-7 text-xs text-owl-text placeholder:text-owl-faint focus:border-owl-accent/60 focus:outline-none"
					/>
					{query !== "" && (
						<button
							type="button"
							className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-owl-faint hover:text-owl-text"
							onClick={() => setQuery("")}
						>
							<IconX size={12} />
						</button>
					)}
				</div>
				<button
					type="button"
					title="新建文件夹"
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
					onClick={() => setCreating({ parent: "", name: "" })}
				>
					<IconFolderPlus size={14} />
				</button>
				<button
					type="button"
					title="刷新"
					className="rounded-md p-1.5 text-owl-muted hover:bg-owl-hover hover:text-owl-text"
					onClick={() => {
						cacheRef.current.clear();
						void reload("", false);
					}}
				>
					<IconRefresh size={14} />
				</button>
			</div>

			{error !== undefined && (
				<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
					{error}
					<button type="button" className="ml-2 underline" onClick={() => setError(undefined)}>
						关闭
					</button>
				</div>
			)}

			{/* 主体 */}
			<div className="min-h-0 flex-1 overflow-y-auto py-1" onClick={() => setMenu(undefined)}>
				{searching && hits === undefined && (
					<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
						<IconLoader size={13} className="animate-spin" /> 搜索中…
					</div>
				)}
				{hits !== undefined && (
					<div className="px-1">
						<div className="px-2 py-1 text-[11px] text-owl-faint">
							{hits.length === 0 ? "没有匹配的文件" : `${hits.length} 个匹配`}
						</div>
						{hits.map((hit) => (
							<button
								key={hit.path}
								type="button"
								className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-owl-text hover:bg-owl-hover"
								onClick={() => {
									if (hit.isDir) {
										store.expandTo(hit.path);
										setQuery("");
									} else {
										onOpenFile(hit.path);
									}
								}}
							>
								{hit.isDir ? <IconFolder size={13} className="text-owl-accent" /> : <IconFile size={13} className={fileColor(hit.path)} />}
								<span className="truncate">{hit.path}</span>
							</button>
						))}
					</div>
				)}
				{hits === undefined && !searching && (
					<>
						{rows.length === 0 && !loading.has("") && (
							<div className="px-3 py-6 text-center text-xs text-owl-faint">目录为空</div>
						)}
						{rows.map(({ entry, depth }) => {
							const isOpen = expanded.has(entry.path);
							const isRenaming = renaming?.path === entry.path;
							const decoration = gitDecoration(entry.path, gitStatus);
							return (
								<div key={entry.path} style={{ paddingLeft: depth * 12 }}>
									{isRenaming ? (
										<input
											autoFocus
											value={renaming.name}
											onChange={(e) => setRenaming({ path: entry.path, name: e.target.value })}
											onKeyDown={(e) => {
												if (e.key === "Enter") void doRename();
												if (e.key === "Escape") setRenaming(undefined);
											}}
											onBlur={() => void doRename()}
											className="mx-2 my-0.5 w-[calc(100%-1rem)] rounded border border-owl-accent/60 bg-owl-panel px-1.5 py-0.5 text-xs text-owl-text focus:outline-none"
										/>
									) : (
										<div
											role="button"
											tabIndex={0}
											onClick={() => onRowClick(entry)}
											onContextMenu={(e) => {
												e.preventDefault();
												setMenu({ x: e.clientX, y: e.clientY, entry });
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") onRowClick(entry);
											}}
											className={`group flex cursor-pointer items-center gap-1 rounded-md py-[3px] pr-2 hover:bg-owl-hover ${entry.hidden ? "opacity-60" : ""}`}
										>
											<span className="flex w-4 shrink-0 justify-center text-owl-faint">
												{entry.isDir ? (isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />) : null}
											</span>
											{rowIcon(entry, isOpen)}
											<span className={`truncate text-xs ${decoration?.color ?? "text-owl-text"}`} title={entry.path}>
												{entry.name}
											</span>
											{decoration !== undefined && (
												<span className={`ml-auto shrink-0 text-[10px] font-semibold ${decoration.color}`}>{decoration.letter}</span>
											)}
											{loading.has(entry.path) && <IconLoader size={11} className="ml-auto shrink-0 animate-spin text-owl-faint" />}
										</div>
									)}
									{creating?.parent === entry.path && (
										<div style={{ paddingLeft: 16 }}>
											<input
												autoFocus
												value={creating.name}
												onChange={(e) => setCreating({ parent: creating.parent, name: e.target.value })}
												onKeyDown={(e) => {
													if (e.key === "Enter") void doCreate();
													if (e.key === "Escape") setCreating(undefined);
												}}
												onBlur={() => void doCreate()}
												placeholder="新文件夹名"
												className="mx-2 my-0.5 w-[calc(100%-1rem)] rounded border border-owl-accent/60 bg-owl-panel px-1.5 py-0.5 text-xs text-owl-text focus:outline-none"
											/>
										</div>
									)}
								</div>
							);
						})}
						{creating?.parent === "" && (
							<input
								autoFocus
								value={creating.name}
								onChange={(e) => setCreating({ parent: "", name: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter") void doCreate();
									if (e.key === "Escape") setCreating(undefined);
								}}
								onBlur={() => void doCreate()}
								placeholder="新文件夹名"
								className="mx-2 my-1 w-[calc(100%-1rem)] rounded border border-owl-accent/60 bg-owl-panel px-1.5 py-0.5 text-xs text-owl-text focus:outline-none"
							/>
						)}
						{loading.has("") && rows.length === 0 && (
							<div className="flex items-center gap-2 px-3 py-2 text-xs text-owl-faint">
								<IconLoader size={13} className="animate-spin" /> 加载中…
							</div>
						)}
					</>
				)}
			</div>

			{/* 右键菜单 */}
			{menu !== undefined && (
				<>
					<div className="fixed inset-0 z-40" onClick={() => setMenu(undefined)} onContextMenu={(e) => { e.preventDefault(); setMenu(undefined); }} />
					<div
						className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-owl-border bg-owl-panel py-1 shadow-xl"
						style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 320) }}
					>
						{menuItems(menu.entry).map((item) => (
							<button
								key={item.label}
								type="button"
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-owl-hover ${
									item.danger === true ? "text-red-300" : "text-owl-text"
								}`}
								onClick={() => {
									setMenu(undefined);
									item.action();
								}}
							>
								{item.icon}
								{item.label}
							</button>
						))}
					</div>
				</>
			)}

			{/* 删除确认 */}
			{confirming !== undefined && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirming(undefined)}>
					<div className="w-80 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
						<div className="text-sm font-medium text-owl-text">删除「{confirming.name}」？</div>
						<div className="mt-1.5 text-xs text-owl-muted">
							{confirming.isDir ? "目录将被递归删除" : "文件将被永久删除"}，此操作不可恢复。
						</div>
						<div className="mt-4 flex justify-end gap-2">
							<button type="button" className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-text hover:bg-owl-hover" onClick={() => setConfirming(undefined)}>
								取消
							</button>
							<button type="button" className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs text-white hover:bg-red-500" onClick={() => void doDelete()}>
								删除
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
