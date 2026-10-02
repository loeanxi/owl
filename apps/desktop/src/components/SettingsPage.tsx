import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProviderModelsMessage } from "../bridge/protocol.ts";

const API_OPTIONS = [
	{ value: "openai-completions", label: "OpenAI 兼容（openai-completions）" },
	{ value: "anthropic-messages", label: "Anthropic 兼容（anthropic-messages）" },
	{ value: "openai-responses", label: "OpenAI Responses（openai-responses）" },
];

/** 设置弹窗：工作目录 + 模型/供应商管理（models.json 可视化编辑）。 */
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
	const [agentDir, setAgentDir] = useState("");
	const [raw, setRaw] = useState("");
	const [saved, setSaved] = useState(false);
	const [groups, setGroups] = useState<ProviderModelsMessage[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

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
		setError(response.error ?? "操作失败");
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
				setAgentDir(settings.result.agentDir);
				setRaw(JSON.stringify(settings.result.settings, null, 2));
			}
			if (models.ok && Array.isArray(models.result)) setGroups(models.result as ProviderModelsMessage[]);
			if (providers.ok && Array.isArray(providers.result)) setCatalog(providers.result);
		})();
	}, [client]);

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

	const input =
		"mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm";
	const smallInput =
		"mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs";
	const btn =
		"rounded border border-neutral-700 px-2.5 py-1 text-xs hover:border-neutral-500 disabled:opacity-40";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="flex h-[85vh] w-[760px] flex-col rounded-lg border border-neutral-700 bg-neutral-900 p-4">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-semibold">设置</h2>
					<button type="button" className="text-neutral-500 hover:text-neutral-300" onClick={onClose}>
						✕
					</button>
				</div>

				<div className="mt-3 flex-1 space-y-5 overflow-y-auto pr-1">
					{error && <div className="rounded border border-red-800 bg-red-950/60 px-2 py-1 text-xs text-red-300">{error}</div>}

					{/* ============ 模型与供应商 ============ */}
					<section>
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-semibold text-neutral-300">模型与供应商</h3>
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
						<p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
							模型只来自你在这里添加的声明（保存到 agent 目录的 models.json），不内置任何目录。新会话立即生效。
						</p>

						{/* 快捷接入：像 /login 一样选厂商 */}
						<div className="rounded border border-neutral-700 bg-neutral-950/60 p-3">
							<div className="text-xs font-semibold text-neutral-200">快捷接入（选厂商 → 浏览器登录或贴 API Key）</div>
							<select
								className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm"
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
											className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"
											value={quickKey}
											onChange={(e) => setQuickKey(e.target.value)}
											placeholder="粘贴 API Key…"
										/>
										<button
											type="button"
											className="rounded bg-sky-800 px-3 py-1 text-xs hover:bg-sky-700 disabled:opacity-40"
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
									{quickHint && <div className="text-[11px] text-neutral-400">{quickHint}</div>}
									{loginAsk && (
										<div className="rounded border border-amber-700 bg-amber-950/40 p-2">
											<div className="text-[11px] text-amber-200">{loginAsk.message ?? "登录流程需要输入"}</div>
											{(loginAsk.type === "text" || loginAsk.type === "secret" || loginAsk.type === "manual_code") && (
												<div className="mt-1.5 flex gap-2">
													<input
														autoFocus
														type={loginAsk.type === "secret" ? "password" : "text"}
														className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs"
														value={askAnswer}
														placeholder={loginAsk.placeholder}
														onChange={(e) => setAskAnswer(e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter" && askAnswer.trim()) respondPrompt(askAnswer.trim());
														}}
													/>
													<button
														type="button"
														className="rounded bg-sky-800 px-3 py-1 text-xs hover:bg-sky-700"
														onClick={() => respondPrompt(askAnswer.trim())}
													>
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
													className="text-[11px] text-neutral-500 hover:text-red-400"
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

						{showProviderForm && (
							<div className="mt-2 space-y-2 rounded border border-neutral-700 bg-neutral-950/60 p-3">
								<div className="grid grid-cols-2 gap-2">
									<label className="block text-[11px] text-neutral-400">
										供应商 ID *（字母数字开头，可含 . _ -）
										<input className={input} value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder="如 zai" />
									</label>
									<label className="block text-[11px] text-neutral-400">
										显示名
										<input className={input} value={pName} onChange={(e) => setPName(e.target.value)} placeholder="如 Z.AI 智谱" />
									</label>
									<label className="block text-[11px] text-neutral-400">
										Base URL *
										<input className={input} value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder="https://..." />
									</label>
									<label className="block text-[11px] text-neutral-400">
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
								<label className="block text-[11px] text-neutral-400">
									API Key（也可以填 <code>$环境变量名</code> 引用）
									<input className={input} value={pApiKey} onChange={(e) => setPApiKey(e.target.value)} placeholder="sk-..." />
								</label>
								<div className="flex justify-end gap-2">
									<button type="button" className={btn} onClick={resetProviderForm}>
										清空
									</button>
									<button
										type="button"
										className="rounded bg-sky-800 px-3 py-1 text-xs hover:bg-sky-700 disabled:opacity-40"
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

						<div className="mt-2 space-y-2">
							{groups.length === 0 && (
								<div className="rounded border border-dashed border-neutral-700 px-3 py-4 text-center text-xs text-neutral-500">
									还没有任何模型 — 点右上角「+ 添加供应商」开始
								</div>
							)}
							{groups.map((group) => (
								<div key={group.id} className="rounded border border-neutral-700 bg-neutral-950/40 p-3">
									<div className="flex items-center justify-between">
										<div className="text-xs font-semibold text-neutral-200">
											{group.name ?? group.id} <span className="text-neutral-500">({group.id})</span>
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
											<div key={model.id} className="flex items-center justify-between rounded bg-neutral-900 px-2 py-1">
												<span className="font-mono text-xs text-neutral-300">
													{model.id}
													{model.contextWindow ? <span className="text-neutral-600"> · {Math.round(model.contextWindow / 1000)}k</span> : null}
												</span>
												<button
													type="button"
													className="text-[11px] text-neutral-500 hover:text-red-400 disabled:opacity-40"
													disabled={busy}
													onClick={() => void run({ type: "models.removeModel", providerKey: group.id, modelId: model.id })}
												>
													删除
												</button>
											</div>
										))}
										{group.models.length === 0 && <div className="text-[11px] text-neutral-600">该供应商还没有模型</div>}
									</div>

									{modelFormFor === group.id ? (
										<div className="mt-2 space-y-2 rounded border border-neutral-800 p-2">
											<div className="grid grid-cols-2 gap-2">
												<label className="block text-[11px] text-neutral-400">
													模型 ID *
													<input className={smallInput} value={mId} onChange={(e) => setMId(e.target.value)} placeholder="如 glm-5.3-flash" />
												</label>
												<label className="block text-[11px] text-neutral-400">
													显示名
													<input className={smallInput} value={mName} onChange={(e) => setMName(e.target.value)} />
												</label>
												<label className="block text-[11px] text-neutral-400">
													上下文窗口（tokens）
													<input className={smallInput} value={mCtx} onChange={(e) => setMCtx(e.target.value)} placeholder="128000" />
												</label>
												<label className="block text-[11px] text-neutral-400">
													最大输出（tokens）
													<input className={smallInput} value={mMax} onChange={(e) => setMMax(e.target.value)} placeholder="8192" />
												</label>
											</div>
											<label className="flex items-center gap-1.5 text-[11px] text-neutral-400">
												<input type="checkbox" checked={mReasoning} onChange={(e) => setMReasoning(e.target.checked)} />
												推理模型
											</label>
											<div className="flex justify-end gap-2">
												<button type="button" className={btn} onClick={() => setModelFormFor(null)}>
													取消
												</button>
												<button
													type="button"
													className="rounded bg-sky-800 px-3 py-1 text-xs hover:bg-sky-700 disabled:opacity-40"
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
					</section>

					{/* ============ 常规设置 ============ */}
					<section>
						<label className="block text-xs text-neutral-400">工作目录（新会话的 cwd）</label>
						<input
							className={input}
							value={workspaceDir}
							onChange={(event) => onWorkspaceDir(event.target.value)}
						/>
						<label className="mt-3 block text-xs text-neutral-400">agent 目录（隔离的数据目录）</label>
						<input
							className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-500"
							value={agentDir}
							readOnly
						/>
						<label className="mt-3 block text-xs text-neutral-400">settings.json（高级；JSON 保存写回）</label>
						<textarea
							className="h-40 w-full rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs"
							value={raw}
							onChange={(event) => setRaw(event.target.value)}
						/>
					</section>
				</div>

				<div className="mt-3 flex justify-end gap-2">
					<button type="button" className="rounded border border-neutral-700 px-3 py-1.5 text-sm" onClick={onClose}>
						关闭
					</button>
					<button
						type="button"
						className="rounded bg-sky-800 px-3 py-1.5 text-sm hover:bg-sky-700"
						onClick={() => {
							void (async () => {
								try {
									const values = JSON.parse(raw) as Record<string, unknown>;
									const response = await client.request({ type: "settings.set", values });
									if (response.ok) {
										setSaved(true);
										setTimeout(() => setSaved(false), 2000);
									} else {
										setError(response.error ?? "保存失败");
									}
								} catch (error) {
									setError(error instanceof Error ? error.message : String(error));
								}
							})();
						}}
					>
						{saved ? "已保存 ✓" : "保存 settings.json"}
					</button>
				</div>
			</div>
		</div>
	);
}
