import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";
import { resolveArtifactActionPath } from "./artifact-actions.ts";
import { useArtifactActionText } from "./artifact-actions-copy.ts";
import "./artifact-actions.css";

type Action = "open" | "reveal" | "copy";
interface Feedback {
	generation: number;
	action: Action;
	status: "pending" | "success" | "error";
	error?: string;
}

export interface ArtifactActionsProps {
	path: string;
	title?: string;
	client?: BridgeClient;
	cwd?: string;
	onOpenFile?: (path: string) => void | Promise<void>;
	/** Keep the established file-title button on artifact cards. */
	children?: (open: () => void, disabled: boolean) => React.ReactNode;
	/** 在文件行的操作菜单中复用相同的确认与错误反馈。 */
	menu?: boolean;
}

/** Acknowledged file actions; failed operations remain visible and can be retried. */
export function ArtifactActions({
	path,
	title,
	client,
	cwd,
	onOpenFile,
	children,
	menu = false,
}: ArtifactActionsProps): React.JSX.Element {
	const text = useArtifactActionText();
	const [feedback, setFeedback] = useState<Feedback>();
	const mounted = useRef(true);
	const current = useRef({ path, cwd, client, generation: 0 });
	if (current.current.path !== path || current.current.cwd !== cwd || current.current.client !== client) {
		current.current = { path, cwd, client, generation: current.current.generation + 1 };
	}
	const generation = current.current.generation;
	const pending = useRef<{ generation: number; action: Action } | undefined>(undefined);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const visible = feedback?.generation === generation ? feedback : undefined;
	const busy = visible?.status === "pending";
	const resolved = cwd ? resolveArtifactActionPath(path, cwd) : undefined;
	const unavailable = !cwd ? text("missingWorkspace") : !resolved ? text("invalidPath") : undefined;

	const run = async (action: Action): Promise<void> => {
		if (pending.current?.generation === generation) return;
		const token = { generation, action };
		pending.current = token;
		setFeedback({ ...token, status: "pending" });
		const active = (): boolean => mounted.current && current.current.generation === generation;
		try {
			if (cwd && !resolved) throw new Error(text("invalidPath"));
			if (action === "copy") {
				if (!resolved) throw new Error(text("missingWorkspace"));
				if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
					throw new Error(text("clipboardUnavailable"));
				await navigator.clipboard.writeText(resolved.absolute);
			} else if (action === "reveal") {
				if (!resolved || !cwd) throw new Error(text("missingWorkspace"));
				if (!client) throw new Error(text("missingConnection"));
				const response = await client.request({
					type: "open.external",
					action: "reveal",
					target: resolved.relative,
					cwd,
				});
				if (!response.ok) throw new Error(response.error ?? text("failed"));
			} else {
				if (!onOpenFile) throw new Error(text("missingOpen"));
				if (client && cwd && resolved) {
					const response = await client.request<{ isFile: boolean }>({
						type: "fs.stat",
						cwd,
						path: resolved.relative,
					});
					if (!response.ok) throw new Error(response.error ?? text("failed"));
					if (!response.result?.isFile) throw new Error(text("notFile"));
				}
				if (!active()) return;
				await onOpenFile(resolved?.relative ?? path);
			}
			if (active()) setFeedback({ ...token, status: "success" });
		} catch (error) {
			if (active())
				setFeedback({ ...token, status: "error", error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (pending.current === token) pending.current = undefined;
		}
	};
	return (
		<div className="owl-artifact-actions" onClick={(event) => event.stopPropagation()}>
			{children?.(
				() => {
					void run("open");
				},
				!!busy || !!(cwd && !resolved) || !onOpenFile,
			)}
			<div
				className="owl-artifact-actions-buttons"
				role={menu ? "none" : "group"}
				aria-label={menu ? undefined : title ? `${title} · ${text("group")}` : text("group")}
			>
				{onOpenFile && (
					<button
						type="button"
						role={menu ? "menuitem" : undefined}
						disabled={busy || !!(cwd && !resolved)}
						title={cwd && !resolved ? unavailable : undefined}
						onClick={() => void run("open")}
					>
						{busy && visible.action === "open" ? text("opening") : text("open")}
					</button>
				)}
				<button
					type="button"
					role={menu ? "menuitem" : undefined}
					disabled={busy || !!unavailable || !client}
					title={unavailable ?? (!client ? text("missingConnection") : undefined)}
					onClick={() => void run("reveal")}
				>
					{busy && visible.action === "reveal" ? text("revealing") : text("reveal")}
				</button>
				<button
					type="button"
					role={menu ? "menuitem" : undefined}
					disabled={busy || !!unavailable}
					title={unavailable}
					onClick={() => void run("copy")}
				>
					{busy && visible.action === "copy" ? text("copying") : text("copy")}
				</button>
			</div>
			{visible && visible.status !== "pending" && (
				<div
					className={`owl-artifact-action-feedback is-${visible.status}`}
					role={visible.status === "error" ? "alert" : "status"}
				>
					<span>
						{visible.status === "error"
							? `${text("failed")}: ${visible.error}`
							: text(visible.action === "copy" ? "copied" : visible.action === "reveal" ? "revealed" : "opened")}
					</span>
					{visible.status === "error" && (
						<button type="button" onClick={() => void run(visible.action)}>
							{text("retry")}
						</button>
					)}
				</div>
			)}
			{unavailable && <p className="owl-artifact-action-unavailable">{unavailable}</p>}
		</div>
	);
}
