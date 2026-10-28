/**
 * 按当前文件图标主题渲染单个文件/文件夹图标。
 * minimal 是调用方原有的图标（各处着色规则不同，由调用方给出）；
 * Seti 不带文件夹图标，文件夹沿用 minimal。
 * Material 的 SVG 由 vite.config.ts 的 owlMaterialIcons 挂到 /file-icons/material/。
 */
import materialRaw from "material-icon-theme/dist/material-icons.json";
import { useSyncExternalStore } from "react";
import { resolveSurfaceTheme } from "../owl-appearance.ts";
import { getFileIconTheme, subscribeFileIconTheme } from "./file-icon-theme.ts";
import { fontGlyph, type IconThemeManifest, iconFileName, resolveIconId } from "./resolve.ts";
import setiRaw from "./seti/vs-seti-icon-theme.json";
import "./file-icons.css";

const SETI = setiRaw as IconThemeManifest;
const MATERIAL = materialRaw as IconThemeManifest;
const MATERIAL_BASE = `${import.meta.env.BASE_URL}file-icons/material/`;

// 一棵文件树几百行：共用一个 <html> 属性观察器，而不是每个图标各挂一个。
const surfaceListeners = new Set<() => void>();
let surfaceObserver: MutationObserver | undefined;

function subscribeSurface(listener: () => void): () => void {
	surfaceListeners.add(listener);
	if (surfaceObserver === undefined) {
		surfaceObserver = new MutationObserver(() => {
			for (const notify of surfaceListeners) notify();
		});
		surfaceObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-owl-theme", "data-owl-wallpaper", "data-owl-glass-theme"],
		});
	}
	return () => {
		surfaceListeners.delete(listener);
		if (surfaceListeners.size === 0) {
			surfaceObserver?.disconnect();
			surfaceObserver = undefined;
		}
	};
}

function getSurface(): "dark" | "light" {
	return resolveSurfaceTheme(document.documentElement.dataset);
}

export function useFileIconTheme() {
	return useSyncExternalStore(subscribeFileIconTheme, getFileIconTheme);
}

interface FileIconProps {
	/** 文件或文件夹名（不含路径）。 */
	name: string;
	folder?: boolean;
	open?: boolean;
	size?: number;
	minimal: React.ReactNode;
}

export function FileIcon({ name, folder = false, open = false, size = 14, minimal }: FileIconProps): React.ReactNode {
	const theme = useFileIconTheme();
	const light = useSyncExternalStore(subscribeSurface, getSurface) === "light";
	if (theme === "none") return null;
	if (theme === "seti" && !folder) {
		const id = resolveIconId(SETI, name, "file", light);
		const definition = id === undefined ? undefined : SETI.iconDefinitions[id];
		if (definition?.fontCharacter !== undefined) {
			return (
				<span
					aria-hidden="true"
					className="owl-file-icon-seti"
					style={{ width: size, height: size, fontSize: Math.round(size * 1.45), color: definition.fontColor }}
				>
					{fontGlyph(definition.fontCharacter)}
				</span>
			);
		}
	}
	if (theme === "material") {
		const id = resolveIconId(MATERIAL, name, folder ? (open ? "folderExpanded" : "folder") : "file", light);
		const iconPath = id === undefined ? undefined : MATERIAL.iconDefinitions[id]?.iconPath;
		if (iconPath !== undefined) {
			return (
				<img
					alt=""
					aria-hidden="true"
					draggable={false}
					className="owl-file-icon-img"
					width={size}
					height={size}
					src={`${MATERIAL_BASE}${iconFileName(iconPath)}`}
				/>
			);
		}
	}
	return minimal;
}
