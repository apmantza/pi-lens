/**
 * One-vocabulary parity for `spawn-cwd-scan.ts` (#2927, folding #2926).
 *
 * `SPAWN_NAMES` and `NODE_SPAWN_NAMES` are the single source of truth for
 * "what counts as a spawn". The scan's own site rule and the sweep's
 * population predicate (`holdsAScannableSpawn`, same module) both derive from
 * them. Each test below loops over the tuple it pins, so adding a name to a
 * tuple automatically extends the coverage: a name the scanner does not scan,
 * or a predicate that does not admit it, reds here instead of riding in
 * uncounted (the #2902 round-3 probe: one name added, 140 tests green).
 *
 * These assert behaviour through the real seams (`scanSpawnCwd`,
 * `holdsAScannableSpawn`), never the derivation expression itself — a test
 * that rebuilt the alternation would pass alongside a drifted copy instead of
 * catching it.
 */

import { describe, expect, it } from "vitest";
import {
	NODE_SPAWN_NAMES,
	SPAWN_NAMES,
	holdsAScannableSpawn,
	scanSpawnCwd,
} from "./spawn-cwd-scan.js";

describe("spawn-cwd scanner vocabulary (#2927)", () => {
	it("scans every seam-wrapper name the vocabulary holds", async () => {
		// A drifted literal in the scan's site rule — one name off — drops the
		// name's sites while the tuple still claims them.
		for (const name of SPAWN_NAMES) {
			const scan = await scanSpawnCwd("fixture.ts", `${name}("tool", [], {});`);
			expect(
				scan.sites.map((site) => `${site.callee}:${site.kind}`),
				`seam wrapper ${name} is a direct site`,
			).toEqual([`${name}:direct`]);
		}
	});

	it("admits every seam-wrapper name in the population predicate", async () => {
		// The reviewer's exact probe (#2926): a name added to the tuple that
		// the predicate does not admit leaves the sweep green and blind.
		for (const name of SPAWN_NAMES) {
			expect(
				holdsAScannableSpawn(`const r = await ${name}("t", [], {});`),
				`seam wrapper ${name} is a population file`,
			).toBe(true);
		}
	});

	it("scans and admits every node spawn name the vocabulary holds", async () => {
		// Seven names since #2902 closed the aliased-import gap (#2888): each
		// entry is admitted by the population predicate AND yields a direct
		// site from the scan, so either side drifting reds here.
		for (const name of NODE_SPAWN_NAMES) {
			const source = `import { ${name} } from "node:child_process";\n${name}("tool", []);`;
			const scan = await scanSpawnCwd("fixture.ts", source);
			expect(
				scan.sites.map((site) => `${site.callee}:${site.kind}`),
				`node spawn ${name} is a direct site`,
			).toEqual([`${name}:direct`]);
			expect(
				holdsAScannableSpawn(source),
				`node spawn ${name} is a population file`,
			).toBe(true);
		}
		// An aliased binding resolves through the same table, on both sides.
		const aliased = `import { spawn as nodeSpawn } from "node:child_process";\nnodeSpawn("t", []);`;
		const aliasedScan = await scanSpawnCwd("fixture.ts", aliased);
		expect(
			aliasedScan.sites.map((site) => `${site.callee}:${site.kind}`),
			"an aliased node spawn is a direct site",
		).toEqual(["nodeSpawn:direct"]);
		expect(
			holdsAScannableSpawn(aliased),
			"an aliased node spawn is a population file",
		).toBe(true);
	});

	it("keeps the bounds: object methods and unbound spellings stay out", () => {
		// `server.spawn(` is an LSP server definition's own method (round-5
		// v4-N3); `promisify(exec)` never binds a vocabulary name (#2888).
		expect(
			holdsAScannableSpawn("await server.spawn(root, { allowInstall });"),
			"a method named spawn on some object",
		).toBe(false);
		expect(
			holdsAScannableSpawn(
				'import { execFileAsync } from "node:child_process";\nexecFileAsync("tool");',
			),
			"an unrecognised child_process spelling stays outside the population",
		).toBe(false);
	});
});
