import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { UI_BUILD } from "../bridge/build-info.ts";
import type { BridgeClient } from "../bridge/client.ts";
import { hasTauri } from "../bridge/native.ts";
import type { BuildHelloResult, BuildIssue } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";

/** Tauri 壳的桥巡检事件（main.rs 的 bridge watchdog）。 */
interface BridgeWatchdogEvent {
	state: "exited" | "restarted" | "down";
	code?: number | null;
}

type BannerIssue =
	| BuildIssue
	/** 桥不认识 build.hello：桥比 UI 旧。 */
	| { kind: "bridge-outdated" }
	| { kind: "bridge-exited"; code: number | null; restarted: boolean }
	| { kind: "bridge-down" };

const DISMISS_KEY = "owl.buildBanner.dismissed";
const SEVERE = new Set<BannerIssue["kind"]>(["protocol-mismatch", "bridge-outdated", "bridge-down"]);

function readDismissed(): string {
	try {
		return localStorage.getItem(DISMISS_KEY) ?? "";
	} catch {
		return "";
	}
}

/**
 * 构建一致性横幅：每次连上桥报一次 UI 指纹（build.hello），把"界面/桥/插件不是同一版代码"、
 * "改完没重建/没重启"、"有状态文件曾损坏"和桥进程崩溃重启直接摆到用户眼前，
 * 而不是让它们表现成"点了没反应"。收起按问题集签名记住，问题变了才重新出现。
 */
export function BuildConsistencyBanner({ client, connected }: { client: BridgeClient; connected: boolean }): React.JSX.Element | null {
	const t = useT();
	const [buildIssues, setBuildIssues] = useState<BannerIssue[]>([]);
	const [watchdog, setWatchdog] = useState<BannerIssue | null>(null);
	const [dismissed, setDismissed] = useState(readDismissed);

	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		client.request<BuildHelloResult>({ type: "build.hello", ui: UI_BUILD }).then(
			(response) => {
				if (cancelled) return;
				if (response.ok && response.result) setBuildIssues(response.result.issues);
				else if (response.error?.includes("未知请求类型")) setBuildIssues([{ kind: "bridge-outdated" }]);
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [client, connected]);

	useEffect(() => {
		if (!hasTauri()) return;
		let unlisten: (() => void) | undefined;
		let disposed = false;
		void listen<BridgeWatchdogEvent>("owl-bridge", (event) => {
			const payload = event.payload;
			if (payload?.state === "down") setWatchdog({ kind: "bridge-down" });
			else if (payload?.state === "exited" || payload?.state === "restarted") {
				setWatchdog({ kind: "bridge-exited", code: payload.code ?? null, restarted: payload.state === "restarted" });
			}
		}).then((off) => {
			if (disposed) off();
			else unlisten = off;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const issues = useMemo(() => (watchdog ? [watchdog, ...buildIssues] : buildIssues), [watchdog, buildIssues]);
	const signature = useMemo(() => JSON.stringify(issues), [issues]);
	if (issues.length === 0 || signature === dismissed) return null;

	const severe = issues.some((issue) => SEVERE.has(issue.kind));
	const title = issues.every((issue) => issue.kind === "corrupt-files")
		? t("build.titleCorrupt")
		: issues.every((issue) => issue.kind === "bridge-exited" || issue.kind === "bridge-down")
			? t("build.titleBridge")
			: t("build.title");
	const describe = (issue: BannerIssue): string => {
		const fileVars = (changed: { files: string[]; count: number }) => ({ files: changed.files.join("、"), count: changed.count });
		switch (issue.kind) {
			case "protocol-mismatch":
				return t("build.protocolMismatch", { ui: issue.uiProtocol, bridge: issue.bridgeProtocol });
			case "bridge-outdated":
				return t("build.bridgeOutdated");
			case "ui-reload":
				return t("build.uiReload");
			case "ui-source-newer":
				return t("build.uiSourceNewer", fileVars(issue));
			case "bridge-restart":
				return t("build.bridgeRestart");
			case "bridge-source-newer":
				return t("build.bridgeSourceNewer", fileVars(issue));
			case "bridge-unstamped":
				return t("build.bridgeUnstamped");
			case "plugin-source-newer":
				return t("build.pluginSourceNewer", { plugin: issue.plugin, ...fileVars(issue) });
			case "corrupt-files":
				return t("build.corruptFiles", { count: issue.files.length, path: issue.files[0]?.path ?? "" });
			case "bridge-exited":
				return t(issue.restarted ? "build.bridgeExited" : "build.bridgeRestarting", { code: issue.code ?? "?" });
			case "bridge-down":
				return t("build.bridgeDown");
		}
	};
	const dismiss = (): void => {
		setDismissed(signature);
		try {
			localStorage.setItem(DISMISS_KEY, signature);
		} catch {
			// 存不下就只在本次会话内收起
		}
	};

	return (
		<div className="pointer-events-none fixed inset-x-0 top-10 z-[60] flex justify-center px-4">
			<div
				className={
					"pointer-events-auto w-full max-w-2xl rounded-xl border px-3 py-2 text-xs shadow-lg shadow-black/25 backdrop-blur-sm " +
					(severe ? "border-red-500/30 bg-red-500/10" : "border-amber-500/30 bg-amber-500/10")
				}
				role="alert"
			>
				<div className="flex items-start gap-2.5">
					<span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${severe ? "bg-red-400" : "bg-amber-400"}`} />
					<div className="min-w-0 flex-1">
						<div className="font-medium text-owl-text">{title}</div>
						<ul className="mt-0.5 space-y-0.5 text-owl-muted">
							{issues.map((issue) => (
								<li key={JSON.stringify(issue)} className="break-all">
									{describe(issue)}
								</li>
							))}
						</ul>
					</div>
					{issues.some((issue) => issue.kind === "ui-reload") && (
						<button
							type="button"
							onClick={() => window.location.reload()}
							className="shrink-0 rounded-md border border-owl-border px-2 py-0.5 text-owl-text transition-colors hover:bg-owl-hover"
						>
							{t("build.reload")}
						</button>
					)}
					<button
						type="button"
						title={t("build.dismiss")}
						aria-label={t("build.dismiss")}
						onClick={dismiss}
						className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-owl-faint transition-colors hover:bg-owl-hover hover:text-owl-text"
					>
						×
					</button>
				</div>
			</div>
		</div>
	);
}
