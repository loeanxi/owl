import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decompressUpx,
	extractApplicationContainer,
	inspectApplicationContainer,
	type UpxRunner,
} from "../src/core/research/container.ts";

const temporary: string[] = [];

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "owl-research-container-"));
	temporary.push(root);
	return root;
}

// ASAR's official writer uses an uint32 size Pickle and a string Pickle.
// https://github.com/electron/asar/blob/main/src/disk.ts
function asar(header: unknown, body: Buffer = Buffer.alloc(0)): Buffer {
	const json = Buffer.from(JSON.stringify(header), "utf8");
	const paddedLength = Math.ceil(json.length / 4) * 4;
	const headerPickle = Buffer.alloc(8 + paddedLength);
	headerPickle.writeUInt32LE(4 + paddedLength, 0);
	headerPickle.writeInt32LE(json.length, 4);
	json.copy(headerPickle, 8);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	return Buffer.concat([sizePickle, headerPickle, body]);
}

async function sampleArchive(root: string): Promise<string> {
	const metadata = Buffer.from(JSON.stringify({ name: "sample-app", version: "2.4.0", main: "./out/main.js" }));
	const code = Buffer.from(
		'const { ipcMain, BrowserWindow } = require("electron");\nipcMain.handle("settings", () => 1);\nnew BrowserWindow({});\nwin.loadURL("https://example.test?token=PRIVATE");\nconst token = "PRIVATE";\n',
	);
	const path = join(root, "app.asar");
	await writeFile(
		path,
		asar(
			{
				files: {
					"package.json": { size: metadata.length, offset: "0" },
					out: { files: { "main.js": { size: code.length, offset: String(metadata.length) } } },
					link: { link: "out/main.js" },
					"native.node": { size: 6, unpacked: true },
				},
			},
			Buffer.concat([metadata, code]),
		),
	);
	await mkdir(`${path}.unpacked`);
	await writeFile(join(`${path}.unpacked`, "native.node"), "native");
	return path;
}

afterEach(async () => {
	for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("static Electron container research", () => {
	it("reads actual ASAR package fields and bounded lexical evidence without executing or exposing source secrets", async () => {
		const root = await workspace();
		const path = await sampleArchive(root);
		const result = await inspectApplicationContainer({ cwd: root, archivePath: path });
		expect(result.status).toBe("supported");
		expect(result.container).toBe("asar");
		expect(result.package).toMatchObject({ name: "sample-app", version: "2.4.0", main: "./out/main.js" });
		expect(result.entries).toContainEqual({ path: "link", type: "link", size: undefined, unpacked: undefined });
		expect(result.javascript[0].signals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "module", snippet: "electron" }),
				expect.objectContaining({ kind: "ipc", snippet: "ipcMain.handle(" }),
				expect.objectContaining({ kind: "navigation", snippet: "loadURL" }),
			]),
		);
		expect(result.javascript[0].sha256Read).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		expect(result.capabilities.peUnpack).toBe(false);
	});

	it("finds adjacent unpacked resources/app, reads main directly, and skips node_modules trees", async () => {
		const root = await workspace();
		const exe = join(root, "app.exe");
		await writeFile(exe, "not executed");
		const app = join(root, "resources", "app");
		await mkdir(join(app, "out", "main"), { recursive: true });
		await mkdir(join(app, "out", "preload"), { recursive: true });
		await mkdir(join(app, "node_modules", "hidden"), { recursive: true });
		await writeFile(
			join(app, "package.json"),
			JSON.stringify({ name: "directory-app", main: "./out/main/index.js" }),
		);
		await writeFile(
			join(app, "out", "main", "index.js"),
			'require("./bytecode-loader.cjs"); require("./index.jsc");',
		);
		await writeFile(
			join(app, "out", "main", "bytecode-loader.cjs"),
			'const child = require("node:child_process"); child.spawn("never-run");',
		);
		await writeFile(join(app, "out", "main", "index.jsc"), "never execute bytecode");
		await writeFile(
			join(app, "out", "preload", "index.js"),
			'const { ipcRenderer } = require("electron"); ipcRenderer.invoke("settings");',
		);
		await writeFile(join(app, "node_modules", "hidden", "secret.js"), "do not read");
		const result = await inspectApplicationContainer({ cwd: root, exePath: exe });
		expect(result.container).toBe("directory");
		expect(result.package?.name).toBe("directory-app");
		expect(result.javascript[0].path).toBe("out/main/index.js");
		expect(result.entries.some((entry) => entry.path.startsWith("node_modules/"))).toBe(false);
		expect(result.javascript.map((file) => file.path)).toEqual([
			"out/main/index.js",
			"out/main/bytecode-loader.cjs",
			"out/preload/index.js",
		]);
		expect(result.javascript[1].signals.some((signal) => signal.kind === "process")).toBe(true);
		expect(result.warnings.some((warning) => warning.includes(".jsc"))).toBe(true);
		expect(result.capabilities.extract).toBe(false);
	});

	it("returns evidence of unsupported container absence and keeps caller input boundaries", async () => {
		const root = await workspace();
		await writeFile(join(root, "plain.exe"), "not executed");
		const result = await inspectApplicationContainer({ cwd: root, path: "plain.exe" });
		expect(result.status).toBe("unsupported");
		expect(result.evidence[0].note).toContain("未发现");
		const outside = await workspace();
		const archive = await sampleArchive(outside);
		await expect(inspectApplicationContainer({ cwd: root, archivePath: archive })).rejects.toThrow("超出");
	});

	it("bounds entry reads and never searches or exposes the unread suffix", async () => {
		const root = await workspace();
		const metadata = Buffer.from(JSON.stringify({ main: "main.js" }));
		const code = Buffer.concat([
			Buffer.alloc(256 * 1024, 32),
			Buffer.from('require("private-module-in-unread-suffix");'),
		]);
		const path = join(root, "large.asar");
		await writeFile(
			path,
			asar(
				{
					files: {
						"package.json": { size: metadata.length, offset: "0" },
						"main.js": { size: code.length, offset: String(metadata.length) },
					},
				},
				Buffer.concat([metadata, code]),
			),
		);
		const result = await inspectApplicationContainer({ cwd: root, archivePath: path });
		expect(result.javascript[0].bytesRead).toBe(256 * 1024);
		expect(result.javascript[0].truncated).toBe(true);
		expect(result.javascript[0].signals).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("private-module-in-unread-suffix");
	});

	it("rejects malformed Pickles, malicious entry names, and out-of-bounds file offsets", async () => {
		const root = await workspace();
		const path = join(root, "bad.asar");
		for (const header of [
			{ files: { "../escape": { size: 0, offset: "0" } } },
			{ files: { "C:escape": { size: 0, offset: "0" } } },
			{ files: { "/absolute": { size: 0, offset: "0" } } },
			{ files: { outside: { size: 1, offset: "99999999" } } },
		]) {
			await writeFile(path, asar(header));
			await expect(inspectApplicationContainer({ cwd: root, archivePath: path })).rejects.toThrow();
		}
		const corrupt = asar({ files: {} });
		corrupt.writeUInt32LE(3, 0);
		await writeFile(path, corrupt);
		await expect(inspectApplicationContainer({ cwd: root, archivePath: path })).rejects.toThrow("Pickle");
	});

	it("extracts only requested files into a separate workspace and preserves original ASAR bytes", async () => {
		const root = await workspace();
		const outputRoot = await workspace();
		const path = await sampleArchive(root);
		const original = await readFile(path);
		const result = await extractApplicationContainer({
			cwd: root,
			archivePath: path,
			names: ["out/main.js", "native.node"],
			outputCwd: outputRoot,
		});
		expect(result.outputDirectory).toMatch(/\.owl[\\/]research[\\/]extracted[\\/][a-f0-9-]{36}$/);
		expect(result.outputDirectory.startsWith(outputRoot)).toBe(true);
		expect(result.files.map((file) => file.path)).toEqual(["out/main.js", "native.node"]);
		expect(await readFile(result.files[1].outputPath, "utf8")).toBe("native");
		expect(await readFile(path)).toEqual(original);
		expect(await readdir(root)).not.toContain(".owl");
	});

	it("rejects traversal, absolute paths, links, and excessive file or aggregate sizes before output creation", async () => {
		const root = await workspace();
		const outputRoot = await workspace();
		const path = await sampleArchive(root);
		for (const name of ["../escape", "C:/escape", "/escape", "out\\main.js", "link"]) {
			await expect(
				extractApplicationContainer({ cwd: root, archivePath: path, names: [name], outputCwd: outputRoot }),
			).rejects.toThrow();
		}
		const size = 32 * 1024 * 1024;
		const files = Object.fromEntries(
			Array.from({ length: 5 }, (_, index) => [`${index}.bin`, { size, offset: "0" }]),
		);
		await writeFile(path, asar({ files }, Buffer.alloc(size)));
		await expect(
			extractApplicationContainer({
				cwd: root,
				archivePath: path,
				names: Object.keys(files),
				outputCwd: outputRoot,
			}),
		).rejects.toThrow("总大小");
		await writeFile(path, asar({ files: { huge: { size: size + 1, offset: "0" } } }, Buffer.alloc(size + 1)));
		await expect(
			extractApplicationContainer({ cwd: root, archivePath: path, names: ["huge"], outputCwd: outputRoot }),
		).rejects.toThrow("单个");
		expect(await readdir(outputRoot)).not.toContain(".owl");
	});

	it("refuses input and output junctions and preserves the external directories", async () => {
		const root = await workspace();
		const outside = await workspace();
		const path = await sampleArchive(outside);
		await symlink(outside, join(root, "linked"), "junction");
		await expect(
			inspectApplicationContainer({ cwd: root, archivePath: join(root, "linked", basename(path)) }),
		).rejects.toThrow("链接");
		const archive = await sampleArchive(root);
		await symlink(outside, join(root, ".owl"), "junction");
		await expect(
			extractApplicationContainer({ cwd: root, archivePath: archive, names: ["package.json"], outputCwd: root }),
		).rejects.toThrow("链接");
		expect(await readdir(outside)).not.toContain("research");
	});

	it("propagates cancellation before static read or extraction", async () => {
		const root = await workspace();
		const controller = new AbortController();
		controller.abort();
		await expect(inspectApplicationContainer({ cwd: root, path: "unused.exe" }, controller.signal)).rejects.toThrow();
		await expect(
			extractApplicationContainer(
				{ cwd: root, archivePath: "unused.asar", names: ["main.js"], outputCwd: root },
				controller.signal,
			),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	});
});

describe("fixed UPX adapter without running sample executables", () => {
	it("accurately reports a missing tool and never starts the sample", async () => {
		const root = await workspace();
		const path = join(root, "sample.exe");
		await writeFile(path, "sample");
		const calls: string[] = [];
		const runner: UpxRunner = async (file) => {
			calls.push(file);
			throw new Error("tool absent");
		};
		const result = await decompressUpx({ cwd: root, path, outputCwd: root }, undefined, runner);
		expect(result.status).toBe("toolMissing");
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toBe(path);
	});

	it("uses only installed UPX -t then -d -o to a fresh output with bounded process options", async () => {
		const root = await workspace();
		const inputRoot = join(root, "input");
		const outputRoot = join(root, "output");
		const toolsRoot = join(root, "tools");
		await Promise.all([mkdir(inputRoot), mkdir(outputRoot), mkdir(toolsRoot)]);
		const path = join(inputRoot, "sample.exe");
		const tool = join(toolsRoot, process.platform === "win32" ? "upx.exe" : "upx");
		await writeFile(path, "compressed");
		await writeFile(tool, "fake runner only");
		const calls: { file: string; args: string[] }[] = [];
		const runner: UpxRunner = async (file, args, options) => {
			calls.push({ file, args });
			expect(options.timeout).toBe(20_000);
			expect(options.maxBuffer).toBe(65_536);
			expect(options.windowsHide).toBe(true);
			expect(options.env).not.toHaveProperty("UPX");
			if (calls.length === 1) return { stdout: tool, stderr: "" };
			if (args[0] === "-t") return { stdout: "[OK]", stderr: "" };
			await writeFile(args[2], "decompressed");
			return { stdout: "Unpacked 1 file", stderr: "" };
		};
		const result = await decompressUpx({ cwd: inputRoot, path, outputCwd: outputRoot }, undefined, runner);
		expect(result.status).toBe("decompressed");
		expect(calls[1]).toEqual({ file: tool, args: ["-t", path] });
		expect(calls[2]).toEqual({ file: tool, args: ["-d", "-o", result.outputPath, path] });
		expect(calls.every((call) => call.file !== path)).toBe(true);
		expect(await readFile(path, "utf8")).toBe("compressed");
		expect(await readFile(result.outputPath!, "utf8")).toBe("decompressed");
		expect(dirname(result.outputPath!)).not.toBe(inputRoot);
	});

	it("does not decompress when -t rejects the sample", async () => {
		const root = await workspace();
		const inputRoot = join(root, "input");
		const outputRoot = join(root, "output");
		await Promise.all([mkdir(inputRoot), mkdir(outputRoot)]);
		const path = join(inputRoot, "sample.exe");
		const tool = join(root, process.platform === "win32" ? "upx.exe" : "upx");
		await writeFile(path, "not upx");
		await writeFile(tool, "fake runner only");
		let count = 0;
		const runner: UpxRunner = async () => {
			if (++count === 1) return { stdout: tool, stderr: "" };
			throw new Error("NotPackedException");
		};
		const result = await decompressUpx({ cwd: inputRoot, path, outputCwd: outputRoot }, undefined, runner);
		expect(result.status).toBe("unsupported");
		expect(count).toBe(2);
		expect(await readdir(outputRoot)).toEqual([]);
	});
});
