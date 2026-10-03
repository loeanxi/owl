import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { assertInside, isRecord, OfficeRuntimeError, requiredString } from "./runtime-paths.ts";

interface ResourceCache {
	readonly location: string;
	read(handle: string): Promise<string | undefined>;
	write(handle: string, svg: string): Promise<void>;
	clear(): Promise<{ path: string; resourceCount: number; byteCount: number }>;
}

interface ResourceOutput {
	write(destination: string, filename: string, svg: string): Promise<string>;
}

interface ResourceLibrary {
	listRegistries(): readonly Record<string, unknown>[];
	find(input: { queries: readonly string[]; registries?: readonly string[]; limit?: number }): unknown;
	read(input: { handle: string }): Promise<{ handle: string; svg: string }>;
	export(input: { handles: readonly string[]; destination: string }): Promise<{
		exported: readonly { handle: string; path: string }[];
		failed: readonly { handle: string; code: string; message: string }[];
	}>;
}

/** Mirrors the installed 1.0.2 declaration file without adding SDK dependencies to Owl. */
interface ResourceSdk {
	createResourceLibrary(options: {
		manifest: unknown;
		cache: ResourceCache;
		downloader: { download(url: string): Promise<string> };
		output: ResourceOutput;
	}): ResourceLibrary;
	FilesystemResourceCache: new (root: string) => ResourceCache;
	HttpsResourceDownloader: new (options: { fetch: typeof fetch; timeoutMs: number }) => {
		download(url: string): Promise<string>;
	};
	loadResourceManifestFromPath(path: string): unknown;
	isResourceLibraryError(error: unknown): error is Error & { code: string };
}

export interface ResourceOfficeOptions {
	assetRoot: string;
	cacheRoot: string;
	/** Allows the host or tests to provide a transport; catalog handles still choose every URL. */
	fetch?: typeof fetch;
}

const manifests = new Map<string, unknown>();

function strings(value: unknown, label: string, allowEmpty = false): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 50) {
		throw new OfficeRuntimeError("INVALID_ARGUMENT", `${label} must be an array of ${allowEmpty ? "0" : "1"} to 50 strings.`);
	}
	return value.map((entry) => requiredString(entry, label));
}

async function noLinks(path: string, signal: AbortSignal): Promise<void> {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	let cursor = root;
	for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
		signal.throwIfAborted();
		cursor = join(cursor, segment);
		try {
			if ((await lstat(cursor)).isSymbolicLink()) {
				throw new OfficeRuntimeError("RESOURCE_SYMLINK_DENIED", "Resource paths must not contain symbolic links or junctions.");
			}
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return;
			throw error;
		}
	}
}

function safeCachePath(root: string, handle: string): string {
	const parts = handle.split("/");
	if (
		parts.length !== 2 ||
		parts.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")
	) {
		throw new OfficeRuntimeError("RESOURCE_INVALID_HANDLE", "Use a registry/resource handle returned by resources find.");
	}
	return join(root, parts[0], `${parts[1]}.svg`);
}

function loadSdk(assetRoot: string): { sdk: ResourceSdk; manifest: unknown } {
	if (!isAbsolute(requiredString(assetRoot, "assetRoot"))) {
		throw new OfficeRuntimeError("INVALID_ARGUMENT", "assetRoot must be an absolute runtime package path.");
	}
	try {
		const require = createRequire(join(assetRoot, "package.json"));
		const entry = require.resolve("@univer-cli/resource-library");
		const manifestPath = require.resolve("@univerjs-pro/cli-assets/manifest.json");
		assertInside(dirname(assetRoot), entry);
		assertInside(dirname(assetRoot), manifestPath);
		const loaded: unknown = require(entry);
		if (
			!isRecord(loaded) ||
			!["createResourceLibrary", "FilesystemResourceCache", "HttpsResourceDownloader", "loadResourceManifestFromPath", "isResourceLibraryError"].every(
				(key) => typeof loaded[key] === "function",
			)
		) {
			throw new Error("The installed resource SDK has an incompatible interface.");
		}
		const sdk = loaded as unknown as ResourceSdk;
		if (!manifests.has(manifestPath)) manifests.set(manifestPath, sdk.loadResourceManifestFromPath(manifestPath));
		return { sdk, manifest: manifests.get(manifestPath) };
	} catch (error) {
		throw new OfficeRuntimeError(
			"RESOURCE_RUNTIME_MISSING",
			`The isolated Univer resource SDK or asset catalog is missing or invalid. Run scripts/install-runtime.mjs. ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function createDestination(cwd: string, input: string, signal: AbortSignal): Promise<{ root: string; path: string }> {
	const root = await realpath(requiredString(cwd, "cwd"));
	const path = resolve(root, requiredString(input, "output"));
	assertInside(root, path);
	if (root === path) throw new OfficeRuntimeError("OUTPUT_EXISTS", "Choose a new directory beneath the workspace for exported resources.");
	await noLinks(path, signal);
	try {
		await lstat(path);
		throw new OfficeRuntimeError("OUTPUT_EXISTS", "The resource export directory already exists. Choose a new directory.");
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
	}
	let cursor = root;
	const segments = relative(root, path).split(sep);
	for (let index = 0; index < segments.length; index++) {
		signal.throwIfAborted();
		cursor = join(cursor, segments[index]);
		try {
			await mkdir(cursor);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST" || index === segments.length - 1) throw error;
			const info = await lstat(cursor);
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw new OfficeRuntimeError("RESOURCE_SYMLINK_DENIED", "Resource output ancestors must be ordinary directories.");
			}
		}
		await noLinks(cursor, signal);
		assertInside(root, await realpath(cursor));
	}
	return { root, path: await realpath(path) };
}

function result(value: unknown, outputs: string[] = []): Record<string, unknown> {
	const safe: unknown = JSON.parse(JSON.stringify(value));
	if (!isRecord(safe)) throw new OfficeRuntimeError("RESOURCE_INVALID_RESPONSE", "Resource SDK returned an invalid object.");
	return { result: safe, outputs };
}

/** Catalog lookup plus cancellable HTTPS retrieval and exclusive, workspace-confined exports. */
export async function resourceOfficeOperation(
	args: Record<string, unknown>,
	cwd: string,
	options: ResourceOfficeOptions,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	signal?.throwIfAborted();
	const action = requiredString(args.action, "action");
	if (!["registries", "find", "read", "export"].includes(action)) {
		throw new OfficeRuntimeError("INVALID_ARGUMENT", "Resource action must be registries, find, read, or export.");
	}
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new OfficeRuntimeError("RESOURCE_OPERATION_TIMEOUT", "Resource operation exceeded 120000 ms.")), 120_000);
	const operationSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	let sdk: ResourceSdk | undefined;
	try {
		operationSignal.throwIfAborted();
		const loaded = loadSdk(options.assetRoot);
		sdk = loaded.sdk;
		const cacheRoot = requiredString(options.cacheRoot, "cacheRoot");
		if (!isAbsolute(cacheRoot) || dirname(resolve(cacheRoot)) === resolve(cacheRoot)) {
			throw new OfficeRuntimeError("INVALID_ARGUMENT", "cacheRoot must be an absolute, dedicated cache directory.");
		}
		await noLinks(cacheRoot, operationSignal);
		const cache = new sdk.FilesystemResourceCache(cacheRoot);
		let destination: { root: string; path: string } | undefined;
		const fetchImpl: typeof fetch = (input, init) => {
			operationSignal.throwIfAborted();
			return (options.fetch ?? fetch)(input, {
				...init,
				signal: init?.signal ? AbortSignal.any([operationSignal, init.signal]) : operationSignal,
			});
		};
		const library = sdk.createResourceLibrary({
			manifest: loaded.manifest,
			cache: {
				location: cache.location,
				read: async (handle) => {
					operationSignal.throwIfAborted();
					await noLinks(safeCachePath(cacheRoot, handle), operationSignal);
					const svg = await cache.read(handle);
					operationSignal.throwIfAborted();
					return svg;
				},
				write: async (handle, svg) => {
					operationSignal.throwIfAborted();
					await noLinks(safeCachePath(cacheRoot, handle), operationSignal);
					await cache.write(handle, svg);
					await noLinks(safeCachePath(cacheRoot, handle), operationSignal);
				},
				clear: () => { throw new OfficeRuntimeError("INVALID_ARGUMENT", "Resource cache clearing is not exposed as an agent operation."); },
			},
			downloader: new sdk.HttpsResourceDownloader({ fetch: fetchImpl, timeoutMs: 15_000 }),
			output: {
				write: async (directory, filename, svg) => {
					operationSignal.throwIfAborted();
					if (!destination || directory !== destination.path) {
						throw new OfficeRuntimeError("WORKSPACE_DENIED", "Resource exports require the authorized destination directory.");
					}
					if (basename(filename) !== filename || /[\\/:\u0000-\u001f]/u.test(filename) || filename === "." || filename === "..") {
						throw new OfficeRuntimeError("WORKSPACE_DENIED", "The resource SDK returned an unsafe filename.");
					}
					const path = join(directory, filename);
					assertInside(destination.root, path);
					await noLinks(path, operationSignal);
					assertInside(destination.root, await realpath(directory));
					await writeFile(path, svg, { encoding: "utf8", flag: "wx", signal: operationSignal });
					await noLinks(path, operationSignal);
					const canonical = await realpath(path);
					assertInside(destination.root, canonical);
					assertInside(destination.path, canonical);
					return canonical;
				},
			},
		});
		if (action === "registries") return result({ registries: library.listRegistries() });
		if (action === "find") {
			const queries = strings(args.queries, "queries");
			const registries = args.registries === undefined ? undefined : strings(args.registries, "registries", true);
			const limit = args.limit ?? 20;
			if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
				throw new OfficeRuntimeError("INVALID_ARGUMENT", "limit must be an integer between 1 and 50.");
			}
			const found = library.find({ queries, ...(registries === undefined ? {} : { registries }), limit });
			operationSignal.throwIfAborted();
			return result(found);
		}
		if (action === "read") {
			const read = await library.read({ handle: requiredString(args.handle, "handle") });
			operationSignal.throwIfAborted();
			return result(read);
		}
		const handles = strings(args.handles, "handles");
		if (new Set(handles).size !== handles.length) throw new OfficeRuntimeError("INVALID_ARGUMENT", "handles must not contain duplicates.");
		destination = await createDestination(cwd, requiredString(args.output, "output"), operationSignal);
		const exported = await library.export({ handles, destination: destination.path });
		operationSignal.throwIfAborted();
		const verified = [];
		for (const item of exported.exported) {
			await noLinks(item.path, operationSignal);
			const canonical = await realpath(item.path);
			assertInside(destination.root, canonical);
			assertInside(destination.path, canonical);
			verified.push({ handle: item.handle, path: canonical });
		}
		return result({ exported: verified, failed: exported.failed }, verified.map((item) => item.path));
	} catch (error) {
		operationSignal.throwIfAborted();
		if (error instanceof OfficeRuntimeError) throw error;
		if (sdk?.isResourceLibraryError(error)) {
			throw new OfficeRuntimeError(error.code.toUpperCase().replaceAll("-", "_"), error.message);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
