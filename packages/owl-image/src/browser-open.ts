/** Open a URL in the default browser, platform-appropriately. */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			// rundll32's FileProtocolHandler opens the default browser directly, with
			// no cmd shell in between, so `&` in OAuth query strings survives. The
			// tempting alternatives are broken: `cmd /c start "" <url>` truncates at
			// the first `&` (Node passes args to cmd.exe verbatim, and cmd treats
			// `&` as a command separator — Google then rejects the login with 400
			// invalid_request "Missing required parameter: client_id"), and
			// `explorer <url>` silently opens nothing on some machines.
			spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// The URL is also surfaced as text; failing to auto-open is not fatal.
	}
}
