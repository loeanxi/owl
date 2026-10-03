/** Plugin viewers run on their own local HTTP server, never on arbitrary websites. */
export function isWorkspaceViewerUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			!url.username &&
			!url.password &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}
