import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { isRecord, OfficeRuntimeError } from "./runtime-paths.ts";

export interface ProcessOptions {
	assetRoot: string;
	nodeExecutable?: string;
	license?: string;
	browserExecutablePath?: string;
}

/** Resolve binaries from the isolated installation, never from the DSH Host. */
export function processEnvironment(options: ProcessOptions): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	env.NODE_PATH = [join(options.assetRoot, "node_modules"), dirname(options.assetRoot)].join(delimiter);
	env.DO_NOT_TRACK = "1";
	if (options.license !== undefined) env.UNIVER_LICENSE = options.license;
	if (options.browserExecutablePath !== undefined) env.UNIVER_RENDER_BROWSER = options.browserExecutablePath;
	return env;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); })]);
	if (timer !== undefined) clearTimeout(timer);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await closed;
	}
}

export class OfficeProcesses {
	readonly options: ProcessOptions;
	private readonly children = new Set<ChildProcess>();
	private disposed = false;
	constructor(options: ProcessOptions) { this.options = options; }

	start(entry: string, env: NodeJS.ProcessEnv): ChildProcess {
		if (this.disposed) throw new OfficeRuntimeError("RUNTIME_DISPOSED", "Office runtime is closed.");
		const child = spawn(this.options.nodeExecutable ?? process.execPath, [entry], {
			env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.children.add(child);
		child.once("close", () => this.children.delete(child));
		return child;
	}

	async worker(entry: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		const child = this.start(entry, processEnvironment(this.options));
		const chunks: Buffer[] = [];
		let bytes = 0;
		let outputTooLarge = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 64 * 1024 * 1024) { outputTooLarge = true; child.kill(); }
			else chunks.push(chunk);
		});
		// Drain stderr; SDK diagnostics may contain source content and are not model output.
		child.stderr?.on("data", () => undefined);
		const closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", () => resolve());
		});
		const abort = () => { child.kill(); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(JSON.stringify(request));
		try { await closed; signal.throwIfAborted(); }
		finally { signal.removeEventListener("abort", abort); await stopProcess(child); }
		if (outputTooLarge) throw new OfficeRuntimeError("WORKER_OUTPUT_LIMIT", "Office worker output exceeded the limit.");
		let value: unknown;
		try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
		catch { throw new OfficeRuntimeError("WORKER_INVALID_RESPONSE", "Office worker did not return valid JSON."); }
		if (!isRecord(value) || typeof value.ok !== "boolean") {
			throw new OfficeRuntimeError("WORKER_INVALID_RESPONSE", "Office worker returned an invalid response.");
		}
		if (!value.ok) {
			const error = isRecord(value.error) ? value.error : {};
			throw new OfficeRuntimeError(typeof error.code === "string" ? error.code : "WORKER_FAILED",
				typeof error.message === "string" ? error.message : "Office worker failed.");
		}
		return value.result;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await Promise.all([...this.children].map(stopProcess));
		this.children.clear();
	}
}
