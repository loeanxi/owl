import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MailStore, type MailStoreData } from "../src/core/mail/store.js";

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("mail credential store", () => {
	it.skipIf(process.platform !== "win32")("protects and recovers credentials with the current Windows user's DPAPI", async () => {
		const directory = await mkdtemp(join(tmpdir(), "owl-mail-store-test-"));
		directories.push(directory);
		const store = new MailStore(directory);
		const state: MailStoreData = {
			client: { clientId: "test.apps.googleusercontent.com", clientSecret: "dpapi-fixture-secret" },
			accounts: [{ id: "gmail-test", email: "work@example.com", label: "Work", status: "connected", scopes: [], accessToken: "dpapi-fixture-token", refreshToken: "dpapi-fixture-refresh" }],
		};
		await store.save(state);
		const persisted = await readFile(store.path, "utf8");
		expect(persisted).toContain("windows-dpapi");
		expect(persisted).not.toContain("dpapi-fixture-secret");
		expect(persisted).not.toContain("dpapi-fixture-token");
		expect(persisted).not.toContain("dpapi-fixture-refresh");
		expect(await new MailStore(directory).load()).toEqual(state);
	}, 10_000);

	it("serializes concurrent protected writes and rejects incompatible protection modes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "owl-mail-store-test-"));
		directories.push(directory);
		const seal = async (value: string) => Buffer.from(value).toString("base64");
		const unseal = async (value: string) => Buffer.from(value, "base64").toString("utf8");
		const store = new MailStore(directory, seal, unseal);
		await Promise.all([store.save({ accounts: [], client: { clientId: "first", clientSecret: "secret" } }), store.save({ accounts: [], client: { clientId: "second", clientSecret: "secret" } })]);
		expect(await store.load()).toMatchObject({ client: { clientId: "second" } });
		await expect(new MailStore(directory).load()).rejects.toThrow("无法解锁");
	});
});
