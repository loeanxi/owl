import { useEffect, useId, useRef, useState } from "react";
import type { ChatActivity } from "./ChatStream.tsx";
import type { ChatEntry } from "../hooks/transcript.ts";
import { useT } from "../i18n/index.ts";

/** 栖在输入框上沿的流羽猫头鹰。姿势只跟现有会话状态走，不另开模型。 */
export type OwlPose = "idle" | "think" | "read" | "search" | "write" | "run" | "wait" | "off" | "party";

const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const RUN_TOOLS = new Set(["bash", "powershell", "process"]);

function poseForTool(name: string): OwlPose {
	const tool = name.toLowerCase();
	if (READ_TOOLS.has(tool)) return "read";
	if (SEARCH_TOOLS.has(tool) || tool.includes("search") || tool.includes("grep")) return "search";
	if (WRITE_TOOLS.has(tool)) return "write";
	if (RUN_TOOLS.has(tool) || tool.startsWith("computer_") || tool.includes("bash") || tool.includes("shell")) return "run";
	if (tool.includes("read")) return "read";
	return "run";
}

function runningToolName(entries: ChatEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "assistant") continue;
		const running = entry.tools.filter((tool) => tool.status === "running");
		const current = [...running].reverse().find((tool) => tool.parentToolCallId) ?? running.at(-1);
		return current?.name;
	}
	return undefined;
}

export function resolveOwlPose(activity: ChatActivity, entries: ChatEntry[]): OwlPose {
	if (activity === "disconnected") return "off";
	if (activity === "waiting") return "wait";
	if (activity === "idle") return "idle";
	const name = runningToolName(entries);
	if (!name) return "think";
	return poseForTool(name);
}

/** 一轮从「正在干活」回到空闲时，短跳一下再停。 */
export function useSessionOwlPose(activity: ChatActivity, entries: ChatEntry[]): OwlPose {
	const pose = resolveOwlPose(activity, entries);
	const previous = useRef(activity);
	const [celebrating, setCelebrating] = useState(false);
	useEffect(() => {
		const before = previous.current;
		previous.current = activity;
		if (before === "working" && activity === "idle") {
			setCelebrating(true);
			const timer = window.setTimeout(() => setCelebrating(false), 1400);
			return () => window.clearTimeout(timer);
		}
		setCelebrating(false);
		return undefined;
	}, [activity]);
	return celebrating && activity === "idle" ? "party" : pose;
}

export function OwlMascot({ pose, inline = false }: { pose: OwlPose; inline?: boolean }): React.JSX.Element {
	const t = useT();
	const rawId = useId().replace(/:/g, "");
	const haloId = `owl-halo-${rawId}`;
	const pupilId = `owl-pupil-${rawId}`;
	const [poked, setPoked] = useState(false);
	return (
		<div className={inline ? "owl-mascot-slot is-inline" : "owl-mascot-slot"}>
			<button
				type="button"
				className={poked ? "owl-mascot poked" : "owl-mascot"}
				data-pose={pose}
				aria-label={t("composer.owlHop")}
				onClick={() => {
					setPoked(false);
					requestAnimationFrame(() => setPoked(true));
				}}
				onAnimationEnd={(event) => {
					if (event.animationName === "owl-hop" && poked) setPoked(false);
				}}
			>
				<span className="owl-mascot-fx owl-mascot-bubbles" aria-hidden="true"><i>{"{}"}</i><i>{"</>"}</i><i>;</i></span>
				<span className="owl-mascot-fx owl-mascot-thoughts" aria-hidden="true"><i /><i /><i /></span>
				<span className="owl-mascot-fx owl-mascot-sparks" aria-hidden="true"><i>✦</i><i>✦</i><i>✦</i></span>
				<svg viewBox="0 0 256 300" aria-hidden="true">
					<defs>
						<radialGradient id={haloId}>
							<stop offset="0%" stopColor="#5ecf82" stopOpacity="0.55" />
							<stop offset="60%" stopColor="#5ecf82" stopOpacity="0.18" />
							<stop offset="100%" stopColor="#5ecf82" stopOpacity="0" />
						</radialGradient>
						<radialGradient id={pupilId}>
							<stop offset="0%" stopColor="#9df0c1" />
							<stop offset="65%" stopColor="#5ecf82" />
							<stop offset="100%" stopColor="#41b06a" />
						</radialGradient>
					</defs>
					<g className="owl-mascot-bird">
						<g className="owl-mascot-plumage" fill="none" stroke="#2f9e5a" strokeLinecap="round">
							<path className="owl-mascot-ray" d="M208 128 L240 128" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-ray-right" d="M201.9 158.6 L232 172" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-ray-right" d="M184.6 184.6 L210 214" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M158.6 201.9 L172 236" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-ray-key" d="M128 208 L128 248" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M97.4 201.9 L84 236" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-ray-left" d="M71.4 184.6 L46 214" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-ray-left" d="M54.1 158.6 L24 172" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M48 128 L16 128" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M54.1 97.4 L24 84" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M71.4 71.4 L46 46" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M128 48 L128 14" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M184.6 71.4 L210 46" strokeWidth="16" />
							<path className="owl-mascot-ray" d="M201.9 97.4 L232 84" strokeWidth="16" />
							<path className="owl-mascot-ray owl-mascot-tuft" d="M108.2 67.1 L88 8" strokeWidth="17" />
							<path className="owl-mascot-ray owl-mascot-tuft" d="M147.8 67.1 L168 8" strokeWidth="17" />
						</g>
						<g className="owl-mascot-paper owl-mascot-prop">
							<rect x="168" y="168" width="46" height="58" rx="4" fill="#efe6d2" />
							<path d="M178 188 h28 M178 200 h24 M178 212 h18" stroke="#8a8172" strokeWidth="2.4" />
							<rect className="owl-mascot-scanline" x="176" y="184" width="30" height="4" rx="1" fill="#2f9e5a" />
						</g>
						<g className="owl-mascot-glass owl-mascot-prop">
							<circle cx="196" cy="168" r="18" fill="none" stroke="#9df0c1" strokeWidth="5" />
							<path d="M210 182 l16 16" stroke="#9df0c1" strokeWidth="5" strokeLinecap="round" />
						</g>
						<g className="owl-mascot-laptop owl-mascot-prop">
							<rect x="156" y="214" width="72" height="46" rx="5" fill="#0e1c16" stroke="#50a992" strokeWidth="3" />
							<path d="M168 240 h22 M168 228 h14" stroke="#5ecf82" strokeWidth="2.4" />
							<path d="M148 264 h88" stroke="#3d3d3d" strokeWidth="4" strokeLinecap="round" />
						</g>
						<g className="owl-mascot-pupils">
							<g className="owl-mascot-eyes">
								<circle cx="94" cy="116" r="28" fill="#241d16" />
								<circle cx="162" cy="116" r="28" fill="#241d16" />
								<circle className="owl-mascot-glow" cx="94" cy="116" r="22" fill={`url(#${haloId})`} />
								<circle className="owl-mascot-glow" cx="162" cy="116" r="22" fill={`url(#${haloId})`} />
								<circle className="owl-mascot-pupil" cx="94" cy="116" r="11.5" fill={`url(#${pupilId})`} />
								<circle className="owl-mascot-pupil" cx="162" cy="116" r="11.5" fill={`url(#${pupilId})`} />
								<circle cx="90.5" cy="112.5" r="3.5" fill="#fffdf8" />
								<circle cx="158.5" cy="112.5" r="3.5" fill="#fffdf8" />
							</g>
						</g>
						<path d="M128 138 L140 153 Q128 168 116 153 Z" fill="#c4a82a" />
					</g>
				</svg>
			</button>
		</div>
	);
}
