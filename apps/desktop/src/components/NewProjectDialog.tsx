import { useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { ProjectCreateResult } from "../bridge/protocol.ts";
import { hasTauri, pickFolder } from "../bridge/native.ts";
import { t, useT } from "../i18n/index.ts";

/**
 * 新建/打开项目对话框：输入或浏览目录，project.create（mkdir -p，幂等）后回调切换。
 * 侧边栏「新建项目」与输入框的添加项目按钮共用。
 */
export function NewProjectDialog({
	client,
	onClose,
	onCreated,
}: {
	client: BridgeClient;
	onClose: () => void;
	/** project.create 成功后的规范化绝对路径，调用方负责切换项目。 */
	onCreated: (path: string) => void;
}): React.JSX.Element {
	const t = useT();
	const [path, setPath] = useState("");
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState("");
	// 桌面壳里可打开系统文件夹选择框（浏览器模式隐藏入口）
	const [browsing, setBrowsing] = useState(false);

	const submit = async (): Promise<void> => {
		const target = path.trim();
		if (!target) return;
		setCreating(true);
		setError("");
		try {
			const response = await client.request<ProjectCreateResult>({ type: "project.create", path: target });
			if (!response.ok || !response.result) {
				setError(response.error ?? t("newproject.createFailed"));
				return;
			}
			onCreated(response.result.path);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	};

	/** 系统资源管理器选择项目目录（仅桌面壳有此入口）。 */
	const browse = async (): Promise<void> => {
		setBrowsing(true);
		setError("");
		try {
			const selected = await pickFolder(t("newproject.pickFolderTitle"));
			if (selected) setPath(selected);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBrowsing(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog">
			<div className="w-96 rounded-xl border border-owl-border bg-owl-panel p-4 shadow-2xl shadow-black/40">
				<h2 className="mb-1 text-sm font-semibold text-owl-text">{t("newproject.title")}</h2>
				<p className="mb-3 text-xs text-owl-muted">{t("newproject.desc")}</p>
				<div className="flex gap-2">
					<input
						type="text"
						className="min-w-0 flex-1 rounded-lg border border-owl-border bg-owl-sidebar px-3 py-2 font-mono text-xs text-owl-text outline-none transition-colors focus:border-owl-accent"
						placeholder="D:\mycode\new-project"
						value={path}
						autoFocus
						disabled={creating}
						onChange={(event) => setPath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void submit();
							if (event.key === "Escape") onClose();
						}}
					/>
					{hasTauri() && (
						<button
							type="button"
							className="shrink-0 rounded-lg border border-owl-border px-3 py-2 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text disabled:opacity-50"
							title={t("newproject.browseTitle")}
							onClick={() => void browse()}
							disabled={browsing || creating}
						>
							{browsing ? t("newproject.browsing") : t("newproject.browse")}
						</button>
					)}
				</div>
				{error && <p className="mt-2 text-xs text-red-400">{error}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						className="rounded-lg border border-owl-border px-3 py-1.5 text-xs text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={onClose}
						disabled={creating}
					>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						className="rounded-lg bg-owl-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:opacity-50"
						onClick={() => void submit()}
						disabled={creating || !path.trim()}
					>
						{creating ? t("newproject.creating") : t("newproject.createAndSwitch")}
					</button>
				</div>
			</div>
		</div>
	);
}
