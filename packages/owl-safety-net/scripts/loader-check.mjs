// End-to-end check: load owl-safety-net through the REAL owl extension loader
// (package.json owl.extensions manifest → jiti → factory), then drive the
// registered tool_call handler the way the runner would.
//
// Run from anywhere: node packages/owl-safety-net/scripts/loader-check.mjs
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
for (const warning of result.warnings ?? []) {
	console.warn(`LOAD WARNING  ${warning.path}: ${warning.warning}`);
}

const extension = result.extensions.find((candidate) => candidate.resolvedPath.replaceAll("\\", "/").includes("owl-safety-net"));
if (!extension) {
	console.error("owl-safety-net was not loaded. Extensions loaded:", result.extensions.map((candidate) => candidate.resolvedPath));
	process.exit(1);
}
console.log(`LOADED  ${extension.resolvedPath}`);
console.log(`COMMANDS  ${[...extension.commands.keys()].join(", ")}`);

const [handler] = extension.handlers.get("tool_call") ?? [];
if (typeof handler !== "function") {
	console.error("No tool_call handler registered");
	process.exit(1);
}

const ctx = {
	cwd: process.cwd(),
	isIdle: () => true,
	sessionManager: { getSessionId: () => "loader-check" },
};
const destructive = await handler({ type: "tool_call", toolCallId: "lc-1", toolName: "bash", input: { command: "rm -rf /" } }, ctx);
const benign = await handler({ type: "tool_call", toolCallId: "lc-2", toolName: "bash", input: { command: "ls -la" } }, ctx);
const secret = await handler({ type: "tool_call", toolCallId: "lc-3", toolName: "read", input: { path: ".env" } }, ctx);

let ok = true;
console.log(`BLOCK rm -rf /       → ${JSON.stringify(destructive)}`);
console.log(`ALLOW ls -la         → ${JSON.stringify(benign)}`);
console.log(`BLOCK read .env      → ${JSON.stringify(secret)}`);
if (destructive?.block !== true || !destructive.reason) ok = false;
if (benign !== undefined) ok = false;
if (secret?.block !== true) ok = false;

if (result.errors.length > 0 || !ok) {
	console.error("\nloader-check FAILED");
	process.exit(1);
}
console.log("\nloader-check PASSED: real loader + real rules, no errors");
