// Pure C# backend-selection/readback checks. No window, UIA provider or input is opened.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The inbox .NET Framework compiler is Windows-only");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "owl-cu-uia-contract-"));
const framework = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
const csc = join(framework, "csc.exe");
function compile(args) {
	const result = spawnSync(csc, ["-nologo", ...args], { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
try {
	const helper = join(temporary, "OwlComputerUse.Uia.dll");
	compile([
		"-target:library", `-out:${helper}`, "-r:System.Web.Extensions.dll",
		...["UIAutomationClient", "UIAutomationTypes", "WindowsBase"].map((name) => `-r:${join(framework, "WPF", `${name}.dll`)}`),
		join(root, "src", "driver", "computer-uia.cs"),
	]);
	const source = join(temporary, "Contract.cs");
	writeFileSync(source, String.raw`
using System;
using System.Reflection;
using OwlComputerUse;
class Contract {
    static int passed;
    static object Call(string name, params object[] args) {
        MethodInfo method = typeof(UiaHelper).GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);
        if (method == null) throw new Exception("RED: missing production backend seam " + name);
        return method.Invoke(null, args);
    }
    static void Check(bool value, string label) { if (!value) throw new Exception(label); passed++; Console.WriteLine("PASS " + label); }
    static bool Candidate(string process, string root, string type, string child, bool writable, bool password) {
        return (bool)Call("CanUseNotepadRichEdit", process, root, type, child, writable, password);
    }
    static void Main() {
        Check(Candidate("Notepad", "Notepad", "Document", "RichEditD2DPT", true, false), "actual modern Notepad Document/RichEdit class can select the narrow candidate");
        foreach (string process in new string[] { "other", "NotepadClone", "Notepad.exe" }) Check(!Candidate(process, "Notepad", "Document", "RichEditD2DPT", true, false), "foreign process excluded: " + process);
        Check(!Candidate("Notepad", "Other", "Document", "RichEditD2DPT", true, false), "foreign root class excluded");
        Check(!Candidate("Notepad", "Notepad", "Edit", "RichEditD2DPT", true, false), "a different UIA control type is not broadly allowlisted");
        foreach (string child in new string[] { "CustomRichEdit", "RichEditD2DPTClone", "WindowsForms10.EDIT.test", "" }) Check(!Candidate("Notepad", "Notepad", "Document", child, true, false), "custom/empty child class excluded: " + child);
        Check(!Candidate("Notepad", "Notepad", "Document", "RichEditD2DPT", false, false), "read-only rich edit excluded");
        Check(!Candidate("Notepad", "Notepad", "Document", "RichEditD2DPT", true, true), "password rich edit excluded");
        Check((string)Call("SelectBackend", "set_value", true, -1, false) == "win32_edit_message", "known standard Edit keeps its message backend");
        Check((string)Call("SelectBackend", "set_value", true, -1, true) == "notepad_richedit_message", "narrow validated Notepad candidate has a distinct backend");
        Check((string)Call("SelectBackend", "invoke", true, -1, false) == "win32_button_notify", "known button keeps parent notification backend");
        Check((string)Call("SelectBackend", "toggle", true, -1, false) == "win32_checkbox_message", "known checkbox keeps message backend");
        Check((string)Call("SelectBackend", "select", true, 0, false) == "win32_listbox_message", "known single-selection ListBox keeps native backend");
        foreach (string action in new string[] { "invoke", "set_value", "select", "toggle", "scroll" }) Check((string)Call("SelectBackend", action, false, -1, false) == "uia_provider", "unknown provider is not presented as a nonactivating message backend: " + action);
        foreach (string backend in new string[] { "win32_edit_message", "win32_button_notify", "win32_checkbox_message", "win32_listbox_message" }) Check((bool)Call("BackendBackgroundSafe", backend), "existing verified native backend remains reachable in background: " + backend);
        Check(!(bool)Call("BackendBackgroundSafe", "uia_provider"), "unknown UIA setters require guarded foreground before any mutation");
        Check((bool)Call("BackendBackgroundSafe", "notepad_richedit_message"), "strict Notepad adapter is enabled after real owned-document nonactivation and persistence probes");
        Check(!(bool)Call("BackendBackgroundSafe", "unknown_backend"), "unrecognized backends cannot silently become background safe");
        Check((bool)Call("BackendMatchesExpected", "notepad_richedit_message", "notepad_richedit_message"), "actual receiver may use the exact planned Notepad backend");
        Check(!(bool)Call("BackendMatchesExpected", "notepad_richedit_message", "uia_provider"), "candidate receiver loss cannot fall through to an activating UIA setter");
        Check(!(bool)Call("BackendMatchesExpected", "win32_button_notify", "uia_provider"), "native button plan cannot silently become a provider invoke");
        Check((bool)Call("BackendMatchesExpected", "uia_provider", "uia_provider"), "explicit foreground provider plan remains executable");
        Check((bool)Call("TextValuesEqual", "a\nb", "a\rb"), "actual Notepad CR-only readback equals requested LF");
        Check((bool)Call("TextValuesEqual", "a\r\nb", "a\nb"), "CRLF and LF compare by text lines");
        Check((bool)Call("TextValuesEqual", "中文\nsecond\n", "中文\rsecond\r"), "Unicode and final newline are preserved");
        Check(!(bool)Call("TextValuesEqual", "a\nb", "a\nb\n"), "missing/extra final newline is not hidden by trimming");
        Check(!(bool)Call("TextValuesEqual", "a\nb", "a b"), "a missing newline is not mistaken for a valid write");
        Check(!(bool)Call("TextValuesEqual", "a\nb", "a\nwrong"), "wrong field content is never confirmed");
        Console.WriteLine(passed + " pure backend/readback contract checks passed; no desktop APIs were invoked.");
    }
}`);
	const executable = join(temporary, "Contract.exe");
	compile(["-target:exe", `-out:${executable}`, `-r:${helper}`, source]);
	const result = spawnSync(executable, [], { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	process.stdout.write(result.stdout);
} finally {
	const target = realpathSync(temporary);
	assert.ok(target.startsWith(`${realpathSync(tmpdir())}${sep}`) && target.includes("owl-cu-uia-contract-"));
	rmSync(target, { recursive: true, force: true });
}
