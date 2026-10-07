import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSISTANT_DIR, DEFAULT_WORKSPACE_DIR, isReservedDir, pathCandidateFromCode } from "./paths.ts";

test("reserved dirs cover the default workspace and assistant dir across separators and case", () => {
	assert.equal(isReservedDir(DEFAULT_WORKSPACE_DIR), true);
	assert.equal(isReservedDir("D:\\owl\\Owl-def"), true);
	assert.equal(isReservedDir("d:/owl/Owl-Def/"), true);
	assert.equal(isReservedDir(ASSISTANT_DIR), true);
	assert.equal(isReservedDir("D:/OWL/Owl-Myself"), true);
	assert.equal(isReservedDir("D:/owl/other"), false);
	assert.equal(isReservedDir("D:/owl/owl-myself-extra"), false);
	assert.equal(isReservedDir(""), false);
	assert.equal(isReservedDir(undefined), false);
});

test("data-dir subdirs (experts, groups, customs) are reserved too; workspace subdirs are not", () => {
	assert.equal(isReservedDir("D:/owl/owl-expert/chenglv"), true);
	assert.equal(isReservedDir("D:\\owl\\owl-expert\\groups\\g-muxbicct"), true);
	assert.equal(isReservedDir("D:/owl/owl-expert/custom/c-abc"), true);
	assert.equal(isReservedDir("D:/owl/owl-myself/2026-10-07.md"), true);
	assert.equal(isReservedDir("D:/owl/owl-expert-extra"), false);
	assert.equal(isReservedDir("D:/owl/Owl-def/subproject"), false);
});

test("code chip candidate keeps windows absolute, posix and file URLs", () => {
	assert.equal(pathCandidateFromCode("D:\\owl\\_scratch\\owl-myself-prototype.html"), "D:\\owl\\_scratch\\owl-myself-prototype.html");
	assert.equal(pathCandidateFromCode("D:/owl/_scratch/x.html"), "D:/owl/_scratch/x.html");
	assert.equal(pathCandidateFromCode("src/app.ts"), "src/app.ts");
	assert.equal(pathCandidateFromCode("file:///D:/owl/x.html"), "file:///D:/owl/x.html");
	assert.equal(pathCandidateFromCode("https://example.com/a/b"), "https://example.com/a/b");
});

test("code chip candidate strips wrappers, trailing punctuation and line suffixes", () => {
	assert.equal(pathCandidateFromCode('"D:\\owl\\x.html"'), "D:\\owl\\x.html");
	assert.equal(pathCandidateFromCode("（D:\\owl\\x.html）"), "D:\\owl\\x.html");
	assert.equal(pathCandidateFromCode("<src/app.ts>"), "src/app.ts");
	assert.equal(pathCandidateFromCode("src/app.ts:42"), "src/app.ts");
	assert.equal(pathCandidateFromCode("src/app.ts:42:7"), "src/app.ts");
	assert.equal(pathCandidateFromCode("D:\\owl\\x.html,"), "D:\\owl\\x.html");
	assert.equal(pathCandidateFromCode("D:\\owl\\x.html。"), "D:\\owl\\x.html");
});

test("code chip candidate rejects commands, bare words and keeps port URLs intact", () => {
	assert.equal(pathCandidateFromCode("todo"), "");
	assert.equal(pathCandidateFromCode("npm run build"), "");
	assert.equal(pathCandidateFromCode("README.md"), "");
	assert.equal(pathCandidateFromCode("example.com"), "");
	assert.equal(pathCandidateFromCode("localhost:5188"), "");
	assert.equal(pathCandidateFromCode("http://localhost:5188"), "http://localhost:5188");
	assert.equal(pathCandidateFromCode(""), "");
});
