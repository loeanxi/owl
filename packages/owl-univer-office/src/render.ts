import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { OfficeRuntime } from "./runtime.ts";
import {
	assertInside,
	authorizePath,
	fileKey,
	isRecord,
	OfficeRuntimeError,
	optionalString,
	requiredString,
} from "./runtime-paths.ts";

type UnitType = "sheet" | "doc" | "slide" | "base" | "board";
interface Snapshot {
	unitType: UnitType;
	unitData: Record<string, unknown>;
}
interface RenderSource extends Snapshot {
	embeddedUnits?: Snapshot[];
	formulaReferenceUnits?: Snapshot[];
}
interface Machine {
	close(): Promise<void>;
	measureText(input: {
		doc: Record<string, unknown>;
		signal?: AbortSignal;
	}): Promise<{ actualWidth: number; firstLineAscent: number; firstLineDescent: number }>;
}
interface RuntimeSdk {
	createUniverRenderRuntime(options: {
		renderPageRoot: string;
		browserExecutablePath?: string;
		env: NodeJS.ProcessEnv;
		license: string;
		signal: AbortSignal;
	}): Promise<Machine>;
	resolveUniverRenderBrowser(options: {
		env: NodeJS.ProcessEnv;
	}): Promise<{ status: "found"; executablePath: string } | { status: "missing" }>;
}
interface ScreenshotImage {
	bytes: Uint8Array;
	width: number;
	height: number;
	name: string;
	mediaType: "image/png";
	page?: number;
	pageId?: string;
	range?: string;
	sheetName?: string;
	scale?: number;
}
interface ScreenshotSdk {
	createUnitScreenshot(options: { runtime: Machine; limits: { maxPages: number; maxPixels: number } }): {
		capture(
			input: RenderSource & { target?: Record<string, unknown>; signal: AbortSignal },
		): Promise<{ images: ScreenshotImage[]; unitId: string; unitType: UnitType }>;
	};
	resolveUnitScreenshotImageAssets(
		source: RenderSource,
		resolver: {
			resolve(input: { source: string; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; mediaType: string }>;
		},
		signal: AbortSignal,
	): Promise<RenderSource>;
}
interface PdfSdk {
	createUnitPdfPrinter(options: { runtime: Machine; maxPages: number }): {
		print(
			input: RenderSource & { signal: AbortSignal },
		): Promise<{ bytes: Uint8Array; pageCount: number; unitId: string; unitType: UnitType }>;
	};
}
interface LintSdk {
	createUnitLayoutLint(options: { runtime: Machine }): {
		lint(input: RenderSource & { pages?: number[]; signal: AbortSignal }): Promise<Record<string, unknown>>;
	};
}
interface TextRun {
	text: string;
	fontSizePx: number;
	bold: boolean;
	italic: boolean;
	fontFamily?: string;
}
interface SvgSdk {
	compileSvgToFacade(
		svg: string,
		options: {
			assetResolver(href: string): { bytes: Uint8Array };
			textMeasurer: {
				source: string;
				measureLine(input: {
					runs: readonly TextRun[];
				}): Promise<{ width: number; ascent: number; descent: number }>;
			};
		},
	): Promise<{
		code: string;
		lints: string[];
		warnings: string[];
		textMeasure: string;
		viewport: { width: number; height: number };
	}>;
	wrapSlideScript(
		code: string,
		options: { page: number; mode: "replace" | "add"; width: number; height: number },
	): string;
}
export interface OfficeRenderOptions {
	assetRoot: string;
	license?: string;
	browserExecutablePath?: string;
}

const MAX_PAGES = 30;
const MAX_PIXELS = 16_777_216;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const EXTERNAL_REFERENCE_RESOURCE = "UNIVER_EXTERNAL_REFERENCE_PLUGIN";
const EMBED_RESOURCE = "UNIVER_EMBED_RESOURCE_PLUGIN";

function sdkModule<T>(require: NodeRequire, name: string, functions: string[]): T {
	const value: unknown = require(name);
	if (!isRecord(value) || functions.some((name) => typeof value[name] !== "function")) {
		throw new OfficeRuntimeError("RENDER_SDK_UNAVAILABLE", `The installed Office runtime is missing ${name}.`);
	}
	return value as T;
}

function snapshot(value: unknown): Snapshot {
	if (
		!isRecord(value) ||
		!["sheet", "doc", "slide", "base", "board"].includes(String(value.unitType)) ||
		!isRecord(value.unitData)
	) {
		throw new OfficeRuntimeError("INVALID_RENDER_SOURCE", "Office runtime returned an invalid render snapshot.");
	}
	return { unitType: value.unitType as UnitType, unitData: value.unitData };
}

function selectedPages(value: unknown): number[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_PAGES ||
		value.some((page) => typeof page !== "number" || !Number.isSafeInteger(page) || page < 1)
	) {
		throw new OfficeRuntimeError("INVALID_RENDER_PAGES", `pages must contain 1-${MAX_PAGES} positive page numbers.`);
	}
	return [...new Set(value as number[])];
}

/** No browser downloads: use explicit settings, the SDK's existing browser, then Windows Edge. */
async function browserPath(sdk: RuntimeSdk, configured: string | undefined): Promise<string> {
	const explicit = configured?.trim() || process.env.UNIVER_RENDER_BROWSER?.trim();
	if (explicit) {
		if (!existsSync(explicit))
			throw new OfficeRuntimeError("BROWSER_UNAVAILABLE", "Configured Office render browser does not exist.");
		return explicit;
	}
	const found = await sdk.resolveUniverRenderBrowser({ env: process.env });
	if (found.status === "found") return found.executablePath;
	if (process.platform === "win32") {
		const candidates = [
			join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
			join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
			...(process.env.LOCALAPPDATA
				? [join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")]
				: []),
		];
		const edge = candidates.find((path) => existsSync(path));
		if (edge) return edge;
	}
	throw new OfficeRuntimeError(
		"BROWSER_UNAVAILABLE",
		"Office rendering requires an installed Chrome/Chromium/Edge or UNIVER_RENDER_BROWSER.",
	);
}

function resourceDependencies(data: Record<string, unknown>): { formula: string[]; embedded: string[] } {
	const formula: string[] = [];
	const embedded: string[] = [];
	if (!Array.isArray(data.resources)) return { formula, embedded };
	for (const resource of data.resources) {
		if (!isRecord(resource) || ![EXTERNAL_REFERENCE_RESOURCE, EMBED_RESOURCE].includes(String(resource.name)))
			continue;
		let value: unknown;
		try {
			value = JSON.parse(requiredString(resource.data, "resource.data"));
		} catch {
			throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Referenced Office resources contain invalid JSON.");
		}
		if (!isRecord(value))
			throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Referenced Office resources must be objects.");
		if (resource.name === EXTERNAL_REFERENCE_RESOURCE) {
			if (!isRecord(value.references))
				throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Formula references are invalid.");
			for (const reference of Object.values(value.references)) {
				if (!isRecord(reference))
					throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Formula reference is invalid.");
				formula.push(requiredString(reference.sourceUnitId, "sourceUnitId"));
			}
		} else {
			if (!isRecord(value.embeds))
				throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Embedded Unit references are invalid.");
			for (const descriptor of Object.values(value.embeds)) {
				if (!isRecord(descriptor))
					throw new OfficeRuntimeError("INVALID_RENDER_RESOURCE", "Embedded Unit reference is invalid.");
				if (descriptor.lifecycle === "soft-deleted") continue;
				const source = isRecord(descriptor.source) ? descriptor.source : {};
				const ref = source.ref;
				const unit = isRecord(ref) && isRecord(ref.unit) ? ref.unit : {};
				let selected = typeof descriptor.childUnitId === "string" ? descriptor.childUnitId : unit.selector;
				if (typeof selected !== "string" && typeof ref === "string") {
					const match = /(?:^|[#&])unit=([^&]+)/.exec(ref);
					try {
						selected = match?.[1] ? decodeURIComponent(match[1]) : undefined;
					} catch {
						throw new OfficeRuntimeError(
							"INVALID_RENDER_RESOURCE",
							"Embedded Unit selector has invalid encoding.",
						);
					}
				}
				embedded.push(requiredString(selected, "embedded Unit ID"));
			}
		}
	}
	return { formula, embedded };
}

async function renderSource(
	runtime: OfficeRuntime,
	sdk: ScreenshotSdk,
	args: Record<string, unknown>,
	cwd: string,
	signal: AbortSignal,
): Promise<RenderSource> {
	const file = await authorizePath(cwd, requiredString(args.file, "file"), "existing");
	const unitId = requiredString(args.unitId, "unitId");
	const worktreeId = optionalString(args.worktreeId, "worktreeId");
	const scope = { file, ...(worktreeId ? { worktreeId } : {}) };
	const primary = snapshot(await runtime.call("render-source", { ...scope, unitId }, cwd, signal));
	const units = new Map<string, Snapshot>([[unitId, primary]]);
	const formulaIds = new Set<string>();
	const embeddedIds = new Set<string>();
	const pending: string[] = [];
	const discover = (data: Record<string, unknown>): void => {
		const references = resourceDependencies(data);
		for (const id of references.formula) formulaIds.add(id);
		for (const id of references.embedded) embeddedIds.add(id);
		for (const id of [...references.formula, ...references.embedded])
			if (!units.has(id) && !pending.includes(id)) pending.push(id);
	};
	discover(primary.unitData);
	while (pending.length > 0) {
		if (units.size >= MAX_PAGES)
			throw new OfficeRuntimeError("RENDER_REFERENCE_LIMIT", "The render snapshot has too many referenced Units.");
		const id = pending.shift()!;
		const dependency = snapshot(await runtime.call("render-source", { ...scope, unitId: id }, cwd, signal));
		units.set(id, dependency);
		discover(dependency.unitData);
	}
	const formulaReferenceUnits: Snapshot[] = [];
	const embeddedUnits: Snapshot[] = [];
	for (const [id, unit] of units) {
		if (id === unitId) continue;
		if (formulaIds.has(id)) {
			if (unit.unitType !== "sheet" && unit.unitType !== "base")
				throw new OfficeRuntimeError(
					"INVALID_FORMULA_REFERENCE",
					"Formula references must target Sheet or Base Units.",
				);
			formulaReferenceUnits.push(unit);
		} else if (embeddedIds.has(id)) embeddedUnits.push(unit);
	}
	const source = {
		...primary,
		...(formulaReferenceUnits.length ? { formulaReferenceUnits } : {}),
		...(embeddedUnits.length ? { embeddedUnits } : {}),
	};
	const failedAssets: Error[] = [];
	const result = await sdk.resolveUnitScreenshotImageAssets(
		source,
		{
			async resolve(input) {
				try {
					const origin = runtime.gatewayOrigin;
					if (!origin)
						throw new OfficeRuntimeError(
							"RENDER_ASSET_UNAVAILABLE",
							"Office image assets require the active Gateway.",
						);
					const path = `/uf/${fileKey(file)}${worktreeId ? `/worktrees/${encodeURIComponent(worktreeId)}` : ""}/universer-api/file/${encodeURIComponent(input.source)}/content`;
					const response = await fetch(`${origin}${path}`, { signal, redirect: "error" });
					const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
					if (!response.ok || !mediaType?.startsWith("image/"))
						throw new OfficeRuntimeError(
							"RENDER_ASSET_UNAVAILABLE",
							"An Office image asset is unavailable in the selected file scope.",
						);
					const declared = Number(response.headers.get("content-length"));
					if (declared > MAX_IMAGE_BYTES)
						throw new OfficeRuntimeError("RENDER_ASSET_LIMIT", "An Office image asset is too large to render.");
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
						throw new OfficeRuntimeError("RENDER_ASSET_LIMIT", "An Office image asset is empty or too large.");
					return { bytes, mediaType };
				} catch (error) {
					const failure = error instanceof Error ? error : new Error(String(error));
					failedAssets.push(failure);
					throw failure;
				}
			},
		},
		signal,
	);
	if (failedAssets.length > 0) throw failedAssets[0];
	return result;
}

async function publish(cwd: string, output: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
	const path = await authorizePath(cwd, output, "new");
	await mkdir(dirname(path), { recursive: true });
	await authorizePath(cwd, path, "new");
	const temporary = join(dirname(path), `.owl-office-render-${randomUUID()}${extname(path)}`);
	try {
		signal.throwIfAborted();
		await writeFile(temporary, bytes, { signal, flag: "wx" });
		signal.throwIfAborted();
		await authorizePath(cwd, path, "new");
		await authorizePath(cwd, temporary, "existing");
		await link(temporary, path);
		return path;
	} finally {
		await rm(temporary, { force: true });
	}
}

function decodeXml(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
		if (entity.toLowerCase().startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
		if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
		return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
	});
}

/** Image hrefs are embedded bytes; never let the compiler preserve an external URL. */
function svgAssetResolver(cwd: string, source: string): (href: string) => { bytes: Uint8Array } {
	const workspace = realpathSync(cwd);
	return (href) => {
		if (/^[a-z][a-z\d+.-]*:/i.test(href) || isAbsolute(href) || href.startsWith("\\") || href.includes("\0")) {
			throw new OfficeRuntimeError(
				"SVG_ASSET_DENIED",
				"SVG image assets must be relative files inside the workspace.",
			);
		}
		const path = realpathSync(resolve(dirname(source), href));
		assertInside(workspace, path);
		const bytes = readFileSync(path);
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES)
			throw new OfficeRuntimeError("SVG_ASSET_LIMIT", "SVG image asset is empty or too large.");
		if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(bytes.subarray(0, 1_000).toString("utf8"))) {
			throw new OfficeRuntimeError(
				"SVG_NESTED_ASSET_UNSUPPORTED",
				"Compile vector SVG shapes directly; nested SVG image assets are not supported.",
			);
		}
		return { bytes };
	};
}

function validateSvg(svg: string, assets: (href: string) => { bytes: Uint8Array }): void {
	if (/<!DOCTYPE|<!ENTITY/i.test(svg))
		throw new OfficeRuntimeError("SVG_ENTITY_DENIED", "SVG document types and custom entities are not supported.");
	for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gis)) {
		const href = decodeXml(match[2]);
		if (href.startsWith("#")) continue;
		if (/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,/i.test(href)) continue;
		assets(href);
	}
}

function textDocument(runs: readonly TextRun[]): Record<string, unknown> {
	const text = runs.map((run) => run.text).join("");
	let offset = 0;
	return {
		id: "owl-svg-measure",
		body: {
			dataStream: `${text}\r\n`,
			textRuns: runs.map((run) => {
				const st = offset;
				offset += run.text.length;
				return {
					st,
					ed: offset,
					ts: {
						fs: run.fontSizePx * 0.75,
						...(run.bold ? { bl: 1 } : {}),
						...(run.italic ? { it: 1 } : {}),
						...(run.fontFamily ? { ff: run.fontFamily } : {}),
					},
				};
			}),
			paragraphs: [{ startIndex: text.length, paragraphId: "owl-svg-measure-p0" }],
		},
		documentStyle: {
			pageSize: { width: 1_000_000, height: 1_000_000 },
			marginTop: 0,
			marginBottom: 0,
			marginLeft: 0,
			marginRight: 0,
		},
	};
}

/** Real browser-backed Office rendering, resolved only from the pinned runtime installation. */
export async function renderOfficeOperation(
	runtime: OfficeRuntime,
	operation: string,
	args: Record<string, unknown>,
	cwd: string,
	options: OfficeRenderOptions,
	inputSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(inputSignal ? [inputSignal] : [])]);
	signal.throwIfAborted();
	if (!["screenshot", "print_pdf", "lint", "compile_svg"].includes(operation))
		throw new OfficeRuntimeError("INVALID_RENDER_OPERATION", "Unknown Office render operation.");
	const pages = selectedPages(args.pages);
	const output =
		operation === "screenshot" || operation === "print_pdf"
			? await authorizePath(cwd, requiredString(args.output, "output"), "new")
			: undefined;
	if (output && extname(output).toLowerCase() !== (operation === "screenshot" ? ".png" : ".pdf"))
		throw new OfficeRuntimeError(
			"INVALID_RENDER_OUTPUT",
			"Screenshot output must end in .png and PDF output in .pdf.",
		);
	let svgSource: string | undefined;
	let svg: string | undefined;
	let assets: ((href: string) => { bytes: Uint8Array }) | undefined;
	if (operation === "compile_svg") {
		requiredString(args.worktreeId, "worktreeId");
		if (!Number.isSafeInteger(args.page) || Number(args.page) < 1)
			throw new OfficeRuntimeError("INVALID_SVG_PAGE", "SVG page must be a positive integer.");
		if (args.mode !== undefined && args.mode !== "replace" && args.mode !== "add")
			throw new OfficeRuntimeError("INVALID_SVG_MODE", "SVG mode must be replace or add.");
		svgSource = await authorizePath(cwd, requiredString(args.source, "source"), "existing");
		if (extname(svgSource).toLowerCase() !== ".svg")
			throw new OfficeRuntimeError("INVALID_SVG_SOURCE", "SVG source must end in .svg.");
		svg = await readFile(svgSource, "utf8");
		if (Buffer.byteLength(svg, "utf8") > 8 * 1024 * 1024)
			throw new OfficeRuntimeError("SVG_SOURCE_LIMIT", "SVG source exceeds the render limit.");
		assets = svgAssetResolver(cwd, svgSource);
		validateSvg(svg, assets);
	}
	const require = createRequire(join(options.assetRoot, "package.json"));
	const rendering = sdkModule<RuntimeSdk>(require, "@univer-cli/univer-render-runtime", [
		"createUniverRenderRuntime",
		"resolveUniverRenderBrowser",
	]);
	const screenshots = sdkModule<ScreenshotSdk>(require, "@univer-cli/unit-screenshot", [
		"createUnitScreenshot",
		"resolveUnitScreenshotImageAssets",
	]);
	const source = await renderSource(runtime, screenshots, args, cwd, signal);
	if ((operation === "lint" || operation === "compile_svg") && source.unitType !== "slide")
		throw new OfficeRuntimeError("INVALID_RENDER_UNIT", "Layout lint and SVG compilation require a Slide Unit.");
	if (operation === "print_pdf" && source.unitType === "base")
		throw new OfficeRuntimeError("INVALID_RENDER_UNIT", "Base Units do not support PDF printing.");
	if (args.range !== undefined && (operation !== "screenshot" || source.unitType !== "sheet"))
		throw new OfficeRuntimeError("INVALID_RENDER_RANGE", "Screenshot range requires a Sheet Unit.");
	if (pages && source.unitType !== "slide" && source.unitType !== "doc")
		throw new OfficeRuntimeError("INVALID_RENDER_PAGES", "Page selection requires a Doc or Slide Unit.");
	const machine = await rendering.createUniverRenderRuntime({
		renderPageRoot: join(options.assetRoot, "artifacts", "render-machine"),
		browserExecutablePath: await browserPath(rendering, options.browserExecutablePath),
		env: process.env,
		license: options.license?.trim() || (await runtime.getLicense()),
		signal,
	});
	try {
		if (operation === "screenshot") {
			let target: Record<string, unknown> | undefined;
			if (source.unitType === "sheet" && args.range !== undefined) {
				const range = requiredString(args.range, "range");
				const split = range.lastIndexOf("!");
				target = {
					kind: "sheet-range",
					range: split < 0 ? range : range.slice(split + 1),
					...(split < 0
						? {}
						: {
								sheetName: range
									.slice(0, split)
									.replace(/^'(.*)'$/, "$1")
									.replace(/''/g, "'"),
							}),
				};
			} else if (pages) target = { kind: source.unitType === "doc" ? "doc-pages" : "slide-pages", pages };
			const result = await screenshots
				.createUnitScreenshot({ runtime: machine, limits: { maxPages: MAX_PAGES, maxPixels: MAX_PIXELS } })
				.capture({ ...source, ...(target ? { target } : {}), signal });
			if (
				result.images.length === 0 ||
				result.images.length > MAX_PAGES ||
				result.images.some(
					(image) =>
						!Number.isSafeInteger(image.width) ||
						!Number.isSafeInteger(image.height) ||
						image.width < 1 ||
						image.height < 1 ||
						image.width * image.height > MAX_PIXELS,
				)
			)
				throw new OfficeRuntimeError(
					"INVALID_RENDER_IMAGE",
					"Office renderer returned invalid or oversized images.",
				);
			const paths = result.images.map((image, index) =>
				result.images.length === 1
					? output!
					: join(
							dirname(output!),
							`${basename(output!, extname(output!))}-p${String(image.page ?? index + 1).padStart(2, "0")}.png`,
						),
			);
			if (new Set(paths).size !== paths.length)
				throw new OfficeRuntimeError("INVALID_RENDER_IMAGE", "Office renderer returned duplicate page images.");
			for (const path of paths) await authorizePath(cwd, path, "new");
			const images: Record<string, unknown>[] = [];
			for (const [index, image] of result.images.entries()) {
				const path = await publish(cwd, paths[index], image.bytes, signal);
				const { bytes: _bytes, ...metadata } = image;
				images.push({ ...metadata, path });
			}
			return { unitId: result.unitId, unitType: result.unitType, images, outputs: paths };
		}
		if (operation === "print_pdf") {
			const pdf = sdkModule<PdfSdk>(require, "@univer-cli/unit-pdf-printer", ["createUnitPdfPrinter"]);
			const result = await pdf
				.createUnitPdfPrinter({ runtime: machine, maxPages: MAX_PAGES })
				.print({ ...source, signal });
			const path = await publish(cwd, output!, result.bytes, signal);
			return {
				unitId: result.unitId,
				unitType: result.unitType,
				pageCount: result.pageCount,
				output: path,
				outputs: [path],
			};
		}
		if (operation === "lint") {
			const lint = sdkModule<LintSdk>(require, "@univer-cli/unit-layout-lint", ["createUnitLayoutLint"]);
			return await lint
				.createUnitLayoutLint({ runtime: machine })
				.lint({ ...source, ...(pages ? { pages } : {}), signal });
		}
		const compiler = sdkModule<SvgSdk>(require, "@univer-cli/svg-facade", ["compileSvgToFacade", "wrapSlideScript"]);
		const compiled = await compiler.compileSvgToFacade(svg!, {
			assetResolver: assets!,
			textMeasurer: {
				source: "browser-render-runtime",
				async measureLine(input) {
					const metrics = await machine.measureText({ doc: textDocument(input.runs), signal });
					return {
						width: metrics.actualWidth,
						ascent: metrics.firstLineAscent,
						descent: metrics.firstLineDescent,
					};
				},
			},
		});
		signal.throwIfAborted();
		const mode = args.mode === "add" ? "add" : "replace";
		const code = compiler.wrapSlideScript(compiled.code, { page: Number(args.page), mode, ...compiled.viewport });
		const execution = await runtime.call(
			"execute",
			{ file: args.file, unitId: args.unitId, worktreeId: args.worktreeId, code },
			cwd,
			signal,
		);
		return {
			source: svgSource,
			page: args.page,
			mode,
			viewport: compiled.viewport,
			textMeasure: compiled.textMeasure,
			lints: compiled.lints,
			warnings: compiled.warnings,
			execution,
		};
	} finally {
		await machine.close();
	}
}
