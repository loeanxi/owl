import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { startPointerDrag } from "../../src/sidebar/pointer-drag.ts";
import { SidebarStore } from "../../src/sidebar/store.ts";
import { Workbench } from "../../src/sidebar/Workbench.tsx";

const h = React.createElement;
const parameters = new URLSearchParams(location.search);
const cwd = "workbench-resize-fixture";
if (parameters.get("restore") !== "1") {
	localStorage.setItem("owl.workbench.width", "780");
	localStorage.setItem("owl.workbench.height", "500");
}
const store = new SidebarStore(cwd);
const sessions = new Set();
const metrics = { ticks: 0, toolUpdates: 0, fsChanged: 0, throwFinished: 0 };
store.onFsChanged(() => metrics.fsChanged++);
const client = {
	onStatus: () => () => {},
	onViewersChanged: () => () => {},
	onSessionEvent(callback) {
		sessions.add(callback);
		return () => sessions.delete(callback);
	},
	async request(request) {
		return {
			ok: true,
			result:
				request.type === "viewer.list"
					? { viewers: [{ id: "office-fixture", title: "Office", extensions: ["univer"] }] }
					: request.type === "viewer.open"
						? { url: parameters.get("viewer"), title: "费用测试.univer" }
						: { repo: false, entries: [] },
		};
	},
};
store.openFileTab("plugin-viewer:office-fixture", "费用测试.univer", "费用测试.univer");
const root = createRoot(document.getElementById("root"));

function Harness() {
	const [dock, setDock] = useState(parameters.get("dock") === "bottom" ? "bottom" : "right");
	const [open, setOpen] = useState(true);
	const [ticks, setTicks] = useState(0);
	window.workbenchHarness = { store, client, metrics, setDock, setOpen, unmount: () => root.unmount() };
	useEffect(() => {
		const timer = setInterval(() => {
			metrics.ticks++;
			metrics.toolUpdates++;
			setTicks(metrics.ticks);
			for (const callback of sessions) {
				callback({ event: { type: "tool_execution_update", toolName: "univer_execute", content: "写入单元格" } });
				callback({ event: { type: "fs_changed", cwd, dirs: [""] } });
			}
		}, 45);
		return () => clearInterval(timer);
	}, []);
	return h(
		"div",
		{ className: "test-layout", "data-dock": dock },
		h(
			"button",
			{
				id: "throw-probe",
				style: { position: "fixed", left: 20, top: 20 },
				onPointerDown(event) {
					startPointerDrag(event.currentTarget, event.nativeEvent, {
						cursor: "grabbing",
						onMove() {
							throw new Error("WORKBENCH_PROBE_MOVE_THROW");
						},
						onFinish() {
							metrics.throwFinished++;
						},
					});
				},
			},
			"Throw probe",
		),
		h(
			"article",
			{ className: "test-chat" },
			h("h2", null, "Office 生成期间"),
			h("p", null, `模拟流式工具与文件更新：${ticks}`),
		),
		h(Workbench, { client, cwd, store, open, onSetOpen: setOpen, dock, onSetDock: setDock }),
	);
}

root.render(h(Harness));
