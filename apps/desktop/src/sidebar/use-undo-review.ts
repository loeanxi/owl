import { useEffect, useRef, useState } from "react";
import type { DiffApprovalPreviewResult, DiffApprovalResolveResult } from "../bridge/protocol.ts";
import type { SidebarApi } from "./api.ts";

export interface UndoOutcome {
	action: "keep" | "revert";
	resolved: number;
	failed: Array<{ path: string; reason: string }>;
	warnings?: Array<{ path: string; reason: string }>;
	error?: string;
	retryIds: string[];
}

/** The preview token binds confirmation to the exact proposed file states. */
export function useUndoReview(api: SidebarApi, cwd: string, contextKey: string, onSettled: () => void) {
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState<DiffApprovalPreviewResult | undefined>();
	const [outcome, setOutcome] = useState<UndoOutcome | undefined>();
	const [previewIds, setPreviewIds] = useState<string[]>([]);
	const current = useRef({ key: contextKey, api, lock: false });
	if (current.current.key !== contextKey || current.current.api !== api)
		current.current = { key: contextKey, api, lock: false };
	const settled = useRef(onSettled);
	settled.current = onSettled;

	useEffect(() => {
		const instance = { key: contextKey, api, lock: false };
		current.current = instance;
		setBusy(false);
		setPreview(undefined);
		setOutcome(undefined);
		setPreviewIds([]);
		return () => {
			if (current.current === instance) current.current = { key: "", api, lock: false };
		};
	}, [contextKey, api]);

	const requestPreview = async (ids: string[]): Promise<void> => {
		if (current.current.lock || ids.length === 0) return;
		const invocation = current.current;
		invocation.lock = true;
		setBusy(true);
		setPreview(undefined);
		setPreviewIds(ids);
		setOutcome(undefined);
		try {
			const result = await api.diffApprovalPreview(cwd, ids, "operations");
			if (current.current !== invocation) return;
			setPreview(result);
		} catch (error) {
			if (current.current !== invocation) return;
			setOutcome({
				action: "revert",
				resolved: 0,
				failed: [],
				error: error instanceof Error ? error.message : String(error),
				retryIds: ids,
			});
		} finally {
			if (current.current === invocation) {
				invocation.lock = false;
				setBusy(false);
			}
		}
	};

	const resolve = async (ids: string[], action: "keep" | "revert", token?: string): Promise<void> => {
		if (current.current.lock || ids.length === 0) return;
		const invocation = current.current;
		invocation.lock = true;
		setBusy(true);
		try {
			const result: DiffApprovalResolveResult = await api.diffApprovalResolve(cwd, ids, action, token);
			if (current.current !== invocation) return;
			const successful = new Set(result.resolvedIds);
			setOutcome({
				action,
				resolved: result.resolved,
				failed: result.failed,
				warnings: result.warnings,
				retryIds: ids.filter((id) => !successful.has(id)),
			});
			setPreview(undefined);
			settled.current();
		} catch (error) {
			if (current.current !== invocation) return;
			setOutcome({
				action,
				resolved: 0,
				failed: [],
				error: error instanceof Error ? error.message : String(error),
				retryIds: ids,
			});
			setPreview(undefined);
			settled.current();
		} finally {
			if (current.current === invocation) {
				invocation.lock = false;
				setBusy(false);
			}
		}
	};

	return {
		busy,
		preview,
		outcome,
		requestPreview,
		confirm: () => preview !== undefined && resolve(previewIds, "revert", preview.token),
		retryPreview: () => requestPreview(previewIds),
		keep: (ids: string[]) => resolve(ids, "keep"),
		dismiss: () => {
			if (!current.current.lock) setPreview(undefined);
		},
		retry: () =>
			outcome !== undefined &&
			(outcome.action === "keep" ? resolve(outcome.retryIds, "keep") : requestPreview(outcome.retryIds)),
	};
}

export type UndoReview = ReturnType<typeof useUndoReview>;
