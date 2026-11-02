import { posix as posixPath } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	_resetProjectReportBuildGuardForTests,
	_toDisplayPathForTests,
	projectReport,
	renderTextProjectReport,
} from "../../clients/project-report.js";
import {
	_resetReviewGraphBuildAttemptsForTests,
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

async function warmGraph(cwd: string): Promise<void> {
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetReviewGraphBuildAttemptsForTests();
	_resetProjectReportBuildGuardForTests();
});

function makeEnv(prefix = "pi-lens-projreport-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

describe("projectReport — cold path (#773)", () => {
	it("returns available:false with an actionable hint and never blocks, kicking a background build", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");

		const report = await projectReport(env.tmpDir);

		expect(report.available).toBe(false);
		expect(report.hint).toBeTruthy();
		expect(report.trust).toBeUndefined();
		expect(report.hubs).toBeUndefined();
		// #2090: the actual claim is "never synchronously run a full graph
		// build on this path" (#773's graph-cold contract) - a wall-clock bound
		// only approximates that, and passed at 88ms against a 2000ms ceiling
		// (a 22.7x margin), loose enough to hide a synchronous build on a small
		// fixture. Assert the claim directly: the cache must still be cold the
		// instant the call returns, because the build is only kicked off
		// (fire-and-forget), never awaited.
		expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();

		// The background build was kicked off (deduped, fire-and-forget) — assert
		// it eventually populates the cache, proving it actually ran rather than
		// silently no-op'ing.
		await vi.waitFor(
			() => {
				expect(getCachedReviewGraph(env.tmpDir)).toBeDefined();
			},
			{ timeout: 10_000, interval: 100 },
		);
	});

	it("surfaces partial persistence honestly (#919/#936)", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
		createTempFile(env.tmpDir, "src/b.ts", "export const b = 2;\n");
		const previousCap = process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS;
		process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = "1";
		try {
			await warmGraph(env.tmpDir);
			const report = await projectReport(env.tmpDir);
			expect(report.available).toBe(true);
			expect(report.lastBuildAttempt).toMatchObject({ outcome: "succeeded" });
			expect(report.lastBuildAttempt?.reason).toContain(
				"persisted partial review graph",
			);
		} finally {
			if (previousCap === undefined) {
				delete process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS;
			} else {
				process.env.PI_LENS_GRAPH_PERSIST_MAX_ELEMENTS = previousCap;
			}
		}
	});

	it("surfaces a rejected background-class build (#919)", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");
		const facts = new FactStore();
		vi.spyOn(facts, "setSessionFact").mockImplementation(() => {
			throw new Error("synthetic graph build death");
		});

		await expect(buildOrUpdateGraph(env.tmpDir, [], facts)).rejects.toThrow(
			"synthetic graph build death",
		);
		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.lastBuildAttempt).toMatchObject({
			outcome: "failed",
			reason: "synthetic graph build death",
		});
	});
});

describe("projectReport — warm path section shapes", () => {
	async function buildWarmFixture(cwd: string) {
		createTempFile(
			cwd,
			"clients/hub.ts",
			[
				"export function hubFn(x) {",
				"  if (x > 0) {",
				"    return 1;",
				"  } else if (x < 0) {",
				"    return -1;",
				"  } else {",
				"    return 0;",
				"  }",
				"}",
			].join("\n"),
		);
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				cwd,
				`clients/consumer${i}.ts`,
				[
					"import { hubFn } from './hub';",
					`export function run${i}() { return hubFn(${i}); }`,
				].join("\n"),
			);
		}
		createTempFile(
			cwd,
			"entry/main.ts",
			[
				"import './consumer-alias';",
				"export function main() { return 1; }",
			].join("\n"),
		);
		// Give main.ts real fan-out so it qualifies as an entry point (near-zero
		// fan-in, high fan-out) rather than dead weight.
		createTempFile(cwd, "entry/consumer-alias.ts", "export const alias = 1;\n");
		createTempFile(cwd, "isolated/dead.ts", "export const dead = 1;\n");
		await warmGraph(cwd);
	}

	it("computes all six sections with correct shapes", async () => {
		const env = makeEnv();
		await buildWarmFixture(env.tmpDir);

		const report = await projectReport(env.tmpDir);

		expect(report.available).toBe(true);

		// 1. Trust header.
		expect(report.trust).toBeDefined();
		expect(report.trust!.filesCovered).toBeGreaterThan(0);
		expect(report.trust!.coverage).toBeGreaterThan(0);
		expect(typeof report.trust!.graphBuiltAt).toBe("string");
		expect(Array.isArray(report.trust!.notes)).toBe(true);

		// 2. Hubs — hub.ts has 3 importers.
		expect(report.hubs).toBeDefined();
		const hub = report.hubs!.find((h) => h.file.endsWith("hub.ts"));
		expect(hub).toBeDefined();
		expect(hub!.fanIn).toBe(3);
		expect(hub!.suggestedNext).toEqual({
			tool: "module_report",
			path: hub!.file,
		});
		expect(typeof hub!.blastRadius).toBe("number");

		// 3. Entry points — main.ts has zero fan-in, one fan-out.
		expect(report.entryPoints).toBeDefined();
		const entry = report.entryPoints!.find((e) => e.file.endsWith("main.ts"));
		expect(entry).toBeDefined();
		expect(entry!.fanIn).toBe(0);
		expect(entry!.fanOut).toBeGreaterThan(0);

		// 4. Subsystem map.
		expect(report.subsystems).toBeDefined();
		expect(report.subsystems!.directories.length).toBeGreaterThan(0);
		expect(Array.isArray(report.subsystems!.edges)).toBe(true);
		expect(Array.isArray(report.subsystems!.cycles)).toBe(true);
		expect(Array.isArray(report.subsystems!.violations)).toBe(true);

		// 5. Risk hotspots — hub.ts has branching (complexity) and fan-in.
		expect(report.riskHotspots).toBeDefined();
		const hotspot = report.riskHotspots!.find((r) => r.file.endsWith("hub.ts"));
		expect(hotspot).toBeDefined();
		expect(hotspot!.maxComplexity).toBeGreaterThan(1);
		expect(hotspot!.score).toBe(hotspot!.fanIn * hotspot!.maxComplexity);

		// 6. Dead weight — dead.ts has zero fan-in and isn't an entry point
		// (zero fan-out too), and the disclaimer always travels with the section.
		expect(report.deadWeight).toBeDefined();
		expect(report.deadWeight!.disclaimer.length).toBeGreaterThan(0);
		expect(
			report.deadWeight!.files.some((f) => f.file.endsWith("dead.ts")),
		).toBe(true);
	});

	it("always includes the dead-weight disclaimer even when nothing qualifies", async () => {
		const env = makeEnv();
		// Every file here either imports or is imported — no dead weight.
		createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		createTempFile(
			env.tmpDir,
			"b.ts",
			"import { a } from './a';\nexport const b = a;\n",
		);
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.deadWeight!.disclaimer.length).toBeGreaterThan(0);

		const text = renderTextProjectReport(report);
		expect(text).toContain("DEAD WEIGHT");
		expect(text).toContain(report.deadWeight!.disclaimer);
	});

	it("never reclassifies entry points past the display cap as dead weight", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "lib/shared.ts", "export const shared = 1;\n");
		// Three entry-point-like files (zero fan-in, real fan-out) — more than
		// the display cap below, so at least two overflow the entryPoints list.
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				env.tmpDir,
				`entry/main${i}.ts`,
				[
					"import { shared } from '../lib/shared';",
					`export function main${i}() { return shared; }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir, { limit: 1 });
		expect(report.available).toBe(true);
		expect(report.entryPoints!.length).toBe(1);
		// The exclusion set is uncapped (#773: "zero-importer files that aren't
		// entry points") — the two overflow entry points must not appear here.
		expect(
			report.deadWeight!.files.some((f) => f.file.includes("entry/main")),
		).toBe(false);
	});

	it("scales every ranked list's cap with the single `limit` knob", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"lib/hub.ts",
			[
				"export function hubFn(x) {",
				"  if (x > 0) { return 1; } else { return 0; }",
				"}",
			].join("\n"),
		);
		for (let i = 1; i <= 5; i += 1) {
			createTempFile(
				env.tmpDir,
				`callers/c${i}.ts`,
				[
					"import { hubFn } from '../lib/hub';",
					`export function run${i}(x) {`,
					"  if (x > 1) { return hubFn(x); } else if (x < -1) { return -1; } else { return 0; }",
					"}",
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const uncapped = await projectReport(env.tmpDir, { limit: 50 });
		const capped = await projectReport(env.tmpDir, { limit: 1 });

		expect(capped.hubs!.length).toBeLessThanOrEqual(1);
		expect(capped.riskHotspots!.length).toBeLessThanOrEqual(1);
		expect(capped.entryPoints!.length).toBeLessThanOrEqual(1);
		// The uncapped run must never be MORE restrictive than the capped one.
		expect(uncapped.hubs!.length).toBeGreaterThanOrEqual(capped.hubs!.length);
	});
});

describe("projectReport — cycle and layering-violation detection", () => {
	it("detects a directory-level import cycle on a synthetic cyclic fixture", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"dirA/a.ts",
			[
				"import { b } from '../dirB/b';",
				"export const a = 1;",
				"export function useB() { return b; }",
			].join("\n"),
		);
		createTempFile(
			env.tmpDir,
			"dirB/b.ts",
			[
				"import { a } from '../dirA/a';",
				"export const b = 2;",
				"export function useA() { return a; }",
			].join("\n"),
		);
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		const cycle = report.subsystems!.cycles.find(
			(c) => c.dirs.includes("dirA") && c.dirs.includes("dirB"),
		);
		expect(cycle).toBeDefined();
		expect(cycle!.edgeCount).toBeGreaterThanOrEqual(2);
	});

	it("flags the minority direction as a layering violation", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"tools/t.ts",
			[
				"import { c1 } from '../clients/c1';",
				"export const t = 1;",
				"export function useC1() { return c1; }",
			].join("\n"),
		);
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/c${i}.ts`,
				[
					"import { t } from '../tools/t';",
					`export const c${i} = 1;`,
					`export function useT${i}() { return t; }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		const violation = report.subsystems!.violations.find(
			(v) => v.from === "tools" && v.to === "clients",
		);
		expect(violation).toBeDefined();
		expect(violation!.count).toBeLessThan(violation!.dominantCount);
	});
});

describe("projectReport — focus re-ranking", () => {
	it("changes hub ordering to favor the focus term", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"clients/payments.ts",
			"export function chargeCard() { return 1; }\n",
		);
		for (let i = 1; i <= 2; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/payments-user${i}.ts`,
				[
					"import { chargeCard } from './payments';",
					`export function run${i}() { return chargeCard(); }`,
				].join("\n"),
			);
		}
		createTempFile(
			env.tmpDir,
			"clients/widgets.ts",
			"export function renderWidget() { return 1; }\n",
		);
		for (let i = 1; i <= 5; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/widgets-user${i}.ts`,
				[
					"import { renderWidget } from './widgets';",
					`export function run${i}() { return renderWidget(); }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const unfocused = await projectReport(env.tmpDir);
		// Without a focus hint, widgets.ts (5 importers) outranks payments.ts (2).
		expect(unfocused.hubs![0].file).toContain("widgets");

		const focused = await projectReport(env.tmpDir, {
			focus: "payments charge",
		});
		expect(focused.hubs![0].file).toContain("payments");
	});
});

// Refs #1194 (shape-2 sibling of #1163): `toDisplayPath` must delegate to the
// shape-aware `toProjectRelativePath` (clients/path-utils.ts) instead of
// hand-rolling relativization with the host-default `path.isAbsolute`/
// `path.relative`. Pre-fix, those bare functions follow `process.platform`,
// not the input's shape: `path.isAbsolute("C:\\repo\\src\\x.ts")` is FALSE
// under POSIX semantics (no leading "/"), so the pre-fix implementation
// short-circuited to the whole absolute path instead of relativizing a file
// that IS under the project root — green on native Windows (where bare
// `path` already resolves to win32 semantics) but wrong on Linux CI, the
// #1024 divergence class. Verified directly: emulating the pre-fix body
// under `require("path").posix` on
// `toDisplayPath("C:\\repo\\src\\x.ts", "C:\\repo")` returns
// `"C:/repo/src/x.ts"`, not `"src/x.ts"` — this test protects the delegated,
// shape-aware behavior that fixes that. Inputs are fed as Windows-shaped
// literals (never a hardcoded normalized key) per the #1139/#1150 anti-
// vacuous-fixture discipline, so this is meaningful on ANY OS: on native
// Windows it exercises the (already-correct) win32 path, and on Linux CI it
// exercises the shape-committed `win32.*` branch this delegation restores.
describe("toDisplayPath delegates to the shape-aware toProjectRelativePath (#1194)", () => {
	it("relativizes a backslash Windows-shaped path under a backslash root", () => {
		expect(_toDisplayPathForTests("C:\\repo\\src\\x.ts", "C:\\repo")).toBe(
			"src/x.ts",
		);
	});

	it("relativizes a forward-slash win32-shaped path under a win32-shaped root", () => {
		expect(_toDisplayPathForTests("C:/repo/src/nested/y.ts", "C:/repo")).toBe(
			"src/nested/y.ts",
		);
	});

	it("relativizes a UNC-shaped path under a UNC-shaped root", () => {
		expect(
			_toDisplayPathForTests(
				"\\\\host\\share\\proj\\src\\z.ts",
				"\\\\host\\share\\proj",
			),
		).toBe("src/z.ts");
	});

	it("keeps a win32-shaped path OUTSIDE a win32-shaped root as the slash-folded absolute path", () => {
		expect(_toDisplayPathForTests("C:\\other\\a.ts", "C:\\repo")).toBe(
			"C:/other/a.ts",
		);
	});

	it("does not regress the native same-OS common case", () => {
		expect(
			_toDisplayPathForTests("/home/dev/project/src/x.ts", "/home/dev/project"),
		).toBe("src/x.ts");
		// Non-absolute input passes through slash-normalized, unchanged.
		expect(
			_toDisplayPathForTests("src\\already\\relative.ts", "/anything"),
		).toBe("src/already/relative.ts");
	});

	// Direct fail-then-pass proof, OS-independent (AGENTS.md #1024 discipline:
	// on a Windows dev box, bare `path` already resolves to win32 semantics, so
	// re-running the OLD hand-rolled body locally would vacuously pass — it only
	// fails under POSIX `path` semantics, i.e. on Linux CI). This test pins the
	// PRE-FIX body explicitly against `path.posix` (never the host-default
	// `path`) to reproduce exactly what Linux CI executed before this fix, and
	// asserts the delegated implementation under test does NOT share that bug.
	it("the pre-fix hand-rolled body was broken under POSIX path semantics — the fix is not equivalent to it", () => {
		function preFixToDisplayPath(p: string, projectRoot: string): string {
			if (!posixPath.isAbsolute(p)) return p.replace(/\\/g, "/");
			const rel = posixPath.relative(projectRoot, p);
			return rel && !rel.startsWith("..")
				? rel.replace(/\\/g, "/")
				: p.replace(/\\/g, "/");
		}

		const input = "C:\\repo\\src\\x.ts";
		const root = "C:\\repo";

		// Pre-fix, under POSIX semantics (Linux CI): path.isAbsolute sees no
		// leading "/", short-circuits, and returns the whole absolute path.
		expect(preFixToDisplayPath(input, root)).toBe("C:/repo/src/x.ts");

		// The delegated, shape-aware implementation under test correctly
		// relativizes the SAME input regardless of host OS.
		expect(_toDisplayPathForTests(input, root)).toBe("src/x.ts");
	});
});
