import { setWindowGlass } from "./bridge/native.ts";
import { isGlassPreset, type OwlAppearanceColors } from "./owl-appearance.ts";

/**
 * 液态玻璃预设的「真透明」：桌面壳里按 glass 档位给窗口挂背板，成功后在 <html> 写
 * data-owl-window-glass="<档位>"，desktop-shell.css 据此撤掉页面自绘的流光底、整窗透出桌面，
 * 并按档位调面板薄厚。挂不上（浏览器模式 / 老系统）就不写属性，页面继续用自绘流光兜底。
 */
let wanted = "off";

export function syncWindowGlass(appearance: Pick<OwlAppearanceColors, "preset" | "glass">): void {
	const next = isGlassPreset(appearance.preset) ? appearance.glass : "off";
	if (next === wanted) return;
	wanted = next;
	const root = document.documentElement;
	if (next === "off") {
		delete root.dataset.owlWindowGlass;
		void setWindowGlass("off");
		return;
	}
	void setWindowGlass(next).then((ok) => {
		if (!ok || wanted !== next) return;
		root.dataset.owlWindowGlass = next;
	});
}
