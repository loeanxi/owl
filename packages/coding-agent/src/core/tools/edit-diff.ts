/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Re-apply the original file's per-line endings onto LF-normalized edited text.
 * Mixed EOL files keep their mix; uniform files stay uniform. New/extra lines
 * inherit the nearest prior ending, then the file's dominant ending.
 */
export function restoreMixedLineEndings(original: string, editedLf: string): string {
	const endings = [...original.matchAll(/\r\n|\n|\r/g)].map((match) => match[0]);
	if (endings.length === 0) return editedLf;

	let crlf = 0;
	let lf = 0;
	for (const ending of endings) {
		if (ending === "\r\n") crlf++;
		else lf++;
	}
	const dominant = crlf > lf ? "\r\n" : "\n";
	if (endings.every((ending) => ending === endings[0])) {
		return restoreLineEndings(editedLf, endings[0] === "\r\n" ? "\r\n" : "\n");
	}

	const lines = editedLf.split("\n");
	let result = "";
	for (let i = 0; i < lines.length; i++) {
		result += lines[i];
		if (i < lines.length - 1) {
			result += endings[i] ?? endings[Math.min(i, endings.length - 1)] ?? dominant;
		}
	}
	return result;
}

const EM_DASH_RUN = /[\u2014\u2015]{2,}/g;

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Collapse em-dash runs, so a Chinese "——" matches a single "—"
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Only Unicode em-dash runs collapse; ASCII "--" stays distinct from "-" in code.
			.replace(EM_DASH_RUN, "\u2014")
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, return offsets in normalized space. Callers can use
	// the normalized content to compute replacements, then decide how much of
	// that normalized output should be written back.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string): number {
	// Prefer exact counts so a unique trailing-space match is not rejected just
	// because a nearby trimEnd-equivalent line also fuzzy-matches.
	let exact = 0;
	let pos = 0;
	while (oldText.length > 0) {
		const idx = content.indexOf(oldText, pos);
		if (idx === -1) break;
		exact++;
		pos = idx + oldText.length;
	}
	if (exact > 0) return exact;

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (!fuzzyOldText) return 0;
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * Map a fuzzy-normalized match back onto the original bytes so NFKC / quote
 * normalization can find text without rewriting untouched characters on the
 * same line (e.g. fullwidth ｂ next to an ASCII quote edit).
 */
function findOriginalSpan(
	original: string,
	oldText: string,
	fuzzyContent: string,
	fuzzyIndex: number,
	fuzzyLength: number,
): { index: number; length: number } | null {
	const exactIndex = original.indexOf(oldText);
	if (exactIndex !== -1) {
		// When the exact string is unique, use it. When duplicates exist, fall
		// through so the fuzzy line range can disambiguate.
		const second = original.indexOf(oldText, exactIndex + oldText.length);
		if (second === -1) return { index: exactIndex, length: oldText.length };
	}

	const fuzzyTarget =
		fuzzyLength > 0 ? fuzzyContent.slice(fuzzyIndex, fuzzyIndex + fuzzyLength) : normalizeForFuzzyMatch(oldText);
	if (!fuzzyTarget) return null;

	const fuzzyLines = getLineSpans(fuzzyContent);
	const range = getReplacementLineRange(fuzzyLines, {
		matchIndex: fuzzyIndex,
		matchLength: fuzzyLength,
		newText: "",
	});
	const originalLines = splitLinesWithEndings(original);
	if (originalLines.length !== fuzzyLines.length) return null;

	const blockStart = originalLines.slice(0, range.startLine).join("").length;
	const block = originalLines.slice(range.startLine, range.endLine).join("");
	const maxSpan = Math.min(block.length, Math.max(fuzzyTarget.length * 4 + 32, oldText.length * 2 + 32));

	for (let i = 0; i < block.length; i++) {
		const endLimit = Math.min(block.length, i + maxSpan);
		for (let j = i + 1; j <= endLimit; j++) {
			if (normalizeForFuzzyMatch(block.slice(i, j)) === fuzzyTarget) {
				// The shortest span can stop inside a collapsed "——"; take the whole run.
				let end = j;
				while (end < block.length && isEmDash(block[end]!) && isEmDash(block[end - 1]!)) end++;
				return { index: blockStart + i, length: end - i };
			}
		}
	}
	return null;
}

function isEmDash(char: string): boolean {
	return char === "\u2014" || char === "\u2015";
}

const NOT_FOUND_HINT =
	"Line endings are normalized (CRLF and LF both match), so the text itself differs from the file, often a misremembered comment or line. Re-read that region and retry with its exact text; do not rewrite the whole file to get around this.";

/**
 * 在 oldText 与文件不匹配时，定位文件里与它最相似的行，给模型一条"最近似位置"提示。
 * 用字符三元组重合度做行级评分（纯词法，无网络/无模型），让模型一次重试就能对准真实区域，
 * 而不是对着 "not found" 盲改。信号不足（oldText 太短/无重合）时返回空串，不强行指路。
 */
export function describeClosestRegion(content: string, oldText: string): string {
	const MIN_SIGNAL_CHARS = 12;
	const MIN_OVERLAP = 0.34;
	const PREVIEW_MAX = 120;

	const clean = (line: string) => line.replace(/\s+/g, " ").trim();
	const trigrams = (text: string): Set<string> => {
		const compact = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
		const set = new Set<string>();
		if (compact.length < 3) {
			if (compact) set.add(compact);
			return set;
		}
		for (let i = 0; i <= compact.length - 3; i++) set.add(compact.slice(i, i + 3));
		return set;
	};

	const oldLines = oldText
		.split("\n")
		.map(clean)
		.filter((line) => line.length >= 4);
	const anchorText = oldLines
		.sort((a, b) => b.length - a.length)
		.slice(0, 3)
		.join(" ");
	if (anchorText.length < MIN_SIGNAL_CHARS) return "";
	const oldGrams = trigrams(anchorText);
	if (oldGrams.size === 0) return "";

	let bestLine = -1;
	let bestScore = 0;
	const contentLines = content.split("\n");
	for (let i = 0; i < contentLines.length; i++) {
		const grams = trigrams(clean(contentLines[i]!));
		if (grams.size === 0) continue;
		let overlap = 0;
		for (const gram of grams) if (oldGrams.has(gram)) overlap++;
		const score = overlap / Math.min(grams.size, oldGrams.size);
		if (score > bestScore) {
			bestScore = score;
			bestLine = i;
		}
	}
	if (bestLine < 0 || bestScore < MIN_OVERLAP) return "";

	const preview = clean(contentLines[bestLine]!).slice(0, PREVIEW_MAX);
	return `Closest matching region is near line ${bestLine + 1}: "${preview}". Re-read that area and align oldText with what is actually there.`;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, closestHint = ""): Error {
	const suffix = closestHint ? ` ${closestHint}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${suffix} ${NOT_FOUND_HINT}`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.${suffix} ${NOT_FOUND_HINT}`,
	);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	lineHint = "",
): Error {
	const suffix = lineHint ? ` ${lineHint}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.${suffix}`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.${suffix}`,
	);
}

/**
 * oldText 命中多处时，列出每次出现所在行，让模型直接锚定要改的那一处（附 1 行预览），
 * 而不是靠"多加一点上下文"盲猜。列出至多 5 处，超出以 … 收尾。
 */
export function describeOccurrenceLines(content: string, oldText: string, totalOccurrences = 0): string {
	const MAX_LISTED = 5;
	const positions: number[] = [];
	let pos = 0;
	while (positions.length < MAX_LISTED + 1) {
		const idx = content.indexOf(oldText, pos);
		if (idx === -1) break;
		positions.push(idx);
		pos = idx + oldText.length;
	}
	if (!positions.length) return "";
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) if (content[i] === "\n") lineStarts.push(i + 1);
	const lineOf = (index: number): number => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid]! <= index) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
	const parts = positions.slice(0, MAX_LISTED).map((idx) => {
		const lineNo = lineOf(idx);
		const lineEnd = content.indexOf("\n", idx);
		const preview = content
			.slice(idx, lineEnd === -1 ? undefined : lineEnd)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 100);
		return `line ${lineNo}: "${preview}"`;
	});
	if (positions.length > MAX_LISTED) parts.push(`… (${totalOccurrences || positions.length} total)`);
	return `Occurrences: ${parts.join("; ")}.`;
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, matches are found in fuzzy-normalized space but applied back
 * onto the original bytes so untouched characters on the same line (e.g.
 * fullwidth identifiers) are not rewritten by NFKC.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const fuzzyContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(fuzzyContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(
				path,
				i,
				normalizedEdits.length,
				describeClosestRegion(normalizedContent, edit.oldText),
			);
		}

		const occurrences = countOccurrences(normalizedContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				occurrences,
				describeOccurrenceLines(normalizedContent, edit.oldText, occurrences),
			);
		}

		if (usedFuzzyMatch) {
			const span = findOriginalSpan(
				normalizedContent,
				edit.oldText,
				fuzzyContent,
				matchResult.index,
				matchResult.matchLength,
			);
			if (!span) {
				throw getNotFoundError(path, i, normalizedEdits.length);
			}
			matchedEdits.push({
				editIndex: i,
				matchIndex: span.index,
				matchLength: span.length,
				newText: edit.newText,
			});
		} else {
			matchedEdits.push({
				editIndex: i,
				matchIndex: matchResult.index,
				matchLength: matchResult.matchLength,
				newText: edit.newText,
			});
		}
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = applyReplacements(normalizedContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
