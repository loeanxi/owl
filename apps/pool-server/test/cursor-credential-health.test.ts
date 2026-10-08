import type { AddressInfo } from "node:net";
import { CheckInService, InMemoryAccountStore, InMemoryCheckInRecordStore } from "owl-pool";
import { expect, it } from "vitest";
import { createPoolServer } from "../src/server.ts";

it("checks Cursor's actual SDK authorization even when its database credentials object is empty", async () => {
	const accounts = new InMemoryAccountStore();
	const current = accounts.create({ name: "SDK account", platform: "CURSOR", credentials: {} }, 0);
	accounts.patchState(current.id, { credentialStatus: "ERROR", credentialMessage: "账号没有凭证" });
	const records = new InMemoryCheckInRecordStore();
	const checkin = new CheckInService({ accounts, records, providers: [] });
	const deps = {
		accounts,
		records,
		checkin,
		dbPath: "memory-only",
		isDbAlive: () => true,
		probeCredential: async () => ({ sdkAuthenticated: true, credentialSource: "ACCOUNT_HOME" }),
	};
	const server = createPoolServer(deps);
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	try {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/credentials/check/${current.id}`,
			{ method: "POST" },
		);
		const body = (await response.json()) as { data: { status: string } };
		expect(body.data.status).toBe("OK");
		const batch = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/credentials/check`, {
			method: "POST",
		});
		const batchBody = (await batch.json()) as { data: Array<{ status: string }> };
		expect(batchBody.data).toMatchObject([{ status: "OK" }]);
	} finally {
		await new Promise<void>((done) => server.close(() => done()));
	}
});
