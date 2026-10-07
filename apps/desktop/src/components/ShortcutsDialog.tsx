import { useEffect, useRef } from "react";
import { useT } from "../i18n/index.ts";

export type HelpSection = "guide" | "shortcuts";

interface ShortcutRow {
	label: string;
	keys: string[];
}

/**
 * 「帮助」弹窗：使用指南 + 全部键盘快捷键。
 * 从帮助菜单的「使用指南」/「显示键盘快捷键 (Ctrl+/)」两个入口打开，定位到对应小节。
 */
export function ShortcutsDialog({ section, onClose }: { section: HelpSection; onClose: () => void }): React.JSX.Element {
	const t = useT();
	const panelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		panelRef.current?.scrollTo({ top: section === "shortcuts" ? panelRef.current.scrollHeight : 0 });
	}, [section]);

	const kbd = "rounded border border-owl-border bg-owl-sidebar px-1.5 py-0.5 font-mono text-[11px] text-owl-muted";
	const groups: { title: string; rows: ShortcutRow[] }[] = [
		{
			title: t("titlebar.menuFile"),
			rows: [
				{ label: t("titlebar.newChat"), keys: ["Ctrl", "N"] },
				{ label: t("titlebar.openProject"), keys: ["Ctrl", "O"] },
				{ label: t("titlebar.closeWindow"), keys: ["Ctrl", "W"] },
				{ label: t("titlebar.quitOwl"), keys: ["Ctrl", "Q"] },
			],
		},
		{
			title: t("titlebar.menuEdit"),
			rows: [
				{ label: t("edit.undo"), keys: ["Ctrl", "Z"] },
				{ label: t("edit.redo"), keys: ["Ctrl", "Y"] },
				{ label: t("edit.cut"), keys: ["Ctrl", "X"] },
				{ label: t("edit.copy"), keys: ["Ctrl", "C"] },
				{ label: t("edit.paste"), keys: ["Ctrl", "V"] },
				{ label: t("edit.selectAll"), keys: ["Ctrl", "A"] },
				{ label: t("titlebar.settings"), keys: ["Ctrl", ","] },
			],
		},
		{
			title: t("help.shortcutChat"),
			rows: [
				{ label: t("composer.sendShortcut"), keys: ["Enter"] },
				{ label: t("composer.queueShortcut"), keys: ["Enter"] },
				{ label: t("composer.steerShortcut"), keys: ["Ctrl", "Enter"] },
			],
		},
		{
			title: t("titlebar.menuView"),
			rows: [
				{ label: t("titlebar.showSessions"), keys: ["Ctrl", "Shift", "S"] },
				{ label: t("view.showBottomPanel"), keys: ["Ctrl", "J"] },
				{ label: t("view.showRightPanel"), keys: ["Ctrl", "Shift", "E"] },
				{ label: t("wb.newTerminal"), keys: ["Ctrl", "`"] },
				{ label: t("app.browserTab"), keys: ["Ctrl", "T"] },
				{ label: t("view.toggleChatContext"), keys: ["Alt", "Ctrl", "B"] },
				{ label: t("view.find"), keys: ["Ctrl", "F"] },
				{ label: t("view.prevSession"), keys: ["Ctrl", "Shift", "["] },
				{ label: t("view.nextSession"), keys: ["Ctrl", "Shift", "]"] },
				{ label: t("view.back"), keys: ["Ctrl", "["] },
				{ label: t("view.forward"), keys: ["Ctrl", "]"] },
				{ label: t("view.zoomIn"), keys: ["Ctrl", "Shift", "="] },
				{ label: t("view.zoomOut"), keys: ["Ctrl", "-"] },
				{ label: t("view.zoomReset"), keys: ["Ctrl", "0"] },
				{ label: t("view.toggleFullscreen"), keys: ["F11"] },
			],
		},
	];

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
			<div
				ref={panelRef}
				className="flex max-h-[76vh] w-[560px] max-w-full flex-col overflow-y-auto rounded-xl border border-owl-border bg-owl-panel shadow-2xl shadow-black/40"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="sticky top-0 flex items-center justify-between border-b border-owl-border bg-owl-panel px-4 py-3">
					<h2 className="text-sm font-semibold">{t("help.guideTitle")}</h2>
					<button type="button" className="owl-chrome-button" aria-label={t("app.closeAria")} onClick={onClose}>✕</button>
				</div>
				<div className="px-4 py-3">
					<section>
						<h3 className="mb-2 text-xs font-semibold tracking-wide text-owl-muted uppercase">{t("help.guide")}</h3>
						<ul className="space-y-2 text-xs leading-relaxed text-owl-muted">
							<li>{t("guide.point1")}</li>
							<li>{t("guide.point2")}</li>
							<li>{t("guide.point3")}</li>
							<li>{t("guide.point4")}</li>
						</ul>
					</section>
					<section className="mt-4">
						<h3 className="mb-2 text-xs font-semibold tracking-wide text-owl-muted uppercase">{t("help.shortcuts")}</h3>
						<div className="space-y-3">
							{groups.map((group) => (
								<div key={group.title}>
									<p className="mb-1 text-[11px] font-semibold text-owl-text">{group.title}</p>
									<table className="w-full text-xs">
										<tbody>
											{group.rows.map((row) => (
												<tr key={row.label} className="align-middle">
													<td className="py-0.5 pr-3 text-owl-muted">{row.label}</td>
													<td className="py-0.5 text-right whitespace-nowrap">
														{row.keys.map((key, index) => (
															<span key={key}>
																{index > 0 && <span className="px-0.5 text-owl-muted/60">+</span>}
																<span className={kbd}>{key}</span>
															</span>
														))}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							))}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
