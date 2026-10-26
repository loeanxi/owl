import { useRef } from "react";
import { Menu } from "../components/Menu.tsx";
import { useT, type TextKey } from "../i18n/index.ts";
import { IconChevronDown } from "./icons.tsx";
import { QUICK_ACTIONS, openQuickAction, type QuickAction, type QuickActionGroup } from "./quick.tsx";
import type { SidebarStore } from "./store.ts";

/** 工具栏固定入口的优先顺序（面板越窄保留越靠前的）。 */
const PINNED_ORDER = ["files", "browser", "changes"];

/** 菜单分组顺序与分组标题文案。 */
const GROUP_ORDER: readonly QuickActionGroup[] = ["workspace", "runtime", "agent"];
const GROUP_LABEL: Record<QuickActionGroup, TextKey> = {
	workspace: "wb.groupWorkspace",
	runtime: "wb.groupRuntime",
	agent: "wb.groupAgent",
};

/**
 * 常用入口随面板宽度收敛；完整工具清单始终能从菜单找到，且每项带一句说明。
 * 菜单按「工作区 / 运行环境 / 会话与 Agent」分组，名字相近的卡片（文件变动 vs
 * 改动审批）靠副标题区分，不再靠用户点进去试。
 *
 * menuScope 两种形态：
 * - all：菜单是完整索引，每种工具都能按名字从菜单里找到（窄面板固定项只剩图标时尤其重要）。
 * - unpinned：菜单只列工具栏没固定的那几个，工具栏已有的不再重复一遍。
 */
export function WorkbenchTools({ store, activeKind, width, kindAllowed, menuScope = "all", onOpenPanel }: {
	store: SidebarStore;
	activeKind?: string;
	width: number;
	kindAllowed: (kind: string) => boolean;
	/** 菜单范围：all=完整索引，unpinned=只列未固定项。 */
	menuScope?: "all" | "unpinned";
	/** 独立面板入口（短剧）：开机器级面板，不往本面板塞页签。 */
	onOpenPanel?: (kind: string) => void;
}): React.JSX.Element {
	const t = useT();
	const root = useRef<HTMLDivElement>(null);
	const actions = QUICK_ACTIONS.filter((action) => !action.disabled && (kindAllowed(action.kind) || (action.panel === true && onOpenPanel !== undefined)));
	const pinned = PINNED_ORDER
		.map((kind) => actions.find((action) => action.kind === kind))
		.filter((action): action is QuickAction => action !== undefined)
		.slice(0, width < 330 ? 1 : width < 480 ? 2 : 3);
	const pinnedKinds = pinned.map((action) => action.kind);
	const menuActions = menuScope === "unpinned" ? actions.filter((action) => !pinnedKinds.includes(action.kind)) : actions;
	const groups = GROUP_ORDER
		.map((group) => ({ group, actions: menuActions.filter((action) => action.group === group) }))
		.filter((entry) => entry.actions.length > 0);
	// 只有一组时（如终端底栏）不挂分组标题，免得给单条菜单套一层空壳。
	const showGroupTitles = groups.length > 1;

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
							{groups.map((entry) => (
								<div key={entry.group} className="owl-workbench-tool-group">
									{showGroupTitles && <p className="owl-workbench-tool-group-title">{t(GROUP_LABEL[entry.group])}</p>}
									{entry.actions.map((action) => (
										<button
											key={action.kind}
											type="button"
											data-workbench-tool={action.kind}
											className={`owl-workbench-tool-item ${activeKind === action.kind ? "is-active" : ""}`}
											onClick={() => {
												if (action.panel === true && onOpenPanel !== undefined) {
													onOpenPanel(action.kind);
													close();
													return;
												}
												openQuickAction(store, action.kind);
												close();
												root.current?.querySelector<HTMLButtonElement>(".owl-workbench-more-tools")?.focus();
											}}
										>
											{action.icon(16)}
											<span className="owl-workbench-tool-text">
												<span className="owl-workbench-tool-label">{action.label}</span>
												<span className="owl-workbench-tool-desc">{action.desc}</span>
											</span>
											{action.badge === "beta" && <span className="owl-workbench-tool-badge">{t("wb.badgeBeta")}</span>}
											{action.hint && <kbd>{action.hint}</kbd>}
										</button>
									))}
								</div>
							))}
						</div>
					)}
				</Menu>
			)}
		</div>
	);
}
