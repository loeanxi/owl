import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../../node_modules/esbuild/lib/main.js";
import { compile } from "../../node_modules/@tailwindcss/node/dist/index.mjs";
import { Scanner } from "../../node_modules/@tailwindcss/oxide/index.js";

export const directory = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(directory, "../..");
export const output = join(directory, "public");

/** Compile the actual desktop entry without its native bridge or a production build. */
export async function buildHarness() {
  const source = join(repo, "apps/desktop/src");
  await mkdir(output, { recursive: true });
  const bundle = await build({
    entryPoints: [join(source, "main.tsx")], outdir: output,
    entryNames: "app", bundle: true, write: false, format: "iife", platform: "browser",
    target: "chrome120", jsx: "automatic", nodePaths: [join(repo, "node_modules")],
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    metafile: true,
    plugins: [{ name: "compile-tailwind-separately", setup(builder) {
      builder.onLoad({ filter: /[\\/]src[\\/]index\.css$/ }, () => ({ contents: "", loader: "css" }));
    } }],
  });
  const indexCss = await readFile(join(source, "index.css"), "utf8");
  const compiler = await compile(indexCss, { base: source, from: join(source, "index.css"), onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: source, pattern: "**/*.{ts,tsx}", negated: false }] });
  const importedCss = bundle.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");
  await writeFile(join(output, "app.js"), bundle.outputFiles.filter((file) => file.path.endsWith(".js")).map((file) => file.text).join("\n"));
  await writeFile(join(output, "app.css"), compiler.build(scanner.scan()) + "\n" + importedCss);
  await writeFile(join(output, "index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OWL 研究模式 · 隔离验证</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  const evidence = { actualApp: true, bridge: "offline WebSocket fixture", paidCalls: 0, sources: {} };
  for (const file of Object.keys(bundle.metafile.inputs).filter((name) => /App\.tsx|ChatStream\.tsx|Composer\.tsx|features[\\/]research/.test(name))) {
    const path = resolve(file);
    evidence.sources[file] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  await writeFile(join(directory, "build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = await buildHarness();
  console.log(`Actual desktop App compiled; ${Object.keys(evidence.sources).length} relevant source hashes recorded.`);
}
