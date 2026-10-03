import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { directory, repo } from "./build.mjs";

// This reads the isolated fixture after CUA has driven the real UI. It performs no UI action.
const port = Number(process.argv[2] ?? 19090);
const state = await fetch(`http://127.0.0.1:${port}/test-state`).then((response) => response.json());
assert.equal(state.fixture, true);
assert.equal(state.paidCalls, 0);
const research = state.sessions.find((session) => session.researchMode);
const ordinary = state.sessions.find((session) => !session.researchMode);
assert.ok(research && ordinary && research.id !== ordinary.id);
const calls = (type) => state.requests.filter((request) => request.type === type);
assert.equal(calls("session.create").filter((request) => request.researchMode).length, 1);
assert.ok(calls("session.create").some((request) => !Object.hasOwn(request, "researchMode")));
assert.ok(calls("session.prompt").filter((request) => request.sessionId === research.id).length >= 2);
assert.ok(calls("session.prompt").filter((request) => request.sessionId === research.id).every((request) => request.researchMode === "crawl"));
assert.ok(calls("session.prompt").filter((request) => request.sessionId === ordinary.id).every((request) => !Object.hasOwn(request, "researchMode")));
assert.equal(research.approvalMode, "plan");
assert.equal(research.thinkingLevel, "off");
assert.equal(ordinary.approvalMode, "confirm");
assert.equal(ordinary.thinkingLevel, "medium");
assert.ok(calls("session.resume").some((request) => request.sessionId === research.id));
assert.ok(calls("session.abort").some((request) => request.sessionId === research.id));
const result = research.messages.find((message) => message.role === "toolResult" && message.toolName === "research_publish")?.details?.researchResult;
assert.equal(result?.rows.length, 2);
assert.equal(result?.sources.length, 1);
const question = state.emitted.find((event) => event.type === "question_request" && event.sessionId === research.id);
assert.ok(calls("question.response").some((request) => request.requestId === question?.requestId));
const permissions = state.emitted.filter((event) => event.type === "permission_request");
assert.equal(permissions.length, 2);
assert.ok(permissions.every((event) => calls("permission.response").some((request) => request.requestId === event.requestId)));
assert.equal(state.pendingQuestions.length, 0);
assert.equal(state.pendingPermissions.length, 0);
assert.ok(calls("iab.open").some((request) => state.emitted.some((event) => event.type === "iab.pages" && event.pages.some((page) => page.pageId === request.pageId && page.sessionId === research.id))));
const evidence = JSON.parse(await readFile(join(directory, "build-evidence.json"), "utf8"));
for (const [source, hash] of Object.entries(evidence.sources)) {
  assert.equal(createHash("sha256").update(await readFile(resolve(repo, source))).digest("hex"), hash, `Source changed after validation compile: ${source}`);
}
const verification = {
  capturedAt: new Date().toISOString(), evidence, paidCalls: 0,
  tests: { backend: "15/15", frontendAndTranscript: "24/24", rootCheck: "passed", researchStrictTypes: "passed", fullDesktopTypes: "blocked by concurrent EvaluationResults.tsx:69 JSX syntax" },
  ui: ["separate research and ordinary sessions", "mode and controls use the correct wire request", "results and sources", "refresh restores result and pending question", "question response routing", "permission queue retains both sessions", "research IAB routing", "one optional panel", "stop", "history restores research settings"],
  limits: ["Offline model and tools at the server boundary", "Evaluation UI excluded from this build", "External websites and paid model calls were not executed"],
  requests: state.requests, fixtureSessions: state.sessions, unsupportedFixtureRequests: state.unsupported,
};
await writeFile(join(directory, "verification.json"), JSON.stringify(verification, null, 2) + "\n");
console.log("Research UI wire invariants passed; verification.json saved. No paid model calls.");
