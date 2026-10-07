import React from "react";
import { createRoot } from "react-dom/client";
import { MirrorTab } from "../../src/sidebar/tabs/MirrorTab.tsx";

const mode = new URLSearchParams(location.search).get("mode") ?? "project";
const calls = [];
const mirrorListeners = new Set();
const statusListeners = new Set();
const pendingProjects = [];
const performanceProbe = {
	enabled: false,
	inputDelayMs: 0,
	decodeDelayMs: 0,
	images: 0,
	activeDecodes: 0,
	maxDecodes: 0,
	sequence: 0,
	frames: new Map(),
	draws: [],
};
const OriginalImage = window.Image;
window.Image = function (...args) {
	const image = new OriginalImage(...args);
	let handler;
	Object.defineProperty(image, "onload", {
		get: () => handler,
		set: (value) => {
			handler = value;
		},
	});
	const measured = performanceProbe.enabled;
	if (measured) {
		performanceProbe.images++;
		performanceProbe.activeDecodes++;
		performanceProbe.maxDecodes = Math.max(performanceProbe.maxDecodes, performanceProbe.activeDecodes);
	}
	image.addEventListener("load", (event) => {
		const finish = () => {
			if (measured) performanceProbe.activeDecodes--;
			handler?.call(image, event);
		};
		if (performanceProbe.decodeDelayMs > 0) setTimeout(finish, performanceProbe.decodeDelayMs);
		else finish();
	});
	return image;
};
window.Image.prototype = OriginalImage.prototype;
const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
	if (performanceProbe.enabled && this.canvas.hasAttribute("data-mirror-content")) {
		const frame = performanceProbe.frames.get(image.src);
		performanceProbe.draws.push({ at: performance.now(), sequence: frame?.sequence, frameAt: frame?.at });
	}
	return originalDrawImage.call(this, image, ...args);
};
let sourceWindows = [makeWindow("fixture-window")];
let geometryVersion = 1;
let frameGeometry = geometry(640, 360);
function makeWindow(windowId) {
	return { windowId, hongguo: true, minimized: false, title: "红果短剧 · 测试窗口", width: 704, height: 410 };
}
function geometry(width, height) {
	return {
		geometryId: `geometry-${geometryVersion}`,
		sourceWidth: width + 64,
		sourceHeight: height + 50,
		crop: { x: 4, y: 40, width, height },
	};
}
const client = {
	request: async (request) => {
		const recorded = { ...request, at: performance.now() };
		calls.push(recorded);
		if (request.type === "mirror.list") return { ok: true, result: { supported: true, windows: sourceWindows } };
		if (request.type === "mirror.project" && request.visible !== false) {
			geometryVersion += 1;
			frameGeometry = geometry(frameGeometry.crop.width, frameGeometry.crop.height);
			if (mode === "pending")
				await new Promise((resolve) => {
					pendingProjects.push(resolve);
				});
			return { ok: true, result: frameGeometry };
		}
		if (request.type === "mirror.attach" && mode !== "no-frame") setTimeout(() => emitFrame(), 10);
		if (request.type === "mirror.input" && mode === "slow-input" && request.action === "move")
			await new Promise((resolve) => setTimeout(resolve, 80));
		if (request.type === "mirror.input" && performanceProbe.enabled && performanceProbe.inputDelayMs > 0)
			await new Promise((resolve) => setTimeout(resolve, performanceProbe.inputDelayMs));
		if (request.type === "mirror.input") {
			recorded.completedAt = performance.now();
			if (request.action === "wheel") recorded.appliedDeltaY = Math.round(request.deltaY ?? 0);
		}
		return { ok: true, result: {} };
	},
	onMirrorMessage: (callback) => {
		mirrorListeners.add(callback);
		return () => mirrorListeners.delete(callback);
	},
	onStatus: (callback) => {
		statusListeners.add(callback);
		return () => statusListeners.delete(callback);
	},
};
let root = createRoot(document.getElementById("mirror-root"));
function mount() {
	const component = React.createElement(MirrorTab, {
		tab: { id: "mirror", kind: "mirror", title: "短剧" },
		store: {
			closeTab: (id) => {
				calls.push({ type: "fixture.closeTab", id });
				root.unmount();
			},
		},
		client,
	});
	root.render(
		new URLSearchParams(location.search).has("strict")
			? React.createElement(React.StrictMode, null, component)
			: component,
	);
}
function emitFrame(width = 640, height = 360, options = {}) {
	if (options.newGeometry) geometryVersion += 1;
	frameGeometry = geometry(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = frameGeometry.sourceWidth;
	canvas.height = frameGeometry.sourceHeight;
	const context = canvas.getContext("2d");
	context.fillStyle = "#ff00ff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.translate(4, 40);
	context.fillStyle = "#273444";
	context.fillRect(0, 0, width, height);
	context.strokeStyle = "#ffffff";
	context.lineWidth = 6;
	context.strokeRect(3, 3, width - 6, height - 6);
	context.fillStyle = "#00ffff";
	context.fillRect((width - 120) / 2, (height - 120) / 2, 120, 120);
	context.fillStyle = "#ffffff";
	context.font = "24px sans-serif";
	context.fillText(`${width} × ${height} · 完整短剧画面`, 24, 44);
	if (performanceProbe.enabled) context.fillText(`frame ${++performanceProbe.sequence}`, 24, 74);
	context.fillStyle = "#00cc44";
	context.fillRect(5, height - 30, width - 10, 25);
	context.fillStyle = "#ffffff";
	context.font = "16px sans-serif";
	context.fillText("首页       剧场       选集       我的", 24, height - 12);
	const data = canvas.toDataURL("image/jpeg", 0.98).split(",")[1];
	if (performanceProbe.enabled)
		performanceProbe.frames.set(`data:image/jpeg;base64,${data}`, {
			sequence: performanceProbe.sequence,
			at: performance.now(),
		});
	for (const callback of mirrorListeners)
		callback({
			type: "mirror.frame",
			windowId: options.windowId ?? sourceWindows[0]?.windowId,
			width: canvas.width,
			height: canvas.height,
			data,
			geometry: options.invalid
				? { ...frameGeometry, crop: { ...frameGeometry.crop, width: canvas.width + 1 } }
				: { ...frameGeometry, geometryId: options.geometryId ?? frameGeometry.geometryId },
		});
}
window.harness = {
	calls,
	emitFrame,
	mount,
	geometry: () => frameGeometry,
	configurePerformance: (options) => {
		Object.assign(
			performanceProbe,
			{
				enabled: true,
				inputDelayMs: 0,
				decodeDelayMs: 0,
				images: 0,
				activeDecodes: 0,
				maxDecodes: 0,
				sequence: 0,
				draws: [],
			},
			options,
		);
		performanceProbe.frames.clear();
		calls.length = 0;
	},
	performanceMetrics: () => ({
		images: performanceProbe.images,
		activeDecodes: performanceProbe.activeDecodes,
		maxDecodes: performanceProbe.maxDecodes,
		receivedFrames: performanceProbe.sequence,
		draws: performanceProbe.draws,
	}),
	emitWindows: (ids) => {
		sourceWindows = ids.map(makeWindow);
		for (const callback of mirrorListeners) callback({ type: "mirror.windows", windows: sourceWindows });
	},
	emitStatus: (online) => {
		for (const callback of statusListeners) callback(online);
	},
	listenerCount: () => mirrorListeners.size,
	clearCalls: () => {
		calls.length = 0;
	},
	completeProject: () => pendingProjects.shift()?.(),
	remount: () => {
		root = createRoot(document.getElementById("mirror-root"));
		mount();
	},
	unmount: () => root.unmount(),
	setPanel: (rect) => {
		Object.assign(
			document.getElementById("panel").style,
			Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, `${value}px`])),
		);
		window.dispatchEvent(new Event("resize"));
	},
};
mount();
