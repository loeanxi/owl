import type { ExtensionAPI, ExtensionUIContext } from "@owl/owl-coding-agent";
import { type TSchema, Type } from "typebox";

export interface OfficeToolRuntime {
	call(
		operation: string,
		args: Record<string, unknown>,
		cwd: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

export interface OfficeArtifact {
	path: string;
	action: "written" | "edited" | "opened";
}

export interface OfficeToolDetails {
	operation: string;
	result: Record<string, unknown>;
	artifacts?: OfficeArtifact[];
}

interface OfficeContext {
	cwd: string;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "confirm">;
}

const file = Type.String({ minLength: 1, description: "当前工作区中的 .univer 文件路径。" });
const worktreeId = Type.String({ minLength: 1, description: "univer_worktree 返回的草稿 ID。" });
const unitId = Type.String({ minLength: 1, description: "univer_status 返回的内容单元 ID。" });
const kind = Type.Union([
	Type.Literal("sheet"),
	Type.Literal("doc"),
	Type.Literal("slide"),
	Type.Literal("base"),
	Type.Literal("board"),
]);
const output = Type.String({ minLength: 1, description: "当前工作区中的输出路径；不要覆盖源文件。" });
const scope = { file, unitId, worktreeId: Type.Optional(worktreeId) };

export async function executeOfficeOperation(
	runtime: OfficeToolRuntime,
	operation: string,
	params: Record<string, unknown>,
	ctx: OfficeContext,
	signal?: AbortSignal,
): Promise<{
	content: { type: "text"; text: string }[];
	structuredContent: Record<string, unknown>;
	details: OfficeToolDetails;
}> {
	signal?.throwIfAborted();
	let args = params;
	if (operation === "worktree" && (params.action === "merge" || params.action === "discard")) {
		if (!ctx.hasUI) throw new Error("确认或放弃 Office 草稿需要已连接的 Owl 界面。请在工作台中审阅后操作。");
		const approved = await ctx.ui.confirm(
			params.action === "merge" ? "确认 Office 修改" : "放弃 Office 草稿",
			`${String(params.file)}\n草稿：${String(params.worktreeId)}\n${params.action === "merge" ? "将这份草稿合入当前版本？" : "放弃这份草稿？"}`,
			{ signal },
		);
		signal?.throwIfAborted();
		if (!approved) throw new Error("用户未确认本次操作。草稿和当前版本保持原状。");
		args = { ...params, userConfirmed: true };
	}
	const result = await runtime.call(operation, args, ctx.cwd, signal);
	signal?.throwIfAborted();
	const artifacts: OfficeArtifact[] = [];
	if (operation === "new" && typeof params.file === "string") artifacts.push({ path: params.file, action: "written" });
	if (
		["unit", "import", "execute", "compile_svg", "worktree"].includes(operation) &&
		typeof params.file === "string"
	) {
		artifacts.push({ path: params.file, action: "edited" });
	}
	if (["export", "print_pdf", "screenshot"].includes(operation) && typeof params.output === "string") {
		artifacts.push({ path: params.output, action: "written" });
	}
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		structuredContent: result,
		details: { operation, result, ...(artifacts.length > 0 ? { artifacts } : {}) },
	};
}

export function registerOfficeTools(pi: Pick<ExtensionAPI, "registerTool">, runtime: OfficeToolRuntime): void {
	function register(
		operation: string,
		label: string,
		description: string,
		properties: Record<string, TSchema>,
		readOnly = false,
	): void {
		pi.registerTool<TSchema, OfficeToolDetails>({
			name: `univer_${operation}`,
			label,
			description,
			parameters: Type.Object(properties, { additionalProperties: false }),
			outputSchema: Type.Record(Type.String(), Type.Unknown()),
			namespace: { name: "univer", description: "创建、检查、修改和交付表格、文档、演示文稿与画布。" },
			annotations: { readOnlyHint: readOnly, openWorldHint: false },
			promptSnippet: description,
			promptGuidelines: [
				"Office 写入只进入显式草稿。先读取 univer_status 获取真实 ID，不要猜测 ID。",
				"通过 univer_inspect 校验内容；修改后将草稿设为 ready，提供 .univer 文件供用户审阅。",
				"只有用户明确要求时才调用 merge/discard；这些动作还需要界面确认。",
				"先用 univer_api 查同版本 Facade API；execute 中显式 return 才能取得读回值。",
			],
			execute: (_id, params, signal, _update, ctx) =>
				executeOfficeOperation(runtime, operation, params as Record<string, unknown>, ctx, signal),
		});
	}
	register("new", "创建 Office 文件", "创建空 .univer 容器，不覆盖已有文件。", { file });
	register("status", "查看 Office 状态", "读取 .univer 的当前内容、草稿与真实 Unit ID。", { file }, true);
	register(
		"worktree",
		"管理 Office 草稿",
		"创建、提交、继续修改、确认或放弃 Office 草稿。merge/discard 必须由用户确认。",
		{
			file,
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("ready"),
				Type.Literal("reopen"),
				Type.Literal("merge"),
				Type.Literal("discard"),
			]),
			worktreeId: Type.Optional(worktreeId),
			name: Type.Optional(Type.String()),
		},
	);
	register("unit", "管理 Office 内容", "在显式草稿中创建或删除 Sheet、Doc、Slide、Base、Board 内容单元。", {
		file,
		worktreeId,
		action: Type.Union([Type.Literal("create"), Type.Literal("remove")]),
		kind: Type.Optional(kind),
		name: Type.Optional(Type.String({ minLength: 1 })),
		unitId: Type.Optional(unitId),
	});
	register("import", "导入办公文件", "将工作区内的 xlsx/csv/tsv/docx/pptx 导入显式草稿，不改源文件。", {
		file,
		worktreeId,
		source: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		docType: Type.Optional(Type.Union([Type.Literal("traditional"), Type.Literal("modern")])),
	});
	register(
		"inspect",
		"检查 Office 内容",
		"读取内容结构或 Sheet 范围（如 Sheet1!A1:D20），可检查草稿或当前版本。",
		{
			...scope,
			range: Type.Optional(Type.String({ minLength: 1 })),
			elementIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		},
		true,
	);
	register(
		"execute",
		"编辑 Office 草稿",
		"执行 Univer Facade JavaScript，将修改提交到显式草稿；code/codeFile 必须二选一。",
		{
			file,
			unitId,
			worktreeId,
			code: Type.Optional(Type.String({ minLength: 1 })),
			codeFile: Type.Optional(Type.String({ minLength: 1 })),
		},
	);
	register(
		"export",
		"导出办公文件",
		"将显式内容单元导出为 xlsx/csv/tsv/docx/pptx，output 必须是工作区内的新文件路径。",
		{ ...scope, output },
	);
	register(
		"api",
		"查询 Univer API",
		"查找同版本 Univer Facade API。find 按关键词搜索；show 展开精确类或 Class.member。",
		{
			action: Type.Union([Type.Literal("find"), Type.Literal("show")]),
			queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			unit: Type.Optional(kind),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		},
		true,
	);
	register(
		"screenshot",
		"预览 Office 图片",
		"把指定内容单元渲染为工作区 PNG。Sheet 可选 range，Doc/Slide 可选 pages。",
		{
			...scope,
			output,
			range: Type.Optional(Type.String()),
			pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
		},
	);
	register("print_pdf", "导出 Office PDF", "将 Sheet、Doc、Slide 或 Board 打印为工作区内的 PDF 文件。", {
		...scope,
		output,
	});
	register(
		"lint",
		"检查幻灯片布局",
		"检查 Slide 文字越界、溢出和重叠；不生成文件。",
		{ ...scope, pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))) },
		true,
	);
	register("compile_svg", "应用 SVG 页面", "按真实文字度量把工作区 SVG 编译到显式 Slide 草稿页面。", {
		file,
		worktreeId,
		unitId,
		source: Type.String({ minLength: 1 }),
		page: Type.Integer({ minimum: 1 }),
		mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("add")])),
	});
	register("resources", "查找 Office 资源", "查询图标、Logo、Emoji、插画资源；可读取 SVG 或导出到工作区。", {
		action: Type.Union([
			Type.Literal("registries"),
			Type.Literal("find"),
			Type.Literal("read"),
			Type.Literal("export"),
		]),
		queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		registries: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		handle: Type.Optional(Type.String({ minLength: 1 })),
		handles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
		output: Type.Optional(output),
	});
}
