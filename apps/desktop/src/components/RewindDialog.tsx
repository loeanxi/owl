import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import type { RewindExecuteResult, RewindImpactFile, RewindImpactResult } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";

/**
 * 会话回退确认弹层（owl-rewind）。点用户消息旁的 ↶ 后弹出：
 * 先选模式——「仅回退对话」立即执行；「回退对话和代码」先拉影响清单
 * （对照磁盘算出的将还原/删除的文件），确认后才执行。
 * App 用 key={target.entryId} 挂载，每次回退都是全新状态。
 */
export function RewindDialog({
	client,
	sessionId,
	target,
	onDone,
	onClose,
}: {
	client: BridgeClient;
	sessionId: string;
	target: { entryId: string; text: string };
	onDone: (result: RewindExecuteResult) => void;
	onClose: () => void;
}): React.JSX.Element {
	const t = useT();
	const [stage, setStage] = useState<"choose" | "impact">("choose");
	const [impact, setImpact] = useState<RewindImpactResult | undefined>(undefined);
	const [loadingImpact, setLoadingImpact] = useState(false);
	const [executing, setExecuting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape" && !executing) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, executing]);

	const preview = target.text.split("\n").find((line) => line.trim() !== "") ?? "";
	const brief = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;

	const loadImpact = async (): Promise<void> => {
		setStage("impact");
		setLoadingImpact(true);
		setError(undefined);
		try {
			const response = await client.request<RewindImpactResult>({
				type: "rewind.impact",
				sessionId,
				entryId: target.entryId,
			});
			if (response.ok && response.result) setImpact(response.result);
			else setError(response.error ?? t("rewind.impactFailed"));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setLoadingImpact(false);
		}
	};

	const execute = async (mode: "conversation" | "both"): Promise<void> => {
		setExecuting(true);
		setError(undefined);
		try {
			const response = await client.request<RewindExecuteResult>({
				type: "rewind.execute",
				sessionId,
				entryId: target.entryId,
				mode,
			});
			if (response.ok && response.result) onDone(response.result);
			else setError(response.error ?? t("rewind.failed"));
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setExecuting(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => !executing && onClose()}>
			<div
				className="flex max-h-[70vh] w-[540px] max-w-full flex-col rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="border-b border-owl-border px-4 py-3">
					<h2 className="text-sm font-semibold">{t("rewind.title")}</h2>
					<p className="mt-1 line-clamp-2 rounded-lg bg-owl-sidebar px-2.5 py-1.5 text-xs text-owl-muted">{brief}</p>
				</div>
				<div className="flex-1 overflow-y-auto px-4 py-3">
					{error && <p className="mb-2 rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-1.5 text-xs text-red-400">{error}</p>}
					{stage === "choose" ? (
						<div className="space-y-2">
							<button
								type="button"
								disabled={executing}
								className="w-full rounded-lg border border-owl-border px-3 py-2.5 text-left transition-colors hover:bg-owl-hover disabled:opacity-50"
								onClick={() => void execute("conversation")}
							>
								<span className="block text-sm font-medium">{t("rewind.modeConversation")}</span>
								<span className="mt-0.5 block text-xs text-owl-muted">{t("rewind.modeConversationHint")}</span>
							</button>
							<button
								type="button"
								disabled={executing}
								className="w-full rounded-lg border border-owl-border px-3 py-2.5 text-left transition-colors hover:bg-owl-hover disabled:opacity-50"
								onClick={() => void loadImpact()}
							>
								<span className="block text-sm font-medium">{t("rewind.modeCode")}</span>
								<span className="mt-0.5 block text-xs text-owl-muted">{t("rewind.modeCodeHint")}</span>
							</button>
						</div>
					) : (
						<div>
							{loadingImpact && <p className="text-xs text-owl-muted">{t("rewind.loadingImpact")}</p>}
							{impact && (
								<>
									{impact.files.length === 0 ? (
										<p className="rounded-lg border border-owl-border bg-owl-sidebar px-2.5 py-2 text-xs text-owl-muted">
											{t("rewind.impactEmpty")}
										</p>
									) : (
										<ul className="space-y-1">
											{impact.files.map((file) => (
												<ImpactFileRow key={`${file.action}:${file.path}`} file={file} />
											))}
										</ul>
									)}
									{impact.unchanged > 0 && (
										<p className="mt-2 text-[11px] text-owl-muted">{t("rewind.unchangedNote", { n: impact.unchanged })}</p>
									)}
								</>
							)}
							{impact && !loadingImpact && (
								<div className="mt-3 flex items-center gap-2">
									<button
										type="button"
										disabled={executing}
										className="flex-1 rounded-lg bg-owl-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-owl-accent-hover disabled:opacity-50"
										onClick={() => void execute("both")}
									>
										{executing ? t("rewind.executing") : t("rewind.confirmCode")}
									</button>
									<button
										type="button"
										disabled={executing}
										className="rounded-lg border border-owl-border px-3 py-2 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
										onClick={() => setStage("choose")}
									>
										{t("rewind.back")}
									</button>
								</div>
							)}
						</div>
					)}
				</div>
				<div className="flex items-center justify-between border-t border-owl-border px-4 py-3">
					<span className="text-[11px] text-owl-muted">{t("rewind.auditNote")}</span>
					<button
						type="button"
						disabled={executing}
						className="rounded-lg border border-owl-border px-3 py-1.5 text-sm text-owl-muted transition-colors hover:bg-owl-hover hover:text-owl-text"
						onClick={onClose}
					>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}

function ImpactFileRow({ file }: { file: RewindImpactFile }): React.JSX.Element {
	const t = useT();
	return (
		<li className="flex items-center gap-2 rounded-lg border border-owl-border px-2.5 py-1.5">
			<span
				className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
					file.action === "delete" ? "bg-red-400/15 text-red-400" : "bg-owl-accent/15 text-owl-accent"
				}`}
			>
				{file.action === "delete" ? t("rewind.actionDelete") : t("rewind.actionRestore")}
			</span>
			<span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
				{file.displayPath}
			</span>
			{file.size > 0 && <span className="shrink-0 text-[10px] text-owl-muted">{formatBytes(file.size)}</span>}
		</li>
	);
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
