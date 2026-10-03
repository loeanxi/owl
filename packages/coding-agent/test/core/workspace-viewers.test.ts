import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isWorkspaceViewerUrl } from "../../src/core/workspace-viewer-url.ts";
import {
	getWorkspaceViewer,
	listWorkspaceViewers,
	openWorkspaceViewer,
	registerWorkspaceViewer,
	subscribeWorkspaceViewers,
	type WorkspaceViewerInfo,
} from "../../src/core/workspace-viewers.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("workspace viewer registration", () => {
	it("publishes serializable metadata and stale disposers cannot remove a replacement", () => {
		const updates: WorkspaceViewerInfo[][] = [];
		cleanup.push(subscribeWorkspaceViewers((viewers) => updates.push(viewers)));
		const disposeOld = registerWorkspaceViewer({
			id: "office",
			title: "Office",
			extensions: ["XLSX", "xlsx"],
			open: async () => ({ url: "http://127.0.0.1:1234/viewer" }),
		});
		cleanup.push(disposeOld);
		expect(listWorkspaceViewers()).toEqual([{ id: "office", title: "Office", extensions: ["xlsx"] }]);
		const snapshot = listWorkspaceViewers();
		snapshot[0]!.title = "mutated";
		expect(getWorkspaceViewer("office")?.title).toBe("Office");
		const disposeNew = registerWorkspaceViewer({
			id: "office",
			title: "Updated Office",
			extensions: ["univer"],
			open: async () => ({ url: "http://127.0.0.1:1235/viewer" }),
		});
		cleanup.push(disposeNew);
		disposeOld();
		expect(getWorkspaceViewer("office")?.title).toBe("Updated Office");
		disposeNew();
		expect(getWorkspaceViewer("office")).toBeUndefined();
		expect(updates).toHaveLength(3);
		expect(updates.at(-1)).toEqual([]);
	});

	it("rejects malformed IDs and extensions", () => {
		const open = async () => ({ url: "http://localhost:1234/viewer" });
		expect(() =>
			registerWorkspaceViewer({ id: "../office", title: "Office", extensions: ["univer"], open }),
		).toThrow();
		expect(() => registerWorkspaceViewer({ id: "office", title: "Office", extensions: [".xlsx"], open })).toThrow();
		expect(() => registerWorkspaceViewer({ id: "office", title: "Office", extensions: [], open })).toThrow();
	});
});

describe("workspace viewer open fence", () => {
	it("only hands supported real files inside the workspace to the plugin", async () => {
		const root = await mkdtemp(join(tmpdir(), "owl-viewer-fence-"));
		const cwd = join(root, "project");
		const outside = join(root, "outside");
		const calls: string[] = [];
		cleanup.push(
			registerWorkspaceViewer({
				id: "office",
				title: "Office",
				extensions: ["univer"],
				open: async (request) => {
					calls.push(request.path);
					return { url: "http://127.0.0.1:1234/uf" };
				},
			}),
		);
		try {
			await mkdir(cwd);
			await mkdir(outside);
			await writeFile(join(cwd, "report.univer"), "test container");
			await writeFile(join(outside, "secret.univer"), "outside");
			await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
			expect(await openWorkspaceViewer("office", { cwd, path: "report.univer" })).toEqual({
				url: "http://127.0.0.1:1234/uf",
			});
			for (const path of [
				"../outside/secret.univer",
				join(outside, "secret.univer"),
				"linked/secret.univer",
				"report.txt",
				"./report.univer",
			]) {
				await expect(openWorkspaceViewer("office", { cwd, path })).rejects.toThrow();
			}
			expect(calls).toEqual(["report.univer"]);
			await expect(openWorkspaceViewer("missing", { cwd, path: "report.univer" })).rejects.toThrow("unavailable");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects external URLs and honors cancellation after plugin work", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "owl-viewer-result-"));
		try {
			await writeFile(join(cwd, "report.univer"), "test container");
			cleanup.push(
				registerWorkspaceViewer({
					id: "office",
					title: "Office",
					extensions: ["univer"],
					open: async () => ({ url: "https://example.com/report" }),
				}),
			);
			await expect(openWorkspaceViewer("office", { cwd, path: "report.univer" })).rejects.toThrow("local HTTP URL");
			const controller = new AbortController();
			cleanup.push(
				registerWorkspaceViewer({
					id: "office",
					title: "Office",
					extensions: ["univer"],
					open: async (request) => {
						expect(request.signal).toBe(controller.signal);
						controller.abort();
						return { url: "http://localhost:1234/uf" };
					},
				}),
			);
			await expect(
				openWorkspaceViewer("office", { cwd, path: "report.univer", signal: controller.signal }),
			).rejects.toThrow();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("workspace viewer URL policy", () => {
	it("permits local HTTP origins and rejects credentials, remote hosts, and other schemes", () => {
		for (const url of [
			"http://127.0.0.1:1234/uf?token=local",
			"http://localhost:1234/viewer",
			"http://[::1]:1234/viewer",
		])
			expect(isWorkspaceViewerUrl(url)).toBe(true);
		for (const url of [
			"https://localhost/viewer",
			"http://localhost.example.com/viewer",
			"http://user:password@localhost/viewer",
			"http://192.168.1.1/viewer",
			"javascript:alert(1)",
			"/viewer",
		])
			expect(isWorkspaceViewerUrl(url)).toBe(false);
	});
});
