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

	it("raises a published narrow window to a later full upstream and enables that route", () => {
		replacePlatformSnapshot(db, "TRAE", [
			{
				upstreamModel: "step-5-preview",
				name: "Step-5-Preview",
				catalogSource: "trae_live",
				contextWindow: 200_000,
				maxOutputTokens: 32_000,
				supportsImages: true,
				supportsTools: true,
				reasoningEfforts: ["high"],
			},
		]);
		const drafts = backfillDiscoveredDrafts(db, catalog, [account("TRAE")]);
		const published = batchPublish(catalog, [drafts[0]!.id]);
		expect(published[0]?.contextWindow).toBe(200_000);

		replacePlatformSnapshot(db, "WORKBUDDY", [
			{
				upstreamModel: "step-5-preview",
				name: "Step-5-Preview",
				catalogSource: "workbuddy_ui",
				contextWindow: 1_000_000,
				maxOutputTokens: 64_000,
				supportsImages: true,
				supportsTools: true,
			},
		]);
		expect(backfillDiscoveredDrafts(db, catalog, [account("TRAE"), account("WORKBUDDY")])).toEqual([]);
		const model = catalog.findPublishedByPublicId("step-5-preview");
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxOutputTokens).toBe(64_000);
		const workbuddy = catalog.routesOf(model!.id).find((route) => route.platform === "WORKBUDDY");
		expect(workbuddy?.priority).toBe(0);
		expect(workbuddy?.enabled).toBe(true);
		expect(catalog.routesOf(model!.id).find((route) => route.platform === "TRAE")?.priority).toBe(0);
		expect(workbuddy?.reasoningEfforts).toEqual(["high"]);
	});
});

function account(platform: "TRAE" | "WORKBUDDY") {
	return {
		id: platform,
		name: platform,
		platform,
		credentials: {},
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
}
