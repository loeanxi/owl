import { parseHTML } from "linkedom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUiLanguage } from "../../i18n/index.ts";
import { AppearanceNavigation } from "./AppearanceNavigation.tsx";

const sections = [
	{ id: "appearance-interface", label: "界面" },
	{ id: "appearance-reading", label: "阅读" },
	{ id: "appearance-theme", label: "主题" },
	{ id: "appearance-wallpaper", label: "壁纸" },
];
const offsets = [160, 780, 1300, 2100];
let root: Root;
let host: HTMLElement;
let content: HTMLElement;
let outerScroll: ReturnType<typeof vi.fn>;
let contentScroll: ReturnType<typeof vi.fn>;
let persist: ReturnType<typeof vi.fn>;
let contentPadding: number;

beforeEach(() => {
	vi.useFakeTimers();
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	persist = vi.fn();
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
	window.matchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
	contentPadding = 0;
	window.getComputedStyle = vi.fn(() => ({ paddingTop: `${contentPadding}px` }) as CSSStyleDeclaration);
	Object.defineProperty(window, "location", { value: { hash: "#existing-route" }, configurable: true });
	setUiLanguage("zh");
	persist.mockClear();
	host = document.getElementById("root")!;
	root = createRoot(host);
	outerScroll = vi.fn();
	host.scrollTo = outerScroll;
	contentScroll = vi.fn();
	dom.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
		const index = sections.findIndex((section) => section.id === this.id);
		const isNavigation = this.classList.contains("owl-appearance-navigation");
		// A sticky child's top includes its parent's padding unless its inset offsets that edge.
		const top = isNavigation
			? 80 + contentPadding - (Number.parseFloat(this.style.getPropertyValue("--owl-appearance-content-inset")) || 0)
			: index === -1
				? 80
				: 80 + offsets[index] - (content?.scrollTop ?? 0);
		const height = isNavigation ? 48 : 600;
		return { x: 0, y: top, top, left: 0, width: 280, height, right: 280, bottom: top + height, toJSON: () => ({}) };
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(labels = sections): Promise<void> {
	await act(async () =>
		root.render(
			<div className="owl-settings-page">
				<div
					className="owl-settings-content"
					data-owl-settings-section="appearance"
					ref={(node) => {
						if (!node) return;
						if (content !== node) {
							content = node;
							content.scrollTop = 0;
							content.scrollTo = contentScroll;
							Object.defineProperties(content, {
								clientTop: { value: 0, configurable: true },
								clientHeight: { value: 600, configurable: true },
								scrollHeight: { value: 2800, configurable: true },
							});
						}
					}}
				>
					<AppearanceNavigation sections={labels} />
					{sections.map((section) => (
						<section id={section.id} key={section.id} tabIndex={-1} data-appearance-section="true">
							{section.label}
						</section>
					))}
				</div>
			</div>,
		),
	);
}

function button(index: number): HTMLButtonElement {
	return host.querySelectorAll<HTMLButtonElement>("nav button")[index];
}

describe("Appearance settings navigation", () => {
	it("scrolls only its settings content and focuses the requested group without saving or routing", async () => {
		await render();
		const target = document.getElementById(sections[1].id)!;
		const focus = vi.spyOn(target, "focus");
		await act(async () => button(1).click());
		expect(contentScroll).toHaveBeenCalledExactlyOnceWith({ top: 716, behavior: "smooth" });
		expect(outerScroll).not.toHaveBeenCalled();
		expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
		expect(button(1).getAttribute("aria-current")).toBe("location");
		expect(window.location.hash).toBe("#existing-route");
		expect(persist).not.toHaveBeenCalled();
	});

	it("tracks manually scrolled sections, including the final short group at the bottom", async () => {
		await render();
		expect(button(0).getAttribute("aria-current")).toBe("location");
		await act(async () => {
			content.scrollTop = 800;
			content.dispatchEvent(new window.Event("scroll"));
			vi.runAllTimers();
		});
		expect(button(1).getAttribute("aria-current")).toBe("location");
		await render(sections.map((section) => ({ ...section })));
		expect(button(1).getAttribute("aria-current")).toBe("location");
		expect(content.scrollTop).toBe(800);
		await act(async () => {
			content.scrollTop = 2200;
			content.dispatchEvent(new window.Event("scroll"));
			vi.runAllTimers();
		});
		expect(button(3).getAttribute("aria-current")).toBe("location");
		expect(contentScroll).not.toHaveBeenCalled();
	});

	it("uses native keyboard buttons for all labels and respects reduced motion", async () => {
		window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
		await render(
			sections.map((section, index) => ({
				...section,
				label: ["Interface", "Reading", "Theme", "Wallpaper"][index],
			})),
		);
		expect(
			[...host.querySelectorAll<HTMLButtonElement>("nav button")].map((entry) => [
				entry.type,
				entry.textContent,
				entry.getAttribute("aria-controls"),
			]),
		).toEqual(
			sections.map((section, index) => [
				"button",
				["Interface", "Reading", "Theme", "Wallpaper"][index],
				section.id,
			]),
		);
		await act(async () => button(2).click());
		expect(contentScroll).toHaveBeenLastCalledWith({ top: 1236, behavior: "auto" });
		expect(persist).not.toHaveBeenCalled();
	});

	it("keeps the sticky bar flush and headings 16px below it as container padding changes", async () => {
		contentPadding = 32;
		await render();
		contentScroll.mockImplementation((options: ScrollToOptions) => {
			content.scrollTop = options.top ?? 0;
		});
		const nav = host.querySelector<HTMLElement>("nav")!;
		const target = document.getElementById(sections[1].id)!;
		await act(async () => button(1).click());
		expect(nav.getBoundingClientRect().top).toBe(content.getBoundingClientRect().top);
		expect(target.getBoundingClientRect().top - nav.getBoundingClientRect().bottom).toBe(16);
		contentPadding = 16;
		await act(async () => {
			content.dispatchEvent(new window.Event("scroll"));
			vi.runAllTimers();
		});
		await act(async () => button(1).click());
		expect(nav.getBoundingClientRect().top).toBe(content.getBoundingClientRect().top);
		expect(target.getBoundingClientRect().top - nav.getBoundingClientRect().bottom).toBe(16);
		expect(outerScroll).not.toHaveBeenCalled();
	});
});
