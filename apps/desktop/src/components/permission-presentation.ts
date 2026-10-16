import { permissionDialogText } from "./permission-dialog-copy.ts";

/** Describe only known tool semantics; the original input remains the approval source of truth. */
export function permissionActionTitle(toolName: string, input: unknown): string {
	const args = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const path = typeof args?.path === "string" ? args.path : "";
		const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
		if (name) return permissionDialogText(toolName === "read" ? "readFile" : toolName === "write" ? "writeFile" : "editFile", { name });
	}
	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof args?.command === "string" ? args.command.trim() : "";
		if (/^npm[ \t]+run[ \t]+check$/.test(command)) return permissionDialogText("runCheck");
		return permissionDialogText(toolName === "bash" ? "runBash" : "runPowerShell");
	}
	return permissionDialogText("toolAction", { tool: toolName });
}
