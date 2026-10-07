import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	backfillDiscoveredDrafts,
	batchPublish,
	listDiscovered,
	replacePlatformSnapshot,
	verifyDiscovered,
} from "../src/catalog/discovery.ts";
import { openDb } from "../src/store/db.ts";
import { SqliteCatalogStore } from "../src/store/gateway-stores.ts";

const dir = mkdtempSync(join(tmpdir(), "owl-discovery-"));
const db = openDb(join(dir, "pool.db"));
const catalog = new SqliteCatalogStore(db);

afterAll(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("discovered models", () => {
	it("stores a snapshot, creates an unpublished draft, then publishes and verifies it", () => {
		replacePlatformSnapshot(db, "CLAUDE", [
			{
				upstreamModel: "claude-sonnet-4-5",
				name: "Claude Sonnet",
				catalogSource: "claude_static",
				contextWindow: 200000,
				supportsImages: true,
				supportsTools: true,
			},
		]);
		const listed = listDiscovered(db);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.upstreamModel).toBe("claude-sonnet-4-5");
		expect(listed[0]?.available).toBe(true);

		const drafts = backfillDiscoveredDrafts(db, catalog, [
			{
				id: "acct",
				name: "claude",
				platform: "CLAUDE",
				credentials: {},
				enabled: true,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.published).toBe(false);
		expect(drafts[0]?.publicId).toBe("claude-sonnet-4-5");

		const published = batchPublish(catalog, [drafts[0]!.id]);
		expect(published[0]?.published).toBe(true);

		const verified = verifyDiscovered(db, String(listed[0]?.id), {
			verifiedModelVersion: "20250929",
			supportsImages: true,
			supportsTools: true,
			reasoningEfforts: ["high"],
			verificationSource: "manual",
		});
		expect(verified.verificationStatus).toBe("VERIFIED");
		expect(verified.modelVersion).toBe("20250929");
	});
});
