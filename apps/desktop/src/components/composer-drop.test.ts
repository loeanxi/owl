import assert from "node:assert/strict";
import test from "node:test";
import { classifyHtmlDrop, dropPointHits, fileUrlToPath, splitDroppedPaths } from "./composer-drop.ts";

test("system drops keep every non-image path, including audio and extensionless files", () => {
	const split = splitDroppedPaths([
		"C:\\Users\\李现\\Music\\DD Ma Shawty.mp3",
		"D:/notes/readme.md",
		"D:/shots/cover.PNG",
		"D:/shots/cover.PNG",
		"D:/bin/firmware",
		"  ",
	]);
	assert.deepEqual(split.images, ["D:/shots/cover.PNG"]);
	assert.deepEqual(split.attachments, [
		"C:\\Users\\李现\\Music\\DD Ma Shawty.mp3",
		"D:/notes/readme.md",
		"D:/bin/firmware",
	]);
});

test("html drops read images from the file list and other types from path or file uri", () => {
	const classified = classifyHtmlDrop(
		[
			{ name: "cover.png", type: "image/png" },
			{ name: "song.mp3", type: "", path: "C:/Music/song.mp3" },
			{ name: "orphan.docx", type: "" },
		],
		"file:///D:/docs/spec.pdf\r\n# comment\r\nfile:///C:/Music/song.mp3\r\n",
	);
	assert.deepEqual(classified.imageIndexes, [0]);
	assert.deepEqual(classified.attachmentPaths, ["C:/Music/song.mp3", "D:/docs/spec.pdf"]);
	assert.equal(classified.unnamedCount, 1);
});

test("html drops count files that have neither a path nor a file uri", () => {
	const classified = classifyHtmlDrop([{ name: "blob.bin", type: "application/octet-stream" }], "");
	assert.deepEqual(classified.attachmentPaths, []);
	assert.equal(classified.unnamedCount, 1);
});

test("file urls on windows drop the leading slash before the drive letter", () => {
	assert.equal(fileUrlToPath("file:///C:/Users/%E6%9D%8E%E7%8E%B0/Music/a.mp3"), "C:/Users/李现/Music/a.mp3");
	assert.equal(fileUrlToPath("https://example.com/a.mp3"), undefined);
});

test("drop hit testing accepts physical pixels and css pixels, and ignores a hidden box", () => {
	const rect = { left: 100, top: 400, right: 900, bottom: 520 };
	assert.equal(dropPointHits(rect, { x: 200, y: 450 }, 1), true);
	assert.equal(dropPointHits(rect, { x: 400, y: 900 }, 2), true);
	assert.equal(dropPointHits(rect, { x: 10, y: 10 }, 2), false);
	assert.equal(dropPointHits({ left: 0, top: 0, right: 0, bottom: 0 }, { x: 0, y: 0 }, 1), false);
});
