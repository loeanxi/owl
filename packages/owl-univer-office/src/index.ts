import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, registerWorkspaceViewer } from "@owl/owl-coding-agent";
import { OfficeRuntime } from "./runtime.ts";
import { registerOfficeTools } from "./tools.ts";

let runtime: OfficeRuntime | undefined;
let unregisterViewer: (() => void) | undefined;
let owners = 0;

function getRuntime(): OfficeRuntime {
	runtime ??= new OfficeRuntime({
		assetRoot:
			process.env.OWL_UNIVER_RUNTIME_ROOT?.trim() ||
			join(getAgentDir(), "cache", "univer-office", "runtime", "node_modules", "dsh-univer-office"),
		license: process.env.UNIVER_LICENSE?.trim(),
		browserExecutablePath: process.env.UNIVER_RENDER_BROWSER?.trim(),
	});
	return runtime;
}

export default function univerOffice(pi: ExtensionAPI): void {
	owners += 1;
	if (!unregisterViewer) {
		unregisterViewer = registerWorkspaceViewer({
			id: "univer-office",
			title: "Office",
			extensions: ["univer", "xlsx", "docx", "pptx"],
			open: (request) => getRuntime().open(request),
		});
	}
	registerOfficeTools(pi, { call: (operation, args, cwd, signal) => getRuntime().call(operation, args, cwd, signal) });
	let disposed = false;
	pi.on("session_shutdown", async () => {
		if (disposed) return;
		disposed = true;
		owners -= 1;
		if (owners > 0) return;
		unregisterViewer?.();
		unregisterViewer = undefined;
		const closing = runtime;
		runtime = undefined;
		await closing?.dispose();
	});
}
