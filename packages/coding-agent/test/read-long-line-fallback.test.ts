import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "owl-contract-audit-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

describe("read long-line Bash fallback", () => {
	it.each([
		["relative", "large log.jsonl"],
		["absolute", "large log.jsonl"],
		["quoted", "中文 O'Brien $draft.jsonl"],
		["corrected", "real long.jsonl"],
	])("runs the tool-generated fallback using the resolved %s path", async (kind, name) => {
		await writeFile(join(cwd, name), `KNOWN_PREFIX_${"x".repeat(DEFAULT_MAX_BYTES + 20)}`);
		const path = kind === "absolute" ? join(cwd, name) : kind === "corrected" ? join("extra", name) : name;
		const read = await createReadTool(cwd).execute("read-long-line", { path });
		const fallback = /Use bash: (.*)\]$/.exec(text(read))?.[1];
		expect(fallback).toBeDefined();
		const shellCwd = join(cwd, "runner");
		await mkdir(shellCwd);
		const result = await createBashTool(shellCwd, { exposeSessionEnvironment: false }).execute("fallback", {
			command: fallback!,
			timeout: 5,
		});
		expect(result.structuredContent, `Suggested command: ${fallback}\n${text(result)}`).toMatchObject({
			exit_code: 0,
		});
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain("KNOWN_PREFIX_");
	});
});
