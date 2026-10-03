/**
 * owl-ui fence 渲染管线（owl-genui 版）。
 *
 * dsh 有两条渲染通道（宿主 fence-registry + DOM 观察）；owl 桌面端由
 * ChatStream 的 AnswerCard 直接把 ```owl-ui 围栏段交到这里，单通道即可。
 * 与 dsh 版的差异：
 *  - panel:true（会话面板）未移植——按普通内联块渲染；
 *  - 修复失败时显示紧凑提示，诊断与可复制的原始 JSON 按需展开；
 *  - artifact 导出（ExportableGenuiBlock）未移植，直接渲染 GenuiBlock。
 */
import { type Key, type ReactNode, useMemo } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { t, useT } from "./i18n/index.ts";
import { fenceStateKey } from "./interaction-store.ts";
import { CodeBlock } from "./primitive-adapter.ts";
import { codeBlockLabels } from "./primitive-labels.ts";
import type { GenuiSpec } from "./spec.ts";
import { describeJsonFailure } from "./shared/fence-repair.ts";
import { resolveFence, resolveFenceSpec, type FenceResolution } from "./shared/fence-resolve.ts";
import { GenuiBlock } from "./GenuiBlock.tsx";
import css from "./owl-primitives.module.css";

/** Settled fence source identity (data shape, host-independent). */
export interface GenuiFenceSource {
	/** Stable structural id, e.g. `['assistant', seq, block, fence]`. */
	readonly id: string;
	/** Three-part order: [messageSeq, textBlockIndex, fenceIndex]. */
	readonly order: readonly [number, number, number];
}

/** Context a fence renderer receives beside the raw source and React key. */
export interface GenuiFenceContext {
	/** Owning session route; absent outside a session-scoped render. */
	readonly sessionId?: string;
	/** Present only for settled/interrupted renders with a stable identity. */
	readonly source?: GenuiFenceSource;
}

/** Format chart-specific process errors without maintaining a second validator. */
function formatChartProcessErrors(errors: string[]): string | null {
	const chartErrors = errors.filter((error) =>
		/(?:variant is unsupported|kind must be bars, line, or donut|requires data or series|(?:data|series) is required for|(?:\.data|\.series)(?:\[\d+\])?(?:\.(?:data|label|value|color))? must|series is only supported for bars)/.test(
			error,
		),
	);
	return chartErrors.length === 0 ? null : chartErrors.join("；");
}

/** Return a semantic/schema diagnostic from the unified fence resolution. */
function processSemanticFailure(resolution: FenceResolution): string | null {
	if (resolution.spec !== null || resolution.processed === null) return null;
	const chartErrors = formatChartProcessErrors(resolution.processed.errors);
	return chartErrors === null ? t("err.fieldValidation", { errors: resolution.processed.errors.join("；") }) : t("err.chartValidation", { errors: chartErrors });
}

/**
 * Explain why a ```owl-ui body cannot render, for the expandable diagnostic.
 * Returns null when there is nothing to report (the body is
 * renderable, or it is an empty/streaming half).
 */
export function describeFenceFailure(raw: string, options: { settled?: boolean } = {}): string | null {
	const resolution = resolveFence(raw, { settled: options.settled ?? true });
	if (resolution.spec !== null) return null;
	const processDiagnostic = processSemanticFailure(resolution);
	if (processDiagnostic !== null) {
		return t("err.fenceKeptAsCode", { diagnostic: processDiagnostic });
	}
	if (raw.trim() === "") return null;
	const parseDiagnostic = describeJsonFailure(raw);
	if (parseDiagnostic === null) return null;
	return t("err.fenceParse", { diagnostic: parseDiagnostic });
}

/**
 * The visible diagnostic for a settled, unrenderable ```owl-ui body: a fence
 * that keeps degrading to raw JSON must say why it degraded — the defect is
 * never silent.
 */
export function FenceDiagnostic({ raw, settled = false }: { raw: string; settled?: boolean }): ReactNode {
	// Subscribe so a language switch re-renders an already-visible diagnostic.
	useT();
	const message = describeFenceFailure(raw, { settled });
	if (message === null) return null;
	return (
		<div className={css.fenceNotice} role="status">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" strokeLinecap="round" /></svg>
			<div><strong>{t("err.fallbackTitle")}</strong><p>{t("err.fallbackHint")}</p></div>
		</div>
	);
}

/** Keep failed content inspectable without making raw JSON the main answer. */
function FenceFallback({ raw, fenceKey }: { raw: string; fenceKey: Key }) {
	useT();
	const message = describeFenceFailure(raw, { settled: true });
	const displaySource = useMemo(() => {
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}, [raw]);
	return (
		<section className={css.fenceFallback} data-genui-fallback>
			{message === null ? <p className={css.fenceEmpty}>{t("err.fallbackEmpty")}</p> : <FenceDiagnostic raw={raw} settled />}
			{raw.trim() !== "" && <details className={css.fenceDetails}>
				<summary>{t("err.fallbackDetails")}</summary>
				{message !== null && <p className={css.fenceDiagnostic}>{message}</p>}
				<CodeBlock key={fenceKey} {...codeBlockLabels()} copyLabel={t("err.fallbackCopy")} code={displaySource} copyText={raw} wrap lang="owl-ui" />
			</details>}
		</section>
	);
}

/**
 * Resolve a raw fence body to a guarded spec.
 *
 * - Tier-1 repair (quote escape + trailing commas): safe at any time —
 *   adopted only when the whole body parses, so a still-growing streaming
 *   half keeps falling back to the code block, never flashing a banner.
 * - Tier-2 completion (missing quotes/brackets): settled renders only —
 *   `context.source` exists exclusively once the message finished, so
 *   streaming halves are never completed early.
 * - Native chart semantics are checked before repair on every candidate so
 *   aliases, empty collections, or line/donut series cannot repair into a
 *   default/blank chart.
 */
export function resolveGenuiSpec(raw: string, context?: GenuiFenceContext): GenuiSpec | null {
	return resolveFenceSpec(raw, { settled: context?.source !== undefined });
}

/** The inline GenuiBlock tree for a resolved spec. */
function renderInlineFence(key: Key, context: GenuiFenceContext | undefined, spec: GenuiSpec): ReactNode {
	const sessionId = context?.sessionId;
	const stateKey =
		sessionId === undefined || context?.source === undefined ? undefined : fenceStateKey(sessionId, context.source.id, JSON.stringify(spec));
	return (
		// Keep the document slot mounted across streaming→settled; GenuiBlock
		// owns durable-state changes, while a session change resets the tree.
		// Recovered content renders normally; only unrecoverable content gets
		// the compact fallback with inspectable diagnostics and original source.
		<ErrorBoundary key={JSON.stringify([sessionId, key])} label={t("err.boundary.fence")}>
			<GenuiBlock spec={spec} animateEntrance={context?.source === undefined} stateKey={stateKey} />
		</ErrorBoundary>
	);
}

/**
 * The resolved fence render for owl: a spec renders the inline GenuiBlock
 * tree (`panel:true` fences render inline too — the session panel dock is a
 * dsh feature not ported to owl MVP), an unrepairable body renders the
 * compact recovery notice with expandable source and diagnostic.
 */
export function renderGenuiFence(raw: string, key: Key, context?: GenuiFenceContext): ReactNode {
	const spec = resolveGenuiSpec(raw, context);
	if (spec === null) return <FenceFallback key={key} fenceKey={key} raw={raw} />;
	return renderInlineFence(key, context, spec);
}
