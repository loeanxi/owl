import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensionsCached } from "../../src/core/extensions/loader.ts";

type Counters = { moduleLoads: number; factoryCalls: number };

function counters(): Counters {
	const g = globalThis as unknown as {
		__owlExtModuleLoads?: number;
		__owlExtFactoryCalls?: number;
	};
	return { moduleLoads: g.__owlExtModuleLoads ?? 0, factoryCalls: g.__owlExtFactoryCalls ?? 0 };
}

let tempDir: string;
let extFile: string;
let cwdA: string;
let cwdB: string;

const SOURCE = `
const g = globalThis as any;
g.__owlExtModuleLoads = (g.__owlExtModuleLoads ?? 0) + 1;
export default function () {
	g.__owlExtFactoryCalls = (g.__owlExtFactoryCalls ?? 0) + 1;
}
`;

beforeEach(() => {
	tempDir = join(tmpdir(), `owl-ext-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const extDir = join(tempDir, "ext");
	cwdA = join(tempDir, "a");
	cwdB = join(tempDir, "b");
	mkdirSync(extDir, { recursive: true });
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	extFile = join(extDir, "probe.ts");
	writeFileSync(extFile, SOURCE);
	const g = globalThis as unknown as { __owlExtModuleLoads?: number; __owlExtFactoryCalls?: number };
	g.__owlExtModuleLoads = 0;
	g.__owlExtFactoryCalls = 0;
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

describe("extension module cache", () => {
	it("keeps the module across workspace changes but still runs the factory per workspace", async () => {
		await loadExtensionsCached([extFile], cwdA);
		expect(counters()).toEqual({ moduleLoads: 1, factoryCalls: 1 });

		// 换工作目录：模块不再重新求值（省掉一次 jiti 求值），工厂仍然按新目录再跑一遍。
		await loadExtensionsCached([extFile], cwdB);
		expect(counters()).toEqual({ moduleLoads: 1, factoryCalls: 2 });

		// 回到第一个目录：依然命中缓存。
		await loadExtensionsCached([extFile], cwdA);
		expect(counters()).toEqual({ moduleLoads: 1, factoryCalls: 3 });
	});

	it("reloads the module after the extension file changes", async () => {
		await loadExtensionsCached([extFile], cwdA);
		expect(counters().moduleLoads).toBe(1);

		// 改完插件代码：文件指纹变了，下次加载必须重新求值。
		writeFileSync(extFile, `${SOURCE}\n// touched\n`);
		const future = new Date(Date.now() + 5000);
		utimesSync(extFile, future, future);

		await loadExtensionsCached([extFile], cwdA);
		expect(counters().moduleLoads).toBe(2);
		expect(counters().factoryCalls).toBe(2);
	});

	it("does not share a workspace-local extension with another workspace", async () => {
		const localDir = join(cwdA, ".owl", "extensions");
		mkdirSync(localDir, { recursive: true });
		const localFile = join(localDir, "local.ts");
		writeFileSync(localFile, SOURCE);

		await loadExtensionsCached([localFile], cwdA);
		expect(counters().moduleLoads).toBe(1);

		// 另一个工作目录里的同名扩展是另一个文件：不能共用缓存。
		const otherDir = join(cwdB, ".owl", "extensions");
		mkdirSync(otherDir, { recursive: true });
		const otherFile = join(otherDir, "local.ts");
		writeFileSync(otherFile, SOURCE);

		await loadExtensionsCached([otherFile], cwdB);
		expect(counters().moduleLoads).toBe(2);
	});
});
