import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProviderModelsMessage } from "../bridge/protocol.ts";
import { isThemePreference, setThemePreference } from "../theme.ts";
import { IconCode, IconInfo, IconPlug, IconSettings, IconSliders, IconSun } from "./icons.tsx";

const API_OPTIONS = [
	{ value: "openai-completions", label: "OpenAI 兼容（openai-completions）" },
	{ value: "anthropic-messages", label: "Anthropic 兼容（anthropic-messages）" },
	{ value: "openai-responses", label: "OpenAI Responses（openai-responses）" },
];

type SettingsSection = "general" | "models" | "packages" | "appearance" | "json" | "about";

type PackageEntry = string | { source: string; extensions?: string[] };

function pkgLabel(entry: PackageEntry): string {
	return typeof entry === "string" ? entry : entry.source;
}

/** 设置侧栏导航项 */
function NavItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
				active ? "bg-owl-hover font-medium text-owl-text" : "text-owl-muted hover:bg-owl-hover/50 hover:text-owl-text"
			}`}
		>
			{icon}
			{label}
		</button>
	);
}

/** 设置分区标题 + 描述（对齐 Claude/ChatGPT 设置页的版式） */
function SectionHeader({ title, desc }: { title: string; desc?: string }): React.JSX.Element {
	return (
		<div className="mb-4">
			<h2 className="text-sm font-semibold text-owl-text">{title}</h2>
			{desc && <p className="mt-1 text-[11px] leading-relaxed text-owl-faint">{desc}</p>}
		</div>
	);
}

/** 设置行：左侧标题/说明，右侧控件；长路径类设置可传 children 全宽铺开 */
function SettingRow({
	title,
	desc,
	control,
	children,
}: {
	title: string;
	desc?: string;
	control?: React.ReactNode;
	children?: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="rounded-xl border border-owl-border bg-owl-sidebar/40 px-3 py-2.5">
			<div className="flex items-center justify-between gap-4">
				<div className="min-w-0">
					<div className="text-xs font-semibold text-owl-text">{title}</div>
					{desc && <div className="mt-0.5 text-[11px] leading-relaxed text-owl-faint">{desc}</div>}
				</div>
				{control && <div className="shrink-0">{control}</div>}
			</div>
			{children && <div className="mt-2">{children}</div>}
		</div>
	);
}

/** 设置弹窗：左侧分类导航 + 右侧内容区（常规 / 模型 / 扩展 / 外观 / JSON / 关于）。 */
export function SettingsPage({
	client,
	workspaceDir,
	onWorkspaceDir,
	onClose,
}: {
	client: BridgeClient;
	workspaceDir: string;
	onWorkspaceDir: (dir: string) => void;
	onClose: () => void;
}): React.JSX.Element {
	const [section, setSection] = useState<SettingsSection>("general");
	const [agentDir, setAgentDir] = useState("");
	const [settingsObj, setSettingsObj] = useState<Record<string, unknown>>({});
	const [raw, setRaw] = useState("");
	const [shellPath, setShellPath] = useState("");
	const [savedMsg, setSavedMsg] = useState("");
	const [groups, setGroups] = useState<ProviderModelsMessage[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 添加供应商表单
	const [showProviderForm, setShowProviderForm] = useState(false);
	const [pKey, setPKey] = useState("");
	const [pName, setPName] = useState("");
	const [pUrl, setPUrl] = useState("");
	const [pApi, setPApi] = useState("openai-completions");
	const [pApiKey, setPApiKey] = useState("");

	// 添加模型表单（按供应商）
	const [modelFormFor, setModelFormFor] = useState<string | null>(null);
	const [mId, setMId] = useState("");
	const [mName, setMName] = useState("");
	const [mCtx, setMCtx] = useState("");
	const [mMax, setMMax] = useState("");
	const [mReasoning, setMReasoning] = useState(false);

	// 快捷接入（像 /login：选厂商 → 登录或贴 Key）
	const [catalog, setCatalog] = useState<{ id: string; name: string; oauth: boolean; apiKey: boolean }[]>([]);
	const [quickProvider, setQuickProvider] = useState("");
	const [quickKey, setQuickKey] = useState("");
	const [quickHint, setQuickHint] = useState("");
	const [loginAsk, setLoginAsk] = useState<{ type: string; message?: string; placeholder?: string; options?: { id: string; label: string }[] } | null>(null);
	const [askAnswer, setAskAnswer] = useState("");

	// 扩展与插件：新增输入框
	const [pkgInput, setPkgInput] = useState("");
	const [extInput, setExtInput] = useState("");

	useEffect(() => {
		const off = client.onSessionEvent((msg) => {
			const ev = msg.event as {
				type?: string;
				ask?: { type: string; message?: string; placeholder?: string; options?: { id: string; label: string }[] };
				detail?: { type?: string; message?: string; userCode?: string; verificationUri?: string };
			};
			if (ev?.type === "auth_prompt" && ev.ask) {
				setLoginAsk(ev.ask);
				setAskAnswer("");
			} else if (ev?.type === "auth_notify" && ev.detail) {
				const d = ev.detail;
				if (d.type === "device_code") setQuickHint(`验证页面已在浏览器打开 — 输入设备码：${d.userCode}`);
				else if (d.type === "auth_url") setQuickHint("已打开浏览器，请在浏览器完成授权…");
				else if (d.message) setQuickHint(d.message);
			}
		});
		return off;
	}, [client]);

	useEffect(() => {
		return () => {
			if (savedTimer.current) clearTimeout(savedTimer.current);
		};
	}, []);

	function respondPrompt(answer: string) {
		setLoginAsk(null);
		setAskAnswer("");
		setQuickHint("已提交，等待登录流程继续…");
		void client.request({ type: "auth.prompt.respond", answer });
	}

	function apply(response: { ok: boolean; result?: unknown; error?: string }): boolean {
		if (response.ok && Array.isArray(response.result)) {
			setGroups(response.result as ProviderModelsMessage[]);
			setError("");
			return true;
		}
		if (!/取消/.test(response.error ?? "")) setError(response.error ?? "操作失败");
		return false;
	}

	useEffect(() => {
		void (async () => {
			const [settings, models, providers] = await Promise.all([
				client.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" }),
				client.request<ProviderModelsMessage[]>({ type: "models.list" }),
				client.request<{ id: string; name: string; oauth: boolean; apiKey: boolean }[]>({ type: "auth.providers" }),
			]);
			if (settings.ok && settings.result) {
				const obj = (settings.result.settings ?? {}) as Record<string, unknown>;
				setAgentDir(settings.result.agentDir);
				setSettingsObj(obj);
				setRaw(JSON.stringify(obj, null, 2));
				if (typeof obj.shellPath === "string") setShellPath(obj.shellPath);
			}
			if (models.ok && Array.isArray(models.result)) setGroups(models.result as ProviderModelsMessage[]);
			if (providers.ok && Array.isArray(providers.result)) setCatalog(providers.result);
		})();
	}, [client]);

	function flashSaved() {
		setSavedMsg("已保存 ✓");
		if (savedTimer.current) clearTimeout(savedTimer.current);
		savedTimer.current = setTimeout(() => setSavedMsg(""), 2000);
	}

	/**
	 * 写回 settings.json。桥端 applyGlobalOverridesAndSave 做深合并：
	 * 对象键增量合并、数组整体替换 —— 所以改 packages/extensions 必须传完整数组。
	 */
	async function saveSettings(partial: Record<string, unknown>): Promise<boolean> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<Record<string, unknown>>({ type: "settings.set", values: partial });
			if (response.ok) {
				if (response.result && typeof response.result === "object") {
					setSettingsObj(response.result);
					setRaw(JSON.stringify(response.result, null, 2));
				}
				flashSaved();
				return true;
			}
			setError(response.error ?? "保存失败");
			return false;
		} finally {
			setBusy(false);
		}
	}

	function resetProviderForm() {
		setPKey("");
		setPName("");
		setPUrl("");
		setPApi("openai-completions");
		setPApiKey("");
	}

	async function run(request: Parameters<BridgeClient["request"]>[0]) {
		setBusy(true);
		setError("");
		try {
			apply(await client.request(request));
		} finally {
			setBusy(false);
		}
	}

	const packages = Array.isArray(settingsObj.packages) ? (settingsObj.packages as PackageEntry[]) : [];
	const extensions = Array.isArray(settingsObj.extensions) ? (settingsObj.extensions as string[]) : [];
	const theme = typeof settingsObj.theme === "string" ? settingsObj.theme : "dark";
	const version = typeof settingsObj.lastChangelogVersion === "string" ? settingsObj.lastChangelogVersion : "未知";
	const modelCount = groups.reduce((n, g) => n + g.models.length, 0);

	const input =
		"mt-1 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 font-mono text-sm text-owl-text outline-none transition-colors focus:border-owl-accent";
	const smallInput =
		"mt-1 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent";
	const btn =
		"rounded-lg border border-owl-border px-2.5 py-1 text-xs text-owl-muted transition-colors hover:border-owl-faint hover:text-owl-text disabled:opacity-40";
	const btnAccent =
		"rounded-lg bg-owl-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:opacity-40";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
			<div className="flex h-[80vh] w-[920px] flex-col overflow-hidden rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40">
				{/* ============ 头部 ============ */}
				<div className="flex items-center justify-between border-b border-owl-border px-4 py-3">
					<h2 className="text-sm font-semibold">设置</h2>
					<button type="button" className="text-owl-faint transition-colors hover:text-owl-text" onClick={onClose}>
						✕
					</button>
				</div>

				<div className="flex min-h-0 flex-1">
					{/* ============ 左侧分类导航 ============ */}
					<nav className="w-44 shrink-0 overflow-y-auto border-r border-owl-border bg-owl-sidebar/40 p-2">
						<div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-wider text-owl-faint">个人</div>
						<NavItem icon={<IconSettings />} label="常规" active={section === "general"} onClick={() => setSection("general")} />
						<NavItem icon={<IconSliders />} label="模型与供应商" active={section === "models"} onClick={() => setSection("models")} />
						<NavItem icon={<IconPlug />} label="扩展与插件" active={section === "packages"} onClick={() => setSection("packages")} />
						<NavItem icon={<IconSun />} label="外观" active={section === "appearance"} onClick={() => setSection("appearance")} />
						<div className="px-2.5 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-owl-faint">高级</div>
						<NavItem icon={<IconCode />} label="settings.json" active={section === "json"} onClick={() => setSection("json")} />
						<NavItem icon={<IconInfo />} label="关于" active={section === "about"} onClick={() => setSection("about")} />
					</nav>

					{/* ============ 右侧内容区 ============ */}
					<div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-5">
						{error && <div className="rounded border border-red-800 bg-red-950/60 px-2 py-1 text-xs text-red-300">{error}</div>}

						{/* -------- 常规 -------- */}
						{section === "general" && (
							<>
								<SectionHeader title="常规" desc="工作目录与运行环境的基础设置。" />
								<SettingRow title="工作目录（新会话的 cwd）" desc="新建会话时使用的默认目录。">
									<input className={input} value={workspaceDir} onChange={(event) => onWorkspaceDir(event.target.value)} />
								</SettingRow>
								<SettingRow title="agent 目录（隔离的数据目录）" desc="存放 models.json、settings.json、会话历史等数据。">
									<input
										className="w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 font-mono text-xs text-owl-faint outline-none"
										value={agentDir}
										readOnly
									/>
								</SettingRow>
								<SettingRow
									title="Shell 路径"
									desc="执行命令使用的 shell 可执行文件；修改后新会话生效。"
									control={
										<button type="button" className={btnAccent} disabled={busy} onClick={() => void saveSettings({ shellPath })}>
											保存
										</button>
									}
								>
									<input className={smallInput} value={shellPath} onChange={(event) => setShellPath(event.target.value)} placeholder="如 D:\\developTool\\git\\Git\\bin\\bash.exe" />
								</SettingRow>
							</>
						)}

						{/* -------- 模型与供应商 -------- */}
						{section === "models" && (
							<>
								<SectionHeader
									title="模型与供应商"
									desc="模型只来自你在这里添加的声明（保存到 agent 目录的 models.json），不内置任何目录。新会话立即生效。"
								/>

								{/* 快捷接入：像 /login 一样选厂商 */}
								<div className="rounded-xl border border-owl-border bg-owl-sidebar/60 p-3">
									<div className="text-xs font-semibold text-owl-text">快捷接入（选厂商 → 浏览器登录或贴 API Key）</div>
									<select
										className="mt-2 w-full rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-sm text-owl-text outline-none focus:border-owl-accent"
										value={quickProvider}
										onChange={(e) => {
											setQuickProvider(e.target.value);
											setQuickKey("");
											setQuickHint("");
										}}
									>
										<option value="">选择厂商…</option>
										{catalog.map((p) => (
											<option key={p.id} value={p.id}>
												{p.name} ({p.id}){p.oauth ? " · 可浏览器登录" : ""}
											</option>
										))}
									</select>
									{quickProvider && (
										<div className="mt-2 space-y-2">
											<div className="flex gap-2">
												<input
													className="flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
													value={quickKey}
													onChange={(e) => setQuickKey(e.target.value)}
													placeholder="粘贴 API Key…"
												/>
												<button
													type="button"
													className={btnAccent}
													disabled={busy || !quickKey.trim()}
													onClick={() => {
														setQuickHint("正在保存 Key…");
														void client
															.request({ type: "auth.login", provider: quickProvider, authType: "api_key", apiKey: quickKey.trim() })
															.then((response) => {
																if (!apply(response)) return;
																setQuickKey("");
																setQuickHint("API Key 已保存 ✓ 该厂商的模型已可用");
																return client.request<ProviderModelsMessage[]>({ type: "models.list" }).then(apply);
															});
													}}
												>
													保存 API Key
												</button>
											</div>
											{catalog.find((p) => p.id === quickProvider)?.oauth && (
												<button
													type="button"
													className={btn}
													disabled={busy}
													onClick={() => {
														setQuickHint("正在启动登录流程…");
														void client
															.request({ type: "auth.login", provider: quickProvider, authType: "oauth" })
															.then((response) => {
																if (!apply(response)) return;
																setQuickHint("登录成功 ✓ 该厂商的模型已可用");
																return client.request<ProviderModelsMessage[]>({ type: "models.list" }).then(apply);
															});
													}}
												>
													浏览器登录（OAuth）
												</button>
											)}
											{quickHint && <div className="text-[11px] text-owl-muted">{quickHint}</div>}
											{loginAsk && (
												<div className="rounded border border-amber-700 bg-amber-950/40 p-2">
													<div className="text-[11px] text-amber-200">{loginAsk.message ?? "登录流程需要输入"}</div>
													{(loginAsk.type === "text" || loginAsk.type === "secret" || loginAsk.type === "manual_code") && (
														<div className="mt-1.5 flex gap-2">
															<input
																autoFocus
																type={loginAsk.type === "secret" ? "password" : "text"}
																className="flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
																value={askAnswer}
																placeholder={loginAsk.placeholder}
																onChange={(e) => setAskAnswer(e.target.value)}
																onKeyDown={(e) => {
																	if (e.key === "Enter" && askAnswer.trim()) respondPrompt(askAnswer.trim());
																}}
															/>
															<button type="button" className={btnAccent} onClick={() => respondPrompt(askAnswer.trim())}>
																提交
															</button>
														</div>
													)}
													{loginAsk.type === "select" && (
														<div className="mt-1.5 flex flex-wrap gap-1">
															{(loginAsk.options ?? []).map((o) => (
																<button key={o.id} type="button" className={btn} onClick={() => respondPrompt(o.id)}>
																	{o.label}
																</button>
															))}
														</div>
													)}
													<div className="mt-1.5 text-right">
														<button
															type="button"
															className="text-[11px] text-owl-faint transition-colors hover:text-red-400"
															onClick={() => {
																setLoginAsk(null);
																void client.request({ type: "auth.cancel" }).then(() => setQuickHint("登录已取消"));
															}}
														>
															取消登录
														</button>
													</div>
												</div>
											)}
										</div>
									)}
								</div>

								<div className="flex items-center justify-between">
									<div className="text-xs font-semibold text-owl-muted">已添加的供应商（{groups.length}）</div>
									<button
										type="button"
										className={btn}
										disabled={busy}
										onClick={() => {
											setShowProviderForm((v) => !v);
											setModelFormFor(null);
										}}
									>
										{showProviderForm ? "收起" : "+ 添加供应商"}
									</button>
								</div>

								{showProviderForm && (
									<div className="space-y-2 rounded-xl border border-owl-border bg-owl-sidebar/60 p-3">
										<div className="grid grid-cols-2 gap-2">
											<label className="block text-[11px] text-owl-muted">
												供应商 ID *（字母数字开头，可含 . _ -）
												<input className={input} value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder="如 zai" />
											</label>
											<label className="block text-[11px] text-owl-muted">
												显示名
												<input className={input} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="如 Z.AI 智谱" />
											</label>
											<label className="block text-[11px] text-owl-muted">
												Base URL *
												<input className={input} value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder="https://..." />
											</label>
											<label className="block text-[11px] text-owl-muted">
												API 协议 *
												<select className={input} value={pApi} onChange={(e) => setPApi(e.target.value)}>
													{API_OPTIONS.map((o) => (
														<option key={o.value} value={o.value}>
															{o.label}
														</option>
													))}
												</select>
											</label>
										</div>
										<label className="block text-[11px] text-owl-muted">
											API Key（也可以填 <code>$环境变量名</code> 引用）
											<input className={input} value={pApiKey} onChange={(e) => setPApiKey(e.target.value)} placeholder="sk-..." />
										</label>
										<div className="flex justify-end gap-2">
											<button type="button" className={btn} onClick={resetProviderForm}>
												清空
											</button>
											<button
												type="button"
												className={btnAccent}
												disabled={busy || !pKey.trim() || !pUrl.trim()}
												onClick={() => {
													void run({
														type: "models.putProvider",
														provider: {
															key: pKey.trim(),
															...(pName.trim() ? { name: pName.trim() } : {}),
															baseUrl: pUrl.trim(),
															api: pApi,
															...(pApiKey.trim() ? { apiKey: pApiKey.trim() } : {}),
														},
													}).then(() => {
														resetProviderForm();
														setShowProviderForm(false);
													});
												}}
											>
												保存供应商
											</button>
										</div>
									</div>
								)}

								<div className="space-y-2">
									{groups.length === 0 && (
										<div className="rounded-xl border border-dashed border-owl-border px-3 py-4 text-center text-xs text-owl-faint">
											还没有任何模型 — 点右上角「+ 添加供应商」开始
										</div>
									)}
									{groups.map((group) => (
										<div key={group.id} className="rounded-xl border border-owl-border bg-owl-sidebar/40 p-3">
											<div className="flex items-center justify-between">
												<div className="text-xs font-semibold text-owl-text">
													{group.name ?? group.id} <span className="font-normal text-owl-faint">({group.id})</span>
												</div>
												<button
													type="button"
													className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-40"
													disabled={busy}
													onClick={() => {
														if (!window.confirm(`删除供应商 ${group.id} 及其全部模型？`)) return;
														void run({ type: "models.removeProvider", providerKey: group.id });
													}}
												>
													删除供应商
												</button>
											</div>
											<div className="mt-2 space-y-1">
												{group.models.map((model) => (
													<div key={model.id} className="flex items-center justify-between rounded-lg bg-owl-panel px-2 py-1">
														<span className="font-mono text-xs text-owl-text">
															{model.id}
															{model.contextWindow ? <span className="text-owl-faint"> · {Math.round(model.contextWindow / 1000)}k</span> : null}
														</span>
														<button
															type="button"
															className="text-[11px] text-owl-faint transition-colors hover:text-red-400 disabled:opacity-40"
															disabled={busy}
															onClick={() => void run({ type: "models.removeModel", providerKey: group.id, modelId: model.id })}
														>
															删除
														</button>
													</div>
												))}
												{group.models.length === 0 && <div className="text-[11px] text-owl-faint">该供应商还没有模型</div>}
											</div>

											{modelFormFor === group.id ? (
												<div className="mt-2 space-y-2 rounded-lg border border-owl-border p-2">
													<div className="grid grid-cols-2 gap-2">
														<label className="block text-[11px] text-owl-muted">
															模型 ID *
															<input className={smallInput} value={mId} onChange={(e) => setMId(e.target.value)} placeholder="如 glm-5.3-flash" />
														</label>
														<label className="block text-[11px] text-owl-muted">
															显示名
															<input className={smallInput} value={mName} onChange={(e) => setMName(e.target.value)} />
														</label>
														<label className="block text-[11px] text-owl-muted">
															上下文窗口（tokens）
															<input className={smallInput} value={mCtx} onChange={(e) => setMCtx(e.target.value)} placeholder="128000" />
														</label>
														<label className="block text-[11px] text-owl-muted">
															最大输出（tokens）
															<input className={smallInput} value={mMax} onChange={(e) => setMMax(e.target.value)} placeholder="8192" />
														</label>
													</div>
													<label className="flex items-center gap-1.5 text-[11px] text-owl-muted">
														<input type="checkbox" checked={mReasoning} onChange={(e) => setMReasoning(e.target.checked)} />
														推理模型
													</label>
													<div className="flex justify-end gap-2">
														<button type="button" className={btn} onClick={() => setModelFormFor(null)}>
															取消
														</button>
														<button
															type="button"
															className={btnAccent}
															disabled={busy || !mId.trim()}
															onClick={() => {
																void run({
																	type: "models.putModel",
																	providerKey: group.id,
																	model: {
																		id: mId.trim(),
																		...(mName.trim() ? { name: mName.trim() } : {}),
																		...(Number(mCtx) > 0 ? { contextWindow: Number(mCtx) } : {}),
																		...(Number(mMax) > 0 ? { maxTokens: Number(mMax) } : {}),
																		reasoning: mReasoning,
																	},
																}).then(() => {
																	setMId("");
																	setMName("");
																	setMCtx("");
																	setMMax("");
																	setMReasoning(false);
																	setModelFormFor(null);
																});
															}}
														>
															保存模型
														</button>
													</div>
												</div>
											) : (
												<button
													type="button"
													className={`mt-2 ${btn}`}
													disabled={busy}
													onClick={() => {
														setModelFormFor(group.id);
														setShowProviderForm(false);
													}}
												>
													+ 添加模型
												</button>
											)}
										</div>
									))}
								</div>
							</>
						)}

						{/* -------- 扩展与插件 -------- */}
						{section === "packages" && (
							<>
								<SectionHeader title="扩展与插件" desc="settings.json 的 packages / extensions 列表；修改后新会话生效。" />
								<SettingRow title={`扩展包（packages，${packages.length}）`} desc="支持 npm:包名 形式；对象条目可带附加扩展入口。">
									<div className="flex gap-2">
										<input
											className={`${smallInput} min-w-0 flex-1`}
											value={pkgInput}
											onChange={(event) => setPkgInput(event.target.value)}
											placeholder="npm:some-package"
											onKeyDown={(event) => {
												if (event.key === "Enter" && pkgInput.trim()) {
													void saveSettings({ packages: [...packages, pkgInput.trim()] }).then((ok) => {
														if (ok) setPkgInput("");
													});
												}
											}}
										/>
										<button
											type="button"
											className={`${btnAccent} shrink-0`}
											disabled={busy || !pkgInput.trim()}
											onClick={() => {
												void saveSettings({ packages: [...packages, pkgInput.trim()] }).then((ok) => {
													if (ok) setPkgInput("");
												});
											}}
										>
											添加
										</button>
									</div>
								</SettingRow>
								<div className="space-y-1">
									{packages.length === 0 && (
										<div className="rounded-xl border border-dashed border-owl-border px-3 py-3 text-center text-xs text-owl-faint">
											还没有安装任何扩展包
										</div>
									)}
									{packages.map((entry, index) => (
										<div key={`${pkgLabel(entry)}-${index}`} className="flex items-center justify-between rounded-lg border border-owl-border bg-owl-sidebar/40 px-2.5 py-1.5">
											<div className="min-w-0">
												<span className="block truncate font-mono text-xs text-owl-text">{pkgLabel(entry)}</span>
												{typeof entry === "object" && entry.extensions && entry.extensions.length > 0 && (
													<span className="mt-0.5 block text-[10px] text-owl-faint">扩展入口：{entry.extensions.join(", ")}</span>
												)}
											</div>
											<button
												type="button"
												className="ml-2 shrink-0 text-[11px] text-owl-faint transition-colors hover:text-red-400 disabled:opacity-40"
												disabled={busy}
												onClick={() => void saveSettings({ packages: packages.filter((_, i) => i !== index) })}
											>
												删除
											</button>
										</div>
									))}
								</div>
								<SettingRow title={`本地扩展（extensions，${extensions.length}）`} desc="直接加载的扩展脚本路径。">
									<div className="flex gap-2">
										<input
											className={`${smallInput} min-w-0 flex-1`}
											value={extInput}
											onChange={(event) => setExtInput(event.target.value)}
											placeholder="C:\\path\\to\\extension.ts"
											onKeyDown={(event) => {
												if (event.key === "Enter" && extInput.trim()) {
													void saveSettings({ extensions: [...extensions, extInput.trim()] }).then((ok) => {
														if (ok) setExtInput("");
													});
												}
											}}
										/>
										<button
											type="button"
											className={`${btnAccent} shrink-0`}
											disabled={busy || !extInput.trim()}
											onClick={() => {
												void saveSettings({ extensions: [...extensions, extInput.trim()] }).then((ok) => {
													if (ok) setExtInput("");
												});
											}}
										>
											添加
										</button>
									</div>
								</SettingRow>
								{extensions.length > 0 && (
									<div className="space-y-1">
										{extensions.map((entry, index) => (
											<div key={`${entry}-${index}`} className="flex items-center justify-between rounded-lg border border-owl-border bg-owl-sidebar/40 px-2.5 py-1.5">
												<span className="block truncate font-mono text-xs text-owl-text">{entry}</span>
												<button
													type="button"
													className="ml-2 shrink-0 text-[11px] text-owl-faint transition-colors hover:text-red-400 disabled:opacity-40"
													disabled={busy}
													onClick={() => void saveSettings({ extensions: extensions.filter((_, i) => i !== index) })}
												>
													删除
												</button>
											</div>
										))}
									</div>
								)}
							</>
						)}

						{/* -------- 外观 -------- */}
						{section === "appearance" && (
							<>
								<SectionHeader title="外观" desc="界面与主题配色。" />
								<SettingRow
									title="主题"
									desc="写入 settings.json 的 theme 字段，桌面界面即时生效；「跟随系统」依据操作系统的深浅色偏好自动切换。"
								>
									<select
										className="rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none focus:border-owl-accent"
										value={theme}
										disabled={busy}
										onChange={(event) => {
											const next = event.target.value;
											void saveSettings({ theme: next }).then((ok) => {
												if (ok && isThemePreference(next)) setThemePreference(next);
											});
										}}
									>
										<option value="dark">深色（dark）</option>
										<option value="light">浅色（light）</option>
										<option value="system">跟随系统（system）</option>
									</select>
								</SettingRow>
							</>
						)}

						{/* -------- settings.json（高级） -------- */}
						{section === "json" && (
							<>
								<SectionHeader title="settings.json（高级）" desc="直接编辑 JSON 原文并保存写回；其余分区保存后此文本会自动同步。" />
								<textarea
									className="h-96 w-full rounded-lg border border-owl-border bg-owl-sidebar p-2 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
									value={raw}
									onChange={(event) => setRaw(event.target.value)}
									spellCheck={false}
								/>
								<div className="flex justify-end">
									<button
										type="button"
										className={btnAccent}
										disabled={busy}
										onClick={() => {
											void (async () => {
												try {
													const values = JSON.parse(raw) as Record<string, unknown>;
													await saveSettings(values);
												} catch (error) {
													setError(error instanceof Error ? error.message : String(error));
												}
											})();
										}}
									>
										保存 settings.json
									</button>
								</div>
							</>
						)}

						{/* -------- 关于 -------- */}
						{section === "about" && (
							<>
								<SectionHeader title="关于" />
								<SettingRow title="Owl 桌面版" desc="基于 pi coding agent 的桌面封装。">
									<span className="font-mono text-xs text-owl-muted">v{version}</span>
								</SettingRow>
								<SettingRow title="agent 目录" desc="隔离的数据目录。">
									<span className="max-w-[360px] truncate font-mono text-xs text-owl-muted">{agentDir || "—"}</span>
								</SettingRow>
								<SettingRow title="已配置模型" desc="来自 models.json 的声明。">
									<span className="text-xs text-owl-muted">
										{groups.length} 个供应商 · {modelCount} 个模型
									</span>
								</SettingRow>
							</>
						)}
					</div>
				</div>

				{/* ============ 底部 ============ */}
				<div className="flex items-center justify-between border-t border-owl-border px-4 py-3">
					<span className="text-xs text-owl-muted">{savedMsg}</span>
					<button
						type="button"
						className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={onClose}
					>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
