// #2530 round 4 F2: scripts/rekey-hook-await-exemptions.mjs and
// scripts/lib/ts-sibling-loader.mjs shipped with no tests at all. Round 4
// F1 found the matching logic could silently launder a stale exemption
// reason onto a brand-new, unrelated flagged await — a hole a test would
// have caught immediately. These pin the fixed matching algorithm
// (`buildRekeyPlan`) directly, via synthetic key lists (no real files, no
// child process for a-c), plus one integration test (d) that spawns the
// real CLI to prove the JavaScript scan seam works under a bare `node`
// process without Node's optional built-in TypeScript support.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
	applyPlan,
	buildRekeyPlan,
	headOf,
	parseOldKeys,
} from "../../scripts/rekey-hook-await-exemptions.mjs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(
	REPO_ROOT,
	"scripts",
	"rekey-hook-await-exemptions.mjs",
);

function occurrence(key: string, detail = `${key} <synthetic>`) {
	return { key, detail };
}

describe("headOf", () => {
	it("strips only the trailing ~context suffix", () => {
		expect(headOf("clients/foo.ts#bar:70abab7e~0e2c385e")).toBe(
			"clients/foo.ts#bar:70abab7e",
		);
	});

	it("leaves a key with no ~ untouched (defensive)", () => {
		expect(headOf("clients/foo.ts#bar:70abab7e")).toBe(
			"clients/foo.ts#bar:70abab7e",
		);
	});

	it("keeps the race: prefix as part of the head", () => {
		expect(headOf("race:clients/foo.ts#70abab7e~0e2c385e")).toBe(
			"race:clients/foo.ts#70abab7e",
		);
	});
});

describe("buildRekeyPlan", () => {
	// (a) A line inserted near a flagged site changes ONLY its context
	// suffix -- the head (file, symbol, own-line hash) is untouched, so the
	// rewrite is accepted.
	it("rewrites a key whose head is unchanged and only ~context differs", () => {
		const oldKeys = ["clients/foo.ts#bar:70abab7e~0e2c385e"];
		const newOccurrences = [occurrence("clients/foo.ts#bar:70abab7e~9f061067")];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.unresolved).toEqual([]);
		expect(plan.changed).toEqual([
			[
				"clients/foo.ts#bar:70abab7e~0e2c385e",
				"clients/foo.ts#bar:70abab7e~9f061067",
			],
		]);
	});

	// (b) #2530 round 4 F1's exact laundering probe: the flagged line under
	// `bar` was replaced by a DIFFERENT, brand-new unbounded await -- same
	// rel#symbol, same coincidental context hash, but a different own-line
	// hash. The round-3 algorithm zipped this pair because the group's
	// COUNT stayed at 1==1; the fix requires the head itself to match.
	it("REFUSES a replacement await laundered as a rename (round 4 F1)", () => {
		const oldKeys = ["clients/foo.ts#bar:70abab7e~0e2c385e"];
		const newOccurrences = [
			occurrence(
				"clients/foo.ts#bar:bdcb06fe~0e2c385e",
				"clients/foo.ts:12  await somethingUnrelated();",
			),
		];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.changed).toEqual([]);
		expect(plan.mapping.size).toBe(0);
		expect(plan.unresolved).toHaveLength(1);
		expect(plan.unresolved[0].oldKey).toBe(
			"clients/foo.ts#bar:70abab7e~0e2c385e",
		);
		expect(plan.unresolved[0].reason).toMatch(/no current occurrence/);

		// And the write path actually refuses -- proves the guard stays red.
		const source = '"clients/foo.ts#bar:70abab7e~0e2c385e": { reason: "x" }';
		const before = process.exitCode;
		process.exitCode = undefined;
		applyPlan(source, plan, /* write */ true);
		const refused = process.exitCode === 1;
		process.exitCode = before;
		expect(refused).toBe(true);
	});

	// (c) A table entry becomes orphaned: two sites were flagged under the
	// same symbol, one got wrapped in bounded() (fixed) and only one
	// occurrence remains in the live scan. The identity-level COUNT for
	// this symbol drops from 2 to 1 -- refused, even though the surviving
	// site's own key is completely unchanged.
	it("refuses when a table entry's count of occurrences under its symbol drops (orphaned entry)", () => {
		const oldKeys = [
			"clients/foo.ts#bar:70abab7e~0e2c385e",
			"clients/foo.ts#bar:cdef1234~1a2b3c4d",
		];
		// Only the first site is still flagged; the second was fixed.
		const newOccurrences = [occurrence("clients/foo.ts#bar:70abab7e~0e2c385e")];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.unresolved).toHaveLength(1);
		expect(plan.unresolved[0].oldKey).toBe(
			"clients/foo.ts#bar:cdef1234~1a2b3c4d",
		);
		// The still-valid sibling is recognised (needs no rewrite) even
		// though the OTHER key in the same symbol is stuck -- but the whole
		// write still refuses (applyPlan below), so nothing is silently
		// dropped from the table.
		expect(plan.mapping.get("clients/foo.ts#bar:70abab7e~0e2c385e")).toBe(
			"clients/foo.ts#bar:70abab7e~0e2c385e",
		);

		const before = process.exitCode;
		process.exitCode = undefined;
		applyPlan("irrelevant source text", plan, true);
		const refused = process.exitCode === 1;
		process.exitCode = before;
		expect(refused).toBe(true);
	});

	// (b2) #3938's migration case: the SAME statement's head gains an
	// enclosing-symbol component because the owner lookup became
	// distance-independent. The own-line hash and the neighbourhood context
	// are byte-identical, but the head string differs, so the tool must
	// REFUSE. That is why the table's 105-key migration was proven and applied
	// by hand (same file + same own-line hash + same context) instead of by
	// loosening this matcher into a count- or suffix-based rename.
	it("REFUSES a bare head that only gains its enclosing symbol (#3938)", () => {
		const oldKeys = ["clients/foo.ts#70abab7e~0e2c385e"];
		const newOccurrences = [
			occurrence(
				"clients/foo.ts#bar:70abab7e~0e2c385e",
				"clients/foo.ts:12  await something();",
			),
		];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.changed).toEqual([]);
		expect(plan.mapping.size).toBe(0);
		expect(plan.unresolved).toHaveLength(1);
		expect(plan.unresolved[0].oldKey).toBe("clients/foo.ts#70abab7e~0e2c385e");
		expect(plan.unresolved[0].reason).toMatch(/no current occurrence/);
	});

	it("pairs duplicate-content occurrences positionally within one head bucket, not across heads", () => {
		// Two occurrences of the byte-identical line under the same symbol,
		// distinguished only by neighbourhood context -- exactly the shape
		// `mcp/server.ts`'s repeated `await ensureReady(cwd);` sites take in
		// the real table. Both contexts shift (a line was inserted between
		// them), so neither survives as an exact match, but since every
		// candidate in the bucket shares the identical head, positional
		// pairing is safe.
		const oldKeys = [
			"clients/foo.ts#bar:70abab7e~AAAA",
			"clients/foo.ts#bar:70abab7e~BBBB",
		];
		const newOccurrences = [
			occurrence("clients/foo.ts#bar:70abab7e~CCCC"),
			occurrence("clients/foo.ts#bar:70abab7e~DDDD"),
		];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.unresolved).toEqual([]);
		expect(plan.changed).toHaveLength(2);
	});

	it("does not rewrite a key that is already exactly correct", () => {
		const oldKeys = ["clients/foo.ts#bar:70abab7e~0e2c385e"];
		const newOccurrences = [occurrence("clients/foo.ts#bar:70abab7e~0e2c385e")];

		const plan = buildRekeyPlan(oldKeys, newOccurrences);

		expect(plan.unresolved).toEqual([]);
		expect(plan.changed).toEqual([]);
		expect(plan.mapping.get("clients/foo.ts#bar:70abab7e~0e2c385e")).toBe(
			"clients/foo.ts#bar:70abab7e~0e2c385e",
		);
	});
});

describe("parseOldKeys", () => {
	it("extracts keys in declaration order from a minimal EXEMPT_SITES literal", () => {
		const source = `
const EXEMPT_SITES: Readonly<Record<string, SweepExemption>> = {
	"clients/a.ts#one:aaa~bbb": {
		family: "hook-await",
	},
	"race:clients/b.ts#two:ccc~ddd": {
		family: "hand-rolled-race",
	},
};
`;
		expect(parseOldKeys(source)).toEqual([
			"clients/a.ts#one:aaa~bbb",
			"race:clients/b.ts#two:ccc~ddd",
		]);
	});
});

// (d) Vitest's own resolver would mask a regression here, so this has to
// spawn the real CLI. CI's Node build has the optional TypeScript feature;
// skip there explicitly, and assert its absence on the distro build that
// exposed #3363.
function nodeHasTypeScriptSupport(): boolean {
	try {
		const strip =
			process.getBuiltinModule?.("node:module")?.stripTypeScriptTypes;
		strip?.("let a: number = 1");
		return typeof strip === "function";
	} catch {
		return false;
	}
}

describe("CLI entry point (bare node, no TypeScript feature)", () => {
	it.skipIf(nodeHasTypeScriptSupport())(
		"runs against the live tree via a bare `node` process without a module-resolution error",
		() => {
			expect(nodeHasTypeScriptSupport()).toBe(false);
			// #3363: keep the bare-Node entry on the plain-JavaScript seam;
			// re-pointing it at the .ts facade must make this regression red.
			const scriptSource = readFileSync(SCRIPT_PATH, "utf8");
			expect(scriptSource).toMatch(
				/pathToFileURL\(path\.join\(REPO_ROOT, "tests\/support\/hook-await-scan\.mjs"\)/,
			);
			expect(scriptSource).not.toMatch(
				/pathToFileURL\(path\.join\(REPO_ROOT, "tests\/support\/hook-await-scan\.ts"\)/,
			);
			let stdout: string;
			try {
				stdout = execFileSync(process.execPath, [SCRIPT_PATH], {
					cwd: REPO_ROOT,
					encoding: "utf-8",
				});
			} catch (e) {
				const err = e as { stdout?: string; stderr?: string };
				// A clean refusal (unresolved table drift) exits 1 by design --
				// only a thrown module-resolution/syntax error is a real failure.
				expect(err.stderr ?? "").not.toMatch(
					/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find module/,
				);
				stdout = err.stdout ?? "";
			}
			// Proves the dynamic import of the JavaScript scan seam ran the real
			// detector.
			expect(stdout).toMatch(/^exemption keys in table: \d+$/m);
			expect(stdout).toMatch(/^scan produced occurrences: \d+$/m);
		},
	);
});
