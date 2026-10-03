import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire('D:/owl/owl-re-v1/owl-mono/package.json');
const ts = require('typescript');
const root = 'D:/owl/owl-re-v1/owl-mono';
const source = await readFile(`${root}/packages/coding-agent/src/core/evaluation/service.ts`, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'service.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
  reportDiagnostics: true,
});
const errors = compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
if (!compiled.outputText.includes('thinking: thinking ?? ""') || !compiled.outputText.includes('generationPhase')) throw new Error('Compiled service is missing live thinking projection');
if (/from\s+["'][^"']+\.ts["']/.test(compiled.outputText)) throw new Error('Relative TypeScript imports were not rewritten');
await writeFile(`${root}/.validation/model-evaluation/service.candidate.js`, compiled.outputText);
console.log('Prepared the evaluation service module; the running service was not changed.');
