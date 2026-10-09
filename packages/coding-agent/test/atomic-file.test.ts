import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	atomicWriteFileSync,
	backupCorruptFile,
	findCorruptFiles,
	withFileLockSync,
} from "../src/utils/atomic-file.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "owl-atomic-"));
	roots.push(root);
	return root;
}

describe("atomicWriteFileSync", () => {
	it("creates parent directories and leaves no temp files behind", () => {
		const root = makeRoot();
		const path = join(root, "nested", "state.json");
		atomicWriteFileSync(path, '{"a":1}');
		atomicWriteFileSync(path, '{"a":2}');
		expect(readFileSync(path, "utf-8")).toBe('{"a":2}');
		expect(readdirSync(join(root, "nested"))).toEqual(["state.json"]);
	});

	it("writes binary data as-is", () => {
		const path = join(makeRoot(), "blob.bin");
		atomicWriteFileSync(path, new Uint8Array([0, 255, 10, 13]));
		expect([...readFileSync(path)]).toEqual([0, 255, 10, 13]);
	});

	it.skipIf(process.platform === "win32")(
		"keeps the mode of an existing file and applies the create mode to new files",
		() => {
			const root = makeRoot();
			const fresh = join(root, "fresh.json");
			atomicWriteFileSync(fresh, "{}", { mode: 0o600 });
			expect(statSync(fresh).mode & 0o777).toBe(0o600);

			const existing = join(root, "existing.json");
			writeFileSync(existing, "{}");
			chmodSync(existing, 0o640);
			atomicWriteFileSync(existing, '{"b":1}', { mode: 0o600 });
			expect(statSync(existing).mode & 0o777).toBe(0o640);
		},
	);

	it("cleans up the temp file when the rename target is a directory", () => {
		const root = makeRoot();
		const path = join(root, "taken");
		mkdirSync(path);
		writeFileSync(join(path, "child"), "x");
		expect(() => atomicWriteFileSync(path, "data")).toThrow();
		expect(readdirSync(root)).toEqual(["taken"]);
	});
});

describe("withFileLockSync", () => {
	it("serializes read-modify-write and releases the lock afterwards", () => {
		const path = join(makeRoot(), "counter.json");
		writeFileSync(path, "0");
		for (let i = 0; i < 5; i++) {
			withFileLockSync(path, () => atomicWriteFileSync(path, String(Number(readFileSync(path, "utf-8")) + 1)));
		}
		expect(readFileSync(path, "utf-8")).toBe("5");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("times out instead of writing without the lock when another holder keeps it", () => {
		const path = join(makeRoot(), "busy.json");
		withFileLockSync(path, () => {
			expect(() => withFileLockSync(path, () => "never", 100)).toThrow();
		});
	});

	it("releases the lock when the callback throws", () => {
		const path = join(makeRoot(), "throws.json");
		expect(() =>
			withFileLockSync(path, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(withFileLockSync(path, () => "ok")).toBe("ok");
	});
});

describe("backupCorruptFile / findCorruptFiles", () => {
	it("keeps every generation of corrupt backups and reports them newest first", async () => {
		const root = makeRoot();
		const path = join(root, "career-stats.json");
		writeFileSync(path, "{broken");
		expect(backupCorruptFile(path)).toBe(`${path}.corrupt`);
		writeFileSync(path, "{broken again");
		expect(backupCorruptFile(path)).toBe(`${path}.corrupt.0`);
		expect(existsSync(path)).toBe(false);
		expect(backupCorruptFile(path)).toBeUndefined();

		mkdirSync(join(root, "Owl-history"));
		writeFileSync(join(root, "Owl-history", "skipped.json.corrupt"), "x");
		const found = await findCorruptFiles(root);
		expect(found.map((file) => file.path).sort()).toEqual([`${path}.corrupt`, `${path}.corrupt.0`]);
	});
});
