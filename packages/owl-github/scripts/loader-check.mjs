// End-to-end check: load owl-github through the REAL owl extension loader
// (package.json owl.extensions manifest → factory) and inspect what it registered.
//
// Run from anywhere: node packages/owl-github/scripts/loader-check.mjs
// Resolves @owl/owl-coding-agent from the monorepo root node_modules.
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep every config read inside the owl dev data dir, never ~/.owl.
process.env.OWL_CODING_AGENT_DIR ??= "D:\\owl\\owl-re-v1\\data\\owl";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { discoverAndLoadExtensions } = await import("@owl/owl-coding-agent");

const result = await discoverAndLoadExtensions([pkgDir], "D:\\owl\\owl-re-v1\\owl-mono", process.env.OWL_CODING_AGENT_DIR);

for (const error of result.errors) {
	console.error(`LOAD ERROR  ${error.path}: ${error.error}`);
}

const extension = result.extensions.find((candidate) => candidate.resolvedPath.replaceAll("\\", "/").includes("owl-github"));
if (!extension) {
	console.error("owl-github was not loaded. Extensions loaded:", result.extensions.map((candidate) => candidate.resolvedPath));
	process.exit(1);
}
console.log(`LOADED  ${extension.resolvedPath}`);

const tools = [...extension.tools.values()].map((entry) => entry.definition ?? entry);
const deferred = tools.filter((tool) => tool.exposure === "deferred").length;
const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
console.log(`TOOLS  ${tools.length} registered, ${deferred} deferred, ${readOnly} read-only`);

if (result.errors.length > 0 || tools.length !== 36 || deferred !== 36 || readOnly !== 18) {
	console.error("\nloader-check FAILED");
	process.exit(1);
}
console.log("\nloader-check PASSED: real loader, no errors");
