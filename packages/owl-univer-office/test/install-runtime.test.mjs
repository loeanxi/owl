import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	installRuntime,
	npmInstallArguments,
	parseArguments,
	REGISTRY,
	RUNTIME_ASSETS,
	RUNTIME_DEPENDENCIES,
	RUNTIME_GIT_HEAD,
	RUNTIME_INTEGRITY,
	RUNTIME_VERSION,
	resolveRuntimeTarget,
	validateRuntime,
	validateUpstreamMetadata,
} from "../scripts/install-runtime.mjs";

const metadata = {
	name: "dsh-univer-office",
	version: RUNTIME_VERSION,
	gitHead: RUNTIME_GIT_HEAD,
	dist: {
		integrity: RUNTIME_INTEGRITY,
		tarball: `${REGISTRY}dsh-univer-office/-/dsh-univer-office-${RUNTIME_VERSION}.tgz`,
	},
};

async function temporary(t) {
	const root = await mkdtemp(join(tmpdir(), "owl-univer-install-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function mockInstallation(target) {
	for (const [name, version] of Object.entries(RUNTIME_DEPENDENCIES)) {
		const root = join(target, "node_modules", ...name.split("/"));
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
	}
	for (const asset of Object.values(RUNTIME_ASSETS)) {
		const path = join(target, "node_modules", "dsh-univer-office", asset);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "fixture");
	}
	await writeFile(
		join(target, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { dependencies: RUNTIME_DEPENDENCIES },
				"node_modules/dsh-univer-office": {
					version: RUNTIME_VERSION,
					integrity: RUNTIME_INTEGRITY,
					resolved: metadata.dist.tarball,
				},
			},
		}),
	);
}

test("cache resolution follows the Owl agent dir and rejects ambiguous install targets", () => {
	const home = join(tmpdir(), "owl-test-home");
	const agentDir = join(tmpdir(), "owl-agent-space");
	assert.equal(resolveRuntimeTarget({ home, env: {} }), join(home, ".owl", "agent", "cache", "univer-office", "runtime"));
	assert.equal(resolveRuntimeTarget({ home, env: { OWL_CODING_AGENT_DIR: agentDir } }), join(agentDir, "cache", "univer-office", "runtime"));
	assert.equal(resolveRuntimeTarget({ home, env: { OWL_CODING_AGENT_DIR: "~/isolated" } }), join(home, "isolated", "cache", "univer-office", "runtime"));
	assert.throws(() => resolveRuntimeTarget({ home, target: "." }), /absolute/u);
	assert.throws(() => resolveRuntimeTarget({ home, target: home }), /dedicated/u);
	assert.throws(() => resolveRuntimeTarget({ home, env: { OWL_CODING_AGENT_DIR: "relative" } }), /absolute/u);
	assert.throws(() => resolveRuntimeTarget({ home, target: `${agentDir}\n` }), /control characters/u);
	assert.throws(() => parseArguments(["--target"]), /Usage/u);
});

test("npm runs only exact runtime dependencies without lifecycle scripts or DSH peer auto-installation", () => {
	const args = npmInstallArguments(join(tmpdir(), "npm cli", "npm-cli.js"));
	assert.equal(args[1], "install");
	for (const flag of ["--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--workspaces=false"]) {
		assert.ok(args.includes(flag));
	}
	assert.ok(args.includes(`--registry=${REGISTRY}`));
	for (const version of Object.values(RUNTIME_DEPENDENCIES)) assert.match(version, /^\d+\.\d+\.\d+$/u);
	assert.throws(() => validateUpstreamMetadata({ ...metadata, gitHead: "different" }), /snapshot/u);
	assert.throws(() => validateUpstreamMetadata({ ...metadata, dist: { ...metadata.dist, integrity: "different" } }), /snapshot/u);
});

test("fresh hydration is isolated and complete caches are reused without overwriting configuration", async (t) => {
	const root = await temporary(t);
	const target = join(root, "runtime with spaces");
	let installs = 0;
	const options = {
		target,
		fetchMetadata: async () => metadata,
		runNpm: async (directory) => {
			installs++;
			assert.equal(directory, target);
			const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
			assert.deepEqual(manifest.dependencies, RUNTIME_DEPENDENCIES);
			assert.equal(manifest.scripts, undefined);
			await mockInstallation(directory);
		},
	};
	assert.equal((await installRuntime(options)).reused, false);
	const config = join(target, "owned-runtime-config.json");
	await writeFile(config, "preserve this configuration");
	const manifestBefore = await readFile(join(target, "package.json"), "utf8");
	assert.equal((await installRuntime({ ...options, fetchMetadata: () => assert.fail("No network needed for cached runtime") })).reused, true);
	assert.equal(installs, 1);
	assert.equal(await readFile(config, "utf8"), "preserve this configuration");
	assert.equal(await readFile(join(target, "package.json"), "utf8"), manifestBefore);
	await assert.rejects(readFile(join(target, ".install.lock")), { code: "ENOENT" });
});

test("unmanaged and occupied directories cannot be hydrated", async (t) => {
	const root = await temporary(t);
	const unmanaged = join(root, "unmanaged");
	await mkdir(unmanaged);
	await writeFile(join(unmanaged, "package.json"), JSON.stringify({ name: "user-project", dependencies: {} }));
	await assert.rejects(installRuntime({ target: unmanaged }), /unmanaged/u);
	const occupied = join(root, "occupied");
	await mkdir(occupied);
	await writeFile(join(occupied, "user-file.txt"), "keep");
	await assert.rejects(installRuntime({ target: occupied }), /non-empty/u);
	assert.equal(await readFile(join(occupied, "user-file.txt"), "utf8"), "keep");
});

test("an interrupted managed installation can retry and install failures release the lock", async (t) => {
	const root = await temporary(t);
	const target = join(root, "retry-runtime");
	await assert.rejects(
		installRuntime({ target, fetchMetadata: async () => metadata, runNpm: async () => { throw new Error("network failed"); } }),
		/network failed/u,
	);
	await assert.rejects(readFile(join(target, ".install.lock")), { code: "ENOENT" });
	const result = await installRuntime({ target, fetchMetadata: async () => metadata, runNpm: mockInstallation });
	assert.equal(result.reused, false);
});

test("runtime validation rejects mismatched package integrity, absent assets and DSH host packages", async (t) => {
	const root = await temporary(t);
	await mockInstallation(root);
	assert.equal((await validateRuntime(root)).worker, join(root, "node_modules", "dsh-univer-office", RUNTIME_ASSETS.worker));
	const lockPath = join(root, "package-lock.json");
	const lock = JSON.parse(await readFile(lockPath, "utf8"));
	lock.packages["node_modules/dsh-univer-office"].integrity = "different";
	await writeFile(lockPath, JSON.stringify(lock));
	await assert.rejects(validateRuntime(root), /snapshot/u);
	lock.packages["node_modules/dsh-univer-office"].integrity = RUNTIME_INTEGRITY;
	lock.packages["node_modules/@deepseek-ai/dsh-tools"] = { version: "0.2.0-rc.1" };
	await writeFile(lockPath, JSON.stringify(lock));
	await assert.rejects(validateRuntime(root), /DSH host/u);
	delete lock.packages["node_modules/@deepseek-ai/dsh-tools"];
	await writeFile(lockPath, JSON.stringify(lock));
	await rm(join(root, "node_modules", "dsh-univer-office", RUNTIME_ASSETS.worker));
	await assert.rejects(validateRuntime(root), { code: "ENOENT" });
});
