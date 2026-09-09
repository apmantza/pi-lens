/**
 * #2780 recurrence guard: the diagnostics gate must remain an opt-in
 * population of fixtures whose source contains a documented seeded error.
 * A clean or merely handshaking fixture must never enter this nightly gate.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LSP_FIXTURES } from "../../scripts/smoke-tools.mjs";

type GateFixture = (typeof LSP_FIXTURES)[number] & {
	lspGateMarker?: string;
};
const gateFixtures = LSP_FIXTURES as GateFixture[];

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("LSP clean-gate fixture population (#2780 round 2)", () => {
	it("contains exactly the five seeded primary fixtures and the custom row", () => {
		const gated = gateFixtures.filter((fixture) => fixture.lspGate === true);
		expect(gated).toHaveLength(6);
		expect(gated.map((fixture) => fixture.lang)).toEqual([
			"typescript",
			"json",
			"css",
			"toml",
			"cue",
			"lua-custom-provenance",
		]);
	});

	it("requires every opted-in fixture to carry its documented source marker", () => {
		for (const fixture of gateFixtures.filter(
			(fixture) => fixture.lspGate === true,
		)) {
			expect(fixture.lspGateMarker, fixture.lang).toBeTruthy();
			const source = readFileSync(
				path.join(repoRoot, fixture.dir, fixture.file),
				"utf8",
			);
			expect(source, fixture.lang).toContain(fixture.lspGateMarker);
		}
	});
});
