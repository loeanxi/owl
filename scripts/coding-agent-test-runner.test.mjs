import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import { isImportDeclaration, isNamedImports, isStringLiteral } from "typescript/unstable/ast/is";
import { API } from "typescript/unstable/sync";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageDir = join(root, "packages", "coding-agent");
const ignoredDirectories = new Set([".git", "coverage", "dist", "build", "node_modules", "target", ".artifacts"]);

function collectTests(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) files.push(...collectTests(path));
		else if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
	}
	return files.sort();
}

// Vitest cannot execute node:test declarations; every discovered file must use its configured runner.
test("coding-agent tests all import the Vitest runner", () => {
	const files = ["src", "test"].flatMap((directory) => collectTests(join(packageDir, directory)));
	assert.ok(files.length > 0, "No coding-agent test files were found");
	const configPath = join(packageDir, "tsconfig.test-runner-guard.json");
	const config = JSON.stringify({
		compilerOptions: { allowJs: true, noResolve: true, noLib: true, types: [] },
		files,
	});
	const api = new API({
		cwd: root,
		fs: {
			fileExists: (path) => (resolve(path) === configPath ? true : undefined),
			readFile: (path) => (resolve(path) === configPath ? config : undefined),
		},
	});
	const failures = [];
	try {
		const program = api.updateSnapshot({ openProjects: [configPath] }).getProject(configPath).program;
		for (const file of files) {
			const source = program.getSourceFile(file);
			assert.ok(source, `Could not parse ${relative(packageDir, file)}`);
			const imports = new Set();
			for (const statement of source.statements) {
				if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue;
				const clause = statement.importClause;
				const bindings = clause?.namedBindings;
				if (clause?.phaseModifier === SyntaxKind.TypeKeyword) continue;
				if (bindings && !clause.name && isNamedImports(bindings) && bindings.elements.length > 0 &&
					bindings.elements.every((element) => element.isTypeOnly)) continue;
				imports.add(statement.moduleSpecifier.text);
			}
			const path = relative(packageDir, file).split("\\").join("/");
			if (!imports.has("vitest")) failures.push(`${path}: missing a runtime import from vitest`);
			if (imports.has("node:test")) failures.push(`${path}: node:test declarations are not run by Vitest`);
		}
	} finally {
		api.close();
	}
	assert.deepEqual(failures, [], failures.join("\n"));
});

test("coding-agent does not exempt files that failed to collect", () => {
	const exemptions = readFileSync(join(packageDir, "test", "known-failures.txt"), "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => !line.startsWith("#") && / > \(file\)$/.test(line));
	assert.deepEqual(exemptions, [], "Collection failures must fail the run, even for known failing tests");
});
