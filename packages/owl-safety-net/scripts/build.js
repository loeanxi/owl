import { build } from "esbuild";
import { stampEsbuild } from "../../../scripts/stamp-build-info.mjs";

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
	external: ["@owl/owl-coding-agent", "node:*"],
	banner: {
		js: "// owl-safety-net — engine vendored from kenryu42/cc-safety-net 2.4.15 (MIT), entry rewritten for the Owl extension API.",
	},
});
stampEsbuild(result.metafile, { component: "plugin:owl-safety-net", outDir: "./dist" });
console.log("Built dist/index.js");
