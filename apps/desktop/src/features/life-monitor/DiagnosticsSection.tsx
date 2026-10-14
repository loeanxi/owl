import { useEffect, useMemo, useState } from "react";
import { LIFE_CHANNELS, LIFE_GROUPS, type LifeChannelDef } from "../../../../../packages/owl-life-monitor/src/life-channels.ts";
import type { LifeChannel } from "../../bridge/protocol.ts";
import { SectionHeader } from "../../components/settings/settings-widgets.tsx";
import { lifeFact, lifeGroup, lifeLevel, lifeName, lifeShell, useLifeCopy } from "./life-copy.ts";
import { presentLife } from "./present.ts";
import type { LifeProbe } from "./use-life-probe.ts";
import "./life-monitor.css";

type FixTarget = NonNullable<LifeChannelDef["fix"]>;

const DEFS = new Map(LIFE_CHANNELS.map((def) => [def.id, def]));
const FIX_LABEL = { models: "fixModels", plugins: "fixPlugins", skills: "fixSkills" } as const;

function isProblem(item: LifeChannel): boolean {
	return item.level === "bad" || item.level === "warn";
}

/** 设置 →「诊断」：按需跑一轮 life.probe，异常置顶并给去处，其余折叠。 */
export function DiagnosticsSection({ probe, onFix }: { probe: LifeProbe; onFix: (target: FixTarget) => void }): React.JSX.Element {
	useLifeCopy();
	const { refresh } = probe;
	const [checking, setChecking] = useState(false);
	const [copied, setCopied] = useState(false);
	const view = useMemo(() => presentLife(probe.channels, probe.round), [probe.channels, probe.round]);
	const problems = view.shown.filter(isProblem);
	const rest = view.shown.filter((item) => !isProblem(item));

	const recheck = (): void => {
		setChecking(true);
		void refresh().finally(() => setChecking(false));
	};
	useEffect(() => {
		setChecking(true);
		void refresh().finally(() => setChecking(false));
	}, [refresh]);

	const copyReport = (): void => {
		void navigator.clipboard.writeText(report(view.shown, probe.checkedAt)).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		}).catch(() => {});
	};

	const status = probe.round === "down" ? lifeShell("down")
		: probe.round === "failed" && probe.checkedAt !== undefined ? lifeShell("failed")
		: problems.length > 0 ? lifeShell("issues", { n: problems.length })
		: probe.checkedAt !== undefined ? lifeShell("allClear", { n: view.shown.length })
		: "";

	return (
		<>
			<SectionHeader title={lifeShell("title")} desc={lifeShell("desc")} />
			<div className="owl-diag-bar">
				<div className="owl-diag-status">
					<span className={`owl-diag-lamp ${problems.length > 0 ? view.summary.dot : probe.round === "ok" ? "ok" : "idle"}`} aria-hidden="true" />
					<div className="min-w-0">
						<div className="owl-diag-status-text">{status || lifeShell("checking")}</div>
						<div className="owl-diag-stamp">
							{probe.checkedAt === undefined ? lifeShell("never") : lifeShell("checkedAt", { time: new Date(probe.checkedAt).toLocaleTimeString() })}
						</div>
					</div>
				</div>
				<button type="button" className="owl-settings-button" disabled={checking} onClick={recheck}>
					{checking ? lifeShell("checking") : lifeShell("recheck")}
				</button>
				<button type="button" className="owl-settings-button" disabled={view.shown.length === 0} onClick={copyReport}>
					{copied ? lifeShell("copied") : lifeShell("copy")}
				</button>
			</div>

			{problems.length > 0 && (
				<ul className="owl-diag-problems">
					{problems.map((item) => {
						const fix = DEFS.get(item.id)?.fix;
						return (
							<li key={item.id} className={`owl-diag-problem ${item.level}`}>
								<span className={`owl-diag-lamp ${item.level}`} aria-hidden="true" />
								<div className="min-w-0 flex-1">
									<div className="owl-diag-problem-head">
										<strong>{lifeName(item.id)}</strong>
										<span className="owl-diag-level">{lifeLevel(item.level, item.note)}</span>
									</div>
									<p className="owl-diag-fact">{lifeFact(item.id, item.note, item.level)}</p>
									{item.evidence && <code className="owl-diag-evidence">{item.evidence}</code>}
								</div>
								{fix && (
									<button type="button" className="owl-settings-button" onClick={() => onFix(fix)}>
										{lifeShell(FIX_LABEL[fix])}
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{rest.length > 0 && (
				<details className="owl-diag-rest">
					<summary>{lifeShell("rest", { n: rest.length })}</summary>
					{LIFE_GROUPS.map((group) => {
						const items = rest.filter((item) => DEFS.get(item.id)?.group === group);
						if (items.length === 0) return null;
						return (
							<section key={group} className="owl-diag-group">
								<h3>{lifeGroup(group)}</h3>
								<ul>
									{items.map((item) => (
										<li key={item.id} title={lifeFact(item.id, item.note, item.level)}>
											<span className={`owl-diag-lamp ${item.level}`} aria-hidden="true" />
											<span className="owl-diag-name">{lifeName(item.id)}</span>
											{item.level !== "ok" && <span className="owl-diag-level">{lifeLevel(item.level, item.note)}</span>}
										</li>
									))}
								</ul>
							</section>
						);
					})}
				</details>
			)}
		</>
	);
}

function report(shown: readonly LifeChannel[], checkedAt: number | undefined): string {
	const lines = [`${lifeShell("reportTitle")} · ${checkedAt === undefined ? lifeShell("never") : new Date(checkedAt).toLocaleString()}`, ""];
	const passing: string[] = [];
	for (const item of shown) {
		if (item.level === "ok") {
			passing.push(lifeName(item.id));
			continue;
		}
		const evidence = item.evidence ? ` (${item.evidence})` : "";
		lines.push(`[${lifeLevel(item.level, item.note)}] ${lifeName(item.id)}: ${lifeFact(item.id, item.note, item.level)}${evidence}`);
	}
	lines.push("", `${lifeShell("reportRest")} (${passing.length}): ${passing.join(", ")}`);
	return lines.join("\n");
}
