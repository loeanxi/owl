import { useEffect, useId, useRef, useState } from "react";
import { getUiLanguage, useT } from "../../i18n/index.ts";
import { todayKey } from "./myself-data.ts";

type HistoryEntry = { id: string; title?: string; modified?: string; created?: string };

/** A small history picker shared by the full conversation and the daily assistant pane. */
export function MyselfChatHistory({
	entries = [],
	loading = false,
	error,
	sessionId,
	disabled,
	onRefresh,
	onSelect,
}: {
	entries?: readonly HistoryEntry[];
	loading?: boolean;
	error?: string;
	sessionId?: string;
	disabled: boolean;
	onRefresh: () => void;
	onSelect: (id: string) => Promise<boolean>;
}): React.JSX.Element {
	const t = useT();
	const lang = getUiLanguage();
	const [open, setOpen] = useState(false);
	const menuId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		const closeOutside = (event: MouseEvent): void => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("mousedown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);
	useEffect(() => {
		if (open && !loading)
			rootRef.current?.querySelector<HTMLButtonElement>("[data-myself-history-item]:not(:disabled)")?.focus();
	}, [open, loading]);
	const today = todayKey();
	const groups: ["myself.historyToday" | "myself.historyEarlier", HistoryEntry[]][] = [
		["myself.historyToday", []],
		["myself.historyEarlier", []],
	];
	for (const entry of entries) {
		const stamp = new Date(entry.modified ?? entry.created ?? "");
		const date = Number.isNaN(stamp.getTime())
			? ""
			: `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
		groups[date === today ? 0 : 1]![1].push(entry);
	}
	return (
		<div className="owl-myself-history" ref={rootRef} data-tauri-drag-region="false">
			<button
				ref={triggerRef}
				type="button"
				className="owl-myself-history-trigger"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? menuId : undefined}
				disabled={disabled}
				onClick={() => {
					if (!open) onRefresh();
					setOpen((value) => !value);
				}}
			>
				{t("myself.history")}
			</button>
			{open && (
				<div
					id={menuId}
					className="owl-myself-history-popover"
					role="dialog"
					aria-labelledby={`${menuId}-title`}
					aria-busy={loading}
				>
					<div className="owl-myself-history-heading">
						<strong id={`${menuId}-title`}>{t("myself.history")}</strong>
						<button type="button" disabled={loading || disabled} onClick={onRefresh}>
							{t("myself.historyRefresh")}
						</button>
					</div>
					{loading && <output>{t("myself.historyLoading")}</output>}
					{error && (
						<div className="owl-myself-history-error" role="alert">
							{t("myself.historyFailed")}
						</div>
					)}
					{!loading && !error && entries.length === 0 && <p>{t("myself.historyEmpty")}</p>}
					<div className="owl-myself-history-list">
						{groups.map(
							([label, items]) =>
								items.length > 0 && (
									<section key={label}>
										<h3>{t(label)}</h3>
										{items.map((entry) => {
											const stamp = new Date(entry.modified ?? entry.created ?? "");
											const time = Number.isNaN(stamp.getTime())
												? ""
												: new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", {
														...(label === "myself.historyEarlier"
															? { month: "short" as const, day: "numeric" as const }
															: {}),
														hour: "2-digit",
														minute: "2-digit",
														hour12: false,
													}).format(stamp);
											return (
												<button
													key={entry.id}
													type="button"
													data-myself-history-item={entry.id}
													aria-current={entry.id === sessionId ? "true" : undefined}
													disabled={disabled}
													onClick={() =>
														void onSelect(entry.id).then((restored) => {
															if (restored) setOpen(false);
														})
													}
												>
													<span>{entry.title || t("myself.historyUntitled")}</span>
													<small>
														<time>{time}</time>
														{entry.id === sessionId && <b>{t("myself.historyCurrent")}</b>}
													</small>
												</button>
											);
										})}
									</section>
								),
						)}
					</div>
				</div>
			)}
		</div>
	);
}
