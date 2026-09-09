/**
 * Tests for scripts/lib/compat-contract-resolution.mjs — the seam that
 * resolves and checks every pinned contract independently (#2581, #2680 F2).
 *
 * #2680 F2: the orchestrator used to keep TWO parallel registries
 * (`CONTRACTS` and a `CONTRACT_SOURCE_LOCATIONS` map) joined by a bare
 * string id with no parity guard and no test — adding a contract to one
 * without the other threw a `TypeError` reading `packageKey` and blinded
 * every OTHER contract's result too, the same "one problem blinds all
 * seven" shape #2581 itself was about. `parts`/`package` are now folded
 * directly into each `CONTRACTS` entry (a structural join, not a string
 * one), and this file exercises the resulting `resolveAndCheckContracts`
 * directly against a small on-disk fixture — a real join-desync bug like F2
 * is now impossible to express, so there is nothing left to regress-test
 * for it beyond exercising the real (folded) shape end to end here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAndCheckContracts } from "../../scripts/lib/compat-contract-resolution.mjs";

// A minimal 3-contract fixture registry exercising each of the three
// outcomes at once, independent of the real 7-contract CONTRACTS list.
const FIXTURE_CONTRACTS = [
	{
		id: "fixture.verified",
		package: "fixture-pkg-a",
		description: "passes when FLAG=1 is present",
		check: (source: string) => {
			const pass = source.includes("FLAG=1");
			return { pass, detail: pass ? "FLAG=1 present" : "FLAG=1 missing" };
		},
		parts: [
			{
				name: "source",
				candidates: [{ path: "src/a.ts", observedAt: "1.0.0" }],
			},
		],
	},
	{
		id: "fixture.drift",
		package: "fixture-pkg-b",
		description: "passes when FLAG=1 is present",
		check: (source: string) => {
			const pass = source.includes("FLAG=1");
			return { pass, detail: pass ? "FLAG=1 present" : "FLAG=1 missing" };
		},
		parts: [
			{
				name: "source",
				candidates: [{ path: "src/b.ts", observedAt: "1.0.0" }],
			},
		],
	},
	{
		id: "fixture.infra",
		package: "fixture-pkg-c",
		description: "passes when FLAG=1 is present",
		check: (source: string) => {
			const pass = source.includes("FLAG=1");
			return { pass, detail: pass ? "FLAG=1 present" : "FLAG=1 missing" };
		},
		parts: [
			{
				name: "source",
				// Package "c" never ships this path in the fixture below —
				// exercises the infra outcome (file not found anywhere).
				candidates: [{ path: "src/c-moved.ts", observedAt: "1.0.0" }],
			},
		],
	},
];

describe("resolveAndCheckContracts", () => {
	let installDir: string;

	beforeEach(() => {
		installDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "compat-resolution-fixture-"),
		);
		fs.mkdirSync(path.join(installDir, "node_modules/fixture-pkg-a/src"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(installDir, "node_modules/fixture-pkg-b/src"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(installDir, "node_modules/fixture-pkg-c/src"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(installDir, "node_modules/fixture-pkg-a/src/a.ts"),
			"const FLAG=1;",
		);
		fs.writeFileSync(
			path.join(installDir, "node_modules/fixture-pkg-b/src/b.ts"),
			"const FLAG=0; // drifted",
		);
		// fixture-pkg-c has NO src/c-moved.ts — only an unrelated file — so
		// the contract's only candidate resolves nowhere (infra).
		fs.writeFileSync(
			path.join(installDir, "node_modules/fixture-pkg-c/src/unrelated.ts"),
			"nothing to do with the contract",
		);
	});

	afterEach(() => {
		fs.rmSync(installDir, { recursive: true, force: true });
	});

	it("resolves verified, drift, and infra independently in the same run", () => {
		const results = resolveAndCheckContracts(installDir, {
			contracts: FIXTURE_CONTRACTS,
		});
		expect(results).toHaveLength(3);

		const byId = Object.fromEntries(results.map((r) => [r.id, r]));
		expect(byId["fixture.verified"]).toMatchObject({
			outcome: "verified",
			pass: true,
		});
		expect(byId["fixture.drift"]).toMatchObject({
			outcome: "drift",
			pass: false,
			detail: "FLAG=1 missing",
		});
		expect(byId["fixture.infra"]).toMatchObject({
			outcome: "infra",
			pass: false,
		});
		expect(byId["fixture.infra"].detail).toContain("src/c-moved.ts");
	});

	it("a package name change on ONE contract entry cannot desync from a second table — there is no second table", () => {
		// Regression shape for F2: renaming fixture-pkg-a's package field
		// alone (without touching a separate locations table, because none
		// exists) must resolve against the RENAMED directory, not throw.
		fs.mkdirSync(path.join(installDir, "node_modules/fixture-pkg-a2/src"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(installDir, "node_modules/fixture-pkg-a2/src/a.ts"),
			"const FLAG=1;",
		);
		const renamed = [{ ...FIXTURE_CONTRACTS[0], package: "fixture-pkg-a2" }];
		const results = resolveAndCheckContracts(installDir, {
			contracts: renamed,
		});
		expect(results).toEqual([
			expect.objectContaining({ outcome: "verified", pass: true }),
		]);
	});

	it("uses the real CONTRACTS registry by default (no fixture override)", () => {
		// Sanity check that the default parameter actually wires up the real
		// 7-contract registry, not just the test-only override path — run
		// against an empty install dir so every contract is "infra" (no
		// packages present), never a crash.
		const results = resolveAndCheckContracts(installDir);
		expect(results).toHaveLength(7);
		expect(results.every((r) => r.outcome === "infra")).toBe(true);
	});
});
