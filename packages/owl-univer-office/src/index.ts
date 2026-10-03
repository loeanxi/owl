import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, registerWorkspaceViewer } from "@owl/owl-coding-agent";
import { renderOfficeOperation } from "./render.ts";
import { resourceOfficeOperation } from "./resources.ts";
import { OfficeRuntime, type OfficeRuntimeOptions } from "./runtime.ts";
import { registerOfficeTools } from "./tools.ts";

let runtime: OfficeRuntime | undefined;
let options: OfficeRuntimeOptions | undefined;
let unregisterViewer: (() => void) | undefined;
let owners = 0;

function getRuntime(): OfficeRuntime {
	if (runtime) return runtime;
	const license = process.env.UNIVER_LICENSE?.trim();
	const browserExecutablePath = process.env.UNIVER_RENDER_BROWSER?.trim();
	options = {
		assetRoot:
			process.env.OWL_UNIVER_RUNTIME_ROOT?.trim() ||
			join(getAgentDir(), "cache", "univer-office", "runtime", "node_modules", "dsh-univer-office"),
		...(license ? { license } : {}),
		...(browserExecutablePath ? { browserExecutablePath } : {}),
	};
	runtime = new OfficeRuntime(options);
	return runtime;
}

async function callOfficeOperation(
	operation: string,
	args: Record<string, unknown>,
	cwd: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const office = getRuntime();
	if (!options) throw new Error("Office runtime configuration is unavailable.");
	if (operation === "resources")
		return resourceOfficeOperation(
			args,
			cwd,
			{
				assetRoot: options.assetRoot,
				cacheRoot: join(getAgentDir(), "cache", "univer-office", "resources"),
			},
			signal,
		);
	if (["screenshot", "print_pdf", "lint", "compile_svg"].includes(operation)) {
		return renderOfficeOperation(office, operation, args, cwd, options, signal);
	}
	return office.call(operation, args, cwd, signal);
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
	registerOfficeTools(pi, { call: callOfficeOperation });
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
		options = undefined;
		await closing?.dispose();
	});
}
