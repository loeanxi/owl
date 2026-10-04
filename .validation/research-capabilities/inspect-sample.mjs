import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runResearchExecutable, buildResearchExecutableResult } from '../../packages/coding-agent/src/core/research/executable-tools.ts';
import { normalizeResearchResult } from '../../packages/coding-agent/src/core/research/agent.ts';

const workspace = resolve(import.meta.dirname, '../..');
const output = resolve(import.meta.dirname);
const input = 'D:\\tool\\mhub\\MCHOSE HUB\\MCHOSE HUB.exe';
const report = await runResearchExecutable({ path: input }, workspace);
const result = buildResearchExecutableResult(report);
const { id: _id, createdAt: _createdAt, ...card } = result;
normalizeResearchResult(card);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'MCHOSE-HUB-report.json'), JSON.stringify({ report, result }, null, 2), 'utf8');
console.log(JSON.stringify({
  file: report.executable?.file,
  architecture: report.executable?.architecture,
  format: report.executable?.format,
  entryPoint: report.executable?.entryPoint,
  sections: report.executable?.sections.map(section => ({ name: section.name, rawSize: section.rawSize, entropy: section.entropy })),
  imports: report.executable?.imports.length,
  truncated: report.executable?.truncated,
  stringCoverage: report.executable?.stringsScan,
  packerIndicators: report.executable?.packerIndicators,
  warnings: report.executable?.warnings,
  app: report.container?.package,
  container: report.container?.container,
  entries: report.container?.entries.length,
  jsc: report.container?.entries.filter(entry => entry.path.endsWith('.jsc')),
  javascript: report.container?.javascript,
  executedTarget: report.executedTarget,
  resultRows: result.rows.length,
}, null, 2));
