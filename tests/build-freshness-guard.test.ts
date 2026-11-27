/**
 * Unit test for the build-freshness guard (#198). The guard runs as a vitest
 * globalSetup; if it ever silently stopped detecting staleness it would
 * reintroduce the exact bug it exists to prevent (tests passing against stale
 * in-place compiled `.js`), so its detection logic is exercised here against a
 * controlled temp fixture with explicit mtimes.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { stampPackageLock } from "../scripts/stamp-package-lock.mjs";
import {
	findResidueCompiledTestSources,
	findStaleCompiledSources,
	nodeModulesLockWarning,
	reportNodeModulesLock,
	runFreshnessChecks,
} from "./support/check-build-freshness.js";
import { TREE_WALK_TIMEOUT_MS } from "./support/test-timeout-scale.js";

describe("node_modules lock stamp (#3694)", () => {
	const made: string[] = [];
	function fixture(lock: string | null, stamp: string | null): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-lock-stamp-"));
		made.push(dir);
		mkdirSync(join(dir, "node_modules"));
		if (lock !== null) writeFileSync(join(dir, "package-lock.json"), lock);
		if (stamp !== null)
			writeFileSync(
				join(dir, "node_modules", ".pi-lens-package-lock-sha256"),
				stamp,
			);
		return dir;
	}
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	afterEach(() => {
		for (const dir of made.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("warns without failing for a stale shared install", () => {
		const warning = nodeModulesLockWarning(fixture("current", "stale\n"), {});
		expect(warning).toContain("node_modules may be stale");
		expect(warning).toContain("npm ci");
	});

	it("accepts a matching install stamp", () => {
		expect(
			nodeModulesLockWarning(fixture("current", `${sha("current")}\n`), {}),
		).toBeNull();
	});

	// A MISSING stamp is the common stale case (an install older than the
	// stamp, or `prepare` skipped), so it warns; CI installs with
	// `npm ci --ignore-scripts` and never has one, so CI stays quiet.
	it("warns when the stamp is missing, except on CI", () => {
		const dir = fixture("current", null);
		expect(nodeModulesLockWarning(dir, {})).toContain(
			"no install stamp; run `npm ci`",
		);
		expect(nodeModulesLockWarning(dir, { CI: "true" })).toBeNull();
	});

	it("stays silent when there is no lockfile to compare against", () => {
		expect(nodeModulesLockWarning(fixture(null, "stale"), {})).toBeNull();
	});

	// Recurrence: seven vitest projects list sharedGlobalSetup, so an unguarded
	// warning printed seven times per run (measured: two projects, two prints
	// with a module-level flag -- the latch is run-scoped).
	it("reports once per run however many projects call setup", () => {
		const dir = fixture("current", "stale");
		const warn = vi.fn();
		const latch: Record<symbol, unknown> = {};
		for (let project = 0; project < 7; project++)
			reportNodeModulesLock(dir, warn, latch);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("node_modules may be stale");
		// A new run (a fresh latch) reports again.
		reportNodeModulesLock(dir, warn, latch);
		reportNodeModulesLock(dir, warn, {});
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("reports nothing for an up-to-date install", () => {
		const warn = vi.fn();
		reportNodeModulesLock(fixture("current", sha("current")), warn, {});
		expect(warn).not.toHaveBeenCalled();
	});

	// setup() is what vitest actually calls, against the REAL checkout root. Its
	// `readFileSync` of the lock and the stamp is answered by a partial node:fs
	// double (everything else is the real fs, so the freshness checks still run
	// for real), making the stale-stamp state deterministic on any box.
	it("setup() prints the warning through console.warn, once across projects", async () => {
		const g = globalThis as Record<symbol, unknown>;
		const latchKey = Symbol.for("pi-lens.node-modules-lock-warning");
		const saved = g[latchKey];
		delete g[latchKey];
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				readFileSync: ((file: unknown, ...rest: unknown[]) => {
					const name = String(file);
					if (name.endsWith("package-lock.json")) return "lock";
					if (name.endsWith(".pi-lens-package-lock-sha256")) return "stale";
					return (actual.readFileSync as (...a: unknown[]) => unknown)(
						file,
						...rest,
					);
				}) as typeof actual.readFileSync,
			};
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const fresh = await import("./support/check-build-freshness.js");
			fresh.default();
			fresh.default();
			fresh.default();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain(
				"node_modules may be stale",
			);
		} finally {
			warn.mockRestore();
			vi.doUnmock("node:fs");
			vi.resetModules();
			if (saved === undefined) delete g[latchKey];
			else g[latchKey] = saved;
		}
	});

	it("the stamp script and the check agree on the hash", () => {
		const dir = fixture("current", null);
		expect(stampPackageLock(dir)).toBe("stamped");
		expect(nodeModulesLockWarning(dir, {})).toBeNull();
		expect(
			readFileSync(
				join(dir, "node_modules", ".pi-lens-package-lock-sha256"),
				"utf8",
			),
		).toBe(`${sha("current")}\n`);
	});

	// `prepare` runs this after every install, including installs where there
	// is no node_modules to stamp; a stamp is a hint and must not fail it.
	it("the stamp script does not fail, or invent node_modules, when there is none", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-lock-stamp-none-"));
		made.push(dir);
		writeFileSync(join(dir, "package-lock.json"), "current");
		expect(stampPackageLock(dir)).toBe("no-node-modules");
		expect(existsSync(join(dir, "node_modules"))).toBe(false);
		expect(stampPackageLock(fixture(null, null))).toBe("failed");
	});
});

let root: string;
const older = new Date("2020-01-01T00:00:00Z");
const newer = new Date("2020-01-02T00:00:00Z");

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lens-freshness-"));
	const clients = join(root, "clients");
	mkdirSync(clients, { recursive: true });

	const write = (rel: string, ts: Date) => {
		const p = join(root, rel);
		writeFileSync(p, "");
		utimesSync(p, ts, ts);
	};

	// fresh: .js newer than .ts → not stale
	write("clients/fresh.ts", older);
	write("clients/fresh.js", newer);
	// stale: .ts newer than .js → stale
	write("clients/stale.js", older);
	write("clients/stale.ts", newer);
	// missing: source with no compiled .js → stale
	write("clients/missing.ts", newer);
	// must be ignored (not compiled in place)
	write("clients/thing.test.ts", newer);
	write("clients/thing.d.ts", newer);
	// root file, fresh
	write("index.js", newer);
	write("index.ts", older);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findStaleCompiledSources (#198 build-freshness guard)", () => {
	const run = () =>
		findStaleCompiledSources({
			root,
			dirs: ["clients"],
			rootFiles: ["index.ts"],
		}).map((p) => p.replace(/\\/g, "/"));

	it("flags a source whose compiled .js is older", () => {
		expect(run().some((p) => p.endsWith("clients/stale.ts"))).toBe(true);
	});

	it("flags a source with no compiled .js", () => {
		expect(run().some((p) => p.endsWith("clients/missing.ts"))).toBe(true);
	});

	it("does not flag a fresh source (.js newer than .ts)", () => {
		const r = run();
		expect(r.some((p) => p.endsWith("clients/fresh.ts"))).toBe(false);
		expect(r.some((p) => p.endsWith("index.ts"))).toBe(false);
	});

	it("ignores .test.ts and .d.ts (excluded from the in-place build)", () => {
		const r = run();
		expect(r.some((p) => p.includes("thing.test.ts"))).toBe(false);
		expect(r.some((p) => p.includes("thing.d.ts"))).toBe(false);
	});
});

describe("findResidueCompiledTestSources (#2232 stale test-support residue guard)", () => {
	let residueRoot: string;

	beforeAll(() => {
		residueRoot = mkdtempSync(join(tmpdir(), "pi-lens-test-residue-"));
		const support = join(residueRoot, "tests", "support");
		mkdirSync(support, { recursive: true });
		const write = (rel: string) => writeFileSync(join(residueRoot, rel), "");

		// tests/ is never built, so ANY .js sibling of a tests/**/*.ts is residue,
		// regardless of mtime — unlike findStaleCompiledSources above.
		write("tests/support/shadowed.ts");
		write("tests/support/shadowed.js");
		// no sibling .js: clean, must not be flagged.
		write("tests/support/clean.ts");
		// .d.ts is never a real test-support module: must not be flagged even
		// with a .js sibling.
		write("tests/support/types.d.ts");
		write("tests/support/types.js");
	});

	afterAll(() => rmSync(residueRoot, { recursive: true, force: true }));

	it(
		"flags a .ts file that has a compiled .js sibling",
		() => {
			const r = findResidueCompiledTestSources({ root: residueRoot }).map((p) =>
				p.replace(/\\/g, "/"),
			);
			expect(r.some((p) => p.endsWith("tests/support/shadowed.js"))).toBe(true);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"does not flag a .ts file with no compiled sibling",
		() => {
			const r = findResidueCompiledTestSources({ root: residueRoot });
			expect(r.some((p) => p.includes("clean"))).toBe(false);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"ignores .d.ts even when a same-stem .js sits beside it",
		() => {
			const r = findResidueCompiledTestSources({ root: residueRoot });
			expect(r.some((p) => p.includes("types.js"))).toBe(false);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("runFreshnessChecks() end-to-end (#2232)", () => {
	// An isolated temp tree, NOT the live repo tests/ directory: planting a
	// file under the real tests/support/ raced a concurrent
	// module-instance-scan.ts walk of that same live tree under parallel
	// test workers (ENOENT observed in review — CI green beforehand was
	// scheduling luck, not correctness). runFreshnessChecks() takes an
	// injectable root precisely so this proof never touches the live tree.
	let e2eRoot: string;

	beforeAll(() => {
		e2eRoot = mkdtempSync(join(tmpdir(), "pi-lens-freshness-e2e-"));
		mkdirSync(join(e2eRoot, "tests", "support"), { recursive: true });
	});

	afterAll(() => rmSync(e2eRoot, { recursive: true, force: true }));

	it(
		"throws a loud error naming a planted stale-residue file",
		() => {
			writeFileSync(join(e2eRoot, "tests", "support", "probe.ts"), "");
			writeFileSync(join(e2eRoot, "tests", "support", "probe.js"), "");
			expect(() => runFreshnessChecks(e2eRoot)).toThrow(/probe\.js/);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});
