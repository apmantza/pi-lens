/**
 * #4133 round 3: census the test harnesses that spawn a child process.
 *
 * A harness child that runs pi-lens (the real `pi` host, the MCP server) can
 * run a scanner whose report directory is created with `mkdtempSync` and
 * removed in a `finally`. Killing the child before that `finally` (the MCP
 * harness `dispose()` SIGKILLs its tree) strands the directory. Every harness
 * that spawns a child must therefore either hand the child an owned scanner
 * temp root (`PI_LENS_TEST_SCANNER_TMPDIR` after caller env, with the
 * scanner-only harness marker) or be named in {@link ADMISSIONS} with a reason.
 *
 * Population: every non-test `*.ts` under `tests/support/` plus every
 * `tests/<dir>/harness*.ts`. Enumerated with:
 *
 *   grep -rn "spawn(" tests/support --include="*.ts" | grep -v "\.test\.ts"
 *   grep -rn "spawn(" tests/<dir>/harness*.ts | grep -v "\.test\.ts"
 *
 * Registered-or-fail through `tests/support/sweep-kit.ts`: a new spawn
 * harness is unaccounted until it is covered or admitted, and a stale
 * admission reds (#1735).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Lang, parse } from "@ast-grep/napi";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

/** A real child-process spawn (not `spawnSync`, not `server.spawn`). */
const SPAWN_CALL = /(?<![\w.$])spawn\s*\(/;

/** Static governance checks the env object rather than token presence:
 * arbitrary future harnesses cannot be run by a fixed runtime witness. */
function hasOwnedScannerRoot(raw: string): boolean {
	return parse(Lang.TypeScript, raw)
		.root()
		.findAll({ rule: { kind: "object" } })
		.some((object) => {
			const properties = object.children();
			const lastSpread = properties
				.map((prop) => prop.kind())
				.lastIndexOf("spread_element");
			const root = properties.findIndex(
				(prop) =>
					prop.field("key")?.text().replace(/["']/g, "") ===
					"PI_LENS_TEST_SCANNER_TMPDIR",
			);
			const marker = properties.findIndex(
				(prop) =>
					prop.field("key")?.text().replace(/["']/g, "") ===
					"PI_LENS_TEST_SCANNER_HARNESS",
			);
			return (
				root > lastSpread &&
				marker > lastSpread &&
				(properties[root].field("value")?.kind() === "identifier" ||
					properties[root].field("value")?.kind() === "member_expression") &&
				properties[marker].field("value")?.text().replace(/["']/g, "") === "1"
			);
		});
}

/**
 * The two spawn-bearing harnesses today, pinned so a new spawn harness must
 * be named here (and covered or admitted) rather than slip in.
 */
const EXPECTED_SPAWN_HARNESSES = [
	"tests/mcp/harness.ts",
	"tests/support/fault-injection.ts",
	"tests/support/real-pi-harness.ts",
].sort();

/**
 * Spawn harnesses with no scanner report directory to strand. Each entry
 * needs a reason; a stale one fails `auditRegistry`.
 */
const ADMISSIONS: Readonly<Record<string, string>> = {
	"tests/support/fault-injection.ts":
		"spawns tests/fixtures/wedged-stdin-child.mjs, a Node fixture that never runs pi-lens or a scanner and creates no report directory; the caller owns its lifetime with a backstop kill",
};

/** Every candidate harness file: `tests/support/**` non-test, plus
 *  `tests/<dir>/harness*.ts`. */
function candidateFiles(): string[] {
	const support = listSourceFiles(path.join(TESTS_ROOT, "support"), {
		extensions: [".ts", ".mts"],
		skipTests: true,
	});
	const harnessFiles: string[] = [];
	for (const entry of fs.readdirSync(TESTS_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(TESTS_ROOT, entry.name);
		for (const name of fs.readdirSync(dir)) {
			if (/^harness.*\.ts$/.test(name)) harnessFiles.push(path.join(dir, name));
		}
	}
	return [...support, ...harnessFiles].sort();
}

interface Census {
	spawnHarnesses: string[];
	ownedRoot: string[];
	scanned: number;
}

function runCensus(): Census {
	const spawnHarnesses: string[] = [];
	const ownedRoot: string[] = [];
	const candidates = candidateFiles();
	for (const abs of candidates) {
		const raw = fs.readFileSync(abs, "utf8");
		// Strip with strings blanked first: a `spawn(` named only in a comment or
		// a string is not a call.
		if (!SPAWN_CALL.test(stripSource(raw))) continue;
		const rel = relativePosix(REPO_ROOT, abs);
		spawnHarnesses.push(rel);
		// Parse executable assignments; comments and unrelated strings cannot own a root.
		if (hasOwnedScannerRoot(raw)) {
			ownedRoot.push(rel);
		}
	}
	return {
		spawnHarnesses: spawnHarnesses.sort(),
		ownedRoot,
		scanned: candidates.length,
	};
}

describe("#4133 scanner temp-root harness census", () => {
	// #4292 r5: TMPDIR presence admitted outside-root's replaceable root.
	it("rejects replaceable roots and prose ownership", () => {
		for (const source of [
			"const env = { TMPDIR: childTmp, ...options.env };",
			'const env = { PI_LENS_TEST_SCANNER_TMPDIR: root, ...options.env, PI_LENS_TEST_SCANNER_HARNESS: "1" };',
			'const env = { PI_LENS_TEST_SCANNER_HARNESS: "1", ...options.env, PI_LENS_TEST_SCANNER_TMPDIR: root };',
			'const env = { ...options.env, PI_LENS_TEST_SCANNER_TMPDIR: root, PI_LENS_TEST_SCANNER_HARNESS: "0" };',
			'const env = { PI_LENS_TEST_SCANNER_TMPDIR: root, PI_LENS_TEST_SCANNER_HARNESS: "1", ...options.env };',
			'const env = { ...options.env, PI_LENS_TEST_SCANNER_TMPDIR: options.env.root ?? root, PI_LENS_TEST_SCANNER_HARNESS: "1" };',
			'// PI_LENS_TEST_SCANNER_TMPDIR: root\nconst text = "PI_LENS_TEST_SCANNER_HARNESS";',
		])
			expect(hasOwnedScannerRoot(source)).toBe(false);
	});

	it("recognises final owned assignments with quoted env keys", () => {
		expect(
			hasOwnedScannerRoot(
				'const env = { ...caller, "PI_LENS_TEST_SCANNER_TMPDIR": ownedRoot, "PI_LENS_TEST_SCANNER_HARNESS": "1" };',
			),
		).toBe(true);
	});
	const { spawnHarnesses, ownedRoot, scanned } = runCensus();

	it("finds the spawn-harness population (a dead census is not clean)", () => {
		assertNonEmptyScan("harness census candidate files", scanned, 50);
		assertNonEmptyScan("spawn harnesses", spawnHarnesses.length, 2);
		expect(spawnHarnesses).toEqual(EXPECTED_SPAWN_HARNESSES);
	});

	it("covers every spawn harness or admits it with a reason", () => {
		const audit = auditRegistry({
			sweepName: "scanner temp-root harness census",
			flagged: spawnHarnesses,
			registered: ownedRoot,
			exemptions: ADMISSIONS,
			minFlagged: 2,
			scannedCount: scanned,
			minScanned: 50,
			remediation:
				"point the child at an owned scanner root (PI_LENS_TEST_SCANNER_TMPDIR, " +
				"after caller env, with PI_LENS_TEST_SCANNER_HARNESS=1) or add a reasoned admission.",
		});
		expect(audit.problems).toEqual([]);
		// The live coverage: both pi-lens-spawning harnesses own their root.
		expect(ownedRoot.sort()).toEqual([
			"tests/mcp/harness.ts",
			"tests/support/real-pi-harness.ts",
		]);
	});
});
