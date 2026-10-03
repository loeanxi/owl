/** Open a URL in the default browser, platform-appropriately. */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			// `start` is a cmd builtin; the empty title argument guards URLs with `&`.
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// The URL is also surfaced as text; failing to auto-open is not fatal.
	}
}
