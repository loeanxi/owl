import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { transform } from "esbuild";

const evidence = [];
for (const name of ["model", "policy", "service"]) {
	const sourcePath = `D:/owl/owl-re-v1/owl-mono/packages/coding-agent/src/core/evaluation/${name}.ts`;
	const targetPath = `D:/owl/owl-re-v1/owl-mono/packages/coding-agent/dist/core/evaluation/${name}.js`;
	const source = await readFile(sourcePath, "utf8");
	const previous = await readFile(targetPath, "utf8").catch(() => null);
	if (previous !== null) await writeFile(new URL(`${name}.before.js`, import.meta.url), previous);
	const transformed = await transform(source, { loader: "ts", format: "esm", platform: "node", target: "node22", sourcefile: sourcePath });
	const output = transformed.code.replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
	assert.ok(!/from\s+["']\.{1,2}\/[^"']+\.ts["']/.test(output));
	if (name === "service") assert.ok(output.includes("EvaluationIdleWatchdog") && !output.includes("32_768"));
	await writeFile(targetPath, output);
	evidence.push({ module: name, sourceSha256: createHash("sha256").update(source).digest("hex"), outputSha256: createHash("sha256").update(output).digest("hex"), warnings: transformed.warnings });
}
await writeFile(new URL("target-build.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
