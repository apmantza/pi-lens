/**
 * Tests for scripts/lib/compat-contract-locator.mjs (#2581).
 *
 * Exercises the locator against real on-disk fixture package trees — never
 * a real npm-installed dependency, that's what scripts/compat-contracts.mjs
 * verifies live — covering exactly the three states #2581's nightly run
 * conflated: the file at its ORIGINAL pinned path, the file having MOVED to
 * a new path (the pi-subagents@0.65.0 case), and the file being ABSENT from
 * every known location.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	locateContractSource,
	locateContractSources,
} from "../../scripts/lib/compat-contract-locator.mjs";

const CANDIDATES = [
	{ path: "src/runs/shared/pi-args.ts", observedAt: "0.34.0" },
	{ path: "src/runs/shared/child-runtime-config.ts", observedAt: "0.65.0" },
];

describe("locateContractSource", () => {
	let packageDir: string;

	beforeEach(() => {
		packageDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "compat-locator-fixture-"),
		);
	});

	afterEach(() => {
		fs.rmSync(packageDir, { recursive: true, force: true });
	});

	it("finds the file at its ORIGINAL pinned path when the package hasn't moved it", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/pi-args.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';",
		);

		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(result.relativePath).toBe("src/runs/shared/pi-args.ts");
		expect(result.observedAt).toBe("0.34.0");
		expect(result.source).toContain("SUBAGENT_CHILD_ENV");
	});

	it("finds the file at its NEW path when the package relocated it (0.65.0 case)", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/child-runtime-config.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';",
		);

		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(result.relativePath).toBe("src/runs/shared/child-runtime-config.ts");
		expect(result.observedAt).toBe("0.65.0");
	});

	// #2680 F1: an npm install (or a partial/stale publish) can leave a file
	// at an OLD candidate path on disk even after the package's CURRENT
	// version moved the logic elsewhere — first-match-wins in authored
	// (oldest-first) order would certify that leftover corpse as the live
	// contract. The live package's own current layout must always win.
	it("prefers the NEWEST existing candidate when both exist (stale leftover must never outrank the live layout)", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/pi-args.ts"),
			"OLD",
		);
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/child-runtime-config.ts"),
			"NEW",
		);

		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(result.relativePath).toBe("src/runs/shared/child-runtime-config.ts");
		expect(result.observedAt).toBe("0.65.0");
		expect(result.source).toBe("NEW");
	});

	// The reviewer's exact #2680 F1 probe: a stale leftover file at the OLD
	// path still carries content that would SATISFY the check (the flag is
	// still set there), while the live file at the NEW path has genuinely
	// dropped it. Preferring the stale file would make Layer A print
	// "ALL CONTRACT CHECKS VERIFIED" — certifying a corpse instead of the
	// package's actual current behavior.
	it("resolves the live (newest) file even when the stale leftover's content would satisfy a check and the live one wouldn't", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/pi-args.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';\nenv[SUBAGENT_CHILD_ENV] = '1';",
		);
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/child-runtime-config.ts"),
			"// flag no longer set here in the live version",
		);

		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(result.relativePath).toBe("src/runs/shared/child-runtime-config.ts");
		expect(result.source).not.toContain("SUBAGENT_CHILD_ENV");
	});

	it("reports found:false with every tried candidate when the file is ABSENT everywhere", () => {
		// packageDir exists but is otherwise empty — neither candidate present.
		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(false);
		if (result.found) throw new Error("unreachable");
		expect(result.tried).toEqual(CANDIDATES);
	});

	it("reports found:false when the package itself was never installed (dir absent)", () => {
		fs.rmSync(packageDir, { recursive: true, force: true });
		const result = locateContractSource(packageDir, CANDIDATES);
		expect(result.found).toBe(false);
	});
});

describe("locateContractSources", () => {
	let packageDir: string;

	beforeEach(() => {
		packageDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "compat-locator-multipart-fixture-"),
		);
	});

	afterEach(() => {
		fs.rmSync(packageDir, { recursive: true, force: true });
	});

	const PARTS = [
		{
			name: "constants",
			candidates: [
				{ path: "src/runs/shared/pi-args.ts", observedAt: "0.34.0" },
				{
					path: "src/runs/shared/child-runtime-config.ts",
					observedAt: "0.65.0",
				},
			],
		},
		{
			name: "assignment",
			candidates: [
				{ path: "src/runs/shared/pi-args.ts", observedAt: "0.34.0" },
				{
					path: "src/runs/background/subagent-runner.ts",
					observedAt: "0.65.0",
				},
			],
		},
	];

	it("concatenates parts resolved from DIFFERENT files (the 0.65.0 split)", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(packageDir, "src/runs/background"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/child-runtime-config.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';",
		);
		fs.writeFileSync(
			path.join(packageDir, "src/runs/background/subagent-runner.ts"),
			"process.env[SUBAGENT_CHILD_ENV] = '1';",
		);

		const result = locateContractSources(packageDir, PARTS);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(result.source).toContain("SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD'");
		expect(result.source).toContain("process.env[SUBAGENT_CHILD_ENV] = '1'");
		expect(result.parts.map((p) => p.name)).toEqual([
			"constants",
			"assignment",
		]);
	});

	it("resolves a single co-located file for BOTH parts (the pre-0.65.0 layout)", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/pi-args.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';\nenv[SUBAGENT_CHILD_ENV] = '1';",
		);

		const result = locateContractSources(packageDir, PARTS);
		expect(result.found).toBe(true);
		if (!result.found) throw new Error("unreachable");
		expect(
			result.parts.every(
				(p) => p.relativePath === "src/runs/shared/pi-args.ts",
			),
		).toBe(true);
	});

	it("reports found:false naming the FIRST unresolvable part when only one part is absent", () => {
		fs.mkdirSync(path.join(packageDir, "src/runs/shared"), {
			recursive: true,
		});
		// Only the "constants" part's file exists; "assignment" is absent
		// everywhere — must not silently pass with a partial concatenation.
		fs.writeFileSync(
			path.join(packageDir, "src/runs/shared/child-runtime-config.ts"),
			"export const SUBAGENT_CHILD_ENV = 'PI_SUBAGENT_CHILD';",
		);

		const result = locateContractSources(packageDir, PARTS);
		expect(result.found).toBe(false);
		if (result.found) throw new Error("unreachable");
		expect(result.part).toBe("assignment");
	});
});
