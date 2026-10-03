import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, link, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { authorizePath, fileKey, isRecord, kindType, OfficeRuntimeError, optionalString, requiredString, unitKind } from "./runtime-paths.ts";
import { OfficeProcesses, processEnvironment, stopProcess, type ProcessOptions } from "./runtime-process.ts";
import { OfficeViewerProxy } from "./runtime-proxy.ts";

export interface OfficeRuntimeOptions extends ProcessOptions {}
interface Assets { root: string; gateway: string; worker: string; viewer: string; }
interface ApiReference { find(input: Record<string, unknown>): unknown; show(queries: string[]): unknown; }

export class OfficeRuntime {
	private readonly options: OfficeRuntimeOptions;
	private readonly processes: OfficeProcesses;
	private readonly lifetime = new AbortController();
	private assetsPromise: Promise<Assets> | undefined;
	private startup: Promise<string> | undefined;
	private gateway: string | undefined;
	private gatewayChild: ChildProcess | undefined;
	private viewer: OfficeViewerProxy | undefined;
	private readonly fileLocks = new Map<string, Promise<unknown>>();
	private disposed = false;

	constructor(options: OfficeRuntimeOptions) {
		this.options = options;
		this.processes = new OfficeProcesses(options);
	}

	/** Trusted rendering adapters only; never include the private Gateway URL in tool results. */
	get gatewayOrigin(): string | undefined { return this.gateway; }

	async getLicense(): Promise<string> {
		if (this.options.license?.trim()) return this.options.license.trim();
		const assets = await this.assets();
		const code = await readFile(assets.worker, "utf8");
		const match = /(["'])(\d{10,}-\d+-[A-Za-z0-9+/=]+-[A-Za-z0-9+/=]+-\d{8,})\1/.exec(code);
		if (!match?.[2]) throw new OfficeRuntimeError("LICENSE_UNAVAILABLE", "Supply UNIVER_LICENSE for this Office runtime.");
		return match[2];
	}

	private async assets(): Promise<Assets> {
		this.assetsPromise ??= (async () => {
			let root: string;
			try { root = await realpath(this.options.assetRoot); }
			catch { throw new OfficeRuntimeError("RUNTIME_NOT_INSTALLED", "Office runtime is not installed. Run the Owl Office setup command first."); }
			const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
			if (!isRecord(manifest) || manifest.name !== "dsh-univer-office" || manifest.version !== "0.3.6") {
				throw new OfficeRuntimeError("RUNTIME_VERSION_MISMATCH", "The Office runtime must be dsh-univer-office@0.3.6.");
			}
			const result = { root, gateway: join(root, "artifacts", "gateway.cjs"), worker: join(root, "artifacts", "unit-content-worker.mjs"), viewer: join(root, "artifacts", "viewer") };
			for (const file of [result.gateway, result.worker, join(result.viewer, "index.html")]) {
				if (!(await stat(file)).isFile()) throw new OfficeRuntimeError("RUNTIME_ASSET_MISSING", "The installed Office runtime is incomplete.");
			}
			return result;
		})();
		try { return await this.assetsPromise; }
		catch (error) { this.assetsPromise = undefined; throw error; }
	}

	private async ensureGateway(): Promise<string> {
		if (this.disposed) throw new OfficeRuntimeError("RUNTIME_DISPOSED", "Office runtime is closed.");
		if (this.gateway) return this.gateway;
		if (this.startup) return this.startup;
		const starting = (async () => {
			const assets = await this.assets();
			this.lifetime.signal.throwIfAborted();
			const env = processEnvironment(this.options);
			env.UNIVER_COLLAB_GATEWAY_PORT = "0";
			env.UNIVER_VIEW_ASSETS_ROOT = assets.viewer;
			const child = this.processes.start(assets.gateway, env);
			this.gatewayChild = child;
			child.stdin?.end();
			child.stderr?.on("data", () => undefined);
			const origin = await new Promise<string>((resolve, reject) => {
				const lifetime = this.lifetime.signal;
				let output = "";
				const timeout = setTimeout(() => settle(new OfficeRuntimeError("GATEWAY_START_TIMEOUT", "Office Gateway did not start in time.")), 30_000);
				const aborted = () => settle(new OfficeRuntimeError("RUNTIME_DISPOSED", "Office runtime is closed."));
				const exited = () => settle(new OfficeRuntimeError("GATEWAY_START_FAILED", "Office Gateway failed to start. Verify its platform dependencies."));
				const errored = () => settle(new OfficeRuntimeError("GATEWAY_START_FAILED", "Office Gateway process could not be launched."));
				let settled = false;
				function settle(error?: Error, value?: string): void {
					if (settled) return;
					settled = true; clearTimeout(timeout);
					lifetime.removeEventListener("abort", aborted);
					child.removeListener("close", exited); child.removeListener("error", errored);
					if (error) reject(error); else resolve(value ?? "");
				}
				this.lifetime.signal.addEventListener("abort", aborted, { once: true });
				child.once("close", exited); child.once("error", errored);
				child.stdout?.on("data", (chunk: Buffer) => {
					output = (output + chunk.toString("utf8")).slice(-4_000);
					const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
					if (match?.[1] && Number(match[1]) > 0) settle(undefined, `http://127.0.0.1:${match[1]}`);
				});
				if (this.lifetime.signal.aborted) aborted();
			});
			this.lifetime.signal.throwIfAborted();
			const health = await fetch(`${origin}/`, { signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5_000)]) });
			const html = await health.text();
			if (!health.ok || !html.includes("<title>Univer</title>")) throw new OfficeRuntimeError("GATEWAY_HEALTH_FAILED", "Office Gateway returned an unexpected health response.");
			child.once("close", () => {
				if (this.gatewayChild === child) { this.gateway = undefined; this.gatewayChild = undefined; }
			});
			this.gateway = origin;
			return origin;
		})();
		this.startup = starting;
		try { return await starting; }
		catch (error) {
			if (this.gatewayChild) await stopProcess(this.gatewayChild);
			this.gatewayChild = undefined; this.gateway = undefined;
			throw error;
		} finally { if (this.startup === starting) this.startup = undefined; }
	}

	private async request(path: string, signal: AbortSignal, method = "GET", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
		signal.throwIfAborted();
		const origin = await this.ensureGateway();
		signal.throwIfAborted();
		const response = await fetch(`${origin}${path}`, { method, signal,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
		const value: unknown = await response.json();
		if (!isRecord(value)) throw new OfficeRuntimeError("GATEWAY_INVALID_RESPONSE", "Office Gateway returned an invalid response.");
		if (!response.ok || value.ok === false || (isRecord(value.error) && value.error.code !== 1)) {
			throw new OfficeRuntimeError(value.conflict === true ? "WORKTREE_CONFLICT" : "GATEWAY_REQUEST_FAILED",
				isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : "Office Gateway rejected the operation.");
		}
		return value;
	}

	private async worktrees(file: string, signal: AbortSignal): Promise<Record<string, unknown>[]> {
		const response = await this.request(`/uf/${fileKey(file)}/worktrees`, signal);
		if (!Array.isArray(response.worktrees) || !response.worktrees.every(isRecord)) {
			throw new OfficeRuntimeError("GATEWAY_INVALID_RESPONSE", "Office Gateway returned invalid worktrees.");
		}
		return response.worktrees;
	}

	private async requireWorktree(file: string, id: string, signal: AbortSignal, draft = false): Promise<void> {
		const tree = (await this.worktrees(file, signal)).find((entry) => entry.worktreeId === id);
		if (!tree) throw new OfficeRuntimeError("WORKTREE_NOT_FOUND", "Worktree does not belong to this Office file.");
		if (draft && tree.status !== "draft") throw new OfficeRuntimeError("WORKTREE_NOT_WRITABLE", "Reopen the worktree before changing its content.");
	}

	private async target(file: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
		const id = requiredString(args.unitId, "unitId");
		const tree = optionalString(args.worktreeId, "worktreeId");
		if (tree) await this.requireWorktree(file, tree, signal);
		const response = await this.request(`/uf/${fileKey(file)}${tree ? `/worktrees/${encodeURIComponent(tree)}` : ""}/units`, signal);
		if (!Array.isArray(response.units)) throw new OfficeRuntimeError("GATEWAY_INVALID_RESPONSE", "Office Gateway returned invalid Units.");
		const unit = response.units.find((entry) => isRecord(entry) && entry.unitId === id);
		if (!isRecord(unit)) throw new OfficeRuntimeError("UNIT_NOT_FOUND", "Unit does not belong to the selected Office scope.");
		unitKind(unit.type);
		return { gatewayOrigin: await this.ensureGateway(), commitTimeoutMs: 30_000, fileKey: fileKey(file), filePath: file, unitId: id, unitType: unit.type, ...(tree ? { worktreeId: tree } : {}) };
	}

	async call(operation: string, args: Record<string, unknown>, cwd: string, inputSignal?: AbortSignal): Promise<Record<string, unknown>> {
		const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(180_000), ...(inputSignal ? [inputSignal] : [])]);
		signal.throwIfAborted();
		if (operation === "api") return this.api(args);
		const supported = ["new", "status", "worktree", "unit", "import", "inspect", "execute", "export", "render-source"];
		if (!supported.includes(operation)) throw new OfficeRuntimeError("UNSUPPORTED_OPERATION", `Office runtime does not implement ${operation}.`);
		const file = await authorizePath(cwd, requiredString(args.file, "file"), operation === "new" ? "new" : "existing");
		if (extname(file).toLowerCase() !== ".univer") throw new OfficeRuntimeError("INVALID_FILE", "Office content operations require a .univer file.");
		const prefix = `/uf/${fileKey(file)}`;
		let result: Record<string, unknown>;
		if (operation === "new") {
			// Serialize our own creators; the Gateway also rejects an existing file.
			const prior = this.fileLocks.get(file) ?? Promise.resolve();
			const creation = prior.then(async () => {
				await authorizePath(cwd, file, "new");
				return this.request(prefix, signal, "POST", {});
			});
			this.fileLocks.set(file, creation);
			try { result = await creation; }
			finally { if (this.fileLocks.get(file) === creation) this.fileLocks.delete(file); }
		} else if (operation === "status") {
			const [trunk, worktrees] = await Promise.all([this.request(`${prefix}/units`, signal), this.worktrees(file, signal)]);
			result = { trunk: { units: trunk.units }, worktrees };
		} else if (operation === "worktree") {
			const action = requiredString(args.action, "action");
			if (action === "create") result = await this.request(`${prefix}/worktrees`, signal, "POST", { agentId: "owl-agent", name: optionalString(args.name, "name") ?? "Owl draft" });
			else {
				if (!["ready", "reopen", "merge", "discard"].includes(action)) throw new OfficeRuntimeError("INVALID_ACTION", "Unknown worktree action.");
				if ((action === "merge" || action === "discard") && args.userConfirmed !== true) throw new OfficeRuntimeError("USER_CONFIRMATION_REQUIRED", "Confirm this Office action in Owl first.");
				const id = requiredString(args.worktreeId, "worktreeId");
				await this.requireWorktree(file, id, signal);
				result = { ...(await this.request(`${prefix}/worktrees/${encodeURIComponent(id)}/${action}`, signal, "POST", {})), worktreeId: id };
			}
		} else if (operation === "unit" || operation === "import") {
			const id = requiredString(args.worktreeId, "worktreeId");
			await this.requireWorktree(file, id, signal, true);
			const treePath = `${prefix}/worktrees/${encodeURIComponent(id)}`;
			if (operation === "unit" && args.action === "remove") {
				const unitId = requiredString(args.unitId, "unitId");
				await this.target(file, args, signal);
				result = await this.request(`${treePath}/units/${encodeURIComponent(unitId)}/remove`, signal, "POST", {});
			} else if (operation === "unit" && args.action !== "create") throw new OfficeRuntimeError("INVALID_ACTION", "Unknown Unit action.");
			else {
				let snapshot: unknown;
				let type = operation === "unit" ? kindType(args.kind) : 0;
				if (operation === "import") {
					const source = await authorizePath(cwd, requiredString(args.source, "source"), "existing");
					const extension = extname(source).toLowerCase();
					type = [".xlsx", ".csv", ".tsv"].includes(extension) ? 2 : extension === ".docx" ? 1 : extension === ".pptx" ? 3 : 0;
					if (!type) throw new OfficeRuntimeError("IMPORT_FORMAT_UNSUPPORTED", "Import requires xlsx/csv/tsv/docx/pptx.");
					if (args.docType !== undefined && (type !== 1 || !["traditional", "modern"].includes(String(args.docType)))) throw new OfficeRuntimeError("INVALID_ARGUMENT", "docType only supports traditional/modern DOCX imports.");
					const assets = await this.assets();
					snapshot = await this.processes.worker(assets.worker, { operation: "import", sourcePath: source, unitType: type, ...(args.docType === undefined ? {} : { docType: args.docType }) }, signal);
				}
				result = await this.request(`${treePath}/units`, signal, "POST", { type, name: requiredString(args.name, "name"), ...(snapshot === undefined ? {} : { snapshot }) });
			}
		} else {
			if (operation === "execute") {
				const tree = requiredString(args.worktreeId, "worktreeId");
				await this.requireWorktree(file, tree, signal, true);
			}
			const target = await this.target(file, args, signal);
			const assets = await this.assets();
			let request: Record<string, unknown> = { ...target, operation };
			if (operation === "execute") {
				if ((args.code === undefined) === (args.codeFile === undefined)) throw new OfficeRuntimeError("INVALID_EXECUTION_SOURCE", "Provide exactly one of code or codeFile.");
				const code = args.code === undefined ? await readFile(await authorizePath(cwd, requiredString(args.codeFile, "codeFile"), "existing"), "utf8") : requiredString(args.code, "code");
				request = { ...request, code };
			}
			if (operation === "inspect") request = { ...request, query: inspectionQuery(target.unitType, args) };
			if (operation === "export") {
				const output = await authorizePath(cwd, requiredString(args.output, "output"), "new");
				await mkdir(dirname(output), { recursive: true });
				await authorizePath(cwd, output, "new");
				const temporary = join(dirname(output), `.owl-office-${randomUUID()}${extname(output)}`);
				try {
					const value = await this.processes.worker(assets.worker, { ...request, outputPath: temporary }, signal);
					signal.throwIfAborted();
					await authorizePath(cwd, output, "new");
					await authorizePath(cwd, temporary, "existing");
					await link(temporary, output); // Atomic no-clobber publication, unlike rename on Unix.
					result = { ...(isRecord(value) ? value : { value }), outputPath: output };
				} finally { await rm(temporary, { force: true }); }
			} else {
				const value = await this.processes.worker(assets.worker, request, signal);
				if (operation === "render-source") {
					if (!isRecord(value) || typeof value.unitType !== "string" || !isRecord(value.unitData)) throw new OfficeRuntimeError("WORKER_INVALID_RESPONSE", "Office worker returned invalid render content.");
					return value;
				}
				result = isRecord(value) ? value : { value };
			}
		}
		signal.throwIfAborted();
		return { ok: true, operation, file, result, ...(typeof result.worktreeId === "string" ? { worktreeId: result.worktreeId } : {}), ...(typeof result.unitId === "string" ? { unitId: result.unitId } : {}) };
	}

	private async api(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!Array.isArray(args.queries) || args.queries.length === 0 || args.queries.some((value) => typeof value !== "string" || !value.trim())) throw new OfficeRuntimeError("INVALID_ARGUMENT", "queries must contain non-empty strings.");
		const queries = args.queries.filter((value): value is string => typeof value === "string");
		const assets = await this.assets();
		const require = createRequire(join(assets.root, "package.json"));
		const module: unknown = require("@univer-cli/api-reference");
		if (!isRecord(module) || typeof module.createStandardApiReference !== "function") throw new OfficeRuntimeError("API_REFERENCE_UNAVAILABLE", "The version-matched API reference is not installed.");
		const reference = module.createStandardApiReference() as ApiReference;
		let result: unknown;
		if (args.action === "show") result = reference.show(queries);
		else if (args.action === "find") {
			if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50)) throw new OfficeRuntimeError("INVALID_ARGUMENT", "limit must be between 1 and 50.");
			if (args.unit !== undefined) kindType(args.unit);
			result = reference.find({ terms: queries, ...(args.unit === undefined ? {} : { unit: args.unit }), ...(args.limit === undefined ? {} : { limit: args.limit }) });
		} else throw new OfficeRuntimeError("INVALID_ACTION", "API action must be find or show.");
		return { ok: true, operation: "api", result };
	}

	async open(input: { cwd: string; path: string; signal?: AbortSignal }): Promise<{ url: string; title?: string }> {
		const signal = AbortSignal.any([this.lifetime.signal, ...(input.signal ? [input.signal] : [])]);
		signal.throwIfAborted();
		let file = await authorizePath(input.cwd, input.path, "existing");
		if (extname(file).toLowerCase() !== ".univer") {
			if (![".xlsx", ".docx", ".pptx"].includes(extname(file).toLowerCase())) throw new OfficeRuntimeError("VIEWER_FORMAT_UNSUPPORTED", "Office viewer supports univer/xlsx/docx/pptx.");
			const source = file;
			const root = await realpath(input.cwd);
			file = await authorizePath(root, join(".owl", "office", `import-${randomUUID()}.univer`), "new");
			await this.call("new", { file }, root, signal);
			const tree = await this.call("worktree", { file, action: "create", name: "Imported original" }, root, signal);
			const worktreeId = requiredString(tree.worktreeId, "worktreeId");
			await this.call("import", { file, worktreeId, source, name: basename(source, extname(source)) }, root, signal);
			// This imports the file the user just opened into a new container; it never publishes an AI draft.
			await this.call("worktree", { file, worktreeId, action: "ready" }, root, signal);
			await this.call("worktree", { file, worktreeId, action: "merge", userConfirmed: true }, root, signal);
		}
		await this.ensureGateway();
		if (!this.viewer) {
			const assets = await this.assets();
			this.viewer = new OfficeViewerProxy({ viewerRoot: assets.viewer, ...(this.options.license ? { license: this.options.license } : {}), gatewayOrigin: () => this.ensureGateway(),
				validate: async (path, cwd, id) => {
					if (await authorizePath(cwd, path, "existing") !== path) throw new OfficeRuntimeError("WORKSPACE_DENIED", "Office file identity changed.");
					if (id !== undefined) await this.requireWorktree(path, requiredString(id, "worktreeId"), this.lifetime.signal);
				},
			});
		}
		signal.throwIfAborted();
		return { url: await this.viewer.open(file, await realpath(input.cwd)), title: basename(input.path) };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.lifetime.abort(new OfficeRuntimeError("RUNTIME_DISPOSED", "Office runtime is closed."));
		await this.viewer?.dispose();
		await this.processes.dispose();
		await this.startup?.catch(() => undefined);
		this.gateway = undefined; this.gatewayChild = undefined;
	}
}

function inspectionQuery(type: unknown, args: Record<string, unknown>): Record<string, unknown> {
	if (args.range !== undefined && args.elementIds !== undefined) throw new OfficeRuntimeError("INVALID_ARGUMENT", "Provide range or elementIds, not both.");
	if (args.range !== undefined) {
		if (type !== 2) throw new OfficeRuntimeError("INVALID_ARGUMENT", "range requires a Sheet Unit.");
		const range = requiredString(args.range, "range");
		const split = range.lastIndexOf("!");
		const name = range.slice(0, split).replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
		return { kind: "worksheet-range", ranges: [{ range: split < 0 ? range : range.slice(split + 1), worksheet: split < 0 ? { index: 0 } : { name } }] };
	}
	if (args.elementIds !== undefined) {
		if (type !== 6 || !Array.isArray(args.elementIds) || args.elementIds.length === 0) throw new OfficeRuntimeError("INVALID_ARGUMENT", "elementIds requires Board element IDs.");
		return { kind: "board-element", elements: args.elementIds.map((id) => ({ id: requiredString(id, "elementId") })) };
	}
	return { kind: type === 2 ? "workbook" : type === 1 ? "document" : type === 3 ? "presentation" : unitKind(type) };
}
