import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readEditorFile } from "../src/modes/desktop/editor-files.ts";

it("two real bridge processes cannot both commit the same file revision", async () => {
	const root = mkdtempSync(join(tmpdir(), "owl-editor-process-lock-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	const file = join(cwd, "file.txt");
	writeFileSync(file, "original\n");
	const revision = readEditorFile(cwd, file).revision;
	const source = new URL("../src/modes/desktop/editor-files.ts", import.meta.url).href;
	const script = join(root, "writer.mjs");
	writeFileSync(
		script,
		`
import { existsSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { saveEditorFile } from ${JSON.stringify(source)};
const [root, cwd, file, revision, tag] = process.argv.slice(2);
let checks = 0, held = false;
const result = await saveEditorFile(cwd, file, 'new from ' + tag + '\\n', revision, () => {
  checks++;
  if (checks === 2) writeFileSync(join(root, tag + '.ready'), 'ready');
}, { write(fd, bytes, offset, length, position) {
  if (!held) {
    held = true;
    writeFileSync(join(root, tag + '.inside'), 'inside');
    const deadline = Date.now() + 8000;
    while (!existsSync(join(root, tag + '.release'))) {
      if (Date.now() >= deadline) throw new Error('test release timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return writeSync(fd, bytes, offset, length, position);
} });
process.stdout.write(JSON.stringify(result));
`,
	);
	const children: ChildProcess[] = [];
	function writer(tag: string) {
		const child = spawn(process.execPath, [script, root, cwd, file, revision!, tag], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		let stdout = "",
			stderr = "";
		child.stdout?.on("data", (data) => {
			stdout += String(data);
		});
		child.stderr?.on("data", (data) => {
			stderr += String(data);
		});
		return new Promise<{ status: string }>((done, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				if (code !== 0) reject(new Error(`Child writer ${tag} failed: ${stderr}`));
				else {
					try {
						done(JSON.parse(stdout) as { status: string });
					} catch (error) {
						reject(error);
					}
				}
			});
		});
	}
	async function waitFor(path: string) {
		const deadline = Date.now() + 6000;
		while (!existsSync(path)) {
			if (Date.now() >= deadline) throw new Error(`Fixture marker not found: ${path}`);
			await new Promise<void>((done) => setTimeout(done, 10));
		}
	}
	const one = writer("A");
	void one.catch(() => {});
	let two: Promise<{ status: string }> | undefined;
	try {
		await waitFor(join(root, "A.inside"));
		two = writer("B");
		void two.catch(() => {});
		await waitFor(join(root, "B.ready"));
		await new Promise<void>((done) => setTimeout(done, 150));
		expect(existsSync(join(root, "B.inside"))).toBe(false);
		writeFileSync(join(root, "A.release"), "release");
		expect((await one).status).toBe("saved");
		expect((await two).status).toBe("conflict");
		expect(readFileSync(file, "utf8")).toBe("new from A\n");
	} finally {
		writeFileSync(join(root, "A.release"), "release");
		writeFileSync(join(root, "B.release"), "release");
		await Promise.allSettled([one, ...(two ? [two] : [])]);
		for (const child of children) if (child.exitCode === null) child.kill();
		rmSync(root, { recursive: true, force: true });
	}
});
