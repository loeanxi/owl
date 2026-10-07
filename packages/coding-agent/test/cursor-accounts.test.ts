import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	clearCursorAccounts,
	credentialFromAccount,
	listCursorAccountsPublic,
	removeCursorAccount,
	switchCursorAccount,
	upsertCursorAccount,
	withCursorAccountSync,
} from "../src/modes/desktop/cursor-accounts.ts";

function oauth(partial: Partial<OAuthCredential> & Pick<OAuthCredential, "access" | "refresh">): OAuthCredential {
	return {
		type: "oauth",
		expires: Date.now() + 3600_000,
		...partial,
	};
}

it("upserts multiple Cursor accounts and switches the active one", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "owl-cursor-accounts-"));
	try {
		upsertCursorAccount(
			agentDir,
			oauth({ access: "a1", refresh: "r1", email: "one@example.com", accountId: "acc-1" }),
		);
		upsertCursorAccount(
			agentDir,
			oauth({ access: "a2", refresh: "r2", email: "two@example.com", accountId: "acc-2" }),
		);
		const listed = listCursorAccountsPublic(agentDir);
		expect(listed).toHaveLength(2);
		expect(listed.find((a) => a.id === "acc-2")?.active).toBe(true);

		const switched = switchCursorAccount(agentDir, "acc-1");
		expect(switched.access).toBe("a1");
		expect(listCursorAccountsPublic(agentDir).find((a) => a.id === "acc-1")?.active).toBe(true);
		expect(credentialFromAccount(switched).type).toBe("oauth");

		removeCursorAccount(agentDir, "acc-1");
		const after = listCursorAccountsPublic(agentDir);
		expect(after).toHaveLength(1);
		expect(after[0]?.id).toBe("acc-2");
		expect(after[0]?.active).toBe(true);

		clearCursorAccounts(agentDir);
		expect(listCursorAccountsPublic(agentDir)).toHaveLength(0);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("withCursorAccountSync mirrors auth.json cursor OAuth writes into the pool", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "owl-cursor-sync-"));
	try {
		const storage = withCursorAccountSync(AuthStorage.create(join(agentDir, "auth.json")), agentDir);
		await storage.modify("cursor", async () =>
			oauth({ access: "ax", refresh: "rx", email: "sync@example.com", accountId: "acc-sync" }),
		);
		const listed = listCursorAccountsPublic(agentDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe("acc-sync");
		expect(listed[0]?.active).toBe(true);

		await storage.modify("cursor", async () =>
			oauth({ access: "ax2", refresh: "rx2", email: "sync@example.com", accountId: "acc-sync" }),
		);
		expect(listCursorAccountsPublic(agentDir)).toHaveLength(1);
		const active = switchCursorAccount(agentDir, "acc-sync");
		expect(active.access).toBe("ax2");
		expect(active.refresh).toBe("rx2");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
