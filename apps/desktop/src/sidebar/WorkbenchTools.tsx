import { useRef } from "react";
import { Menu } from "../components/Menu.tsx";
import { useT } from "../i18n/index.ts";
import { IconChevronDown } from "./icons.tsx";
import { QUICK_ACTIONS, openQuickAction } from "./quick.tsx";
import type { SidebarStore } from "./store.ts";

/** 常用入口随面板宽度收敛；完整工具名称始终能从菜单找到。 */
export function WorkbenchTools({ store, activeKind, width, kindAllowed }: {
	store: SidebarStore;
	activeKind?: string;
	width: number;
	kindAllowed: (kind: string) => boolean;
}): React.JSX.Element {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && kindAllowed(action.kind));
	const pinned = ["files", "browser", "changes"]
		.flatMap((kind) => actions.find((action) => action.kind === kind) ?? [])
		.slice(0, width < 330 ? 1 : width < 480 ? 2 : 3);

	return (
		<div
			ref={root}
			className="owl-workbench-shortcuts"
			aria-label={t("wb.toolsAria")}
			onKeyDown={(event) => {
				if (event.key === "Escape") root.current?.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")?.focus();
			}}
		>
			{pinned.map((action) => (
				<button
					key={action.kind}
					type="button"
					title={action.label}
					aria-label={action.label}
					aria-pressed={activeKind === action.kind}
					data-workbench-quick={action.kind}
					className={`owl-workbench-icon-button owl-workbench-quick-tool ${activeKind === action.kind ? "is-active" : ""}`}
					onClick={() => openQuickAction(store, action.kind)}
				>
					{action.icon(15)}
					<span>{action.label}</span>
				</button>
			))}
			{actions.length > 0 && (
				<Menu
					trigger={<><span>{t("start.moreTools")}</span><IconChevronDown size={13} /></>}
					triggerTitle={t("start.moreTools")}
					triggerClassName="owl-workbench-more-tools"
					panelClassName="owl-workbench-tools-menu right-0"
					direction="down"
				>
					{(close) => (
						<div aria-label={t("wb.toolsAria")}>
							{actions.map((action) => (
								<button
									key={action.kind}
									type="button"
									data-workbench-tool={action.kind}
									className={`owl-workbench-tool-item ${activeKind === action.kind ? "is-active" : ""}`}
									onClick={() => {
										openQuickAction(store, action.kind);
										close();
										root.current?.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")?.focus();
									}}
								>
									{action.icon(16)}
									<span>{action.label}</span>
									{action.hint && <kbd>{action.hint}</kbd>}
								</button>
							))}
						</div>
					)}
				</Menu>
			)}
		</div>
	);
}
