import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderOfficeOperation } from "../src/render.ts";
import { OfficeRuntime } from "../src/runtime.ts";

const unavailable = {} as OfficeRuntime;

test("render paths reject clobbering, workspace escapes and cancelled requests before loading a renderer", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-render-fence-"));
	const cwd = join(root, "project");
	const outside = join(root, "outside");
	try {
		await mkdir(cwd);
		await mkdir(outside);
		await writeFile(join(cwd, "existing.png"), "original");
		await symlink(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		const options = { assetRoot: join(root, "not-installed") };
		for (const output of ["existing.png", "../outside/report.png", "linked/report.png"]) {
			await assert.rejects(renderOfficeOperation(unavailable, "screenshot", { output }, cwd, options));
		}
		assert.equal(await readFile(join(cwd, "existing.png"), "utf8"), "original");
		await assert.rejects(
			renderOfficeOperation(unavailable, "screenshot", { output: "report.jpeg" }, cwd, options),
			/must end/,
		);
		await assert.rejects(renderOfficeOperation(unavailable, "lint", { pages: [0] }, cwd, options), /page numbers/);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(renderOfficeOperation(unavailable, "lint", {}, cwd, options, controller.signal));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("SVG compilation rejects remote hrefs, encoded URLs, custom entities and escaping local assets", async () => {
	const root = await mkdtemp(join(tmpdir(), "owl-render-svg-fence-"));
	const cwd = join(root, "project");
	try {
		await mkdir(cwd);
		await writeFile(join(root, "outside.png"), "outside");
		const invalid = [
			'<svg><image href="https://example.com/private.png" /></svg>',
			'<svg><image href="http&#58;//example.com/private.png" /></svg>',
			'<svg><image href="../outside.png" /></svg>',
			'<!DOCTYPE svg [<!ENTITY remote SYSTEM "file:///outside">]><svg />',
		];
		for (const [index, svg] of invalid.entries()) {
			const source = `invalid-${index}.svg`;
			await writeFile(join(cwd, source), svg);
			await assert.rejects(
				renderOfficeOperation(unavailable, "compile_svg", { source, worktreeId: "draft", page: 1 }, cwd, {
					assetRoot: "missing",
				}),
			);
		}
		await writeFile(join(cwd, "nested.svg"), '<svg xmlns="http://www.w3.org/2000/svg" />');
		await writeFile(join(cwd, "parent.svg"), '<svg><image href="nested.svg" /></svg>');
		await assert.rejects(
			renderOfficeOperation(
				unavailable,
				"compile_svg",
				{ source: "parent.svg", worktreeId: "draft", page: 1 },
				cwd,
				{ assetRoot: "missing" },
			),
			/nested SVG/i,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const assetRoot = process.env.OWL_UNIVER_TEST_RUNTIME_ROOT?.trim();

test(
	"the installed renderer produces real PNG/PDF, paged slide images, layout facts and measured SVG code",
	{ skip: !assetRoot, timeout: 120_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "owl-render-sample-"));
		const actual = new OfficeRuntime({ assetRoot: assetRoot! });
		const executions: Record<string, unknown>[] = [];
		const sheet = {
			unitType: "sheet",
			unitData: {
				id: "sample-sheet",
				name: "Owl Sample",
				locale: "en-US",
				appVersion: "1.0.2",
				sheetOrder: ["sheet1"],
				styles: {},
				sheets: {
					sheet1: {
						id: "sheet1",
						name: "Sheet1",
						rowCount: 10,
						columnCount: 5,
						defaultColumnWidth: 100,
						defaultRowHeight: 24,
						cellData: { 0: { 0: { v: "Owl" }, 1: { v: 42 } } },
					},
				},
			},
		};
		const slide = {
			unitType: "slide",
			unitData: {
				id: "sample-slide",
				name: "Owl Slides",
				locale: "en-US",
				appVersion: "1.0.2",
				defaultPageSize: { width: 640, height: 360 },
				slideOrder: ["page1", "page2"],
				slides: {
					page1: {
						id: "page1",
						pageType: "slide",
						name: "Page 1",
						elementOrder: [],
						elements: {},
						background: { type: "solid", color: "#ffffff" },
					},
					page2: {
						id: "page2",
						pageType: "slide",
						name: "Page 2",
						elementOrder: [],
						elements: {},
						background: { type: "solid", color: "#f5f5f5" },
					},
				},
			},
		};
		const runtime = {
			getLicense: () => actual.getLicense(),
			async call(operation: string, args: Record<string, unknown>) {
				if (operation === "render-source") {
					assert.equal(typeof args.unitId, "string");
					return args.unitId === "sample-sheet" ? sheet : slide;
				}
				assert.equal(operation, "execute");
				executions.push(args);
				return { ok: true };
			},
		} as unknown as OfficeRuntime;
		try {
			await writeFile(join(cwd, "sample.univer"), "snapshot supplied by the deterministic test port");
			const options = { assetRoot: assetRoot! };
			const sheetArgs = { file: "sample.univer", unitId: "sample-sheet" };
			const png = await renderOfficeOperation(
				runtime,
				"screenshot",
				{ ...sheetArgs, output: "sample.png", range: "Sheet1!A1:B2" },
				cwd,
				options,
			);
			const pngBytes = await readFile(join(cwd, "sample.png"));
			assert.equal(pngBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
			assert.ok(pngBytes.length > 100);
			assert.deepEqual(png.outputs, [join(cwd, "sample.png")]);
			assert.ok(!JSON.stringify(png).includes('"bytes"'));
			const pdf = await renderOfficeOperation(
				runtime,
				"print_pdf",
				{ ...sheetArgs, output: "sample.pdf" },
				cwd,
				options,
			);
			assert.equal((await readFile(join(cwd, "sample.pdf"))).subarray(0, 5).toString(), "%PDF-");
			assert.ok(Number(pdf.pageCount) > 0);
			const slideArgs = { file: "sample.univer", unitId: "sample-slide" };
			const missingImageRuntime = {
				getLicense: () => actual.getLicense(),
				async call() {
					return {
						...slide,
						unitData: { ...slide.unitData, imageAssets: [{ source: "missing-image", imageSourceType: "UUID" }] },
					};
				},
			} as unknown as OfficeRuntime;
			await assert.rejects(
				renderOfficeOperation(
					missingImageRuntime,
					"screenshot",
					{ ...slideArgs, output: "missing-asset.png" },
					cwd,
					options,
				),
				/active Gateway/,
			);
			const images = await renderOfficeOperation(
				runtime,
				"screenshot",
				{ ...slideArgs, output: "slides.png", pages: [1, 2] },
				cwd,
				options,
			);
			assert.deepEqual(images.outputs, [join(cwd, "slides-p01.png"), join(cwd, "slides-p02.png")]);
			const lint = await renderOfficeOperation(runtime, "lint", { ...slideArgs, pages: [1] }, cwd, options);
			assert.equal(lint.kind, "unit-layout-lint");
			assert.equal(lint.unitType, "slide");
			await writeFile(
				join(cwd, "page.svg"),
				'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect x="0" y="0" width="640" height="360" fill="#ffffff"/><text x="40" y="80" font-size="32">Owl 测试</text><image href="sample.png" x="40" y="100" width="200" height="80" /></svg>',
			);
			const compiled = await renderOfficeOperation(
				runtime,
				"compile_svg",
				{ ...slideArgs, source: "page.svg", worktreeId: "draft", page: 1 },
				cwd,
				options,
			);
			assert.equal(compiled.textMeasure, "browser-render-runtime");
			assert.equal(executions.length, 1);
			assert.equal(executions[0].worktreeId, "draft");
			assert.ok(typeof executions[0].code === "string" && executions[0].code.length > 100);
			assert.ok(String(executions[0].code).includes("data:image/png;base64,"));
		} finally {
			await actual.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
