import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setUiLanguage } from "../i18n/index.ts";
import { permissionActionTitle } from "./permission-presentation.ts";

afterEach(() => setUiLanguage("zh"));

test("known file actions name only their exact basename and retain the caller's complete input", () => {
	setUiLanguage("zh");
	const path = "D:\\很长的项目路径\\子目录\\中文 report.ts";
	const input = { path, offset: 17, limit: 83, content: "原文 <tag> & 引号" };
	const original = JSON.stringify(input);
	assert.equal(permissionActionTitle("read", input), "读取 中文 report.ts");
	assert.equal(permissionActionTitle("write", input), "写入 中文 report.ts");
	assert.equal(permissionActionTitle("edit", input), "编辑 中文 report.ts");
	assert.equal(JSON.stringify(input), original);
});

test("only the complete project-check command earns that action label", () => {
	setUiLanguage("zh");
	assert.equal(permissionActionTitle("bash", { command: "  npm run check  " }), "运行项目检查");
	for (const command of ["npm run check && echo done", "echo npm run check", "npm\nrun\ncheck", "npm run check; upload result"]) {
		assert.equal(permissionActionTitle("bash", { command }), "运行 Bash 命令");
		assert.equal(permissionActionTitle("powershell", { command }), "运行 PowerShell 命令");
	}
});

test("unknown tools name the requested operation without inferring effects from arbitrary JSON", () => {
	setUiLanguage("zh");
	for (const input of [null, 42, ["delete", "upload"], '<script>not executable</script>', { command: "delete everything", path: "private/file", safe: true }]) {
		assert.equal(permissionActionTitle("custom_tool", input), "确认 custom_tool 操作");
	}
});

test("action labels follow English while names and command contents remain exact", () => {
	setUiLanguage("en");
	assert.equal(permissionActionTitle("read", { path: "/work/中文.md" }), "Read 中文.md");
	assert.equal(permissionActionTitle("write", { path: "/work/中文.md" }), "Write 中文.md");
	assert.equal(permissionActionTitle("edit", { path: "/work/中文.md" }), "Edit 中文.md");
	assert.equal(permissionActionTitle("custom_tool", { command: "anything" }), "Confirm custom_tool operation");
	const input = { command: '\n  echo "你好 & <原文>"\r\n  ' };
	const original = input.command;
	assert.equal(permissionActionTitle("powershell", input), "Run a PowerShell command");
	assert.equal(input.command, original);
});
