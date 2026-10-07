import { memo, useEffect, useMemo, useRef, useState } from "react";
import { LIFE_CHANNELS, LIFE_GROUPS, type LifeChannelDef } from "../../../../../packages/coding-agent/src/modes/desktop/life-channels.ts";
import type { LifeChannel, LifeLevel } from "../../bridge/protocol.ts";
import { lifeFact, lifeGroup, lifeLevel, lifeName, lifeShell, useLifeCopy } from "./life-copy.ts";
import type { LifeView } from "./present.ts";
import type { LifeRound } from "./use-life-probe.ts";
import "./life-monitor.css";

const BY_GROUP = new Map<string, LifeChannelDef[]>(LIFE_GROUPS.map((group) => [
	group,
	LIFE_CHANNELS.filter((item) => item.group === group),
]));

export const LifeMonitorPage = memo(function LifeMonitorPage(props: {
	view: LifeView;
	round: LifeRound;
	active: boolean;
}): React.JSX.Element {
	useLifeCopy();
	const since = useRef(new Map<string, { key: string; at: number }>());
	const stamped = useMemo(() => props.view.shown.map((card) => stamp(since.current, card)), [props.view.shown]);
	const byId = useMemo(() => new Map(props.view.shown.map((card, index) => [card.id, { card, at: stamped[index] ?? 0 }])), [props.view.shown, stamped]);
	const { summary } = props.view;
	const lead = props.view.shown.find((item) => item.level === "bad") ?? props.view.shown.find((item) => item.level === "warn");
	const banner = props.round === "down"
		? lifeShell("bannerDown")
		: props.round === "failed" && summary.dot !== "bad" && summary.dot !== "warn"
			? lifeShell("bannerFailed")
			: lead
				? `${lifeName(lead.id)} · ${lifeFact(lead.id, lead.note, lead.level)}`
				: lifeShell("bannerSteady", { n: LIFE_CHANNELS.length });
	const word = summary.dot === "bad" ? lifeShell("critical") : summary.dot === "warn" ? lifeShell("attention") : summary.dot === "idle" ? lifeShell("unchecked") : lifeShell("steady");
	const count = summary.count > 0 ? lifeShell("alarms", { n: summary.count }) : lifeShell("noAlarms");

	return (
		<section className="owl-life" aria-label={lifeShell("title")}>
			<header className="owl-life-head">
				<div className="owl-life-brand">
					<b>{lifeShell("title")}</b>
					<span>{lifeShell("cadence", { n: LIFE_CHANNELS.length })}</span>
				</div>
				<div className="owl-life-overall">
					<strong className={summary.dot}>{word}</strong>
					<span className="owl-life-count">{count}</span>
				</div>
				<div className="owl-life-meta">
					<LifeClock active={props.active} />
					<span>{lifeShell("cadence", { n: LIFE_CHANNELS.length }).split("·")[1]?.trim()}</span>
				</div>
			</header>
			<div className={`owl-life-banner ${summary.dot}`}>
				<em>{word}</em>
				<span>{banner}</span>
			</div>
			<div className="owl-life-floor">
				{LIFE_GROUPS.map((group) => (
					<section className="owl-life-group" key={group}>
						<h2>{lifeGroup(group)}</h2>
						<div className="owl-life-grid">
							{(BY_GROUP.get(group) ?? []).map((def) => {
								const row = byId.get(def.id);
								if (!row) return null;
								return <LifeCard key={def.id} def={def} card={row.card} at={row.at} />;
							})}
						</div>
					</section>
				))}
			</div>
		</section>
	);
});

function LifeCard(props: { def: LifeChannelDef; card: LifeChannel; at: number }): React.JSX.Element {
	const { def, card, at } = props;
	return (
		<article className={`owl-life-card ${card.level}${def.span === 2 ? " owl-life-span2" : ""}`} aria-label={`${lifeName(def.id)}，${lifeLevel(card.level, card.note)}`}>
			<header>
				<span className={`owl-life-lamp ${card.level}`} aria-hidden="true" />
				<h3>{lifeName(def.id)}</h3>
				<span className={`owl-life-tag ${card.level}`}>{lifeLevel(card.level, card.note)}</span>
			</header>
			<Trace level={card.level} />
			<p className="owl-life-fact">{lifeFact(def.id, card.note, card.level)}</p>
			{card.evidence ? <p className="owl-life-evidence">{card.evidence}</p> : null}
			<p className="owl-life-when">{at > 0 ? `${lifeShell("changed")} ${clock(new Date(at), false)}` : lifeShell("round")}</p>
		</article>
	);
}

function LifeClock(props: { active: boolean }): React.JSX.Element {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		if (!props.active) return;
		setNow(new Date());
		const timer = window.setInterval(() => setNow(new Date()), 1000);
		return () => window.clearInterval(timer);
	}, [props.active]);
	return <b>{clock(now)}</b>;
}

function stamp(store: Map<string, { key: string; at: number }>, card: LifeChannel): number {
	const key = `${card.level}:${card.note}`;
	const prev = store.get(card.id);
	if (prev && prev.key === key) return prev.at;
	const at = card.at > 0 ? card.at : Date.now();
	store.set(card.id, { key, at });
	return at;
}

function clock(date: Date, withSeconds = true): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const base = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

function Trace(props: { level: LifeLevel }): React.JSX.Element {
	const d = props.level === "bad"
		? "M0 16 H160"
		: props.level === "warn"
			? "M0 16 C14 16 16 4 28 4 C40 4 42 16 56 16 C70 16 74 8 88 8 C102 8 110 16 124 16 C138 16 146 8 160 8"
			: props.level === "ok"
				? "M0 16 C6 16 8 4 14 4 C20 4 22 16 28 16 C34 16 36 8 42 8 C48 8 50 16 56 16 C62 16 64 4 70 4 C76 4 78 16 84 16 C90 16 92 8 98 8 C104 8 106 16 112 16 C118 16 120 4 126 4 C132 4 134 16 140 16 C146 16 148 8 154 8"
				: "M0 16 H18 M28 16 H46 M56 16 H74 M84 16 H102 M112 16 H130 M140 16 H160";
	return (
		<svg className={`owl-life-trace ${props.level}`} viewBox="0 0 160 24" aria-hidden="true">
			<path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	);
}
