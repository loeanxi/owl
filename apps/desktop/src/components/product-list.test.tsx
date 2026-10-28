import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "../hooks/products.ts";
import { setUiLanguage } from "../i18n/index.ts";
import { ProductList } from "./ProductList.tsx";

let root: Root;
let host: HTMLElement;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	setUiLanguage("zh");
	host = document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setUiLanguage("zh");
});

const fileProduct: Product = {
	id: "file:report.md",
	kind: "file",
	title: "report.md",
	subtitle: "report.md",
	path: "report.md",
	toolId: "w1",
	fileKind: "document",
	action: "written",
};

const chartProduct: Product = {
	id: "visual:v1",
	kind: "chart",
	title: "月度趋势",
	toolId: "v1",
};

async function render(node: React.ReactNode): Promise<void> {
	await act(async () => {
		root.render(node);
	});
}

describe("the product list", () => {
	it("lists files and visualizations in one table", async () => {
		await render(<ProductList products={[fileProduct, chartProduct]} />);
		const rows = host.querySelectorAll(".owl-product-row");
		expect(rows).toHaveLength(2);
		expect(host.querySelector(".owl-products-heading")?.textContent).toContain("产物");
		expect(host.querySelector(".owl-products-heading")?.textContent).toContain("2");
		// 类型徽标：文件按文件类型，可视化按形态。
		expect(host.querySelector(".owl-product-kind[data-kind='file']")?.textContent).toBe("文档");
		expect(host.querySelector(".owl-product-kind[data-kind='chart']")?.textContent).toBe("图表");
	});

	it("opens a file product through the file action", async () => {
		const onOpenFile = vi.fn();
		await render(<ProductList products={[fileProduct]} onOpenFile={onOpenFile} />);
		const button = host.querySelector(".owl-product-button") as HTMLButtonElement;
		await act(async () => {
			button.click();
		});
		expect(onOpenFile).toHaveBeenCalled();
	});

	it("locates a visualization product instead of opening a file", async () => {
		const onLocate = vi.fn();
		const onOpenFile = vi.fn();
		await render(<ProductList products={[chartProduct]} onOpenFile={onOpenFile} onLocate={onLocate} />);
		const button = host.querySelector(".owl-product-button") as HTMLButtonElement;
		await act(async () => {
			button.click();
		});
		expect(onLocate).toHaveBeenCalledWith("v1");
		expect(onOpenFile).not.toHaveBeenCalled();
	});

	it("renders nothing without products", async () => {
		await render(<ProductList products={[]} />);
		expect(host.querySelector(".owl-products")).toBeNull();
	});

	it("opens the artifact page when the host offers one", async () => {
		const onOpenProduct = vi.fn();
		await render(<ProductList products={[fileProduct, chartProduct]} onOpenProduct={onOpenProduct} />);
		const buttons = [...host.querySelectorAll(".owl-product-button")] as HTMLButtonElement[];
		expect(buttons).toHaveLength(2);
		await act(async () => {
			buttons[0]!.click();
		});
		expect(onOpenProduct).toHaveBeenCalledWith(fileProduct);
		await act(async () => {
			buttons[1]!.click();
		});
		expect(onOpenProduct).toHaveBeenCalledWith(chartProduct);
	});
});
