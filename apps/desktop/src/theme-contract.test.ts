import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(css|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
	});
}

test("desktop theme color references use declared roles instead of silently falling back to another theme", () => {
	const sources = sourceFiles(root).map((path) => ({ path, source: readFileSync(path, "utf8") }));
	const declared = new Set<string>();
	for (const { source } of sources) {
		for (const match of source.matchAll(/(--(?:color-owl|owl-ui)-[\w-]+)["']?\s*:/g)) declared.add(match[1]);
		for (const match of source.matchAll(/setProperty\(["'](--(?:color-owl|owl-ui)-[\w-]+)["']/g))
			declared.add(match[1]);
	}
	const missing: string[] = [];
	for (const { path, source } of sources) {
		for (const match of source.matchAll(/var\(\s*(--(?:color-owl|owl-ui)-[\w-]+)/g)) {
			if (declared.has(match[1])) continue;
			const line = source.slice(0, match.index).split("\n").length;
			missing.push(`${relative(root, path)}:${line} ${match[1]}`);
		}
	}
	assert.deepEqual(missing, [], `Undeclared theme tokens:\n${missing.join("\n")}`);
});
