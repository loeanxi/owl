// Native integration checks only touch this script's own WinForms fixture.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Native checks require Windows");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageRoot, "..", "..");
const temporary = mkdtempSync(join(tmpdir(), "owl-cu-native-test-"));
const csc = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const fixtureSource = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using OwlComputerUse;
class PassiveForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { CreateParams value = base.CreateParams; value.ExStyle |= 0x08000000; return value; } }
}
class Fixture {
    [STAThread] static void Main() {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true });
        Console.SetIn(new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false)));
        Kernel.Initialize();
        Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs error) {
            Console.Error.WriteLine("Fixture UI exception: " + error.Exception.ToString());
            Environment.Exit(2);
        };
        int[] point = Kernel.NormalizeCoordinates(-1919, 0, -1920, 0, 3840, 1080);
        if (point[0] < 0 || point[0] > 65535) throw new Exception("negative desktop mapping");
        try { Kernel.NormalizeCoordinates(-1921, 0, -1920, 0, 3840, 1080); throw new Exception("outside point accepted"); }
        catch (ArgumentOutOfRangeException) { }
        bool background = Environment.GetEnvironmentVariable("OWL_NATIVE_TEST_BACKGROUND") == "1";
        long originalForeground = DesktopGuard.ForegroundHwnd();
        Form form = background ? new PassiveForm() : new Form();
        form.Text = "Owl native isolated fixture"; form.Location = new Point(180,140); form.Size = new Size(520,320);
        form.StartPosition = FormStartPosition.Manual; form.TopMost = !background; form.KeyPreview = true;
        TextBox text = new TextBox { Name = "NativeTestText", Location = new Point(30,40), Size = new Size(360,30) };
        TextBox password = new TextBox { Location = new Point(30,90), Size = new Size(360,30), UseSystemPasswordChar = true, Text = "private-fixture-value" };
        Button button = new Button { Text = "NativeTestInvoke", Location = new Point(30,145), Size = new Size(150,35) };
        CheckBox toggle = new CheckBox { Text = "NativeTestToggle", Location = new Point(220,150), Size = new Size(200,30) };
        ListBox selection = new ListBox { Location = new Point(30,200), Size = new Size(260,55) };
        selection.Items.AddRange(new object[] { "NativeTestFirst", "NativeTestSecond" }); selection.SelectedIndex = 0;
        int invokes = 0; button.Click += delegate { invokes++; };
        bool shortcut = false;
        form.KeyDown += delegate(object sender, KeyEventArgs key) {
            if (key.Control && key.KeyCode == Keys.A) { shortcut = true; text.SelectAll(); key.SuppressKeyPress = true; }
        };
        form.Controls.AddRange(new Control[] { text, password, button, toggle, selection });
        JavaScriptSerializer json = new JavaScriptSerializer();
        Action state = delegate { Console.WriteLine(json.Serialize(new { hwnd = form.Handle.ToInt64(), originalForeground = originalForeground, foreground = DesktopGuard.ForegroundHwnd(), text = text.Text, invokes = invokes, toggled = toggle.Checked, shortcut = shortcut, selected = selection.SelectedIndex, minimized = form.WindowState == FormWindowState.Minimized })); Console.Out.Flush(); };
        form.Shown += delegate {
            if (!background) text.Focus(); state();
            new Thread(delegate() {
                string command;
                while ((command = Console.ReadLine()) != null) {
                    if (command == "quit") { form.BeginInvoke(new Action(form.Close)); break; }
                    string current = command;
                    form.BeginInvoke(new Action(delegate {
                        if (current == "move") form.Left += 25;
                        if (current == "minimize") form.WindowState = FormWindowState.Minimized;
                        if (current == "restore") { form.WindowState = FormWindowState.Normal; form.Activate(); }
                        if (current == "external_input") { form.Activate(); text.Focus(); Kernel.TypeText("q"); }
                        state();
                    }));
                }
            }) { IsBackground = true }.Start();
        };
        Application.Run(form);
    }
}`;
let fixture;
let extraFixture;
let openedFixturePid;
let fixtureErrors = "";
const workers = [];
const fixtureReplies = [];
let nextFixtureReply;
let passed = 0;
function check(condition, label) {
	assert.ok(condition, label);
	passed++;
	process.stdout.write(`PASS ${label}\n`);
}
function compile(args) {
	const result = spawnSync(csc, ["-nologo", ...args], { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
async function fixtureState(command) {
	if (command) fixture.stdin.write(`${command}\n`);
	if (fixtureReplies.length) return fixtureReplies.shift();
	return await new Promise((resolveReply, reject) => {
		const timer = setTimeout(() => reject(new Error(`Fixture reply timed out: ${fixtureErrors}`)), 5000);
		nextFixtureReply = (reply) => { clearTimeout(timer); resolveReply(reply); };
	});
}
async function worker() {
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(packageRoot, "src", "driver", "computer-driver.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OWL_COMPUTER_USE_NATIVE_TEST: "1" } });
	workers.push(child);
	let nextId = 1;
	const pending = new Map();
	const ready = new Promise((resolveReady, rejectReady) => {
		const timer = setTimeout(() => rejectReady(new Error("Native worker ready timed out")), 30000);
		createInterface({ input: child.stdout }).on("line", (line) => {
			const response = JSON.parse(line);
			if (response.event === "ready") { clearTimeout(timer); resolveReady(); }
			else if (response.event === "error") { clearTimeout(timer); rejectReady(new Error(response.message)); }
			else {
				const request = pending.get(response.id);
				if (request) { pending.delete(response.id); clearTimeout(request.timer); request.resolve(response); }
			}
		});
	});
	await ready;
	return {
		ask: async (request) => await new Promise((resolveReply, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => reject(new Error(`Native ${request.cmd} timed out`)), 20000);
			pending.set(id, { resolve: resolveReply, timer });
			child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
		}),
	};
}
try {
	const kernel = join(temporary, "OwlComputerUse.Kernel.dll");
	compile(["-target:library", `-out:${kernel}`, "-r:System.Drawing.dll", join(packageRoot, "src", "driver", "computer-kernel.cs")]);
	if (process.argv.includes("--scope-unit")) {
		const scopeSource = join(temporary, "ScopeUnit.cs");
		writeFileSync(scopeSource, String.raw`
using System;
using System.Reflection;
using OwlComputerUse;
class ScopeUnit {
    static void Main() {
        MethodInfo read = typeof(DesktopGuard).GetMethod("WindowRevision");
        MethodInfo record = typeof(DesktopGuard).GetMethod("RecordExternalInput", BindingFlags.Static | BindingFlags.NonPublic);
        if (read == null || record == null) throw new Exception("RED: native input guard has only desktop-global revision; unrelated-window input cannot be separated");
        long a = (long)read.Invoke(null, new object[] { 101L });
        long global = DesktopGuard.UserRevision;
        record.Invoke(null, new object[] { 202L, 202L, true });
        if ((long)read.Invoke(null, new object[] { 101L }) != a) throw new Exception("unrelated input invalidated background target");
        if (DesktopGuard.UserRevision <= global) throw new Exception("exclusive SendInput guard stopped observing unrelated input");
        record.Invoke(null, new object[] { 101L, 101L, false });
        if ((long)read.Invoke(null, new object[] { 101L }) != a) throw new Exception("hover invalidated target");
        record.Invoke(null, new object[] { 101L, 101L, true });
        if ((long)read.Invoke(null, new object[] { 101L }) == a) throw new Exception("same-window input was ignored");
        a = (long)read.Invoke(null, new object[] { 101L });
        record.Invoke(null, new object[] { 303L, 101L, true });
        if ((long)read.Invoke(null, new object[] { 101L }) == a) throw new Exception("owned-dialog input did not fence owner");
        Console.WriteLine("PASS isolated scope classifier: unrelated window allowed; target/owned-dialog guarded; global SendInput guard retained");
    }
}`);
		const scopeExe = join(temporary, "ScopeUnit.exe");
		compile(["-target:exe", `-out:${scopeExe}`, `-r:${kernel}`, scopeSource]);
		const scopeResult = spawnSync(scopeExe, [], { encoding: "utf8", windowsHide: true });
		assert.equal(scopeResult.status, 0, `${scopeResult.stdout}\n${scopeResult.stderr}`);
		process.stdout.write(scopeResult.stdout);
	} else {
	const fixturePath = join(temporary, "Fixture.cs");
	writeFileSync(fixturePath, fixtureSource);
	const fixtureExe = join(temporary, "Fixture.exe");
	// A GUI subsystem avoids an automatically activated console before the passive
	// form can capture its initial foreground. Redirected Console streams still work.
	compile(["-target:winexe", `-out:${fixtureExe}`, `-r:${kernel}`, "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", "-r:System.Web.Extensions.dll", fixturePath]);
	const auto = process.argv.includes("--auto");
	const background = process.argv.includes("--background") || auto;
	fixture = spawn(fixtureExe, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(background ? { OWL_NATIVE_TEST_BACKGROUND: "1" } : {}) } });
	fixture.stderr.setEncoding("utf8");
	fixture.stderr.on("data", (chunk) => { fixtureErrors = (fixtureErrors + chunk).slice(-4000); });
	createInterface({ input: fixture.stdout }).on("line", (line) => {
		const reply = JSON.parse(line);
		if (nextFixtureReply) { const resolveReply = nextFixtureReply; nextFixtureReply = undefined; resolveReply(reply); }
		else fixtureReplies.push(reply);
	});
	const initial = await fixtureState();
	const first = await worker();
	const second = await worker();
	const observe = async (engine = first, image = false) => {
		for (let attempt = 0; attempt < 4; attempt++) {
			const response = await engine.ask({ cmd: "observe", hwnd: initial.hwnd, includeImage: image, maxWidth: image ? 256 : 640, quality: 70, captureKernelPath: join(workspace, "packages", "coding-agent", "src", "modes", "desktop", "mirror", "windows-capture.cs") });
			assert.equal(response.ok, true, response.error);
			if (process.env.OWL_NATIVE_TEST_DEBUG === "1" && response.data.diagnostics?.some((message) => message.startsWith("observation_changed:"))) process.stdout.write(`${JSON.stringify(response.data.diagnostics)}\n`);
			if (!response.data.diagnostics?.some((message) => message.startsWith("observation_changed:"))) return response.data;
		}
		throw new Error("Desktop remained in use during fixture observations");
	};
	if (auto) {
		const original = initial.originalForeground;
		let snapshot = await observe(first, true);
		await first.ask({ cmd: "_test_input", hwnd: original, interaction: true });
		let response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "type", replace: true, elementId: snapshot.elements.find((element) => element.controlType === "Edit" && !element.password).id, text: "自动后台中文" });
		check(response.data.status === "confirmed" && response.data.executedMode === "background" && response.data.executedAction === "set_value", `auto replacement chooses verified background Value without foreground takeover (${JSON.stringify(response.data ?? response)})`);
		check((await fixtureState("state")).text === "自动后台中文" && (await fixtureState("state")).foreground !== initial.hwnd, "auto background writes and reads Chinese while target stays behind the user's app");
		snapshot = await observe();
		check(snapshot.elements.find((element) => element.controlType === "Edit" && !element.password)?.value === "自动后台中文", "actual observation exposes non-password text for model readback");
		check(snapshot.elements.filter((element) => element.password).every((element) => element.value === undefined && element.text === undefined), "actual observation never exposes password values or text");
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "click", elementId: snapshot.elements.find((element) => element.name === "NativeTestInvoke").id });
		check(["issued", "confirmed"].includes(response.data.status) && response.data.executedMode === "background" && response.data.executedAction === "invoke" && (await fixtureState("state")).invokes === 1, `auto click uses Invoke and independently verifies the button effect (${JSON.stringify(response.data ?? response)})`);
		snapshot = await observe();
		const beforeBusy = await fixtureState("state");
		await first.ask({ cmd: "_test_input", hwnd: original, interaction: true });
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "key", down: [17], tap: [65] });
		const afterBusy = await fixtureState("state");
		check(response.data.status === "blocked" && response.data.retryable === true && afterBusy.foreground === beforeBusy.foreground, `busy user's input defers exclusive fallback without stealing focus (${JSON.stringify({ result: response.data ?? response, before: beforeBusy.foreground, after: afterBusy.foreground })})`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 850));
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "click", elementId: snapshot.elements.find((element) => element.controlType === "Edit" && !element.password).id });
		check(response.data.status === "issued" && response.data.executedMode === "foreground", `auto input falls back to real foreground click after quiet and focuses the edit (${JSON.stringify(response.data ?? response)})`);
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "key", down: [17], tap: [65] });
		await new Promise((resolveWait) => setTimeout(resolveWait, 80));
		check(response.data.status === "issued" && (await fixtureState("state")).shortcut, "auto foreground shortcut arrives after a recoverable busy response");
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "type", text: "灵活前后台闭环" });
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		check(response.data.status === "issued" && response.data.executedMode === "foreground" && (await fixtureState("state")).text === "灵活前后台闭环", "auto insert preserves type semantics and real Unicode input is independently read back");
		snapshot = await observe();
		check(snapshot.elements.find((element) => element.controlType === "Edit" && !element.password)?.value === "灵活前后台闭环", "foreground Unicode result is also readable through the model's actual observation");
		await first.ask({ cmd: "release" });
		const openSource = join(temporary, "OpenFixture.cs");
		writeFileSync(openSource, String.raw`using System; using System.Drawing; using System.Windows.Forms;
class OpenFixture { [STAThread] static void Main() { Form form = new Form { Text = "Owl auto launched fixture", Size = new Size(400,220) }; form.Controls.Add(new TextBox { Name = "OpenFixtureText", Location = new Point(20,40), Width = 300 }); Timer timer = new Timer { Interval = 15000 }; timer.Tick += delegate { form.Close(); }; timer.Start(); Application.Run(form); } }`);
		const openExe = join(temporary, "OpenFixture.exe");
		compile(["-target:winexe", `-out:${openExe}`, "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", openSource]);
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "open_app", app: openExe });
		check(["issued", "confirmed"].includes(response.data.status), `missing-app launch accepts a normal executable without a shell (${JSON.stringify(response.data)})`);
		for (let attempt = 0; attempt < 12; attempt++) {
			const listed = await first.ask({ cmd: "windows" });
			const opened = listed.data.windows.find((window) => window.title === "Owl auto launched fixture");
			if (opened) {
				openedFixturePid = opened.pid;
				const launched = await first.ask({ cmd: "observe", hwnd: opened.hwnd, includeImage: false });
				check(launched.data.elements.some((element) => element.controlType === "Edit"), "launched application's actual UIA tree is observable");
				break;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 150));
		}
		check(openedFixturePid !== undefined, "open_app produces the requested real window");
		process.stdout.write(`${passed} automatic-routing native checks passed; background and foreground effects independently verified.\n`);
	} else if (background) {
		const original = initial.originalForeground;
		check(initial.foreground === original && initial.hwnd !== original, "passive AI fixture does not activate or focus the user's window");
		let snapshot = await observe(first, true);
		check(snapshot.capabilities.backgroundUia && snapshot.capabilities.uia, "native advertises background UIA separately from real input");
		check(snapshot.screenshot?.imageWidth === 256, "passive window capture produces a model image");
		await first.ask({ cmd: "_test_input", hwnd: original, interaction: true });
		let response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "set_value", elementId: snapshot.elements.find((element) => element.controlType === "Edit" && !element.password).id, text: "后台中文" });
		check(response.data.status === "confirmed" && (await fixtureState("state")).text === "后台中文", "unrelated-window input does not reject background Value action");
		check((await fixtureState("state")).foreground === original, "background Value preserves original foreground");
		for (const [action, name, field, expected] of [["invoke", "NativeTestInvoke", "invokes", 1], ["toggle", "NativeTestToggle", "toggled", true], ["select", "NativeTestSecond", "selected", 1]]) {
			snapshot = await observe();
			await first.ask({ cmd: "_test_input", hwnd: original, interaction: true });
			response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action, elementId: snapshot.elements.find((element) => element.name === name).id });
			const state = await fixtureState("state");
			check(["confirmed", "issued"].includes(response.data.status) && state[field] === expected, `background ${action} executes and is independently read back (${JSON.stringify({ result: response.data ?? response, actual: state[field], expected })})`);
			check(state.foreground === original, `background ${action} preserves original foreground`);
		}
		extraFixture = spawn(fixtureExe, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OWL_NATIVE_TEST_BACKGROUND: "1" } });
		const extra = await new Promise((resolveReply, reject) => {
			const timeout = setTimeout(() => reject(new Error("Second passive fixture timed out")), 5000);
			createInterface({ input: extraFixture.stdout }).once("line", (line) => { clearTimeout(timeout); resolveReply(JSON.parse(line)); });
		});
		const other = (await second.ask({ cmd: "observe", hwnd: extra.hwnd, includeImage: false })).data;
		response = await second.ask({ cmd: "act", observationId: other.observationId, action: "set_value", elementId: other.elements.find((element) => element.controlType === "Edit" && !element.password).id, text: "second-window" });
		check(response.data.status === "confirmed", "different-window UIA worker is not blocked by another window lease");
		await second.ask({ cmd: "release" });
		const same = await observe(second);
		response = await second.ask({ cmd: "act", observationId: same.observationId, action: "invoke", elementId: same.elements.find((element) => element.name === "NativeTestInvoke").id });
		check(response.data.code === "target_busy", "same-window concurrent controller remains blocked");
		snapshot = await observe();
		await first.ask({ cmd: "_test_input", hwnd: initial.hwnd, interaction: false });
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "set_value", elementId: snapshot.elements.find((element) => element.controlType === "Edit" && !element.password).id, text: "hover-safe" });
		check(response.data.status === "confirmed", "crossing or hovering over AI window does not count as editing");
		snapshot = await observe();
		await first.ask({ cmd: "_test_input", hwnd: initial.hwnd, interaction: true });
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "set_value", elementId: snapshot.elements.find((element) => element.controlType === "Edit" && !element.password).id, text: "must-not-overwrite" });
		check(response.data.code === "target_intervened" && (await fixtureState("state")).text === "hover-safe", "same-window user edit fences UIA mutation");
		snapshot = await observe();
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "type", inputMode: "background", text: "must-not-type" });
		check(response.data.code === "exclusive_required" && response.data.requiresExclusive, "explicit background mode cannot silently inject real input");
		snapshot = await observe();
		await first.ask({ cmd: "_test_input", hwnd: original, interaction: true });
		response = await first.ask({ cmd: "act", observationId: snapshot.observationId, action: "type", inputMode: "foreground", text: "must-not-type" });
		check(response.data.code === "user_intervened", "explicit foreground input retains desktop-global intervention guard");
		check((await fixtureState("state")).foreground === original, "background suite preserves user's original foreground throughout");
		process.stdout.write(`${passed} background native checks passed; no focus, pointer or keyboard injection was performed.\n`);
	} else {
	let observation = await observe();
	check(observation.target.hwnd === initial.hwnd && observation.capabilities.uia, "UIA observes only owned fixture");
	if (process.env.OWL_NATIVE_TEST_DEBUG === "1") process.stdout.write(`${JSON.stringify(observation)}\n`.replaceAll("private-fixture-value", "[unexpected secret]"));
	check(observation.elements.some((element) => element.password && element.name === "[password]"), "password metadata omits secret value");
	check(!JSON.stringify(observation).includes("private-fixture-value"), "password content is absent");
	const edit = observation.elements.find((element) => element.controlType === "Edit" && !element.password);
	check(edit?.patterns.includes("Value"), "editable ref exposes Value pattern");
	let result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "set_value", elementId: edit.id, text: "native-contract-中文" });
	if (process.env.OWL_NATIVE_TEST_DEBUG === "1") process.stdout.write(`${JSON.stringify(result)}\n`);
	check(result.ok && result.data.status === "confirmed", "set_value confirms exact readback");
	check((await fixtureState("state")).text === "native-contract-中文", "independent target state preserves UTF8 Chinese");
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "set_value", elementId: edit.id, text: "wrong" });
	check(result.data.code === "stale_observation", "single use observation rejects replay");
	let contender = await observe(second);
	const contenderEdit = contender.elements.find((element) => element.controlType === "Edit" && !element.password);
	result = await second.ask({ cmd: "act", observationId: contender.observationId, action: "set_value", elementId: contenderEdit.id, text: "wrong" });
	check(result.data.code === "target_busy", "cross process window mutex blocks concurrent controller");
	const releaseResult = await first.ask({ cmd: "release" });
	if (process.env.OWL_NATIVE_TEST_DEBUG === "1") process.stdout.write(`${JSON.stringify(releaseResult)}\n`);
	contender = await observe(second);
	result = await second.ask({ cmd: "act", observationId: contender.observationId, action: "set_value", elementId: contenderEdit.id, text: "second-owner" });
	if (process.env.OWL_NATIVE_TEST_DEBUG === "1") process.stdout.write(`${JSON.stringify(result)}\n`);
	check(result.data.status === "confirmed", "release transfers native control");
	await second.ask({ cmd: "release" });
	observation = await observe();
	await fixtureState("move");
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "invoke", elementId: observation.elements.find((element) => element.name === "NativeTestInvoke").id });
	check(result.data.code === "geometry_changed", "window movement invalidates snapshot");
	observation = await observe();
	await fixtureState("external_input");
	await new Promise((resolveWait) => setTimeout(resolveWait, 80));
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "set_value", elementId: edit.id, text: "wrong" });
	check(result.data.code === "target_intervened", "target input triggers takeover revision");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "invoke", elementId: observation.elements.find((element) => element.name === "NativeTestInvoke").id });
	check(result.data.status === "issued", "Invoke reports issued rather than false confirmed");
	await first.ask({ cmd: "release" });
	observation = await observe(first, true);
	check(observation.screenshot?.imageWidth === 256 && observation.screenshot.screenWidth > 256, "WGC shrinks model image while preserving physical geometry");
	check(observation.diagnostics.includes("capture_backend: wgc"), "existing WGC kernel captures owned window");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "toggle", elementId: observation.elements.find((element) => element.name === "NativeTestToggle").id });
	check(result.data.status === "confirmed" && (await fixtureState("state")).toggled, "Toggle changes and reads back owned checkbox");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "select", elementId: observation.elements.find((element) => element.name === "NativeTestSecond").id });
	check(result.data.status === "confirmed" && (await fixtureState("state")).selected === 1, "SelectionItem selects and reads back owned list item");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "focus", inputMode: "foreground" });
	check(result.data.status === "confirmed", "foreground focus verifies owned fixture");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "click", inputMode: "foreground", elementId: observation.elements.find((element) => element.controlType === "Edit" && !element.password).id });
	check(result.data.status === "issued", `real mouse clicks owned editable UIA ref (${JSON.stringify(result.data)})`);
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "key", inputMode: "foreground", down: [17], tap: [65] });
	await new Promise((resolveWait) => setTimeout(resolveWait, 80));
	check(result.data.status === "issued" && (await fixtureState("state")).shortcut, "Ctrl+A shortcut reaches owned control with Control modifier");
	observation = await observe();
	result = await first.ask({ cmd: "act", observationId: observation.observationId, action: "type", inputMode: "foreground", text: "键鼠中文" });
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	const typedState = await fixtureState("state");
	check(result.data.status === "issued" && result.data.typedCharacters === 4 && typedState.text === "键鼠中文", `real Unicode typing is independently read back (${JSON.stringify({ result: result.data, text: typedState.text })})`);
	await first.ask({ cmd: "release" });
	await fixtureState("minimize");
	observation = await observe(first, true);
	const minimized = await fixtureState("state");
	check(minimized.minimized && !observation.screenshot, "observe never restores minimized target");
	result = await first.ask({ cmd: "click", x: 0, y: 0 });
	check(!result.ok && result.error.includes("legacy_action_requires_observation"), "unsafe legacy mutation path is closed");
	check(readFileSync(join(packageRoot, "src", "driver", "computer-driver.ps1")).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "PowerShell source preserves UTF8 BOM");
	process.stdout.write(`${passed} native checks passed; only the isolated fixture was changed.\n`);
	}
	}
} finally {
	for (const child of workers) child.kill();
	if (fixture && !fixture.killed) fixture.kill();
	if (extraFixture && !extraFixture.killed) extraFixture.kill();
	if (openedFixturePid !== undefined) {
		try { process.kill(openedFixturePid); } catch { /* The owned timed fixture may have exited already. */ }
	}
	await new Promise((resolveWait) => setTimeout(resolveWait, 300));
	const resolved = realpathSync(temporary);
	assert.ok(resolved.startsWith(`${realpathSync(tmpdir())}${sep}`) && resolved.includes("owl-cu-native-test-"));
	rmSync(resolved, { recursive: true, force: true });
}
