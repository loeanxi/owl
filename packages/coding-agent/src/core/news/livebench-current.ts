import type { NewsLeaderboardEntry } from "./types.ts";

const LIVEBENCH_URL = "https://livebench.ai/";

export interface CurrentLiveBenchResult {
	entries: NewsLeaderboardEntry[];
	codingEntries: NewsLeaderboardEntry[];
	updatedAt: string;
	dataUrl: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function literalString(value: string): string {
	if (value.startsWith('"')) return JSON.parse(value) as string;
	return value.slice(1, -1).replace(/\\(['\\])/g, "$1");
}

function stringField(source: string, key: string): string | undefined {
	const literal = source.match(new RegExp(`\\b${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`))?.[1];
	return literal ? literalString(literal).trim() || undefined : undefined;
}

function releaseMetadata(constants: string): { fileDate: string; updatedAt: string } {
	const declared = constants.match(/export\s+const\s+RELEASES\s*=\s*\[([^\]]*)\]/)?.[1];
	const releases = [...(declared?.matchAll(/["'](\d{4}-\d{2}-\d{2})["']/g) ?? [])].map((match) => match[1]!);
	const fileDate = releases.sort().at(-1);
	if (!fileDate) throw new Error("LiveBench 当前网站未声明评测版本");
	// LiveBench retains the data filename when updating a release, and publishes its current date separately.
	const labels = constants.match(/\bRELEASE_LABELS\s*=\s*\{([^}]*)\}/)?.[1];
	const label = [...(labels?.matchAll(/["'](\d{4}-\d{2}-\d{2})["']\s*:\s*["'](\d{4}-\d{2}-\d{2})["']/g) ?? [])].find(
		(match) => match[1] === fileDate,
	)?.[2];
	return { fileDate, updatedAt: label ?? fileDate };
}

/** Inspect published source text as data only; upstream JavaScript is never imported or executed. */
function publishedSource(sourceMap: unknown, filename: string): string {
	const map = record(sourceMap);
	if (!Array.isArray(map?.sources) || !Array.isArray(map.sourcesContent))
		throw new Error("LiveBench 当前网站的公开数据索引格式已变化");
	const index = map.sources.findIndex(
		(source) =>
			typeof source === "string" &&
			(source === filename || source.endsWith(`/${filename}`)) &&
			!/(?:^|\/)v1\//.test(source),
	);
	const content: unknown = map.sourcesContent[index];
	if (index < 0 || typeof content !== "string") throw new Error(`LiveBench 当前网站缺少 ${filename}`);
	return content;
}

function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const input = text.replace(/^\uFEFF/, "");
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === '"') {
			if (quoted && input[index + 1] === '"') {
				field += '"';
				index++;
			} else if (quoted || !field) quoted = !quoted;
			else throw new Error("LiveBench CSV 引号格式异常");
		} else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
			row.push(field);
			field = "";
			if (char !== ",") {
				if (row.some((cell) => cell.trim())) rows.push(row);
				row = [];
				if (char === "\r" && input[index + 1] === "\n") index++;
			}
		} else field += char;
	}
	if (quoted) throw new Error("LiveBench CSV 内容不完整");
	row.push(field);
	if (row.some((cell) => cell.trim())) rows.push(row);
	return rows;
}

interface ModelMetadata {
	name: string;
	organization?: string;
	url?: string;
	effort?: string;
}

function modelMetadata(text: string): Map<string, ModelMetadata> {
	const source = text.match(/export\s+const\s+modelLinks\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1];
	if (!source) throw new Error("LiveBench 当前模型目录格式已变化");
	const starts = [...source.matchAll(/^\s{4}["']([^"']+)["']\s*:\s*\{/gm)];
	const models = new Map<string, ModelMetadata>();
	for (const [index, match] of starts.entries()) {
		const body = source.slice((match.index ?? 0) + match[0].length, starts[index + 1]?.index ?? source.length);
		const base = body.split(/\b(?:variants|finetune)\s*:/)[0] ?? body;
		const rawUrl = stringField(base, "url");
		let url: string | undefined;
		if (rawUrl) {
			try {
				const candidate = new URL(rawUrl);
				if (/^https?:$/.test(candidate.protocol) && !candidate.username && !candidate.password)
					url = candidate.href;
			} catch {
				// Invalid optional model links do not invalidate the published scores.
			}
		}
		const model: ModelMetadata = {
			name: stringField(base, "displayName") ?? match[1]!,
			organization: stringField(base, "organization"),
			url,
			effort: stringField(base, "effort"),
		};
		models.set(match[1]!, model);
		const variants = body.match(/\bvariants\s*:\s*\[([\s\S]*?)\]/)?.[1];
		for (const variant of variants?.matchAll(/\{([^{}]*)\}/g) ?? []) {
			const id = stringField(variant[1]!, "rawName");
			if (id) models.set(id, { ...model, name: stringField(variant[1]!, "displayName") ?? model.name });
		}
	}
	if (!models.size) throw new Error("LiveBench 当前网站没有可识别的模型目录");
	return models;
}

function ranked(entries: NewsLeaderboardEntry[]): NewsLeaderboardEntry[] {
	entries.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	let rank = 0;
	return entries.map((entry, index) => {
		if (!index || entries[index - 1]?.score !== entry.score) rank = index + 1;
		return { ...entry, rank };
	});
}

/** Match the current site's equal-suite mean, including zero and excluding ungraded/n/a suites. */
export function parseCurrentLiveBenchData(
	csv: string,
	categoryData: unknown,
	metadata: string,
): Pick<CurrentLiveBenchResult, "entries" | "codingEntries"> {
	const categories = record(categoryData);
	if (!categories || !Object.keys(categories).length) throw new Error("LiveBench 当前评测领域格式已变化");
	const rows = parseCsv(csv);
	const headers = rows.shift();
	if (!headers?.includes("model") || new Set(headers).size !== headers.length)
		throw new Error("LiveBench 当前 CSV 缺少有效表头");
	const indexes = new Map<string, number[]>();
	for (const [category, columns] of Object.entries(categories)) {
		if (!Array.isArray(columns) || !columns.length || columns.some((column) => typeof column !== "string"))
			throw new Error("LiveBench 当前评测领域缺少子任务");
		const positions = columns.map((column) => headers.indexOf(column));
		if (positions.some((index) => index < 0)) throw new Error("LiveBench 当前 CSV 缺少评测子任务");
		indexes.set(category, positions);
	}
	if (!indexes.has("Coding")) throw new Error("LiveBench 当前版本未提供编程评测");
	const models = modelMetadata(metadata);
	const entries: NewsLeaderboardEntry[] = [];
	const codingEntries: NewsLeaderboardEntry[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (row.length !== headers.length) throw new Error("LiveBench 当前 CSV 列数不一致");
		const id = row[headers.indexOf("model")]?.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const model = models.get(id);
		if (!model) continue;
		const scores = new Map<string, number>();
		for (const [category, positions] of indexes) {
			const values = positions.flatMap((index) => {
				const raw = row[index]?.trim();
				if (!raw || /^(?:n\/a|na|null|-)$/i.test(raw)) return [];
				const value = Number(raw);
				if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("LiveBench 当前 CSV 包含无效分数");
				return [value];
			});
			if (values.length) scores.set(category, values.reduce((sum, value) => sum + value, 0) / values.length);
		}
		if (!scores.size) continue;
		const detail = ["LiveBench 2.0", model.effort ? `推理强度 ${model.effort}` : undefined]
			.filter(Boolean)
			.join(" · ");
		const entry: NewsLeaderboardEntry = {
			id,
			rank: 0,
			model: model.name,
			organization: model.organization,
			url: model.url,
			detail,
			score: Number(([...scores.values()].reduce((sum, value) => sum + value, 0) / scores.size).toFixed(2)),
		};
		entries.push(entry);
		const coding = scores.get("Coding");
		if (coding !== undefined) codingEntries.push({ ...entry, score: Number(coding.toFixed(2)) });
	}
	if (!entries.length || !codingEntries.length) throw new Error("LiveBench 当前版本没有可核验的综合与编程结果");
	return { entries: ranked(entries), codingEntries: ranked(codingEntries) };
}

/** Discover the CURRENT deployment, rather than the separate and outdated v1 GitHub repository. */
export async function fetchCurrentLiveBench(
	getText: (url: string) => Promise<string>,
): Promise<CurrentLiveBenchResult> {
	const html = await getText(LIVEBENCH_URL);
	const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
	const script = scripts
		.map((match) => new URL(match[1]!, LIVEBENCH_URL))
		.find(
			(url) => url.origin === new URL(LIVEBENCH_URL).origin && /\/static\/js\/main\.[\w-]+\.js$/.test(url.pathname),
		);
	if (!script) throw new Error("LiveBench 当前网站的数据入口已变化");
	const sourceMap = JSON.parse(await getText(`${script.origin}${script.pathname}.map`)) as unknown;
	const constants = publishedSource(sourceMap, "lib/constants.js");
	const metadata = publishedSource(sourceMap, "Table/modelLinks.js");
	const release = releaseMetadata(constants);
	// Official deployments reuse CSV filenames; a deployment hash prevents an old CDN copy being reused.
	const version = encodeURIComponent(script.pathname.split("/").at(-1)!);
	const suffix = `${release.fileDate.replaceAll("-", "_")}`;
	const dataUrl = new URL(`table_${suffix}.csv?v=${version}`, LIVEBENCH_URL).href;
	const categoriesUrl = new URL(`categories_${suffix}.json?v=${version}`, LIVEBENCH_URL).href;
	const [csv, categories] = await Promise.all([getText(dataUrl), getText(categoriesUrl)]);
	return {
		...parseCurrentLiveBenchData(csv, JSON.parse(categories) as unknown, metadata),
		updatedAt: release.updatedAt,
		dataUrl,
	};
}
