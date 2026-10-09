import { build } from "esbuild";
import { stampEsbuild } from "../../../scripts/stamp-build-info.mjs";

const hostExternals = [
	"@owl/owl-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
	"@sinclair/typebox",
];

const result = await build({
	entryPoints: ["./index.ts"],
	outfile: "./dist/index.js",
	metafile: true,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	sourcemap: false,
	legalComments: "inline",
	external: [
		...hostExternals,
		...hostExternals.map((id) => `${id}/*`),
		"node:*",
		// unpdf 的 pdfjs 可选原生依赖（仅图像渲染用，文本提取不需要）
		"canvas",
	],
	banner: {
		js: "// owl-web-access — ported from nicobailon/pi-web-access (MIT). Host SDK modules are provided by the owl agent at runtime.",
	},
});
stampEsbuild(result.metafile, { component: "plugin:owl-web-access", outDir: "./dist" });
console.log("Built dist/index.js");
