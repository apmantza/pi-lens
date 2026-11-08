/**
 * The whole-content sha256 of a byte buffer has one owner: `hashContentBytes`
 * in `clients/content-stamp.ts`. Twelve production sites used to spell
 * `createHash("sha256").update(bytes).digest("hex")` themselves
 * (partial-edit-apply, review-graph builder x2, fix-run-restore,
 * read-guard-tool-lines, observed-mutation x2, opaque-mutation-scan,
 * managed-tool-refresh x2, installer archive integrity, grammar-source), so a
 * change to the seam's algorithm or encoding left them on their own digest.
 *
 * Recurrence this guards: a former bypass site stops delegating to the seam,
 * or the seam's digest drifts from the plain sha256 the stores on disk and the
 * pinned manifests hold. Each cell drives a former site through its exported
 * production caller and compares with a digest this file derives itself, so a
 * mutation of the seam (an extra update, a constant) reds the cell instead of
 * staying consistent on both sides of a comparison. The sites with no exported
 * caller are witnessed by their existing behaviour suites (see the PR body).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashContentBytes } from "../../clients/content-stamp.js";
import { grammarFileSha256 } from "../../clients/grammar-source.js";
import { captureFileStatsForPaths } from "../../clients/opaque-mutation-scan.js";
import { PartialApplyRecordStore } from "../../clients/partial-edit-apply.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

// Not valid UTF-8 and carries a NUL: a text-mode or string-typed digest of
// these bytes differs from the digest of the bytes themselves.
const BINARY = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0xff, 0xfe, 0x80, 0x0a]);

function independentSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("whole-content sha256 owner (content-stamp)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let file: string;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-content-hash-fold-");
		file = path.join(env.tmpDir, "payload.bin");
		fs.writeFileSync(file, BINARY);
	});

	afterEach(() => removeTempDirSync(env.tmpDir));

	it("the seam answers the plain sha256 hex of the bytes", () => {
		expect(hashContentBytes(BINARY)).toBe(independentSha256(BINARY));
	});

	it("an applied-edit record without a recorded hash stamps the file's sha256", () => {
		const store = new PartialApplyRecordStore();
		store.record(file, "old text", "new text");
		expect(store.find(file, "old text", "new text")?.contentHash).toBe(
			independentSha256(BINARY),
		);
	});

	it("an applied-edit record over an unreadable file carries no hash", () => {
		const store = new PartialApplyRecordStore();
		const missing = path.join(env.tmpDir, "absent.bin");
		store.record(missing, "old text", "new text");
		expect(
			store.find(missing, "old text", "new text")?.contentHash,
		).toBeUndefined();
	});

	it("the opaque stat-diff capture hashes a file's bytes with the same digest", async () => {
		const { snapshot } = await captureFileStatsForPaths([file], {
			withHashes: true,
		});
		const hashes = [...snapshot.values()].map((entry) => entry.hash);
		expect(hashes).toEqual([independentSha256(BINARY)]);
	});

	it("a grammar file's pinned-hash comparison value is sha256:<plain hex>", () => {
		expect(grammarFileSha256(file)).toBe(`sha256:${independentSha256(BINARY)}`);
	});
});
