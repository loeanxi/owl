import { build } from "esbuild";

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
		js: "// owl-safety-net — engine vendored from kenryu42/cc-safety-net 2.4.15 (MIT), entry rewritten for the Owl extension API.",
	},
});
console.log("Built dist/index.js");
