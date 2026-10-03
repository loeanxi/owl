/**
 * 图片 tab：fs.readBin 整文件 base64 → data URL，带缩放控制。
 * （dsh-better-sidebar 用 /sidebar/file HTTP 路由做媒体流；owl 桥是纯 WS
 * JSON，8MB 内的 base64 本地回环传输成本可接受。）
 */
import { useEffect, useState } from "react";
import type { TabComponentProps } from "../registry.ts";
import { IconLoader } from "../icons.tsx";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];

export function ImageTab({ api, client, cwd, tab }: TabComponentProps): React.JSX.Element {
	const path = tab.path ?? "";
	const [src, setSrc] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [zoom, setZoom] = useState(1);

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

	const step = ZOOM_STEPS.indexOf(zoom);

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
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(#2f2e2b_0%_25%,#262624_0%_50%)] bg-[length:16px_16px] p-4">
				{src === undefined && error === undefined && <IconLoader size={20} className="animate-spin text-owl-faint" />}
				{src !== undefined && <img src={src} alt={path} style={{ transform: `scale(${zoom})`, transformOrigin: "center" }} className="max-h-full max-w-full object-contain transition-transform" />}
			</div>
		</div>
	);
}
