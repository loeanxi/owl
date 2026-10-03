import { build } from "esbuild";

// 内核（vendor/acp-kernel/dist）打进 bundle；宿主 API 与 node 内建保持 external。
await build({
	entryPoints: ["./src/index.ts"],
	outfile: "./dist/index.js",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	sourcemap: false,
	legalComments: "inline",
	external: ["@owl/owl-coding-agent", "node:*"],
	banner: {
		js: "// owl-billion-context — engine vendored from npm acp-kernel@0.0.100 (MIT), integration layer ported from ranxianglei/billion-context-pi (MIT) for the Owl extension API.",
	},
});
console.log("Built dist/index.js");
