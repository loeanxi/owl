import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../../bridge/client.ts";
import { DEFAULT_CHAT_APPEARANCE } from "../../chat-appearance.ts";
import { setUiLanguage, t } from "../../i18n/index.ts";
import { parseOwlWallpaper } from "../../wallpaper.ts";
import { SettingsPage } from "../SettingsPage.tsx";
import type { WallpaperEntry } from "../WallpaperLayer.tsx";

const fixture = vi.hoisted(() => ({ entries: [] as WallpaperEntry[] }));
vi.mock("../../bridge/native.ts", () => ({ pickFile: vi.fn(async () => undefined), pickFolder: vi.fn(async () => undefined) }));
vi.mock("../../window-glass.ts", () => ({ syncWindowGlass: vi.fn() }));
vi.mock("../../theme.ts", () => ({ getResolvedTheme: () => "dark", isThemePreference: () => true, setThemeLock: vi.fn(), setThemePreference: vi.fn() }));
vi.mock("../WallpaperLayer.tsx", () => ({
	fetchInventory: async () => fixture.entries,
	passesRating: () => true,
	resolveActiveEntry: (entries: WallpaperEntry[], settings: { customPath: string; selectionId: string }) => entries.find((entry) => entry.id === (settings.customPath ? "custom" : settings.selectionId)) ?? null,
}));

type Props = React.ComponentProps<typeof SettingsPage>;
let root: Root;
let host: HTMLElement;
let props: Props;
let settings: Record<string, unknown>;
let request: ReturnType<typeof vi.fn<(payload: Record<string, unknown>) => Promise<unknown>>>;
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
	const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	vi.stubGlobal("window", dom.window);
	vi.stubGlobal("document", dom.document);
	vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
	vi.stubGlobal("Element", dom.window.Element);
	vi.stubGlobal("Node", dom.window.Node);
	vi.stubGlobal("Event", dom.window.Event);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
	vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	const computedStyle = (element: Element): CSSStyleDeclaration => ({
		paddingTop: (element as HTMLElement).style?.paddingTop || "24px",
		getPropertyValue: (name: string) => name === "--color-owl-accent" ? "#58bfa9" : name === "--color-owl-accent-hover" ? "#479b88" : (element as HTMLElement).style?.getPropertyValue(name) || "",
	}) as CSSStyleDeclaration;
	dom.window.getComputedStyle = computedStyle;
	vi.stubGlobal("getComputedStyle", computedStyle);
	dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as MediaQueryList;
	Object.defineProperty(dom.window, "location", { value: { hash: "#workspace", origin: "http://localhost" }, configurable: true });
	scroll = vi.fn();
	dom.window.HTMLElement.prototype.scrollTo = scroll;
	dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 40, top: 0, left: 0, right: 800, bottom: 40, toJSON: () => ({}) });
	// React imported before a DOM uses its legacy input event path in this Node harness.
	Object.assign(dom.window.HTMLInputElement.prototype, {
		attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
		detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
	});
	Object.defineProperty(dom.window.HTMLInputElement.prototype, "valueAsNumber", { configurable: true, get(this: HTMLInputElement) { return Number(this.value); } });
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ general: { properties: { showStars: { type: "bool", text: "显示星光", value: true } } } }) })));
	setUiLanguage("zh");
	settings = {
		uiLanguage: "zh", theme: "dark", fileIconTheme: "minimal", owlAppearance: { preset: "liquid-glass" },
		desktopChatAppearance: { fontSize: 18, codeFontSize: 14, lineHeight: 1.8, width: 860, toolRecords: "expanded", motion: false },
	};
	fixture.entries = [{ id: "custom", title: "测试壁纸", type: "video", mediaUrl: "/test.mp4", webUrl: null, previewUrl: "/preview.jpg", contentRating: "everyone", schemeColor: "#202020", projectUrl: "/fixture/project.json", sceneSrc: null, pkgBytes: null, hasProps: true }];
	request = vi.fn(async (payload) => {
		if (payload.type === "settings.get") return { ok: true, result: { agentDir: "D:/profile", settings } };
		if (payload.type === "settings.set") { settings = { ...settings, ...(payload.values as Record<string, unknown>) }; return { ok: true, result: settings }; }
		if (["models.list", "auth.providers", "cursor.accounts.list", "session.list"].includes(String(payload.type))) return { ok: true, result: [] };
		return { ok: false };
	});
	props = {
		client: { request, onSessionEvent: () => () => {} } as unknown as BridgeClient,
		workspaceDir: "D:/owl", restoreSection: "appearance", onWorkspaceDir: vi.fn(), onClose: vi.fn(), onSectionChange: vi.fn(),
		wallpaper: parseOwlWallpaper({ enabled: true, customPath: "D:/wallpapers/test.mp4", rotationEnabled: true }), onWallpaperChange: vi.fn(),
		lifeProbe: { channels: [], round: "ok", checkedAt: undefined, refresh: async () => {} },
	};
	host = dom.document.getElementById("root")!;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	await act(async () => root.render(<SettingsPage {...props} />));
}

function group(key: "interface" | "reading" | "theme" | "wallpaper"): HTMLElement {
	return host.querySelector<HTMLElement>(`[data-appearance-section="${key}"]`)!;
}

function settingWrites(): Record<string, unknown>[] {
	return request.mock.calls.map(([payload]) => payload).filter((payload) => payload.type === "settings.set");
}

function buttonWithin(element: HTMLElement, label: string): HTMLButtonElement {
	return [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
}

async function changeRange(input: HTMLInputElement, value: number): Promise<void> {
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, String(value));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

describe("Appearance settings real-page integration", () => {
	it("places reading before themes and wallpapers while retaining all existing controls and previews", async () => {
		await render();
		expect([...host.querySelectorAll("[data-appearance-section]")].map((section) => section.getAttribute("data-appearance-section"))).toEqual(["interface", "reading", "theme", "wallpaper"]);
		expect(group("theme").querySelectorAll(".owl-settings-preset-card")).toHaveLength(21);
		expect(group("theme").querySelectorAll(".owl-settings-preset-preview")).toHaveLength(21);
		expect(group("theme").querySelector(`[aria-label="${t("settings.appearance.glassMode")}"]`)?.querySelectorAll('[role="radio"]')).toHaveLength(3);
		expect(group("theme").querySelector(`[aria-label="${t("settings.appearance.fileIconTheme")}"]`)?.querySelectorAll('[role="radio"]')).toHaveLength(4);
		expect(group("interface").querySelectorAll('.owl-settings-mode-row [role="radio"]')).toHaveLength(3);
		expect(group("interface").querySelector(`[aria-label="${t("settings.appearance.background")}"]`)).not.toBeNull();
		expect(group("interface").querySelector(`[aria-label="${t("settings.appearance.foreground")}"]`)).not.toBeNull();
		expect(group("reading").querySelectorAll('input[type="range"]')).toHaveLength(4);
		expect(buttonWithin(group("reading"), t("settings.general.saveReading"))).toBeDefined();
		expect(buttonWithin(group("reading"), t("settings.general.resetDefaults"))).toBeDefined();
		expect(group("reading").querySelector(`[aria-label="${t("settings.general.toolRecords")}"]`)).not.toBeNull();
		expect(group("reading").querySelector(`[title="${t("settings.general.motion")}"]`)).not.toBeNull();
		expect(group("wallpaper").querySelector(".owl-wallpaper-card img")?.getAttribute("src")).toBe("/preview.jpg");
		for (const key of ["wallpaperEnable", "wallpaperVolume", "wallpaperRate", "wallpaperDim", "wallpaperBlur", "wallpaperPanel", "wallpaperFit", "wallpaperRating", "wallpaperSceneFps", "wallpaperRotationInterval", "wallpaperRotationOrder", "wallpaperCustomDir"] as const) {
			expect(group("wallpaper").querySelector(`[aria-label="${t(`settings.appearance.${key}`)}"], [title="${t(`settings.appearance.${key}`)}"]`), key).not.toBeNull();
		}
		expect(group("wallpaper").textContent).toContain("显示星光");
		expect(buttonWithin(group("wallpaper"), t("settings.appearance.wallpaperLocalClear"))).toBeDefined();
		expect(buttonWithin(group("wallpaper"), t("settings.general.resetDefaults"))).toBeDefined();
	});

	it("keeps reading edits as a draft, then saves only desktopChatAppearance and applies it", async () => {
		await render();
		const input = group("reading").querySelector<HTMLInputElement>(`[aria-label="${t("settings.general.fieldFontSize")}"]`)!;
		await changeRange(input, 20);
		expect(input.value).toBe("20");
		expect(settingWrites()).toEqual([]);
		expect(document.documentElement.style.getPropertyValue("--owl-chat-font-size")).toBeUndefined();
		await act(async () => buttonWithin(group("reading"), t("settings.general.saveReading")).click());
		expect(settingWrites()).toEqual([{ type: "settings.set", values: { desktopChatAppearance: { fontSize: 20, codeFontSize: 14, lineHeight: 1.8, width: 860, toolRecords: "expanded", motion: false } } }]);
		expect(document.documentElement.style.getPropertyValue("--owl-chat-font-size")).toBe("20px");
		expect(props.onWallpaperChange).not.toHaveBeenCalled();
	});

	it("keeps glass, wallpaper, local-file and rotation options conditional on their original settings", async () => {
		await render();
		settings.owlAppearance = { preset: "" };
		props.client = { request, onSessionEvent: () => () => {} } as unknown as BridgeClient;
		props.wallpaper = parseOwlWallpaper({ enabled: false, rotationEnabled: false });
		await render();
		expect(group("theme").querySelector(`[aria-label="${t("settings.appearance.glassMode")}"]`)).toBeNull();
		expect(group("wallpaper").querySelector(`[aria-label="${t("settings.appearance.wallpaperVolume")}"]`)).toBeNull();
		expect(buttonWithin(group("wallpaper"), t("settings.appearance.wallpaperRefresh"))).toBeDefined();
		expect(buttonWithin(group("wallpaper"), t("settings.general.resetDefaults"))).toBeDefined();
		props.wallpaper = parseOwlWallpaper({ enabled: true, rotationEnabled: false });
		await render();
		expect(group("wallpaper").querySelector(`[aria-label="${t("settings.appearance.wallpaperVolume")}"]`)).not.toBeNull();
		expect(group("wallpaper").querySelector(`[aria-label="${t("settings.appearance.wallpaperRotationInterval")}"]`)).toBeNull();
		expect(group("wallpaper").querySelector(`[aria-label="${t("settings.appearance.wallpaperRotationOrder")}"]`)).toBeNull();
		expect(buttonWithin(group("wallpaper"), t("settings.appearance.wallpaperLocalClear"))).toBeUndefined();
		expect(group("wallpaper").textContent).not.toContain("显示星光");
		expect(settingWrites()).toEqual([]);
	});

	it("restores the actual reading defaults without saving and keeps their help text accurate", async () => {
		await render();
		await act(async () => buttonWithin(group("reading"), t("settings.general.resetDefaults")).click());
		const labels = ["fieldFontSize", "fieldCodeFontSize", "fieldLineHeight", "fieldWidth"] as const;
		const values = [DEFAULT_CHAT_APPEARANCE.fontSize, DEFAULT_CHAT_APPEARANCE.codeFontSize, DEFAULT_CHAT_APPEARANCE.lineHeight, DEFAULT_CHAT_APPEARANCE.width];
		for (const [index, label] of labels.entries()) {
			const slider = group("reading").querySelector<HTMLInputElement>(`[aria-label="${t(`settings.general.${label}`)}"]`)!;
			expect(slider.value).toBe(String(values[index]));
			expect(slider.closest(".owl-settings-row")?.querySelector(".owl-settings-row-description")?.textContent).toContain(String(values[index]));
		}
		expect(group("reading").textContent).toContain("输入区");
		expect(settingWrites()).toEqual([]);
		await act(async () => buttonWithin(group("reading"), t("settings.general.saveReading")).click());
		expect(settingWrites()).toEqual([{ type: "settings.set", values: { desktopChatAppearance: { ...DEFAULT_CHAT_APPEARANCE } } }]);
	});

	it("opens the Codex theme menu from the preset grid and saves the picked one as the preset", async () => {
		await render();
		const card = group("theme").querySelector<HTMLButtonElement>(".owl-settings-preset-grid .owl-codex-theme-card")!;
		expect(card.classList.contains("is-active")).toBe(false);
		await act(async () => card.click());
		const options = [...group("theme").querySelectorAll<HTMLButtonElement>('.owl-codex-theme-panel [role="option"]')];
		expect(options).toHaveLength(29);
		expect(options[0].textContent).toContain("ChatGPT");
		expect(group("theme").querySelector(".owl-codex-theme-group")?.textContent).toBe(t("settings.appearance.codexThemes"));
		expect(options.every((option) => option.querySelector(".owl-codex-theme-badge")?.textContent === "Aa")).toBe(true);
		const tokyo = options.find((option) => option.textContent?.includes("Tokyo Night"))!;
		expect(tokyo.textContent).toContain(t("settings.appearance.codexDarkOnly"));
		await act(async () => tokyo.click());
		expect(settingWrites().at(-1)).toEqual({
			type: "settings.set",
			values: { owlAppearance: { preset: "cx-tokyo-night", glass: "clear", accent: "", dark: { background: "", foreground: "" }, light: { background: "", foreground: "" } } },
		});
		expect(document.documentElement.dataset.owlPreset).toBe("cx-tokyo-night");
		const picked = group("theme").querySelector(".owl-codex-theme-card")!;
		expect(picked.classList.contains("is-active")).toBe(true);
		expect(picked.textContent).toContain("Tokyo Night");
	});

	it("uses in-page navigation without saving or changing the settings category", async () => {
		await render();
		const navigation = host.querySelector<HTMLElement>('nav[aria-label="外观设置分组"]')!;
		expect(navigation).not.toBeNull();
		for (const button of navigation.querySelectorAll<HTMLButtonElement>("button")) await act(async () => button.click());
		expect(scroll).toHaveBeenCalledTimes(4);
		expect(settingWrites()).toEqual([]);
		expect(props.onSectionChange).not.toHaveBeenCalled();
		expect(window.location.hash).toBe("#workspace");
	});
});
