/**
 * 用户印象 tab —— 查看/编辑 Owl Si 对用户的长期印象（settings.json 的
 * owlUserImpression）。数据与设置页「提示词」分区同源：走 settings.get/set，
 * 保存后新会话生效；模型侧通过 update_user_impression 工具维护同一份档案。
 */
import { useEffect, useRef, useState } from "react";
import type { TabComponentProps } from "../registry.ts";
import { IconLoader, IconPencil, IconSave } from "../icons.tsx";

export function ImpressionTab({ client }: TabComponentProps): React.JSX.Element {
	const [impression, setImpression] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [savedMsg, setSavedMsg] = useState("");
	const [error, setError] = useState("");
	const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (savedTimer.current) clearTimeout(savedTimer.current);
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		let requestVersion = 0;
		let initialized = false;
		setLoaded(false);
		const load = async (): Promise<void> => {
			const version = ++requestVersion;
			setLoading(true);
			setError("");
			try {
				const response = await client.request<{ agentDir: string; settings: unknown }>({ type: "settings.get" });
				if (cancelled || version !== requestVersion) return;
				if (!response.ok || !response.result) {
					setError(response.error ?? "读取用户印象失败");
					return;
				}
				const obj = (response.result.settings ?? {}) as Record<string, unknown>;
				setImpression(typeof obj.owlUserImpression === "string" ? obj.owlUserImpression : "");
				initialized = true;
				setLoaded(true);
			} catch (err) {
				if (!cancelled && version === requestVersion) {
					setError(err instanceof Error ? err.message : String(err));
				}
			} finally {
				if (!cancelled && version === requestVersion) setLoading(false);
			}
		};
		const offStatus = client.onStatus((connected) => {
			if (cancelled || initialized) return;
			if (connected) void load();
			else {
				requestVersion += 1;
				setLoading(false);
				setError("连接已断开，恢复后将自动重新读取");
			}
		});
		void load();
		return () => {
			cancelled = true;
			requestVersion += 1;
			offStatus();
		};
	}, [client]);

	async function save(): Promise<void> {
		setBusy(true);
		setError("");
		try {
			const response = await client.request<Record<string, unknown>>({
				type: "settings.set",
				values: { owlUserImpression: impression },
			});
			if (response.ok) {
				if (response.result && typeof response.result === "object") {
					const obj = response.result as Record<string, unknown>;
					if (typeof obj.owlUserImpression === "string") setImpression(obj.owlUserImpression);
				}
				setSavedMsg("已保存 ✓ 新会话生效");
				if (savedTimer.current) clearTimeout(savedTimer.current);
				savedTimer.current = setTimeout(() => setSavedMsg(""), 2000);
			} else {
				setError(response.error ?? "保存失败");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between border-b border-owl-border/60 px-3 py-2">
				<span className="text-[11px] text-owl-faint">Owl Si 会把它对你的了解记在这里，并随身带进每次对话</span>
				<div className="flex items-center gap-2">
					{savedMsg && <span className="text-[11px] text-emerald-500">{savedMsg}</span>}
					{error && <span className="max-w-[160px] truncate text-[11px] text-red-400" title={error}>{error}</span>}
					<button
						type="button"
						className="flex items-center gap-1 rounded-lg border border-owl-border px-2 py-0.5 text-[11px] text-owl-muted transition-colors hover:border-owl-faint hover:text-owl-text disabled:opacity-40"
						disabled={busy || !loaded}
						onClick={() => void save()}
					>
						{busy ? <IconLoader size={12} /> : <IconSave size={12} />}
						保存
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
				{!loaded ? (
					<div className="flex h-full items-center justify-center text-owl-faint">
						{loading ? (
							<IconLoader size={18} className="animate-spin" />
						) : (
							<p className="px-4 text-center text-xs leading-relaxed">尚未读取用户印象，连接恢复后会自动重试。</p>
						)}
					</div>
				) : (
					<textarea
						className="h-full min-h-48 w-full resize-none rounded-lg border border-owl-border bg-owl-sidebar px-2.5 py-2 text-xs leading-relaxed text-owl-text outline-none transition-colors focus:border-owl-accent"
						value={impression}
						onChange={(event) => setImpression(event.target.value)}
						placeholder={
							"还是空的。\n\n平时聊天里提到的工作习惯、技术偏好、项目背景…… Owl Si 觉得值得长期记住时，会自动整理到这里；你也可以直接写几条让它记住的事。"
						}
						spellCheck={false}
					/>
				)}
			</div>
			<div className="flex items-center gap-1.5 border-t border-owl-border/60 px-3 py-1.5 text-[10px] text-owl-faint">
				<IconPencil size={11} />
				直接编辑也行；对话中 Owl Si 更新后，重新打开这个栏目就能看到。
			</div>
		</div>
	);
}
