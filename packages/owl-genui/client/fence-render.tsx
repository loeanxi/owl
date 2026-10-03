/**
 * owl-ui fence 渲染管线（owl-genui 版）。
 *
 * dsh 有两条渲染通道（宿主 fence-registry + DOM 观察）；owl 桌面端由
 * ChatStream 的 AnswerCard 直接把 ```owl-ui 围栏段交到这里，单通道即可。
 * 与 dsh 版的差异：
 *  - panel:true（会话面板）未移植——按普通内联块渲染；
 *  - 修复失败时不再依赖宿主 CodeBlock，用 owl 本地原语展示原始 JSON 并附诊断；
 *  - artifact 导出（ExportableGenuiBlock）未移植，直接渲染 GenuiBlock。
 */
import { type Key, type ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { t, useT } from "./i18n/index.ts";
import { fenceStateKey } from "./interaction-store.ts";
import { CodeBlock } from "./primitive-adapter.ts";
import { codeBlockLabels } from "./primitive-labels.ts";
import type { GenuiSpec } from "./spec.ts";
import { describeJsonFailure } from "./shared/fence-repair.ts";
import { resolveFence, resolveFenceSpec, type FenceResolution } from "./shared/fence-resolve.ts";
import { GenuiBlock } from "./GenuiBlock.tsx";

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

const FENCE_ERROR_STYLE: React.CSSProperties = {
	margin: "0 0 6px",
	padding: "6px 10px",
	borderRadius: 6,
	background: "rgba(239, 68, 68, 0.14)",
	border: "1px solid rgba(239, 68, 68, 0.4)",
	color: "#f87171",
	fontSize: 12,
	lineHeight: 1.55,
	whiteSpace: "pre-wrap",
};

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
 * Explain why a ```owl-ui body cannot render, as the one-line message the
 * renderer shows. Returns null when there is nothing to report (the body is
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
		<div style={FENCE_ERROR_STYLE} role="alert">
			{message}
		</div>
	);
}

/** Fallback for a ```owl-ui fence whose body has no finished component yet:
 * the raw JSON as a code block, plus a diagnostic once the message settled. */
function FenceFallback({ raw, fenceKey }: { raw: string; fenceKey: Key }) {
	useT();
	return (
		<div>
			<FenceDiagnostic raw={raw} settled />
			<CodeBlock key={fenceKey} {...codeBlockLabels()} code={`${raw}\n`} lang="owl-ui" />
		</div>
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
		// Repaired specs render SILENTLY: once the UI renders, no amber note
		// tells the user something was wrong — only an unrecoverable body keeps
		// the red diagnostic.
		<ErrorBoundary key={JSON.stringify([sessionId, key])} label={t("err.boundary.fence")}>
			<GenuiBlock spec={spec} animateEntrance={context?.source === undefined} stateKey={stateKey} />
		</ErrorBoundary>
	);
}

/**
 * The resolved fence render for owl: a spec renders the inline GenuiBlock
 * tree (`panel:true` fences render inline too — the session panel dock is a
 * dsh feature not ported to owl MVP), an unrepairable body renders the
 * fallback code block + diagnostic.
 */
export function renderGenuiFence(raw: string, key: Key, context?: GenuiFenceContext): ReactNode {
	const spec = resolveGenuiSpec(raw, context);
	if (spec === null) return <FenceFallback key={key} fenceKey={key} raw={raw} />;
	return renderInlineFence(key, context, spec);
}
