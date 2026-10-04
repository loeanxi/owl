/**
 * 图片 tab：fs.readBin 整文件 base64 → data URL，带缩放控制。
 * （dsh-better-sidebar 用 /sidebar/file HTTP 路由做媒体流；owl 桥是纯 WS
 * JSON，8MB 内的 base64 本地回环传输成本可接受。）
 */
import { useEffect, useRef, useState } from "react";
import type { TabComponentProps } from "../registry.ts";
import { IconLoader } from "../icons.tsx";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];

/** 舞台内边距（与渲染层的 p-4 一致）；适配基准按扣掉内边距的可用区算。 */
const STAGE_PADDING = 16;

export function ImageTab({ api, client, cwd, tab }: TabComponentProps): React.JSX.Element {
	const path = tab.path ?? "";
	const [src, setSrc] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [zoom, setZoom] = useState(1);
	const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined);
	const [stage, setStage] = useState<{ width: number; height: number } | undefined>(undefined);
	const stageRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let url: string | undefined;
		let cancelled = false;
		let initialized = false;
		let readVersion = 0;
		const load = (): void => {
			if (cancelled || initialized) return;
			const version = ++readVersion;
			setError(undefined);
			void api
				.fsReadBin(cwd, path)
				.then((result) => {
					if (cancelled || version !== readVersion) return;
					url = `data:${result.mediaType};base64,${result.base64}`;
					setSrc(url);
					initialized = true;
				})
				.catch((err: unknown) => {
					if (!cancelled && version === readVersion) setError(err instanceof Error ? err.message : String(err));
				});
		};
		const offStatus = client.onStatus((connected) => {
			if (connected) load();
			else readVersion += 1;
		});
		load();
		return () => {
			cancelled = true;
			readVersion += 1;
			offStatus();
			// data URL 无需 revoke；保留结构以便换成 blob URL
			void url;
		};
	}, [api, client, cwd, path]);

	// 舞台尺寸：适配基准跟着可用区走（tab 非激活隐藏时是 0 尺寸，激活后再量）。
	// 桌面壳里 ResizeObserver 可能饿死，用 BrowserTab 同款兜底：先量一次 + 观察者 + 轮询。
	useEffect(() => {
		const element = stageRef.current;
		if (!element) return;
		const measure = (): void => {
			const width = element.clientWidth;
			const height = element.clientHeight;
			setStage((current) =>
				current !== undefined && current.width === width && current.height === height ? current : { width, height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		const poll = window.setInterval(measure, 1_000);
		return () => {
			observer.disconnect();
			window.clearInterval(poll);
		};
	}, []);

	// 缩放走布局尺寸（width/height = 适配基准 × zoom），不能用 transform: scale——
	// transform 的向上/向左溢出进不了滚动区，放大后图片顶部/左侧永远看不到。
	const usable =
		natural !== undefined && stage !== undefined && stage.width > STAGE_PADDING * 2 && stage.height > STAGE_PADDING * 2
			? Math.min(
					(stage.width - STAGE_PADDING * 2) / natural.width,
					(stage.height - STAGE_PADDING * 2) / natural.height,
					1,
				)
			: undefined;
	const display =
		natural !== undefined && usable !== undefined
			? {
					width: Math.max(1, Math.round(natural.width * usable * zoom)),
					height: Math.max(1, Math.round(natural.height * usable * zoom)),
				}
			: undefined;

	const step = ZOOM_STEPS.indexOf(zoom);

	const syncNatural = (node: HTMLImageElement | null): void => {
		// data URL 可能早就解码完（ref 回调时机晚于 load 事件），complete 也要兜
		if (node !== null && node.complete && node.naturalWidth > 0) {
			setNatural((current) =>
				current !== undefined && current.width === node.naturalWidth && current.height === node.naturalHeight
					? current
					: { width: node.naturalWidth, height: node.naturalHeight },
			);
		}
	};

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex items-center gap-2 border-b border-owl-border/40 px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-owl-faint" title={path}>
					{path}
				</span>
				<button type="button" className="rounded px-1.5 py-0.5 text-xs text-owl-muted hover:bg-owl-hover" onClick={() => setZoom(ZOOM_STEPS[Math.max(0, step - 1)] ?? 0.25)} disabled={step <= 0}>
					−
				</button>
				<span className="w-10 text-center text-[11px] text-owl-faint">{Math.round(zoom * 100)}%</span>
				<button type="button" className="rounded px-1.5 py-0.5 text-xs text-owl-muted hover:bg-owl-hover" onClick={() => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, step + 1)] ?? 3)} disabled={step >= ZOOM_STEPS.length - 1}>
					+
				</button>
				<button type="button" className="rounded px-1.5 py-0.5 text-[11px] text-owl-muted hover:bg-owl-hover" onClick={() => setZoom(1)}>
					适应
				</button>
			</div>
			{error !== undefined && (
				<div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</div>
			)}
			<div
				ref={stageRef}
				className="flex min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(#2f2e2b_0%_25%,#262624_0%_50%)] bg-[length:16px_16px]"
			>
				{src === undefined && error === undefined && <IconLoader size={20} className="m-auto animate-spin text-owl-faint" />}
				{src !== undefined && (
					// display 依赖图片原始尺寸：尺寸未就绪时先隐藏渲染（display:none 也照常解码触发 onLoad）
					<div className="m-auto p-4" style={display === undefined ? { display: "none" } : undefined}>
						<img
							ref={syncNatural}
							src={src}
							alt={path}
							onLoad={(event) => syncNatural(event.currentTarget)}
							// 内联尺寸并关掉 max-width：Tailwind Preflight 给 img 的
							// max-width:100%/height:auto 会把放大尺寸压回容器宽
							style={display === undefined ? undefined : { width: display.width, height: display.height, maxWidth: "none" }}
							className="block select-none"
						/>
					</div>
				)}
			</div>
		</div>
	);
}
