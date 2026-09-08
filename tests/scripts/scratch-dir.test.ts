import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
	SCRATCH_OWNER_FILE,
	sweepScratchDirs,
} from "../../scripts/lib/scratch-dir.mjs";
import { sweepLeftovers } from "../../scripts/smoke-tools.mjs";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("scratch directory ownership (#2688/#2687)", () => {
	it("preserves a live owner and removes a dead owner", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-scratch-test-"),
		);
		roots.push(root);
		const live = claimScratchDir(root, "pi-lens-smoke-");
		const dead = fs.mkdtempSync(path.join(root, "pi-lens-smoke-dead-"));
		fs.writeFileSync(path.join(dead, SCRATCH_OWNER_FILE), "999999999");

		expect(sweepScratchDirs(root, "pi-lens-smoke-")).toBe(1);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(dead)).toBe(false);
	});

	it("makes smoke-tools use the same live-owner gate", () => {
		const live = claimScratchDir(SCRATCH_DIR_ROOT, "pi-lens-smoke-");
		try {
			sweepLeftovers();
			expect(fs.existsSync(live)).toBe(true);
		} finally {
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	it("uses the age fallback only for directories without owner.pid", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-scratch-test-"),
		);
		roots.push(root);
		const young = fs.mkdtempSync(path.join(root, "pi-lens-smoke-young-"));
		const old = fs.mkdtempSync(path.join(root, "pi-lens-smoke-old-"));
		const oldTime = new Date(Date.now() - 2_000);
		fs.utimesSync(old, oldTime, oldTime);

		expect(sweepScratchDirs(root, "pi-lens-smoke-", { maxAgeMs: 1_000 })).toBe(
			1,
		);
		expect(fs.existsSync(young)).toBe(true);
		expect(fs.existsSync(old)).toBe(false);
	});
});
