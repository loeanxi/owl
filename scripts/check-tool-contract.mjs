#!/usr/bin/env node
/**
 * Tool contract for weak models.
 *
 * Two rules, learned from production history (see .owl/skills/tool-schema-contract.md):
 *
 * 1. A tool's published `parameters` schema must not be a top-level union (JSON Schema `anyOf`)
 *    of object branches. Weak models (glm-5.3-flash et al.) emit bare calls with empty arguments
 *    against `anyOf` schemas - observed: 6 consecutive `arguments: {}` calls with 6 output tokens.
 *    Flatten to one `Type.Object` and move branch requirements into `execute` validation.
 *
 * 2. Validation errors that reach the model must carry a copyable JSON template. A field list
 *    ("must have required properties action, goal, ...") does not let a weak model recover;
 *    a ready-to-fill template does.
 *
 * Usage: node scripts/check-tool-contract.mjs [--root <dir>] [--json]
 * Exit 1 when any error is found. Warnings do not fail.
 */

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	isCallExpression,
	isIdentifier,
	isNewExpression,
	isPropertyAccessExpression,
	isPropertyAssignment,
	isThrowStatement,
	isVariableDeclaration,
} from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

const IGNORED_DIRECTORIES = new Set([
	".git",
	"coverage",
	"dist",
	"node_modules",
	"target",
	".artifacts",
	"test",
	"tests",
	"examples",
]);
const SCAN_ROOTS = ["packages", "apps"];

/**
 * Messages that only make sense to a model if they carry a copyable template: the schema-level
 * fallback errors ("invalid arguments", "must provide all fields"). Field-level errors that
 * already name the fix ("remove names and retry") are intentionally out of scope.
 */
const VALIDATION_MESSAGE_PATTERN =
	/(参数无效|必须提供|必须填写|不接受其它字段|invalid (?:arguments|parameters)|must (?:have|provide) required|required properties)/i;

/** A copyable JSON template marker: `{"field"` / `{\"field\"` / explicit guidance words. */
function hasTemplate(text) {
	return /[{]\s*\\?"/.test(text) || /标准格式|可照抄|模板|template/i.test(text);
}

function parseArgs(argv) {
	let root = process.cwd();
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
		else if (argv[i] === "--json") json = true;
		else if (argv[i] === "--help" || argv[i] === "-h") {
			console.log("Usage: node scripts/check-tool-contract.mjs [--root <dir>] [--json]");
			process.exit(0);
		}
	}
	return { root, json };
}

function collectTypeScriptFiles(root) {
	const files = [];
	const visit = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
				continue;
			}
			const name = entry.name;
			if (entry.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
				files.push(join(directory, entry.name));
			}
		}
	};
	for (const scanRoot of SCAN_ROOTS) visit(join(root, scanRoot));
	return files.sort();
}

/** Returns "Object" / "Union" / "Optional" / "Literal" / ... when the node is a `Type.<method>(...)` call. */
function typeCallMethod(node) {
	if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return undefined;
	const owner = node.expression.expression;
	if (!isIdentifier(owner) || owner.text !== "Type") return undefined;
	return node.expression.name.text;
}

function main() {
	const { root, json } = parseArgs(process.argv.slice(2));
	const files = collectTypeScriptFiles(root);

	const configPath = resolve(join(root, "tsconfig.tool-contract.json"));
	const config = JSON.stringify({
		compilerOptions: { noResolve: true, noLib: true, types: [] },
		files: files.map((file) => resolve(file)),
	});
	const api = new API({
		cwd: root,
		fs: {
			fileExists: (fileName) => (resolve(fileName) === configPath ? true : undefined),
			readFile: (fileName) => (resolve(fileName) === configPath ? config : undefined),
		},
	});

	const errors = [];
	const warnings = [];
	const unresolved = [];
	/** @type {Map<string, Array<{ file: string, node: unknown, sourceFile: unknown }>>} */
	const schemaDeclarations = new Map();
	const parametersUses = [];
	const throwExpressions = [];
	const toolFiles = new Set();

	try {
		const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
		for (const file of files) {
			const sourceFile = program.getSourceFile(resolve(file));
			if (!sourceFile) continue;

			const visit = (node) => {
				if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
					const list = schemaDeclarations.get(node.name.text) ?? [];
					list.push({ node: node.initializer, sourceFile, file });
					schemaDeclarations.set(node.name.text, list);
				}
				if (isPropertyAssignment(node) && isIdentifier(node.name) && node.name.text === "parameters") {
					parametersUses.push({ file, sourceFile, node, initializer: node.initializer });
				}
				if (isThrowStatement(node) && node.expression) {
					throwExpressions.push({ file, sourceFile, node: node.expression });
				}
				node.forEachChild(visit);
			};
			visit(sourceFile);
		}
	} finally {
		api.close();
	}

	/** Same-file declaration wins; a unique global match is accepted, collisions stay unresolved. */
	function resolveSchemaDeclaration(useFile, name) {
		const list = schemaDeclarations.get(name);
		if (!list || list.length === 0) return undefined;
		const local = list.find((item) => item.file === useFile);
		if (local) return local;
		return list.length === 1 ? list[0] : undefined;
	}

	/**
	 * Resolves a schema expression to its shape:
	 * "object" | "union-of-objects" | "union-scalar" | "other" | "unknown".
	 */
	function classify(node, file, depth = 0) {
		if (depth > 8) return "unknown";
		const method = typeCallMethod(node);
		if (method === "Object") return "object";
		if (method === "Optional" || method === "Readonly") {
			return node.arguments[0] ? classify(node.arguments[0], file, depth + 1) : "unknown";
		}
		if (method === "Union") {
			const branches = node.arguments[0];
			if (!branches || branches.kind !== SyntaxKind.ArrayLiteralExpression) return "unknown";
			const shapes = branches.elements.map((element) => {
				if (isIdentifier(element)) {
					const declaration = resolveSchemaDeclaration(file, element.text);
					if (!declaration) return "unknown";
					return classify(declaration.node, declaration.file, depth + 1);
				}
				return classify(element, file, depth + 1);
			});
			if (shapes.some((shape) => shape === "unknown")) return "unknown";
			if (shapes.some((shape) => shape === "object")) return "union-of-objects";
			return "union-scalar";
		}
		return "other";
	}

	for (const use of parametersUses) {
		const initializer = use.initializer;
		// Inline schema literal (Type.Object / Type.Union written directly) - classify it in place.
		if (!isIdentifier(initializer)) {
			const method = typeCallMethod(initializer);
			if (method === "Union" || method === "Object" || method === "Optional" || method === "Readonly") {
				toolFiles.add(use.file);
				if (classify(initializer, use.file) === "union-of-objects") {
					const { line, character } = use.sourceFile.getLineAndCharacterOfPosition(use.node.getStart(use.sourceFile));
					errors.push({
						file: use.file,
						line: line + 1,
						column: character + 1,
						message:
							"inline tool parameters is a top-level Type.Union of object branches (JSON Schema anyOf). " +
							"Flatten it to a single Type.Object and enforce branch requirements in execute.",
					});
				}
			}
			continue;
		}
		const declaration = resolveSchemaDeclaration(use.file, initializer.text);
		if (!declaration) {
			unresolved.push({ file: use.file, identifier: initializer.text, reason: "schema declared in another file" });
			continue;
		}
		toolFiles.add(use.file);
		const shape = classify(declaration.node, declaration.file);
		if (shape === "union-of-objects") {
			const { line, character } = use.sourceFile.getLineAndCharacterOfPosition(use.node.getStart(use.sourceFile));
			errors.push({
				file: use.file,
				line: line + 1,
				column: character + 1,
				message:
					`tool parameters "${initializer.text}" is a top-level Type.Union of object branches (JSON Schema anyOf). ` +
					`Flatten it to a single Type.Object and enforce branch requirements in execute.`,
			});
		} else if (shape === "unknown") {
			unresolved.push({ file: use.file, identifier: initializer.text, reason: "unresolved schema shape" });
		}
	}

	// Template check: only validation-flavored throws inside files that define tool parameters.
	for (const item of throwExpressions) {
		if (!toolFiles.has(item.file)) continue;
		const expression = item.node;
		let messageNode;
		if (isNewExpression(expression)) messageNode = expression.arguments?.[0];
		else if (isCallExpression(expression)) messageNode = expression.arguments?.[0];
		if (!messageNode) continue;
		const text = messageNode.getText?.(item.sourceFile);
		if (typeof text !== "string" || text.length === 0) continue;
		if (!VALIDATION_MESSAGE_PATTERN.test(text)) continue;
		if (hasTemplate(text)) continue;
		const { line, character } = item.sourceFile.getLineAndCharacterOfPosition(messageNode.getStart(item.sourceFile));
		warnings.push({
			file: item.file,
			line: line + 1,
			column: character + 1,
			message: `validation error has no copyable JSON template: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
		});
	}

	if (json) {
		console.log(JSON.stringify({ errors, warnings, unresolved, checked: parametersUses.length, toolFiles: [...toolFiles] }, null, 2));
	} else {
		for (const error of errors) console.error(`${relative(root, error.file)}:${error.line}:${error.column}: ${error.message}`);
		for (const warning of warnings)
			console.error(`${relative(root, warning.file)}:${warning.line}:${warning.column}: warning: ${warning.message}`);
		if (errors.length > 0) {
			console.error(`\n${errors.length} tool contract error(s). See .owl/skills/tool-schema-contract.md.`);
		}
		console.log(
			`Checked ${parametersUses.length} tool parameters schema(s) in ${toolFiles.size} file(s); ${unresolved.length} unresolved.`,
		);
		if (errors.length === 0) console.log("Tool contract OK.");
		if (warnings.length > 0) console.log(`${warnings.length} template warning(s) (not failing).`);
	}

	process.exit(errors.length > 0 ? 1 : 0);
}

main();
