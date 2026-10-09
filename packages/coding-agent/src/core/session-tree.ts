/**
 * Session-tree navigation for AgentSession — mirrors SessionBashController style.
 *
 * Owns the branch-summary AbortController. Leaf surgery stays on SessionManager;
 * summarization auth/retry/extension hooks stay injected as deps.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Model, RetryCallbacks, Usage } from "@earendil-works/pi-ai/compat";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/index.ts";
import type { SessionBeforeTreeResult, TreePreparation } from "./extensions/index.ts";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export type NavigateTreeOptions = {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};

export type NavigateTreeResult = {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
};

export type SummarizationRequestAuth = {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	thinkingLevel: string;
};

export interface SessionTreeNavigationDeps {
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	isStreaming(): boolean;
	/** Compaction only — this controller reports its own navigation via `isNavigating`. */
	isCompacting(): boolean;
	getModel(): Model<any> | undefined;
	getStreamFunction(): StreamFn | undefined;
	getSummarizationRequestAuth(model: Model<any>, signal: AbortSignal): Promise<SummarizationRequestAuth>;
	getSummarizationRetryCallbacks(): RetryCallbacks;
	emitBeforeTree(preparation: TreePreparation, signal: AbortSignal): Promise<SessionBeforeTreeResult | undefined>;
	emitSessionTree(args: {
		newLeafId: string | null;
		oldLeafId: string | null;
		summaryEntry?: BranchSummaryEntry;
		fromExtension?: boolean;
	}): Promise<void>;
	refreshAfterNavigate(): void;
	resolveIdleWaitIfIdle(): void;
}

export class SessionTreeNavigationController {
	private readonly deps: SessionTreeNavigationDeps;
	private abortController: AbortController | undefined;

	constructor(deps: SessionTreeNavigationDeps) {
		this.deps = deps;
	}

	get isNavigating(): boolean {
		return this.abortController !== undefined;
	}

	abort(): void {
		this.abortController?.abort();
	}

	listUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const result: Array<{ entryId: string; text: string }> = [];
		for (const entry of this.deps.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;
			const text = contentText(entry.message.content, "");
			if (text) result.push({ entryId: entry.id, text });
		}
		return result;
	}

	async navigate(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		if (this.deps.isStreaming()) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.deps.isCompacting() || this.isNavigating) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.deps.sessionManager.getLeafId();
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		if (options.summarize && !this.deps.getModel()) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.deps.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.deps.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this.abortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			const beforeTree = await this.deps.emitBeforeTree(preparation, this.abortController.signal);
			if (beforeTree?.cancel) {
				return { cancelled: true };
			}

			if (beforeTree?.summary && options.summarize) {
				extensionSummary = beforeTree.summary;
				fromExtension = true;
			}
			if (beforeTree?.customInstructions !== undefined) {
				customInstructions = beforeTree.customInstructions;
			}
			if (beforeTree?.replaceInstructions !== undefined) {
				replaceInstructions = beforeTree.replaceInstructions;
			}
			if (beforeTree?.label !== undefined) {
				label = beforeTree.label;
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this.abortController.signal;
				const model = this.deps.getModel()!;
				const branchSummarySettings = this.deps.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this.deps.getSummarizationRequestAuth(model, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.deps.getStreamFunction(),
					retry: this.deps.settingsManager.getRetrySettings(),
					callbacks: this.deps.getSummarizationRetryCallbacks(),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.deps.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.deps.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
				if (label) {
					this.deps.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.deps.sessionManager.resetLeaf();
			} else {
				this.deps.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.deps.sessionManager.appendLabelChange(targetId, label);
			}

			this.deps.refreshAfterNavigate();

			await this.deps.emitSessionTree({
				newLeafId: this.deps.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this.abortController = undefined;
			this.deps.resolveIdleWaitIfIdle();
		}
	}
}
