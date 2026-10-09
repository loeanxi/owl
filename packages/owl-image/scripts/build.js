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
	entryPoints: ["./src/index.ts"],
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
		// undici 是运行时依赖（代理感知 fetch）：保持 external 由 node_modules 解析,
		// 打进 ESM bundle 会让它的 CJS require 在 jiti 加载时炸掉。
		"undici",
		"undici/*",
	],
	banner: {
		js: "// owl-image — image generation for the Owl coding agent. Core capability adapted from shanliuling/dsh-image-gen (Apache-2.0). Host SDK modules are provided by the owl agent at runtime.",
	},
});
stampEsbuild(result.metafile, { component: "plugin:owl-image", outDir: "./dist" });
console.log("Built dist/index.js");
