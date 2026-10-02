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
	entryPoints: ["./index.ts"],
	outfile: "./dist/index.js",
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
	],
	banner: {
		js: "// owl-web-access — ported from nicobailon/pi-web-access (MIT). Host SDK modules are provided by the owl agent at runtime.",
	},
});
console.log("Built dist/index.js");
