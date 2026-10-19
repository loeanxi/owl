import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import createSafetyNetExtension from "../src/index.ts";

// Source-only decisions: no supplied command is ever executed, and no user config/audit is touched.
const isolatedRoot = mkdtempSync(join(tmpdir(), "owl-stash-commands-"));
const cwd = join(isolatedRoot, "workspace");
mkdirSync(cwd);
const keys = [...new Set([...Object.keys(process.env).filter((key) => /^(?:CC_SAFETY_NET_|SAFETY_NET_)/.test(key)), "NODE_ENV", "CC_SAFETY_NET_HOME", "CC_SAFETY_NET_AUDIT_HOME", "CC_SAFETY_NET_LEVEL"])];
const previous = new Map(keys.map((key) => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
Object.assign(process.env, { NODE_ENV: "test", CC_SAFETY_NET_HOME: join(isolatedRoot, "config"), CC_SAFETY_NET_AUDIT_HOME: join(isolatedRoot, "audit"), CC_SAFETY_NET_LEVEL: "standard" });
after(() => {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(isolatedRoot, { recursive: true, force: true });
});
const handlers = new Map();
createSafetyNetExtension({ on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, sendUserMessage: () => {} });
const context = { cwd, sessionManager: { getSessionId: () => "stash-regression" } };

const allow = [
	'git stash list | head -2; echo "=== 该测试在 HEAD 是否通过（用 git stash 不方便，先用 git show 对比 ChatStream）"; git log --oneline -2 -- example.ts',
	'echo "git stash"',
	"printf '%s\\n' 'git stash push'",
	"git stash list",
	"git stash show -p 'stash@{0}'",
	'git -C "path with spaces" stash list',
	"'git' 'stash' list",
	'echo "$(git stash list)"',
];
const deny = [
	"git stash",
	"git stash push -u",
	"git stash pop",
	"git stash apply",
	"git stash drop",
	"git stash clear",
	"git stash list; git stash push",
	'echo "$(git stash push)"',
	"bash -c 'git stash push'",
	'git -C "path with spaces" stash push',
	"'git' 'stash' push",
	"env git stash push",
	"command git stash push",
	"(git stash push)",
	'echo "git stash push" | bash',
];
for (const command of ["if true; then git stash push; fi", "for item in a; do git stash push; done"]) {
	test(`bash blocks stash mutation in control flow: ${command}`, () => {
		assert.equal(handlers.get("tool_call")({ type: "tool_call", toolCallId: "stash", toolName: "bash", input: { command } }, context)?.block, true);
	});
}
for (const toolName of ["bash", "powershell"]) {
	for (const command of allow) test(`${toolName} allows literal/read-only stash text: ${command}`, () => {
		assert.equal(handlers.get("tool_call")({ type: "tool_call", toolCallId: "stash", toolName, input: { command } }, context), undefined);
	});
	for (const command of deny) test(`${toolName} blocks stash mutation: ${command}`, () => {
		assert.equal(handlers.get("tool_call")({ type: "tool_call", toolCallId: "stash", toolName, input: { command } }, context)?.block, true);
	});
}
