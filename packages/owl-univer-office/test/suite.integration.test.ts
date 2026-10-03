import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { renderOfficeOperation } from "../src/render.ts";
import { OfficeRuntime } from "../src/runtime.ts";

const assetRoot = process.env.OWL_UNIVER_TEST_RUNTIME;
const validationRoot = resolve(
	process.env.OWL_UNIVER_TEST_WORKSPACE || join(process.cwd(), ".artifacts", "office-integration"),
);

test(
	"real Doc and Slide export Office files, with Base and Board inspection",
	{ skip: !assetRoot, timeout: 180_000 },
	async () => {
		if (!assetRoot) return;
		const cwd = join(validationRoot, `suite-${randomUUID()}`);
		await mkdir(cwd, { recursive: true });
		const runtime = new OfficeRuntime({ assetRoot });
		try {
			await runtime.call("new", { file: "office.univer" }, cwd);
			const draft = await runtime.call("worktree", { file: "office.univer", action: "create" }, cwd);
			const worktreeId = draft.worktreeId;
			const doc = await runtime.call(
				"unit",
				{ file: "office.univer", worktreeId, action: "create", kind: "doc", name: "接入报告" },
				cwd,
			);
			await runtime.call(
				"execute",
				{
					file: "office.univer",
					worktreeId,
					unitId: doc.unitId,
					code: 'const paragraph = doc.getParagraphs()[0]; paragraph.setText("Owl Office 接入验证：文档内容可编辑并导出。"); return paragraph.getText();',
				},
				cwd,
			);
			const slide = await runtime.call(
				"unit",
				{ file: "office.univer", worktreeId, action: "create", kind: "slide", name: "接入演示" },
				cwd,
			);
			await writeFile(
				join(cwd, "page.svg"),
				'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect x="0" y="0" width="1280" height="720" fill="#FFFFFF"/><text x="80" y="120" font-family="Arial" font-size="48" fill="#172033">Owl Office Integration</text><text x="80" y="210" font-family="Arial" font-size="28" fill="#334155">Editable presentation verified with the real runtime.</text></svg>',
			);
			await renderOfficeOperation(
				runtime,
				"compile_svg",
				{ file: "office.univer", worktreeId, unitId: slide.unitId, source: "page.svg", page: 1, mode: "replace" },
				cwd,
				{ assetRoot },
			);
			await renderOfficeOperation(
				runtime,
				"lint",
				{ file: "office.univer", worktreeId, unitId: slide.unitId, pages: [1] },
				cwd,
				{ assetRoot },
			);
			await renderOfficeOperation(
				runtime,
				"screenshot",
				{ file: "office.univer", worktreeId, unitId: slide.unitId, pages: [1], output: "slide.png" },
				cwd,
				{ assetRoot },
			);
			await runtime.call(
				"export",
				{ file: "office.univer", worktreeId, unitId: doc.unitId, output: "report.docx" },
				cwd,
			);
			await runtime.call(
				"export",
				{ file: "office.univer", worktreeId, unitId: slide.unitId, output: "deck.pptx" },
				cwd,
			);
			for (const kind of ["base", "board"]) {
				const unit = await runtime.call(
					"unit",
					{ file: "office.univer", worktreeId, action: "create", kind, name: `${kind} 验证` },
					cwd,
				);
				const inspected = await runtime.call(
					"inspect",
					{ file: "office.univer", worktreeId, unitId: unit.unitId },
					cwd,
				);
				assert.equal(inspected.ok, true);
			}
			for (const file of ["report.docx", "deck.pptx", "slide.png"])
				assert.ok((await stat(join(cwd, file))).size > 100);
			await writeFile(
				join(cwd, "validation.json"),
				JSON.stringify(
					{
						docUnitId: doc.unitId,
						slideUnitId: slide.unitId,
						worktreeId,
						outputs: ["report.docx", "deck.pptx", "slide.png"],
						baseInspected: true,
						boardInspected: true,
					},
					null,
					2,
				),
			);
			process.stdout.write(`Office suite validation artifacts: ${cwd}\n`);
		} finally {
			await runtime.dispose();
		}
	},
);
