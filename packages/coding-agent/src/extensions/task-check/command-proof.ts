import { isAbsolute, resolve } from "node:path";
import type { ToolResultEvent } from "../../core/extensions/types.ts";

/** Kept only for this user turn. Oversized/incomplete results are not eligible proofs. */
export interface CommandProof {
	toolName: "bash";
	toolCallId: string;
	command: string;
	cwd: string;
	output: string;
	exitCode: 0;
}

export function commandProofFromResult(event: ToolResultEvent, cwd: string): CommandProof | undefined {
	const result: unknown = event.structuredContent;
	if (
		event.toolName !== "bash" ||
		event.isError ||
		typeof event.input.command !== "string" ||
		event.input.command.length > 16_384 ||
		!isAbsolute(cwd) ||
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		!("exit_code" in result) ||
		!("truncated" in result) ||
		!("output" in result) ||
		result.exit_code !== 0 ||
		result.truncated !== false ||
		("status" in result && result.status !== undefined && result.status !== "exited") ||
		typeof result.output !== "string" ||
		result.output.length > 131_072
	)
		return undefined;
	return {
		toolName: "bash",
		toolCallId: event.toolCallId,
		command: event.input.command,
		cwd,
		output: result.output,
		exitCode: 0,
	};
}

interface Word {
	value: string;
	and?: boolean;
}

/** A literal subset, not a shell parser. No expansions, escapes, pipes, comments or extra commands. */
function literalWords(command: string): Word[] | undefined {
	const words: Word[] = [];
	let cursor = 0;
	while (cursor < command.length) {
		if (/[ \t]/.test(command[cursor]!)) {
			cursor++;
			continue;
		}
		if (command.startsWith("&&", cursor)) {
			words.push({ value: "&&", and: true });
			cursor += 2;
			continue;
		}
		const match = /"([^"\r\n$`\\]*)"|'([^'\r\n$`\\]*)'|([^\s"'\\$`;&|<>(){}[\]*?!#]+)/y;
		match.lastIndex = cursor;
		const found = match.exec(command);
		if (!found) return undefined;
		words.push({ value: found[1] ?? found[2] ?? found[3]! });
		cursor = match.lastIndex;
		if (cursor < command.length && !/[ \t]/.test(command[cursor]!) && !command.startsWith("&&", cursor))
			return undefined;
	}
	return words;
}

function runner(command: string, cwd: string): { cwd: string; selector: string; path: string } | undefined {
	let words = literalWords(command);
	if (!words) return undefined;
	if (words[0]?.value === "cd") {
		if (!words[1]?.value || words[1].and || words[1].value.startsWith("-") || !words[2]?.and) return undefined;
		cwd = resolve(cwd, words[1].value);
		words = words.slice(3);
	}
	if (
		words.length !== 4 ||
		words.some((word) => word.and) ||
		words[0]?.value !== "npx" ||
		words[1]?.value !== "vitest" ||
		words[2]?.value !== "run"
	)
		return undefined;
	const selector = words[3]!.value;
	if (
		!selector ||
		selector.startsWith("-") ||
		/[$`*?[\]{}\r\n]/.test(selector) ||
		!/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(selector)
	)
		return undefined;
	return { cwd, selector, path: resolve(cwd, selector) };
}

function normalized(path: string): string {
	return process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
}

/** Only for command-claim semantics; strict path association is checked separately first. */
export function commandClaimText(claim: string): string {
	const file = /\.[A-Za-z][A-Za-z0-9]{0,7}[.,，。:：]*$/u;
	return claim
		.replace(
			/`([^`\r\n]*)`|"([^"\r\n]*)"|'([^'\r\n]*)'/gu,
			(whole, backtick: string | undefined, double: string | undefined, single: string | undefined) =>
				file.test(backtick ?? double ?? single ?? "") ? " file " : whole,
		)
		.replace(/[^\s"'`()，。；;<>|]+/gu, (token) => (file.test(token) ? "file" : token));
}

/** Command claims use stricter complete paths, including absolute paths/spaces/bare filenames. */
function claimedPaths(text: string, cwd: string): string[] {
	const paths: string[] = [];
	const file = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
	const unquote = (value: string) =>
		value
			.replace(/^[“‘]|[”’]$/gu, "")
			.replace(/[.,，。:：]+$/gu, "")
			.replace(/:\d+(?::\d+)?$/u, "");
	const masked = text.replace(
		/`([^`\r\n]*)`|"([^"\r\n]*)"|'([^'\r\n]*)'/gu,
		(whole, backtick: string | undefined, double: string | undefined, single: string | undefined) => {
			const value = backtick ?? double ?? single ?? "";
			const invocation = runner(value, cwd);
			if (invocation) paths.push(invocation.path);
			else if (file.test(unquote(value))) paths.push(resolve(cwd, unquote(value)));
			return " ".repeat(whole.length);
		},
	);
	for (const token of masked.matchAll(/[^\s"'`()，。；;<>|]+/gu)) {
		const value = unquote(token[0]);
		if (file.test(value)) paths.push(resolve(cwd, value));
	}
	return paths;
}

function passedOutput(output: string, cwd: string, selectedPath: string): boolean {
	const lines = output
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.split(/\r?\n/)
		.map((line) => line.trim());
	const files = lines.filter((line) => /^Test Files\b/.test(line));
	const tests = lines.filter((line) => /^Tests\b/.test(line));
	const roots = lines.flatMap((line) => {
		const run = /^RUN\s+v\d+\.\d+(?:\.\d+)?\s+(.+)$/u.exec(line);
		return run ? [run[1]!] : [];
	});
	if (
		roots.length !== 1 ||
		!isAbsolute(roots[0]!) ||
		normalized(resolve(roots[0]!)) !== normalized(resolve(cwd)) ||
		files.length !== 1 ||
		tests.length !== 1 ||
		!/^Test Files\s+1 passed\s+\(1\)$/u.test(files[0]!)
	)
		return false;
	const summary = /^Tests\s+([1-9]\d*) passed((?:\s*\|\s*\d+ (?:skipped|todo))*)\s+\(([1-9]\d*)\)$/u.exec(tests[0]!);
	if (!summary) return false;
	const passed = Number(summary[1]);
	const skipped = [...summary[2]!.matchAll(/\d+/g)].reduce((sum, match) => sum + Number(match[0]), 0);
	const passedFiles = lines.flatMap((line) => {
		const result = /^(?:✓|✔|PASS)\s+(.+?)\s+\(([1-9]\d*) tests?(?:\s*\|[^)]*)?\)(?:\s+.*)?$/u.exec(line);
		return result ? [{ path: resolve(cwd, result[1]!), tests: Number(result[2]) }] : [];
	});
	return (
		Number.isSafeInteger(passed) &&
		passed + skipped === Number(summary[3]) &&
		passedFiles.length === 1 &&
		normalized(passedFiles[0]!.path) === normalized(selectedPath) &&
		passedFiles[0]!.tests === Number(summary[3])
	);
}

export function commandEvidenceError(proof: CommandProof, claim: string): string | undefined {
	const invocation = runner(proof.command, proof.cwd);
	if (!invocation)
		return "Command evidence supports only literal npx vitest run <one exact .test/.spec file>, optionally after one cd <directory> &&. Flags, pipelines and other shell syntax are unsupported.";
	const paths = claimedPaths(claim, invocation.cwd);
	if (paths.length === 0 || paths.some((path) => normalized(path) !== normalized(invocation.path)))
		return "Name only the exact test-selector path in the command criterion/evidence, relative to that command's effective cwd or as an absolute path. Bare filenames and other directories do not prove that file.";
	if (!passedOutput(proof.output, invocation.cwd, invocation.path))
		return "Command evidence requires complete Vitest output with RUN, one actual ✓/PASS file-result line matching the exact selector path, Test Files 1 passed (1), and a positive Tests passed summary. Zero tests, skipped-only, failed, mismatched files or summary-only output are not verified.";
	return undefined;
}

/** Artifact production is a different assertion from a test named, for example, 'generated catalogs'. */
export function claimsGeneratedArtifact(claim: string): boolean {
	return /生成|导出|命令产物|\b(?:generate[ds]?|produce[ds]?|export(?:ed|s)?)\s+(?:(?:a|an|the|new)\s+)?(?:file\b|artifact\b|output\b|report\b|[`'"]?[^\s`'"]+\.[A-Za-z][A-Za-z0-9]{0,7}\b)|\b(?:file|artifact|output|report)\b[^\r\n]{0,50}\b(?:generated|produced|exported)\b|\S+\.[A-Za-z][A-Za-z0-9]{0,7}\s+(?:(?:was|is|were)\s+)?(?:generated|produced|exported)\b/iu.test(
		claim,
	);
}

export function looksLikeCommandVerification(claim: string): boolean {
	return /\bvitest\b|\btests?\s+(?:pass(?:ed)?|succeeded)\b|测试.*(?:通过|执行)|(?:执行|运行).*测试/iu.test(claim);
}
