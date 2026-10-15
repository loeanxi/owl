import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { DEFAULT_FILE_ICON_THEME, parseFileIconTheme } from "./file-icon-theme.ts";
import { fontGlyph, iconFileName, type IconThemeManifest, languageIdOf, resolveIconId } from "./resolve.ts";

const seti = JSON.parse(readFileSync(new URL("./seti/vs-seti-icon-theme.json", import.meta.url), "utf8")) as IconThemeManifest;
const material = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("material-icon-theme/dist/material-icons.json"), "utf8")) as IconThemeManifest;

test("file names win over extensions, longer extensions over shorter, then language ids", () => {
	assert.equal(resolveIconId(seti, "tsconfig.json", "file", false), "_tsconfig");
	assert.equal(resolveIconId(seti, "README.md", "file", false), "_info");
	assert.equal(resolveIconId(seti, "foo.spec.ts", "file", false), "_typescript_1");
	assert.equal(resolveIconId(seti, "index.ts", "file", false), "_typescript");
	assert.equal(resolveIconId(seti, "App.tsx", "file", false), "_react");
	assert.equal(resolveIconId(seti, "Dockerfile", "file", false), "_docker");
	assert.equal(resolveIconId(seti, ".gitignore", "file", false), "_git");
	assert.equal(resolveIconId(seti, "unknown.xyz", "file", false), "_default");
});

test("light surfaces prefer the light overrides and fall back to the base associations", () => {
	assert.equal(resolveIconId(seti, "index.ts", "file", true), "_typescript_light");
	assert.equal(resolveIconId(material, "Cargo.toml", "file", true), "toml_light");
	assert.equal(resolveIconId(material, "index.ts", "file", true), "typescript");
});

test("folders resolve by name with open variants, and Seti has no folder icons", () => {
	assert.equal(resolveIconId(material, "src", "folder", false), "folder-src");
	assert.equal(resolveIconId(material, "SRC", "folderExpanded", false), "folder-src-open");
	assert.equal(resolveIconId(material, "zzz", "folder", false), "folder");
	assert.equal(resolveIconId(material, "zzz", "folderExpanded", false), "folder-open");
	assert.equal(resolveIconId(seti, "src", "folder", false), undefined);
});

test("every resolved Material id points to a bundled svg", () => {
	for (const name of ["package.json", "foo.spec.ts", "main.rs", "build.cmd", "notes.txt", "x.unknown"]) {
		const id = resolveIconId(material, name, "file", false);
		assert.ok(id !== undefined && material.iconDefinitions[id]?.iconPath?.endsWith(".svg"), name);
	}
	assert.equal(iconFileName("./../icons/git.svg"), "git.svg");
});

test("language ids come from the full file name first, then the last extension", () => {
	assert.equal(languageIdOf("Makefile"), "makefile");
	assert.equal(languageIdOf("docker-compose.yml"), "dockercompose");
	assert.equal(languageIdOf("a.b.ts"), "typescript");
	assert.equal(languageIdOf("noext"), undefined);
});

test("Seti font characters decode from their CSS escapes", () => {
	assert.equal(fontGlyph("\\E099"), "\uE099");
});

test("unknown saved theme values fall back to the default", () => {
	for (const id of ["none", "minimal", "seti", "material"]) assert.equal(parseFileIconTheme(id), id);
	for (const bad of [undefined, null, "vs-seti", "Material", 1]) assert.equal(parseFileIconTheme(bad), DEFAULT_FILE_ICON_THEME);
});
