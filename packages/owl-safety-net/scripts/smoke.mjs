// Host-free smoke test for owl-safety-net: drives the extension factory with a
// mock extension API and asserts the block/allow decisions on real engine rules.
import { fileURLToPath } from "node:url";
import path from "node:path";

const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const { default: createSafetyNetExtension } = await import(`file://${distPath.replaceAll("\\", "/")}`);

const registered = { handlers: {}, commands: {}, sent: [] };
const pi = {
	on: (event, handler) => {
		registered.handlers[event] = handler;
	},
	registerCommand: (name, options) => {
		registered.commands[name] = options;
	},
	sendUserMessage: (message, opts) => registered.sent.push({ message, opts }),
};
const ctx = {
	cwd: process.cwd(),
	isIdle: () => true,
	sessionManager: { getSessionId: () => "smoke-test" },
};

createSafetyNetExtension(pi);

let failures = 0;
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

function toolCall(toolName, input) {
	return registered.handlers.tool_call({ type: "tool_call", toolCallId: "smoke-1", toolName, input }, ctx);
}

// Hook + command registered.
check("registers tool_call hook", Boolean(registered.handlers.tool_call), true);
check("registers command", Object.keys(registered.commands).includes("safety-net"), true);

// Destructive commands must be blocked.
const destructive = [
	["bash", { command: "rm -rf /" }],
	["bash", { command: "rm -rf ~/projects && echo done" }],
	["bash", { command: "sudo dd if=/dev/zero of=/dev/sda" }],
	["bash", { command: "git reset --hard HEAD~5" }],
	["powershell", { command: "Remove-Item -Recurse -Force C:\\" }],
];
for (const [toolName, input] of destructive) {
	const result = toolCall(toolName, input);
	check(`blocks ${toolName}: ${input.command}`, result?.block === true && typeof result.reason === "string" && result.reason.length > 0, true);
}

// Secret-file access must be blocked.
const secretAccess = [
	["read", { path: ".env" }],
	["read", { path: "~/.ssh/id_rsa" }],
	["bash", { command: "cat .env" }],
	["bash", { command: "cat ~/.aws/credentials" }],
];
for (const [toolName, input] of secretAccess) {
	const result = toolCall(toolName, input);
	check(`blocks ${toolName}: ${JSON.stringify(input)}`, result?.block === true, true);
}

// Benign calls must pass through untouched.
const benign = [
	["bash", { command: "ls -la" }],
	["bash", { command: "git status" }],
	["bash", { command: "npm test" }],
	["read", { path: "src/index.ts" }],
	["edit", { path: "README.md", oldValue: "a", newValue: "b" }],
];
for (const [toolName, input] of benign) {
	check(`allows ${toolName}: ${JSON.stringify(input)}`, toolCall(toolName, input), undefined);
}

// Malformed shell input fails closed.
check("blocks malformed bash input", toolCall("bash", {})?.block === true, true);
check("blocks non-string bash command", toolCall("bash", { command: 42 })?.block === true, true);

// Unknown custom tools are not our business.
check("ignores custom tool", toolCall("web-search", { query: "cats" }), undefined);

// /safety-net command sends the vendored reference doc.
registered.commands["safety-net"].handler("why was my command blocked?", ctx);
const sent = registered.sent.at(-1);
check("command sends doc prompt", sent.message.startsWith("# CC Safety Net") && sent.message.includes("## User request"), true);
check("command includes user args", sent.message.includes("why was my command blocked?"), true);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll smoke checks passed");
