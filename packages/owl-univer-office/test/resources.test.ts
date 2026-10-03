import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { type ResourceOfficeOptions, resourceOfficeOperation } from "../src/resources.ts";
import { isRecord } from "../src/runtime-paths.ts";

const assetRoot =
	process.env.OWL_UNIVER_TEST_RUNTIME_ROOT ??
	fileURLToPath(
		new URL("../../../../data/owl/cache/univer-office/runtime/node_modules/dsh-univer-office", import.meta.url),
	);
const installed = existsSync(join(assetRoot, "package.json"));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M1 1h10v10z"/></svg>';

async function environment(t: TestContext): Promise<{ cwd: string; root: string; options: ResourceOfficeOptions }> {
	const root = await mkdtemp(join(tmpdir(), "owl-univer-resources-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	return { root, cwd, options: { assetRoot, cacheRoot: join(root, "cache") } };
}

function object(value: unknown): Record<string, unknown> {
	assert.ok(isRecord(value));
	return value;
}

async function coffeeHandle(cwd: string, options: ResourceOfficeOptions): Promise<string> {
	const found = await resourceOfficeOperation(
		{ action: "find", queries: ["coffee"], registries: ["example-tabler-outline"], limit: 3 },
		cwd,
		options,
	);
	const resources = object(found.result).resources;
	assert.ok(Array.isArray(resources));
	assert.ok(resources.length > 0);
	const handle = object(resources[0]).handle;
	assert.equal(typeof handle, "string");
	return String(handle);
}

test("missing isolated SDK produces an actionable error", async (t) => {
	const { cwd, root, options } = await environment(t);
	await assert.rejects(
		resourceOfficeOperation({ action: "registries" }, cwd, { ...options, assetRoot: join(root, "missing-runtime") }),
		(error: unknown) =>
			isRecord(error) &&
			error.code === "RESOURCE_RUNTIME_MISSING" &&
			String(error.message).includes("install-runtime.mjs"),
	);
});

test("actual 1.0.2 catalog lists registries and searches Tabler without network", { skip: !installed }, async (t) => {
	const { cwd, options } = await environment(t);
	options.fetch = () => {
		throw new Error("Catalog lookup must not use the network");
	};
	const listed = await resourceOfficeOperation({ action: "registries" }, cwd, options);
	const registries = object(listed.result).registries;
	assert.ok(Array.isArray(registries));
	assert.ok(registries.some((entry: unknown) => object(entry).id === "example-tabler-outline"));
	assert.deepEqual(listed.outputs, []);
	assert.match(await coffeeHandle(cwd, options), /^example-tabler-outline\//u);
	await assert.rejects(
		resourceOfficeOperation({ action: "find", queries: ["coffee"], limit: 51 }, cwd, options),
		/between 1 and 50/u,
	);
	await assert.rejects(
		resourceOfficeOperation({ action: "find", queries: ["coffee"], registries: ["unknown-registry"] }, cwd, options),
		/Unknown resource registry/u,
	);
});

test(
	"actual SDK read caches mock HTTPS SVG and export returns confined files without replacing a directory",
	{ skip: !installed },
	async (t) => {
		const { cwd, options } = await environment(t);
		let downloads = 0;
		options.fetch = async (input) => {
			downloads++;
			assert.equal(new URL(String(input)).protocol, "https:");
			return new Response(svg, { status: 200 });
		};
		const handle = await coffeeHandle(cwd, options);
		const read = await resourceOfficeOperation({ action: "read", handle }, cwd, options);
		assert.equal(object(read.result).svg, svg);
		assert.equal(downloads, 1);
		const exported = await resourceOfficeOperation(
			{ action: "export", handles: [handle], output: "artifacts/icons" },
			cwd,
			options,
		);
		assert.ok(Array.isArray(exported.outputs));
		assert.equal(exported.outputs.length, 1);
		const output = String(exported.outputs[0]);
		assert.equal(await readFile(output, "utf8"), svg);
		assert.ok(output.startsWith(join(cwd, "artifacts", "icons")));
		assert.deepEqual(object(exported.result).failed, []);
		assert.equal(downloads, 1);
		await writeFile(join(cwd, "artifacts", "icons", "user-file.txt"), "preserve");
		await assert.rejects(
			resourceOfficeOperation({ action: "export", handles: [handle], output: "artifacts/icons" }, cwd, options),
			/already exists/u,
		);
		assert.equal(await readFile(join(cwd, "artifacts", "icons", "user-file.txt"), "utf8"), "preserve");
		assert.equal(downloads, 1);
	},
);

test("export refuses traversal and junctions before downloading", { skip: !installed }, async (t) => {
	const { cwd, root, options } = await environment(t);
	options.fetch = () => {
		throw new Error("Rejected outputs must not download resources");
	};
	const outside = join(root, "outside");
	await mkdir(outside);
	const handle = await coffeeHandle(cwd, options);
	await assert.rejects(
		resourceOfficeOperation({ action: "export", handles: [handle], output: "../outside/icons" }, cwd, options),
		/inside the current workspace/u,
	);
	await symlink(outside, join(cwd, "junction"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(
		resourceOfficeOperation({ action: "export", handles: [handle], output: "junction/icons" }, cwd, options),
		/symbolic links or junctions/u,
	);
	assert.deepEqual(await readdir(outside), []);
	await assert.rejects(
		resourceOfficeOperation({ action: "export", handles: [handle, handle], output: "duplicates" }, cwd, options),
		/duplicates/u,
	);
	assert.equal(existsSync(join(cwd, "duplicates")), false);
});

test("SDK resource handles cannot be used to request arbitrary URLs", { skip: !installed }, async (t) => {
	const { cwd, options } = await environment(t);
	options.fetch = () => {
		throw new Error("Invalid handles must not fetch URLs");
	};
	await assert.rejects(
		resourceOfficeOperation({ action: "read", handle: "https://example.com/arbitrary.svg" }, cwd, options),
		/Invalid resource handle/u,
	);
});

test("an output file created during download is never overwritten", { skip: !installed }, async (t) => {
	const { cwd, options } = await environment(t);
	const handle = await coffeeHandle(cwd, options);
	const output = join(cwd, "reserved-output", `${handle.replace("/", "--")}.svg`);
	options.fetch = async () => {
		await writeFile(output, "existing user file", { flag: "wx" });
		return new Response(svg, { status: 200 });
	};
	const exported = await resourceOfficeOperation(
		{ action: "export", handles: [handle], output: "reserved-output" },
		cwd,
		options,
	);
	assert.deepEqual(exported.outputs, []);
	const failed = object(exported.result).failed;
	assert.ok(Array.isArray(failed));
	assert.equal(failed.length, 1);
	assert.equal(await readFile(output, "utf8"), "existing user file");
});

test("cancellation propagates through the SDK HTTPS downloader", { skip: !installed }, async (t) => {
	const { cwd, options } = await environment(t);
	const handle = await coffeeHandle(cwd, options);
	const cancelled = new AbortController();
	cancelled.abort(new Error("Already cancelled"));
	await assert.rejects(
		resourceOfficeOperation(
			{ action: "export", handles: [handle], output: "cancelled" },
			cwd,
			options,
			cancelled.signal,
		),
		/Already cancelled/u,
	);
	assert.equal(existsSync(join(cwd, "cancelled")), false);
	const controller = new AbortController();
	let observedAbort = false;
	options.fetch = (_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const requestSignal = init?.signal;
			assert.ok(requestSignal);
			requestSignal.addEventListener(
				"abort",
				() => {
					observedAbort = true;
					reject(requestSignal.reason);
				},
				{ once: true },
			);
			setImmediate(() => controller.abort(new Error("Download cancelled")));
		});
	await assert.rejects(
		resourceOfficeOperation({ action: "read", handle }, cwd, options, controller.signal),
		/Download cancelled/u,
	);
	assert.equal(observedAbort, true);
});
