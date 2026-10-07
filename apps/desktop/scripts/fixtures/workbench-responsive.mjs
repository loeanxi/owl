import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar } from "../../src/components/SessionSidebar.tsx";
import { registerBuiltins } from "../../src/sidebar/builtins.tsx";
import { registerTab } from "../../src/sidebar/registry.ts";
import { SidebarStore } from "../../src/sidebar/store.ts";
import { Workbench } from "../../src/sidebar/Workbench.tsx";
import "../../src/desktop-shell.css";

const h = React.createElement;
const parameters = new URLSearchParams(location.search);
const cwd = "workbench-responsive-fixture";
if (parameters.get("restore") !== "1") {
	localStorage.setItem("owl.sidebar.width", parameters.get("sidebar") ?? "720");
	localStorage.setItem("owl.workbench.width", parameters.get("workbench") ?? "950");
	localStorage.setItem("owl.workbench.height", "500");
}
registerBuiltins();
registerTab({
	kind: "mirror",
	title: "短剧",
	icon: () => null,
	component: () => h("div", { className: "test-video" }, "短剧画面占位 · 仅验证布局"),
});
const store = new SidebarStore(cwd);
store.openNew("mirror", "短剧");
const terminalStore = new SidebarStore(cwd, "responsive-test-terminal");
const client = {
	onStatus: () => () => {},
	onViewersChanged: () => () => {},
	onSessionEvent: () => () => {},
	async request(request) {
		return { ok: true, result: request.type === "viewer.list" ? { viewers: [] } : { repo: false, entries: [] } };
	},
};

function Harness() {
	const [minimized, setMinimized] = useState(false);
	const [open, setOpen] = useState(true);
	const [terminalOpen, setTerminalOpen] = useState(false);
	window.responsiveHarness = { setMinimized, setOpen, setTerminalOpen };
	return h("div", { className: "owl-desktop-shell" },
		h("div", { className: "owl-desktop-titlebar" }, "Owl 分栏回归"),
		h("div", { className: "owl-desktop-body" },
			h("nav", { className: "owl-activity-rail", style: { flexShrink: 0 } }, "Owl"),
			h(SessionSidebar, {
				client, sessionScope: "chat", connected: false, activeId: undefined, activeProject: "",
				runningSessions: new Set(), refreshKey: "", revision: 0, focus: "chat", minimized,
				onToggleMinimized: () => setMinimized(!minimized), onNewChat: () => {},
				onNewChatInProject: () => {}, onSelectProject: () => {}, onOpenSession: () => {},
			}),
			h("div", { className: "owl-main-frame" },
				h("div", { className: "owl-chat-header" }, "对话"),
				h("div", { className: "owl-shell-content" },
					h("div", { className: "owl-shell-content-main" },
						h("div", { className: "owl-shell-conversation" },
							h("p", { className: "test-message" }, "窗口缩小时，对话与短剧都应保留可用空间。"),
							h("textarea", { className: "test-composer", placeholder: "描述问题或想完成的任务…" }),
						),
						h(Workbench, { client, cwd, store: terminalStore, open: terminalOpen, onSetOpen: setTerminalOpen, dock: "bottom", role: "terminal" }),
					),
					h(Workbench, { client, cwd, store, open, onSetOpen: setOpen, dock: "right" }),
				),
			),
		),
	);
}
createRoot(document.getElementById("root")).render(h(Harness));
