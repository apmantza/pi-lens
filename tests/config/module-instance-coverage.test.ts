/**
 * #1565 — tests must import the artifact the runtime imports.
 *
 * Vitest resolves `x.ts` and `x.js` to two separate module instances, and this
 * repo's runtime is the compiled `.js`. A test that spells a build-compiled
 * module `.ts` therefore holds a private copy of that module's mutable state:
 * a reset called through it clears the copy, the code under test keeps reading
 * the compiled original, and the assertion passes vacuously (defect shape 7).
 *
 * See tests/support/module-instance-scan.ts for the mechanics, and
 * module-instance-binding.test.ts for the live demonstration that a
 * `.ts`-bound reset does not clear compiled state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	importKey,
	importSpecifiers,
	repoRoot,
	scanDualInstanceImports,
} from "../support/module-instance-scan.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/**
 * Reviewed exceptions: `file -> target`, each with the reason it is safe.
 *
 * `vitest.config.ts` is the one module whose `.ts` spelling is REQUIRED. The
 * build emits a `vitest.config.js` at the repo root, so the `.js` spelling
 * would read a stale compiled copy of the very config the guard below is
 * validating (verified 2026-08-12 in timing-sensitive-coverage.test.ts:
 * commenting an entry out of the `.ts` left the imported list unchanged). It is
 * also a pure data object with no mutable state the runtime shares, so the
 * duplicate instance costs nothing.
 */
const reviewedExceptions = new Map<string, string>([
	[
		"tests/config/timing-sensitive-coverage.test.ts -> vitest.config.ts",
		"reads the live config source, not the stale compiled vitest.config.js",
	],
	[
		"tests/config/worker-budget.test.ts -> vitest.config.ts",
		"reads the live config source, not the stale compiled vitest.config.js",
	],
	[
		"tests/config/lsp-spawn-heavy-coverage.test.ts -> vitest.config.ts",
		"reads the live config source, not the stale compiled vitest.config.js",
	],
	[
		"tests/clients/flake-shape-ratchet.test.ts -> vitest.config.ts",
		"reads the live config source, not the stale compiled vitest.config.js",
	],
	[
		"tests/config/real-harness-lane.test.ts -> vitest.config.ts",
		"reads the live config source, not the stale compiled vitest.config.js",
	],
]);

describe("test imports bind the compiled module instance (#1565)", () => {
	it("no test reaches a build-compiled module through a .ts specifier", () => {
		const scanned = scanDualInstanceImports();
		const violations = scanned.filter(
			(entry) => !reviewedExceptions.has(importKey(entry)),
		);
		// Calibration: 1 dual-instance import on 2026-08-26; this guard stays
		// at 1 because the population is intentionally a single known exception.
		assertNonEmptyScan("module-instance scan", scanned.length, 1);

		expect(
			violations.map((entry) => `${entry.file}: ${entry.specifier}`).sort(),
			"import the compiled .js the runtime imports, or allowlist with a reason",
		).toEqual([]);
	});

	it("keeps the exception list honest", () => {
		const present = new Set(scanDualInstanceImports().map(importKey));
		const stale = [...reviewedExceptions.keys()].filter(
			(key) => !present.has(key),
		);
		expect(stale, "reviewed exceptions must still be live .ts imports").toEqual(
			[],
		);
	});

	it("detects the hazard it claims to detect", () => {
		// The scan is regex-driven, so prove it on a synthetic sample rather than
		// trusting an empty result: an empty result must distinguish clean from
		// broken. A fixture-string import (a quoted snippet a test feeds to a
		// parser) must NOT count; every real binding form must — including
		// `vi.unmock`, whose registry key has to match the `vi.mock` spelling or
		// it lifts nothing (a #1565 rebase sweep found one).
		const suffix = ".t" + "s";
		const sample = [
			`import { a } from "../../clients/thing${suffix}";`,
			`const b = await import("../../clients/other${suffix}");`,
			`vi.mock("../../clients/mocked${suffix}", () => ({}));`,
			`vi.unmock("../../clients/unmocked${suffix}");`,
			`\tconst src = 'import { c } from "../../clients/fixture${suffix}";\\n';`,
		].join("\n");
		expect(importSpecifiers(sample).sort()).toEqual([
			`../../clients/mocked${suffix}`,
			`../../clients/other${suffix}`,
			`../../clients/thing${suffix}`,
			`../../clients/unmocked${suffix}`,
		]);
	});

	it("only counts modules the build actually compiles", () => {
		// Helpers under tests/ have no compiled twin (tsconfig.build.json excludes
		// the directory), so their `.ts` spelling is the only spelling and carries
		// no hazard. If the build ever starts compiling tests/, this fails and the
		// guard's scope has to be revisited.
		const buildConfig = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "tsconfig.build.json"), "utf8"),
		) as { exclude?: string[] };
		expect(buildConfig.exclude).toContain("tests");
	});
});
