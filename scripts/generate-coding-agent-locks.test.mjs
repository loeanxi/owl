import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const generators = ["generate-coding-agent-shrinkwrap.mjs", "generate-coding-agent-install-lock.mjs"];

async function fixture(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "owl-runtime-locks-"));
	t.after(async () => {
		if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Fixture cleanup escaped the temporary directory");
		await rm(root, { recursive: true, force: true });
	});
	const manifest = { name: "@owl/owl-coding-agent", version: "1.0.0", license: "MIT", dependencies: {
		"@earendil-works/pi-ai": "0.7.0", "@google/genai": "2.21.0", "@mozilla/readability": "0.6.0", linkedom: "0.16.11", "node-pty": "1.1.0", protobufjs: "7.6.6",
		...(options.unreviewed ? { unreviewed: "1.0.0" } : {}),
	}, ...(options.platform ? { optionalDependencies: { "platform-addon": "1.2.3" } } : {}) };
	const packages = {
		"": { name: "fixture", version: "1.0.0" },
		"packages/coding-agent": manifest,
		"packages/ai": { name: "@earendil-works/pi-ai", version: "0.7.0" },
		// A relocated checkout can contain stale, unused workspace records.
		"packages/removed-unused": { name: "@earendil-works/pi-unused", version: "1.0.0" },
		"node_modules/@owl/owl-coding-agent": { link: true, resolved: "packages/coding-agent" },
		"node_modules/@earendil-works/pi-ai": { link: true, resolved: "packages/ai" },
		"node_modules/@google/genai": { version: "2.21.0", hasInstallScript: true, resolved: "https://registry.npmjs.org/@google/genai/-/genai-2.21.0.tgz" },
		"node_modules/node-pty": { version: "1.1.0", hasInstallScript: true, resolved: "https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz" },
		"node_modules/protobufjs": { version: "7.6.6", hasInstallScript: true, resolved: "https://registry.npmjs.org/protobufjs/-/protobufjs-7.6.6.tgz" },
		"node_modules/@mozilla/readability": { version: "0.6.0", resolved: "https://registry.npmjs.org/@mozilla/readability/-/readability-0.6.0.tgz" },
		"node_modules/linkedom": { version: "0.16.11", resolved: "https://registry.npmjs.org/linkedom/-/linkedom-0.16.11.tgz" },
		// A root dev tool must never be pulled into the runtime graph or required allowlist.
		"node_modules/esbuild": { version: "0.28.2", dev: true, hasInstallScript: true },
		...(options.unreviewed ? { "node_modules/unreviewed": { version: "1.0.0", hasInstallScript: true, resolved: "https://registry.npmjs.org/unreviewed/-/unreviewed-1.0.0.tgz" } } : {}),
		...(options.platform === "present" ? { "node_modules/platform-addon": { version: "1.2.3", optional: true, os: ["win32"], cpu: ["x64"], resolved: "https://registry.npmjs.org/platform-addon/-/platform-addon-1.2.3.tgz" } } : {}),
	};
	if (options.missingRequired) delete packages["node_modules/@mozilla/readability"];
	const files = {
		"package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages }),
		"packages/coding-agent/package.json": JSON.stringify(manifest),
		"packages/ai/package.json": JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.7.0", license: "MIT" }),
	};
	for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
	await mkdir(join(root, "scripts"), { recursive: true });
	for (const generator of generators) await copyFile(join(scriptDir, generator), join(root, "scripts", generator));
	return root;
}

function run(root, generator, args = []) {
	return spawnSync(process.execPath, [join(root, "scripts", generator), ...args], { cwd: root, encoding: "utf8" });
}

for (const generator of generators) {
	test(`${generator}: resolves the fork workspace, preserves its real dependency versions, and supports zero platform packages`, async t => {
		const root = await fixture(t); const generated = run(root, generator); assert.equal(generated.status, 0, generated.stderr);
		const path = generator.includes("shrinkwrap") ? "packages/coding-agent/npm-shrinkwrap.json" : "packages/coding-agent/install-lock/package-lock.json";
		const lock = JSON.parse(await readFile(join(root, path), "utf8"));
		assert.equal(lock.packages["node_modules/@earendil-works/pi-ai"].version, "0.7.0");
		assert.equal(lock.packages["node_modules/@mozilla/readability"].version, "0.6.0"); assert.equal(lock.packages["node_modules/linkedom"].version, "0.16.11");
		assert.equal(lock.packages["node_modules/node-pty"].hasInstallScript, true); assert.equal(lock.packages["node_modules/esbuild"], undefined);
		assert.match(generated.stdout, /0 platform-specific/); const checked = run(root, generator, ["--check"]); assert.equal(checked.status, 0, checked.stderr);
		if (generator.includes("install-lock")) assert.equal(lock.packages["node_modules/@owl/owl-coding-agent"].version, "1.0.0");
	});
	test(`${generator}: still rejects unreviewed runtime lifecycle scripts`, async t => {
		const root = await fixture(t, { unreviewed: true }); const result = run(root, generator); assert.equal(result.status, 1); assert.match(result.stderr, /install scripts \(unreviewed@1\.0\.0\)/);
	});
	test(`${generator}: still rejects a missing required dependency`, async t => {
		const root = await fixture(t, { missingRequired: true }); const result = run(root, generator); assert.equal(result.status, 1); assert.match(result.stderr, /Cannot resolve @mozilla\/readability/);
	});
	test(`${generator}: still requires declared platform optional entries and carries them when present`, async t => {
		const missing = await fixture(t, { platform: "missing" }); const rejected = run(missing, generator); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Cannot resolve platform-addon/);
		const present = await fixture(t, { platform: "present" }); const generated = run(present, generator); assert.equal(generated.status, 0, generated.stderr); assert.match(generated.stdout, /1 platform-specific/);
	});
}
