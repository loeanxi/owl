import { build } from "esbuild";
import { stampEsbuild } from "../../../scripts/stamp-build-info.mjs";

const hostExternals = ["@owl/owl-coding-agent", "typebox", "@sinclair/typebox"];

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
	external: [...hostExternals, ...hostExternals.map((id) => `${id}/*`), "node:*"],
	banner: {
		js: "// owl-github — ported from amitkot/pi-tools safe-github 0.2.0 (MIT). Host SDK modules are provided by the owl agent at runtime.",
	},
});
stampEsbuild(result.metafile, { component: "plugin:owl-github", outDir: "./dist" });
console.log("Built dist/index.js");
