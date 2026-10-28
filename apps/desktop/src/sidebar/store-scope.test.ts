import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarStore } from "./store.ts";

describe("面板作用域", () => {
	let storage: Map<string, string>;

	beforeEach(() => {
		storage = new Map();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
	});

	it("project 作用域：两个项目各存各的布局", () => {
		const first = new SidebarStore("D:/proj-a");
		const second = new SidebarStore("D:/proj-b");
		first.openSingleton("files", "文件");
		expect(first.getState().tabs.map((tab) => tab.kind)).toEqual(["files"]);
		expect(second.getState().tabs).toHaveLength(0);
	});

	it("global 作用域：换个项目重开应用，读到的是同一份面板状态（短剧面板）", () => {
		const first = new SidebarStore("D:/proj-a", "owl.mirror.state", { scope: "global" });
		first.openSingleton("mirror", "短剧");
		// 重开应用（新的 store 实例）且项目换了：短剧面板不该被项目重置。
		const reopened = new SidebarStore("D:/proj-b", "owl.mirror.state", { scope: "global" });
		expect(reopened.getState().tabs.map((tab) => tab.kind)).toEqual(["mirror"]);
	});

	it("project 作用域：换个项目重开应用，短剧面板不会跟过去", () => {
		const first = new SidebarStore("D:/proj-a", "owl.mirror.state");
		first.openSingleton("mirror", "短剧");
		const other = new SidebarStore("D:/proj-b", "owl.mirror.state");
		expect(other.getState().tabs).toHaveLength(0);
	});

	it("产物页：同一件产物只有一个页签，再点只是切过去", () => {
		const store = new SidebarStore("D:/proj-a");
		store.openArtifactTab("visual:v1", "月度趋势");
		const tabs = store.getState().tabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.kind).toBe("artifact");
		expect(tabs[0]?.productId).toBe("visual:v1");
		expect(tabs[0]?.title).toBe("月度趋势");
		// 再点一次不并排开两份。
		store.openArtifactTab("visual:v1", "月度趋势");
		expect(store.getState().tabs).toHaveLength(1);
		// 另一件产物是另一个页签。
		store.openArtifactTab("file:docs/report.md", "report.md");
		expect(store.getState().tabs).toHaveLength(2);
	});

	it("产物页：布局持久化后仍然指回同一件产物", () => {
		const store = new SidebarStore("D:/proj-a");
		store.openArtifactTab("visual:v1", "月度趋势");
		const reopened = new SidebarStore("D:/proj-a");
		expect(reopened.getState().tabs[0]?.productId).toBe("visual:v1");
	});
});
