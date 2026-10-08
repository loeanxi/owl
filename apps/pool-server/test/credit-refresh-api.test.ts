import type { AddressInfo } from "node:net";
import { CheckInService, InMemoryAccountStore, InMemoryCheckInRecordStore } from "owl-pool";
import { expect, it } from "vitest";
import { createPoolServer } from "../src/server.ts";

it("reports unavailable balance capabilities separately from failed refreshes in the batch API", async () => {
	const accounts = new InMemoryAccountStore();
	const records = new InMemoryCheckInRecordStore();
	accounts.create({ name: "supported", platform: "ZCODE", credentials: {} }, 0);
	accounts.create({ name: "no balance endpoint", platform: "MIMO", credentials: {} }, 0);
	accounts.create({ name: "failed query", platform: "CURSOR", credentials: {} }, 0);
	const checkin = new CheckInService({ accounts, records, providers: [] });
	const server = createPoolServer({
		accounts,
		records,
		checkin,
		dbPath: "memory-only",
		isDbAlive: () => true,
		refreshCredit: async (account) =>
			accounts.patchState(account.id, {
				creditsStatus: account.platform === "MIMO" ? "UNAVAILABLE" : account.platform === "ZCODE" ? "OK" : "FAIL",
			}),
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	try {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/accounts/credits/refresh`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { total: number; ok: number; unavailable: number; failed: number };
		};
		expect(body.data).toMatchObject({ total: 3, ok: 1, unavailable: 1, failed: 1 });
	} finally {
		await new Promise<void>((closed, reject) => server.close((error) => (error ? reject(error) : closed())));
	}
});
