import { build } from "esbuild";

const hostExternals = [
	"@owl/owl-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
	"@sinclair/typebox",
];

await build({
	entryPoints: ["./src/index.ts"],
	outfile: "./dist/index.js",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	sourcemap: false,
	legalComments: "inline",
	external: [...hostExternals, ...hostExternals.map((id) => `${id}/*`), "node:*"],
	banner: {
		js: "// owl-image — image generation for the Owl coding agent. Core capability adapted from shanliuling/dsh-image-gen (Apache-2.0). Host SDK modules are provided by the owl agent at runtime.",
	},
});
console.log("Built dist/index.js");
