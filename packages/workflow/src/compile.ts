import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Vendored TS 5.9: the monorepo root carries typescript 7 (native Go port) whose
// JS API is gone, and the lowering transformer needs the classic compiler API.
const ts = require("../vendor/typescript/lib/typescript.js") as any;

import { FACADE_DTS } from "./facade.js";
import type { AskSpec } from "./types.js";

const T = ts;

export interface Diagnostic {
	line: number;
	column: number;
	message: string;
}

export type SiteKind = "actor" | "ask" | "world" | "report" | "artifact" | "hole" | "phase";

export interface SiteInfo {
	siteId: string;
	kind: SiteKind;
	/** Op string for world/artifact sites ("files.glob", "world.run", "artifact.file"). */
	op?: string;
	name?: string;
}

export interface LoweredScript {
	code: string;
	sites: SiteInfo[];
	phases: string[];
	holeNames: string[];
	/** Per ask site: the ask<T> result contract (typed:false = free text). */
	askSpecs: Record<string, AskSpec>;
}

export interface CompileResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	lowered?: LoweredScript;
	scriptHash?: string;
}

const WORLD_OPS = new Set([
	"files.glob",
	"files.read",
	"files.grep",
	"git.changedFiles",
	"git.diff",
	"git.status",
	"git.log",
	"world.run",
]);

const HOST = "__host";
const BARE_SITED = new Set(["agent", "phase", "hole", "report"]);
const BARE_UNSITED = new Set(["log", "channel", "future"]);

function diagAt(file: any, start: number | undefined, message: string): Diagnostic {
	const pos = file.getLineAndCharacterOfPosition(start ?? 0);
	return { line: pos.line + 1, column: pos.character + 1, message };
}

function propertyName(expr: any): string | undefined {
	if (T.isIdentifier(expr)) return expr.text;
	if (T.isPropertyAccessExpression(expr)) return expr.name.text;
	if (T.isStringLiteral(expr) || T.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
	return undefined;
}

function isEvaluableFunction(node: any): boolean {
	return T.isArrowFunction(node) || T.isFunctionExpression(node);
}

const vendoredLibDir = dirname(require.resolve("../vendor/typescript/lib/typescript.js"));

interface SchemaProperty {
	type: string;
	description?: string;
	enum?: string[];
	items?: SchemaProperty;
	properties?: Record<string, SchemaProperty>;
	required?: string[];
}

function documentationOf(checker: any, symbol: any): string | undefined {
	const parts = symbol.getDocumentationComment(checker) ?? [];
	const text = parts
		.map((p: any) => (typeof p === "string" ? p : (p.text ?? "")))
		.join("")
		.trim();
	return text === "" ? undefined : text;
}

/** JSON-schema-ish shape for the ask<T> contract; undefined = unsupported type (diagnostic). */
function buildSchemaFromType(checker: any, type: any, depth: number): SchemaProperty | undefined {
	if (depth > 2) return undefined;
	const flags = type.flags;
	if (flags & T.TypeFlags.String) return { type: "string" };
	if (flags & T.TypeFlags.Number) return { type: "number" };
	if (flags & T.TypeFlags.Boolean) return { type: "boolean" };
	if (type.isUnion?.()) {
		const parts = type.types ?? [];
		if (parts.length > 0 && parts.every((p: any) => p.flags & T.TypeFlags.StringLiteral)) {
			return { type: "string", enum: parts.map((p: any) => p.value) };
		}
		return undefined;
	}
	if (flags & T.TypeFlags.Object || type.getSymbol?.() || type.aliasSymbol) {
		const numberIndex = checker.getIndexTypeOfType?.(type, T.IndexKind.Number);
		if (numberIndex && !checker.isArrayType?.(type)) return undefined;
		if (checker.isArrayType?.(type)) {
			const element = type.getNumberIndexType?.() ?? checker.getNumberIndexType?.(type);
			if (!element) return undefined;
			const items = buildSchemaFromType(checker, element, depth + 1);
			if (!items) return undefined;
			return { type: "array", items };
		}
		const properties: Record<string, SchemaProperty> = {};
		const props = type.getProperties?.() ?? [];
		if (props.length === 0) return undefined;
		for (const prop of props) {
			if (prop.name.startsWith("__")) return undefined; // the wrapper's own symbols
			const propType = checker.getTypeOfSymbol?.(prop);
			if (!propType) return undefined;
			const propSchema = buildSchemaFromType(checker, propType, depth + 1);
			if (!propSchema) return undefined;
			const description = documentationOf(checker, prop);
			properties[prop.getName()] = description === undefined ? propSchema : { ...propSchema, description };
		}
		return { type: "object", properties, required: Object.keys(properties) };
	}
	return undefined;
}

function contractText(schema: SchemaProperty): string {
	return `[OUTPUT CONTRACT] The final reply must be ONLY one JSON object (no markdown fences, no prose) matching this schema:\n${JSON.stringify(schema, null, 2)}`;
}

/**
 * ZCode's wAn: the T of every ask<T> becomes a result contract. Typed specs
 * enable engine-side validation with a repair round-trip to the same session.
 * askSiteIds are the ask sites in document order; the Nth spec keys to the Nth.
 */
function extractAskSpecs(
	scopeFile: any,
	program: any,
	wrapPrefix: string,
	askSiteIds: string[],
): { specs: Record<string, AskSpec>; diagnostics: Diagnostic[] } {
	const checker = program.getTypeChecker();
	const specsInOrder: AskSpec[] = [];
	const diagnostics: Diagnostic[] = [];
	const walk = (node: any): void => {
		if (
			T.isCallExpression(node) &&
			T.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "ask"
		) {
			const typeArg = node.typeArguments?.[0];
			if (!typeArg) {
				specsInOrder.push({ typed: false });
			} else {
				const type = checker.getTypeAtLocation(typeArg);
				const schema = buildSchemaFromType(checker, type, 0);
				if (!schema) {
					const pos = node.getStart(scopeFile);
					const { line, character } = scopeFile.getLineAndCharacterOfPosition(pos);
					diagnostics.push({
						line: Math.max(1, line + 1 - (wrapPrefix.split("\n").length - 1)),
						column: character + 1,
						message:
							"unsupported ask<T> result type (9012): use an interface/type alias of objects, arrays, primitives or string-literal unions",
					});
					specsInOrder.push({ typed: false });
				} else {
					specsInOrder.push({ typed: true, schema, contract: contractText(schema) });
				}
			}
		}
		T.forEachChild(node, walk);
	};
	walk(scopeFile);
	if (specsInOrder.length !== askSiteIds.length) {
		diagnostics.push({
			line: 1,
			column: 1,
			message: `internal: ${specsInOrder.length} ask<T> extractions vs ${askSiteIds.length} ask sites`,
		});
		return { specs: {}, diagnostics };
	}
	const specs: Record<string, AskSpec> = {};
	askSiteIds.forEach((siteId, index) => {
		specs[siteId] = specsInOrder[index];
	});
	return { specs, diagnostics };
}

/**
 * Compile a workflow script: typecheck against the facade, enumerate sites in
 * document order, and lower every facade call to a __host.* call whose first
 * argument is the site id literal. Diagnostics mean nothing ran.
 */
export function compileScript(source: string): CompileResult {
	const scriptFile = T.createSourceFile("workflow.ts", source, T.ScriptTarget.ES2022, true, T.ScriptKind.TS);
	const facadeFile = T.createSourceFile("facade.d.ts", FACADE_DTS, T.ScriptTarget.ES2022, true, T.ScriptKind.DTS);
	// The script is typechecked inside a function body (that is why `declare` is
	// illegal in scripts): top-level await and a final return are then ordinary.
	const WRAP_PREFIX = "async function __workflowScope() {\n";
	const scopeFile = T.createSourceFile(
		"workflow-scope.ts",
		`${WRAP_PREFIX}${source}\n}`,
		T.ScriptTarget.ES2022,
		true,
		T.ScriptKind.TS,
	);

	const options: any = {
		strict: true,
		target: T.ScriptTarget.ES2022,
		noEmit: true,
		skipDefaultLibCheck: false,
		skipLibCheck: true,
		module: T.ModuleKind.ESNext,
		moduleResolution: T.ModuleResolutionKind.Bundler,
	};

	const host: any = {
		getSourceFile(name: string, languageVersion: any, onError?: any) {
			if (name === "workflow.ts") return scriptFile;
			if (name === "workflow-scope.ts") return scopeFile;
			if (name === "facade.d.ts") return facadeFile;
			const path = name.includes("/") || name.includes("\\") ? name : join(vendoredLibDir, name);
			if (!existsSync(path)) {
				onError?.(`lib file not found: ${name}`);
				return undefined;
			}
			return T.createSourceFile(name, readFileSync(path, "utf8"), languageVersion, true);
		},
		getDefaultLibFileName: () => "lib.es2022.d.ts",
		getDefaultLibLocation: () => vendoredLibDir,
		writeFile: () => {},
		getCurrentDirectory: () => "/",
		getCanonicalFileName: (name: string) => name,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (name: string) =>
			name === "workflow.ts" ||
			name === "workflow-scope.ts" ||
			name === "facade.d.ts" ||
			existsSync(name) ||
			existsSync(join(vendoredLibDir, name)),
		readFile: (name: string) => {
			if (name === "workflow.ts") return source;
			if (name === "workflow-scope.ts") return `${WRAP_PREFIX}${source}\n}`;
			if (name === "facade.d.ts") return FACADE_DTS;
			const path = name.includes("/") || name.includes("\\") ? name : join(vendoredLibDir, name);
			return existsSync(path) ? readFileSync(path, "utf8") : undefined;
		},
		directoryExists: (name: string) => name === vendoredLibDir || name === "/",
		getDirectories: () => [],
	};

	const program = T.createProgram(["workflow-scope.ts", "facade.d.ts"], options, host);
	const diagnostics: Diagnostic[] = [];
	for (const d of [...program.getSyntacticDiagnostics(scopeFile), ...program.getSemanticDiagnostics(scopeFile)]) {
		const diag = diagAt(d.file ?? scopeFile, d.start, T.flattenDiagnosticMessageText(d.messageText, "\n"));
		// Diagnostics come from the wrapped file: shift back onto the author's lines.
		if (diag.line > 1) diag.line -= WRAP_PREFIX.split("\n").length - 1;
		diagnostics.push(diag);
	}
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	// ---- Rule: world.run's command must be a compile-time literal (ZCode Xq) ----
	{
		const checkLiteralCmd = (node: any): void => {
			if (T.isCallExpression(node) && T.isPropertyAccessExpression(node.expression)) {
				const owner = T.isIdentifier(node.expression.expression) ? node.expression.expression.text : undefined;
				const member = propertyName(node.expression.name);
				if (owner === "world" && member === "run") {
					const cmd = node.arguments[0];
					if (!cmd || !(T.isStringLiteral(cmd) || T.isNoSubstitutionTemplateLiteral(cmd))) {
						diagnostics.push(
							diagAt(
								scriptFile,
								node.getStart(scriptFile),
								"world.run command must be a string literal: interpolate runtime values into the args array (9012)",
							),
						);
					}
				}
			}
			T.forEachChild(node, checkLiteralCmd);
		};
		checkLiteralCmd(scriptFile);
		if (diagnostics.length > 0) return { ok: false, diagnostics };
	}

	// ---- Typed asks: extract the T of ask<T> into per-site specs (JSDoc → descriptions) ----
	// (runs after site analysis below; askSpecs key by ask site id)

	// ---- Site analysis: document order, deterministic ----
	const sites: SiteInfo[] = [];
	const phases: string[] = [];
	const holeNames: string[] = [];

	/** Pure classification: which sited kind (if any) this call is. */
	const classifySite = (node: any): { kind: SiteKind; op?: string; name?: string } | undefined => {
		if (!T.isCallExpression(node)) return undefined;
		const expr = node.expression;
		if (T.isIdentifier(expr)) {
			if (!BARE_SITED.has(expr.text)) return undefined;
			switch (expr.text) {
				case "agent":
					return { kind: "actor" };
				case "phase":
					return { kind: "phase" };
				case "hole": {
					const name = node.arguments[0];
					return {
						kind: "hole",
						name:
							name && (T.isStringLiteral(name) || T.isNoSubstitutionTemplateLiteral(name))
								? name.text
								: undefined,
					};
				}
				default:
					return { kind: "report" };
			}
		}
		if (T.isPropertyAccessExpression(expr)) {
			const owner = T.isIdentifier(expr.expression) ? expr.expression.text : undefined;
			const member = propertyName(expr.name);
			if (member === "ask") return { kind: "ask" };
			if (
				owner === "artifact" &&
				member &&
				["file", "markdown", "chart", "table", "metrics", "board"].includes(member)
			) {
				return { kind: "artifact", op: `artifact.${member}` };
			}
			if (
				(owner === "files" || owner === "git" || owner === "world") &&
				member &&
				WORLD_OPS.has(`${owner}.${member}`)
			) {
				return { kind: "world", op: `${owner}.${member}` };
			}
		}
		return undefined;
	};

	const walk = (node: any): void => {
		const match = classifySite(node);
		if (match) {
			if (match.kind === "phase") {
				const name = node.arguments[0];
				if (name && (T.isStringLiteral(name) || T.isNoSubstitutionTemplateLiteral(name))) phases.push(name.text);
			}
			if (match.kind === "hole") {
				const holeName = match.name;
				if (holeName === undefined) {
					diagnostics.push(
						diagAt(scriptFile, node.getStart(scriptFile), "hole() name must be a string literal (9012)"),
					);
				} else if (holeNames.includes(holeName) || phases.includes(holeName)) {
					diagnostics.push(
						diagAt(
							scriptFile,
							node.getStart(scriptFile),
							`hole name "${holeName}" is not unique among holes and phases (9012)`,
						),
					);
				} else {
					holeNames.push(holeName);
				}
			}
			const siteId = `s${sites.length}`;
			sites.push({ siteId, ...match });
		}
		T.forEachChild(node, walk);
	};
	walk(scriptFile);
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	// ---- Typed asks: extract the T of ask<T> into per-site specs (JSDoc → descriptions) ----
	const askSiteIds = sites.filter((s) => s.kind === "ask").map((s) => s.siteId);
	const askSpecs = extractAskSpecs(scopeFile, program, WRAP_PREFIX, askSiteIds);
	if (askSpecs.diagnostics.length > 0) return { ok: false, diagnostics: askSpecs.diagnostics };

	// ---- Lowering: map each sited call to its site (same document order), rewrite to __host.* ----
	const siteOf = new Map<any, SiteInfo>();
	{
		let index = 0;
		const assign = (node: any): void => {
			const match = classifySite(node);
			if (match) {
				siteOf.set(node, sites[index]);
				index += 1;
			}
			T.forEachChild(node, assign);
		};
		assign(scriptFile);
	}

	const transformer = (context: any) => {
		const f = context.factory;
		const hostMember = (name: string) => f.createPropertyAccessExpression(f.createIdentifier(HOST), name);
		const visit = (node: any): any => {
			if (T.isIdentifier(node) && node.text === "args") {
				const parent = node.parent;
				const isName =
					(parent && T.isPropertyAccessExpression(parent) && parent.name === node) ||
					(T.isPropertySignature?.(parent) ?? false);
				if (!isName) return hostMember("args");
			}
			if (T.isCallExpression(node)) {
				const expr = node.expression;
				const site = siteOf.get(node);
				const loweredArgs = () => node.arguments.map((a: any) => T.visitNode(a, visit) as any);

				if (site) {
					const siteArg = f.createStringLiteral(site.siteId);
					if (site.kind === "actor") {
						return f.createCallExpression(hostMember("createActor"), undefined, [siteArg, ...loweredArgs()]);
					}
					if (site.kind === "ask") {
						const receiver = T.visitNode(expr.expression, visit) as any;
						return f.createCallExpression(hostMember("ask"), undefined, [siteArg, receiver, ...loweredArgs()]);
					}
					if (site.kind === "phase") {
						const name = node.arguments[0];
						return f.createCallExpression(
							hostMember("enterPhase"),
							undefined,
							name && (T.isStringLiteral(name) || T.isNoSubstitutionTemplateLiteral(name))
								? [f.createStringLiteral(name.text)]
								: name
									? [(T.visitNode(name, visit) as any) ?? f.createIdentifier("undefined")]
									: [],
						);
					}
					if (site.kind === "hole") {
						// hole(name) | hole(name, prompt) | hole(name, body) | hole(name, prompt, body)
						const a = node.arguments;
						let promptExpr: any = f.createIdentifier("undefined");
						let bodyExpr: any = f.createIdentifier("undefined");
						if (a.length >= 2 && isEvaluableFunction(a[1])) {
							bodyExpr = T.visitNode(a[1], visit) as any;
						} else if (a.length >= 2) {
							promptExpr = T.visitNode(a[1], visit) as any;
							if (a.length >= 3) bodyExpr = T.visitNode(a[2], visit) as any;
						}
						const evaluate = f.createArrowFunction(
							undefined,
							undefined,
							[f.createParameterDeclaration(undefined, undefined, f.createIdentifier("__src"))],
							undefined,
							f.createToken(T.SyntaxKind.EqualsGreaterThanToken),
							f.createCallExpression(f.createIdentifier("eval"), undefined, [f.createIdentifier("__src")]),
						);
						return f.createCallExpression(hostMember("hole"), undefined, [
							siteArg,
							loweredArgs()[0],
							promptExpr,
							evaluate,
							bodyExpr,
						]);
					}
					if (site.kind === "report") {
						return f.createCallExpression(hostMember("report"), undefined, [siteArg, ...loweredArgs()]);
					}
					if (site.kind === "world") {
						return f.createCallExpression(hostMember("worldRead"), undefined, [
							siteArg,
							f.createStringLiteral(site.op!),
							f.createArrayLiteralExpression(loweredArgs()),
						]);
					}
					if (site.kind === "artifact") {
						const member = ["artifact.file", "artifact.markdown"].includes(site.op!)
							? "publishArtifact"
							: "declareArtifact";
						return f.createCallExpression(hostMember(member), undefined, [
							siteArg,
							f.createStringLiteral(site.op!),
							f.createArrayLiteralExpression(loweredArgs()),
						]);
					}
				}

				if (T.isIdentifier(expr) && BARE_UNSITED.has(expr.text)) {
					return f.createCallExpression(hostMember(expr.text), undefined, loweredArgs());
				}
			}
			return T.visitEachChild(node, visit, context);
		};
		return (sf: any) => T.visitNode(sf, visit);
	};

	const transformed = T.transform(scriptFile, [transformer]).transformed[0];
	const printer = T.createPrinter({ newLine: T.NewLineKind.LineFeed, removeComments: false });
	const printed = (transformed.statements as any[])
		.map((s) => printer.printNode(T.EmitHint.Unspecified, s, transformed))
		.join("\n");
	const code = T.transpileModule(printed, {
		compilerOptions: { target: T.ScriptTarget.ES2022, module: T.ModuleKind.ESNext },
		reportDiagnostics: false,
	}).outputText;

	return {
		ok: true,
		diagnostics: [],
		lowered: { code, sites, phases, holeNames, askSpecs: askSpecs.specs },
		scriptHash: createHash("sha256").update(source, "utf8").digest("hex"),
	};
}
