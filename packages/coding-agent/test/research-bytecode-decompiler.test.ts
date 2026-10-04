import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BytecodeDecompilerManifest,
	type BytecodeDecompilerRunner,
	inspectBytecodeDecompilerAvailability,
	runBytecodeDecompiler,
} from "../src/core/research/bytecode-decompiler.ts";

const temporary: string[] = [];
const disassembly = [
	"Start SharedFunctionInfo",
	"0xabc: [SharedFunctionInfo] in OldSpace",
	"Start BytecodeArray",
	"0x123 @    0 : 0d 2a LdaSmi [42]",
	"0x125 @    2 : a9 Return",
	"End BytecodeArray",
	"End SharedFunctionInfo",
].join("\n");

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owl-research-bytecode-"));
	temporary.push(root);
	return root;
}

function hash(data: string): string {
	return createHash("sha256").update(data).digest("hex");
}

function jsc(): Buffer {
	const data = Buffer.alloc(64, 0);
	data.writeUInt32LE(0xc0de063a, 0);
	data.writeUInt32LE(0xa5e2d63c, 4);
	data.writeUInt32LE(21, 8);
	data.writeUInt32LE(32, 20);
	return data;
}

async function fixture(): Promise<{
	root: string;
	input: string;
	output: string;
	home: string;
	manifest: BytecodeDecompilerManifest;
}> {
	const root = await workspace();
	const input = join(root, "input");
	const output = join(root, "output");
	const home = join(root, "tools");
	await Promise.all([mkdir(input), mkdir(output), mkdir(home)]);
	await mkdir(join(home, "view8"));
	await writeFile(join(input, "sample.jsc"), jsc());
	const contents = {
		"d8.exe": "fixture decoder executable; only fake runner called",
		"snapshot_blob.bin": "fixture snapshot",
		"view8/view8.py": "fixture reviewed script",
		"view8/parse.py": "fixture reviewed dependency",
	};
	for (const [path, content] of Object.entries(contents)) await writeFile(join(home, path), content);
	const python = join(root, "python.exe");
	await writeFile(python, "fixture runtime");
	const manifest: BytecodeDecompilerManifest = {
		schemaVersion: 1,
		adapter: "jsc2js-view8",
		engine: "12.6.228.30",
		releaseUrl: "https://github.com/xqy2006/jsc2js/releases/download/12.6.228.30/d8-12.6.228.30-windows.zip",
		releaseArchiveSha256: "b8c87c661ebb561db4363ebf48eb9e92288961d233b947f465e1d0303854a6b4",
		sourceCommit: "d240cec90dd3ea371504c24bb1fb1ea5aad4e81a",
		decoderSourceCommit: "87a35e1e186bd1d86fca6ba500e203a273a6e1bb",
		d8: { path: "d8.exe", sha256: hash(contents["d8.exe"]) },
		snapshot: { path: "snapshot_blob.bin", sha256: hash(contents["snapshot_blob.bin"]) },
		view8: { path: "view8/view8.py", sha256: hash(contents["view8/view8.py"]) },
		python: { path: python, sha256: hash("fixture runtime") },
		files: [{ path: "view8/parse.py", sha256: hash(contents["view8/parse.py"]) }],
	};
	await writeFile(join(home, "toolchain.json"), JSON.stringify(manifest));
	return { root, input, output, home, manifest };
}

afterEach(async () => {
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("pinned V8 bytecode decompiler", () => {
	it("verifies pinned provenance, every imported source hash, runtime hash, and supports only configured Windows tools", async () => {
		const { home } = await fixture();
		const result = await inspectBytecodeDecompilerAvailability(undefined, { toolchainHome: home, platform: "win32" });
		expect(result.status).toBe("available");
		expect(result.verifiedFiles).toHaveLength(5);
		expect(
			await inspectBytecodeDecompilerAvailability(undefined, { toolchainHome: home, platform: "linux" }),
		).toMatchObject({ status: "unsupported" });
	});

	it("copies unchanged bytes, runs only fixed deserializer and source reconstruction, and never executes target or output", async () => {
		const { input, output, home, manifest } = await fixture();
		const calls: { file: string; args: string[] }[] = [];
		const runner: BytecodeDecompilerRunner = async (file, args, options) => {
			calls.push({ file, args });
			expect(options.maxBuffer).toBe(64 * 1024 * 1024);
			expect(options.timeout).toBe(60_000);
			expect(options.windowsHide).toBe(true);
			expect(Object.keys(options.env).every((key) => !/key|token|secret|proxy|PATH/i.test(key))).toBe(true);
			if (file.endsWith("d8.exe")) {
				expect(args.slice(0, 3)).toEqual(["--snapshot_blob", join(home, "snapshot_blob.bin"), "-e"]);
				expect(args[3]).toMatch(/^loadjsc\(".+\/input\.jsc"\);$/);
				expect(await readFile(join(options.cwd, "input.jsc"))).toEqual(jsc());
				return { stdout: disassembly, stderr: "" };
			}
			expect(file).toBe(manifest.python.path);
			expect(args.slice(0, 4)).toEqual(["-E", "-s", "-S", "-B"]);
			expect(args[4]).toBe(join(home, "view8", "view8.py"));
			expect(args[5]).toBe("--disassembled");
			await writeFile(args[7], "function recovered() { return 42; }\n");
			return { stdout: "Decompiling 1 functions.\nDone.", stderr: "" };
		};
		const result = await runBytecodeDecompiler({ cwd: input, path: "sample.jsc", outputCwd: output }, undefined, {
			toolchainHome: home,
			platform: "win32",
			run: runner,
		});
		expect(result.status).toBe("completed");
		expect(result).toMatchObject({
			approximate: true,
			targetExecuted: false,
			osSandbox: false,
			functionCount: 1,
			opcodeCount: 2,
		});
		expect(result.artifacts).toHaveLength(4);
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => !call.file.endsWith(".jsc") && !call.file.endsWith("reconstructed.js"))).toBe(true);
		expect(await readFile(join(input, "sample.jsc"))).toEqual(jsc());
		expect(await readdir(input)).toEqual(["sample.jsc"]);
	});

	it("refuses incompatible magic or version, truncated payload, and non-JSC files before starting any process", async () => {
		const { input, output, home } = await fixture();
		const runner: BytecodeDecompilerRunner = async () => {
			throw new Error("must not start");
		};
		for (const [offset, value, expected] of [
			[0, 1, "unsupported"],
			[4, 1, "unsupported"],
			[20, 999, "failed"],
		] as const) {
			const data = jsc();
			data.writeUInt32LE(value, offset);
			await writeFile(join(input, "sample.jsc"), data);
			const result = await runBytecodeDecompiler({ cwd: input, path: "sample.jsc", outputCwd: output }, undefined, {
				toolchainHome: home,
				platform: "win32",
				run: runner,
			});
			expect(result.status).toBe(expected);
		}
		await writeFile(join(input, "sample.exe"), jsc());
		expect((await runBytecodeDecompiler({ cwd: input, path: "sample.exe", outputCwd: output })).status).toBe(
			"unsupported",
		);
		expect(await readdir(output)).toEqual([]);
	});

	it("rejects changed decoder/source hashes, undeclared scripts, cached Python files, links, and invalid provenance", async () => {
		for (const change of ["tamper", "extra", "cache", "provenance", "link"] as const) {
			const { home, root, manifest } = await fixture();
			if (change === "tamper") await writeFile(join(home, "view8", "parse.py"), "changed");
			if (change === "extra") await writeFile(join(home, "view8", "extra.py"), "not declared");
			if (change === "cache") await mkdir(join(home, "view8", "__pycache__"));
			if (change === "provenance")
				await writeFile(join(home, "toolchain.json"), JSON.stringify({ ...manifest, engine: "99.0.0.0" }));
			if (change === "link") await symlink(root, join(home, "view8", "linked"), "junction");
			const result = await inspectBytecodeDecompilerAvailability(undefined, {
				toolchainHome: home,
				platform: "win32",
			});
			expect(result.status).toBe("invalidToolchain");
		}
	});

	it("preserves partial parse failures instead of calling them full source recovery", async () => {
		const { input, output, home } = await fixture();
		const runner: BytecodeDecompilerRunner = async (file, args) => {
			if (file.endsWith("d8.exe")) return { stdout: disassembly, stderr: "" };
			await writeFile(args[7], "function recovered() { /* placeholder */ }\n");
			return { stdout: "Warning! failed to decompile func_x stopped after 2/5", stderr: "" };
		};
		const result = await runBytecodeDecompiler({ cwd: input, path: "sample.jsc", outputCwd: output }, undefined, {
			toolchainHome: home,
			platform: "win32",
			run: runner,
		});
		expect(result.status).toBe("partial");
		expect(result.warnings.join("\n")).toContain("stopped after 2/5");
		expect(result.artifacts.some((file) => file.kind === "disassembly")).toBe(true);
	});

	it("never starts processes for missing tools or abort, bounds timeout, and preserves failures", async () => {
		const { input, output, home } = await fixture();
		const missing = await runBytecodeDecompiler({ cwd: input, path: "sample.jsc", outputCwd: output }, undefined, {
			toolchainHome: join(home, "missing"),
			platform: "win32",
		});
		expect(missing.status).toBe("toolMissing");
		const controller = new AbortController();
		controller.abort();
		const cancelled = await runBytecodeDecompiler(
			{ cwd: input, path: "sample.jsc", outputCwd: output },
			controller.signal,
		);
		expect(cancelled.status).toBe("cancelled");
		const result = await runBytecodeDecompiler(
			{ cwd: input, path: "sample.jsc", outputCwd: output, timeoutMs: 999_999 },
			undefined,
			{
				toolchainHome: home,
				platform: "win32",
				run: async (_file, _args, options) => {
					expect(options.timeout).toBe(120_000);
					throw new Error("decoder timed out");
				},
			},
		);
		expect(result.status).toBe("failed");
		expect(result.errors).toContain("decoder timed out");
	});

	it("rejects input traversal and output junctions while leaving outside paths unchanged", async () => {
		const { input, output, home, root } = await fixture();
		await writeFile(join(root, "outside.jsc"), jsc());
		const traversal = await runBytecodeDecompiler({ cwd: input, path: "../outside.jsc", outputCwd: output });
		expect(traversal.status).toBe("failed");
		await symlink(input, join(output, ".owl"), "junction");
		const junction = await runBytecodeDecompiler({ cwd: input, path: "sample.jsc", outputCwd: output }, undefined, {
			toolchainHome: home,
			platform: "win32",
		});
		expect(junction.status).toBe("failed");
		expect(junction.errors.join("\n")).toContain("链接");
		expect(await readdir(input)).toEqual(["sample.jsc"]);
	});
});
